// Printer / process / filament preset selection for slicing.
//
// Extracted verbatim from `SliceModal.tsx` (the pre-pick effects that used to
// live around lines 411-465) so the modal and the `/slicer` page pick presets
// through the same code path instead of each deriving their own. Behaviour is
// unchanged — see `__tests__/hooks/useSlicePresets.test.tsx`, the parity guard.
//
// The hook owns everything the pre-pick needs to be self-contained: the two
// queries it reads (unified presets + the Bambu printer-model registry), the
// four slot selections, the bed-type override, and the embedded-settings gate.
// It owns no UI concerns — no toasts, no i18n; callers render the feedback.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type PresetRef, type SlicerPipeline } from '../api/client';
import {
  presetCompatibility,
  buildCompatibilityIndex,
  type PrinterCompatibilityIndex,
} from '../utils/slicerPrinterMatch';
import {
  findPreset,
  findPresetByName,
  pickDefault,
  pickFilamentForSlot,
  pickProcessDefault,
} from '../utils/slicePresetPicker';

// The only part of a plate's filament requirement the pre-pick scores against.
// `PlateFilament` is assignable to this, so callers pass their slot list as-is.
export interface SliceFilamentSlot {
  type: string;
  color: string;
}

export interface UseSlicePresetsOptions {
  // One entry per plate slot, in plate order. Must be referentially stable
  // across renders (memoise it) — its identity is what re-runs the filament
  // pre-pick, exactly as it did when the effect lived in the modal.
  filamentSlots: SliceFilamentSlot[];
  // Printer / process preset names the source 3MF was prepared with.
  embeddedPrinter?: string | null;
  embeddedProcess?: string | null;
  // Gate the presets fetch. The modal defers it until past the plate picker so
  // cancelling out of that step costs no round-trip.
  enabled?: boolean;
}

export function useSlicePresets({
  filamentSlots,
  embeddedPrinter = null,
  embeddedProcess = null,
  enabled = true,
}: UseSlicePresetsOptions) {
  const queryClient = useQueryClient();

  const [printerPreset, setPrinterPreset] = useState<PresetRef | null>(null);
  const [processPreset, setProcessPreset] = useState<PresetRef | null>(null);
  // One filament ref per plate slot, in plate order. For STL / single-plate /
  // single-color sources this is a one-element array; multi-color 3MFs get one
  // entry per AMS slot the plate uses. Pre-pick (effect below) initialises
  // each slot from the source plate's required (type, colour).
  const [filamentPresets, setFilamentPresets] = useState<(PresetRef | null)[]>([]);
  // Build-plate override (#1337). null = inherit from the process preset
  // (the default). Set to a canonical slicer enum value to patch
  // curr_bed_type into the resolved process JSON before slicing — needed
  // because the process preset's default plate (typically "Cool Plate") is
  // incompatible with high-temp filaments like ABS / ASA / PC, and the
  // user had no way to switch plates without cloning the preset.
  const [bedType, setBedType] = useState<string | null>(null);
  // "Slice as designed" (#2611). When on, the backend honours the source
  // 3MF's embedded project_settings.config (the designer's own wall count,
  // infill, etc.) instead of the picked process/filament profiles. Only
  // offered when the picked printer matches the design's target model —
  // see canUseEmbedded below.
  const [useEmbedded, setUseEmbedded] = useState(false);

  const presetsQuery = useQuery({
    queryKey: ['slicerPresets'],
    queryFn: () => api.getSlicerPresets(),
    staleTime: 60_000,
    enabled,
  });

  // Manual refresh — bypasses the backend's 5-minute cloud cache and 1-hour
  // bundled cache for one call so users who deleted a preset in Bambu
  // Studio / Bambu Handy see the change immediately (#1581). The cache write
  // inside _fetch_cloud_presets / _fetch_bundled_presets refills with the
  // fresh result so subsequent normal callers still get cached responses.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshPresets = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const fresh = await api.getSlicerPresets({ refresh: true });
      queryClient.setQueryData(['slicerPresets'], fresh);
    } catch {
      // Fall through to invalidate so React Query retries via its normal
      // path on the next render — surfacing the failure through the existing
      // isError banner instead of duplicating error UI here.
      queryClient.invalidateQueries({ queryKey: ['slicerPresets'] });
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, queryClient]);

  // Canonical Bambu printer-model registry — drives the @BBL <code> name
  // fallback in slicerPrinterMatch for cloud / standard presets (#1325).
  // Long staleTime: the registry only changes across backend releases.
  const printerModelsQuery = useQuery({
    queryKey: ['slicerPrinterModels'],
    queryFn: api.getSlicerPrinterModels,
    staleTime: Infinity,
  });

  // Selected-printer context for the process / filament filter (#1325).
  const selectedPrinterName = useMemo<string | null>(() => {
    if (!presetsQuery.data || !printerPreset) return null;
    return findPreset(presetsQuery.data, printerPreset, 'printer')?.name ?? null;
  }, [presetsQuery.data, printerPreset]);
  // Compatibility ground truth: the slicer's own `compatible_printers` list
  // on local-imported presets, plus the @BBL <code> name fallback for cloud
  // / standard presets via the backend Bambu printer-model registry.
  const compatIndex = useMemo<PrinterCompatibilityIndex>(
    () => buildCompatibilityIndex(printerModelsQuery.data ?? {}),
    [printerModelsQuery.data],
  );

  // "Slice as designed" is offered only when the source carries embedded
  // settings (a real project 3MF, not an STL) AND the picked printer matches
  // the design's target model. The match gate is load-bearing: honouring
  // embedded settings for a different model would place the model on the
  // wrong bed. Names come from the same preset namespace, so a normalised
  // (strip "# " prefix, case-fold) equality is enough.
  const canUseEmbedded = useMemo<boolean>(() => {
    if (!embeddedPrinter || !embeddedProcess || !selectedPrinterName) return false;
    const norm = (s: string) => s.replace(/^#\s*/, '').trim().toLowerCase();
    return norm(selectedPrinterName) === norm(embeddedPrinter);
  }, [embeddedPrinter, embeddedProcess, selectedPrinterName]);

  // Drop back to profile slicing whenever the toggle stops being offered
  // (e.g. the user switches to a printer that doesn't match the design).
  useEffect(() => {
    if (!canUseEmbedded) setUseEmbedded(false);
  }, [canUseEmbedded]);

  // Printer pre-pick: defaults to the printer the 3MF was prepared for when
  // that preset is available, else the first listed printer. Runs once when
  // presets first arrive; later re-renders preserve any manual choice.
  useEffect(() => {
    const data = presetsQuery.data;
    if (!data) return;
    if (printerPreset == null) {
      setPrinterPreset(
        findPresetByName(data, 'printer', embeddedPrinter) ?? pickDefault(data, 'printer'),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetsQuery.data, embeddedPrinter]);

  // Process pre-pick / re-pick (#1325): defaults to a process compatible with
  // the selected printer, and re-defaults when a printer change leaves the
  // current process incompatible. A compatible or unknown manual pick is kept.
  useEffect(() => {
    const data = presetsQuery.data;
    if (!data) return;
    setProcessPreset((current) => {
      if (current) {
        const p = findPreset(data, current, 'process');
        if (p && presetCompatibility(p, 'process', selectedPrinterName, compatIndex) !== 'mismatch') {
          return current;
        }
      }
      return pickProcessDefault(data, selectedPrinterName, compatIndex, embeddedProcess);
    });
  }, [presetsQuery.data, selectedPrinterName, compatIndex, embeddedProcess]);

  // Filament pre-pick: re-runs when the active filament-slot count changes
  // (plate selection, single-plate metadata arriving) or the selected printer
  // changes. Each slot scores every available filament preset against the
  // slot's required (type, colour); an existing pick (incl. a user override)
  // is kept as long as it's still compatible with the selected printer, while
  // null slots and printer-incompatible picks are re-picked (#1325).
  useEffect(() => {
    const data = presetsQuery.data;
    if (!data) return;
    setFilamentPresets((current) => {
      return filamentSlots.map((slot, i) => {
        const cur = current[i] ?? null;
        if (cur) {
          const p = findPreset(data, cur, 'filament');
          if (p && presetCompatibility(p, 'filament', selectedPrinterName, compatIndex) !== 'mismatch') {
            return cur;
          }
        }
        return pickFilamentForSlot(
          data,
          { type: slot.type, color: slot.color },
          selectedPrinterName,
          compatIndex,
        );
      });
    });
  }, [presetsQuery.data, filamentSlots, selectedPrinterName, compatIndex]);

  // Set one slot, growing/truncating the list to the current slot count first
  // so a pick made before the plate's requirements arrived lands in the right
  // index.
  const setFilamentPresetAt = useCallback(
    (index: number, ref: PresetRef | null) => {
      setFilamentPresets((current) => {
        const next =
          current.length === filamentSlots.length
            ? [...current]
            : filamentSlots.map((_, i) => current[i] ?? null);
        next[index] = ref;
        return next;
      });
    },
    [filamentSlots],
  );

  // Slicer Pipelines (#1425) — apply a saved preset bundle to all slots with
  // one pick. The filament list is right-padded from current state so a
  // pipeline with fewer entries than the current source's slot count keeps the
  // existing tail.
  const applyPipeline = useCallback((pipeline: SlicerPipeline) => {
    setPrinterPreset(pipeline.printer_preset);
    setProcessPreset(pipeline.process_preset);
    setBedType(pipeline.bed_type);
    setFilamentPresets((current) => {
      const next = current.length > 0 ? [...current] : pipeline.filament_presets.map(() => null);
      for (let i = 0; i < next.length; i++) {
        if (i < pipeline.filament_presets.length) {
          next[i] = pipeline.filament_presets[i];
        }
      }
      return next;
    });
  }, []);

  return {
    presets: presetsQuery.data,
    isLoading: presetsQuery.isLoading,
    isError: presetsQuery.isError,
    isRefreshing,
    refreshPresets,
    printerPreset,
    setPrinterPreset,
    processPreset,
    setProcessPreset,
    filamentPresets,
    setFilamentPresetAt,
    bedType,
    setBedType,
    useEmbedded,
    setUseEmbedded,
    canUseEmbedded,
    selectedPrinterName,
    compatIndex,
    applyPipeline,
  };
}
