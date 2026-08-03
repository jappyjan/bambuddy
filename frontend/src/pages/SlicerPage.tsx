/**
 * `/slicer?file=42` (and `?archive=7`) — the desktop slicer page
 * (#15, step-5.3; spec §6/§7 step 5, mockup screen 2 "Proposed desktop layout").
 *
 * This is the integration ticket for step-5: it assembles `SlicerRail` (#13's
 * `ProcessSettingsEditor` under the preset triplet), `PlateStage` (#14) and the
 * action bar, and owns the state all three read. The pieces themselves know
 * nothing about each other — that is what let them be built in parallel — so
 * everything they need to agree on lives here.
 *
 * ## What this page owns
 *
 * The **selection**: presets (via `useSlicePresets`, the same hook `SliceModal`
 * consumes — preset logic is not re-derived here), the override diff, the
 * active plate, and the stage layout. It is assembled into one
 * `SliceSelection` per render, and *both* the slice request and the Print-now
 * gate are computed from that single object, so they cannot disagree about
 * what the user is currently looking at.
 *
 * ## The filament slots (#45, rail.2)
 *
 * They used to be *derived* — `filamentReqsQuery`'s answer read straight
 * through. Making them add/removable makes them **owned**: the plate seeds the
 * list once per (source, plate) and the user edits it from there. Two things
 * that follow, both easy to undo by accident:
 *
 * 1. **The slot list and `useSlicePresets`' profile list are spliced
 *    together.** `filament_presets` is positional, so an insert that grows only
 *    one of them slides every later slot's profile onto its neighbour — a
 *    slice that succeeds and prints the wrong material. See `handleInsertSlotAfter`.
 * 2. **Colours are overrides, not values.** Only a colour the user chose
 *    travels; an untouched selection sends no `filament_colours` at all, which
 *    is what keeps a plain slice from this page byte-identical to `SliceModal`'s.
 *
 * ## The rail's sections (#46, rail.3)
 *
 * The desktop rail groups itself into three collapsible panels and remembers
 * which are open. **Nothing about that is this page's business**, and that is
 * the point: every value the rail edits is owned here, so a hidden control
 * goes on contributing to `selection` — and therefore to the slice body and to
 * the Print-now fingerprint — exactly as it did while it was on screen. The
 * one thing decided here is that the *phone* does not get chevrons; see the
 * desktop `SlicerRail` below.
 *
 * ## Print now
 *
 * Enabled only while the last completed slice still matches the selection on
 * screen; the rule and the reasoning are in `sliceSelection.ts`. The page
 * records the fingerprint at dispatch time, keeps it with the job's result, and
 * compares against the live fingerprint on every render.
 *
 * ## The saved arrangement (#32, step-8.2)
 *
 * The gizmos in `PlateStage` produce **deltas from as-designed**; the persisted
 * `plate_layout` holds **absolute bed coordinates**. The two are bridged by the
 * per-object anchors the viewport measures off the 3MF and reports on
 * `onObjectMetricsChange`, which is why this page consumes them —
 * `components/slicer/plateLayout.ts` holds the conversion and the reasons.
 *
 * Two things about that arrangement are easy to get wrong and impossible to
 * see afterwards:
 *
 * 1. **The slicer only ever reads the stored column.** There is no layout field
 *    on `SliceRequest`; the backend applies `LibraryFile.plate_layout` to the
 *    model bytes at slice time. So an unsaved move would slice the *previous*
 *    arrangement while the viewport showed the new one. Slicing therefore
 *    flushes a pending layout first — see `handleSlice`.
 * 2. **Archives have no layout endpoint.** Rather than offer gizmos whose
 *    output can never reach the slicer, the stage is left read-only for an
 *    archive source (`PlateStage` is read-only exactly when it is given no
 *    `onTransformChange`).
 *
 * ## Coexistence with SliceModal
 *
 * `SliceModal` stays reachable — the file grid's per-card Slice button still
 * opens it, and it remains the fallback until this page has been tested on real
 * hardware (spec §10). Only the *inspector panel's* Slice button routes here.
 * Both must produce the same request for the same selection;
 * `__tests__/pages/SlicerPage.test.tsx` pins that against the modal's real
 * dispatch rather than a copy of its body builder.
 *
 * ## The phone (#24, step-6.1)
 *
 * A phone gets `MobileSliceWizard` instead of the rail-beside-stage tree —
 * **only the layout changes.** Every hook above runs identically on both, and
 * the wizard is handed the same `canSlice`, `canPrintNow`, `estimate` and
 * `handleSlice` this page already computed; it re-derives none of them. That is
 * the whole reason the phone cannot slice or print something different from the
 * desktop: there is no second copy of the rules to disagree with.
 *
 * ## Review-first (#31, step-6.2)
 *
 * The one thing the phone branch decides for itself is **which step the wizard
 * opens on**, from the source's `slice_count`: a file that already has a sliced
 * child opens on Review, where chips summarise the three steps behind it. The
 * presets there are not restored from anywhere — `useSlicePresets` re-picks
 * them deterministically from the same 3MF, which is why re-opening a file
 * reproduces its selection.
 *
 * Two constraints shape the code below and are easy to undo by accident:
 *
 * 1. `MobileSliceWizard` reads `initialStep` once, at mount. The count arrives
 *    over the network, so the wizard is **withheld until the query settles**
 *    rather than seeded afterwards — see the mobile branch.
 * 2. **`slice_count` never touches Print now.** That gate is the fingerprint
 *    comparison below and nothing else; a previous slice's output is not in
 *    `lastSlice`, and mounting on Review must not imply it is.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileQuestion, Loader2 } from 'lucide-react';
import {
  api,
  type PresetRef,
  type SliceArchiveResponse,
  type SliceResponse,
} from '../api/client';
import { useSliceJobTracker } from '../contexts/SliceJobTrackerContext';
import { useToast } from '../contexts/ToastContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { useSlicePresets } from '../hooks/useSlicePresets';
import { MobileSliceWizard } from '../components/slicer/MobileSliceWizard';
import { initialStepForSource } from '../components/slicer/wizardSteps';
import { PlateStage } from '../components/slicer/PlateStage';
import { SliceActionBar } from '../components/slicer/SliceActionBar';
import { SlicerRail } from '../components/slicer/SlicerRail';
import {
  applyTransformEdits,
  buildStagePlates,
  toPlateLayout,
  withTransformEdit,
  type PlateTransformEdits,
} from '../components/slicer/plateLayout';
import {
  canInsertAfter,
  canRemoveSlotAt,
  insertSlotAfter,
  removeSlotAt,
  seedSlots,
  setSlotColorAt,
  slotColorPayload,
  type FilamentSlotState,
} from '../components/slicer/filamentSlots';
import type { ObjectMetrics } from '../components/slicer/transformMath';
import type { ObjectTransform, PlateLayout } from '../types/plateStage';
import {
  resolveDefaults,
  sanitizeOverrides,
  type ProcessOverrides,
} from '../components/slicer/processFields';
import {
  buildSliceBody,
  isSelectionComplete,
  selectionFingerprint,
  type SliceSelection,
} from '../components/slicer/sliceSelection';
import { PrintModal } from '../components/PrintModal';

type SourceKind = 'libraryFile' | 'archive';

/** A slice that finished, and the selection it was made from. */
interface CompletedSlice {
  fingerprint: string;
  printTimeSeconds: number | null;
  filamentGrams: number | null;
  /** What Print now hands to `PrintModal`. */
  target: { kind: 'libraryFile'; id: number; name: string } | { kind: 'archive'; id: number; name: string };
}

/** Anchors and footprints are as-designed constants; equal means "no news". */
function sameMetrics(a: ObjectMetrics | undefined, b: ObjectMetrics): boolean {
  return (
    a != null &&
    a.anchor.every((value, index) => value === b.anchor[index]) &&
    a.size.every((value, index) => value === b.size[index])
  );
}

export function SlicerPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [searchParams] = useSearchParams();
  const { trackJob } = useSliceJobTracker();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  // Deep-linkable and refresh-proof: the source lives entirely in the URL, so
  // a reload, a bookmark and the browser Back button all behave without any
  // page-held navigation state.
  const fileParam = searchParams.get('file');
  const archiveParam = searchParams.get('archive');
  const source = useMemo<{ kind: SourceKind; id: number } | null>(() => {
    const fileId = Number(fileParam);
    if (fileParam != null && Number.isInteger(fileId) && fileId > 0) {
      return { kind: 'libraryFile', id: fileId };
    }
    const archiveId = Number(archiveParam);
    if (archiveParam != null && Number.isInteger(archiveId) && archiveId > 0) {
      return { kind: 'archive', id: archiveId };
    }
    return null;
  }, [fileParam, archiveParam]);

  const [overrides, setOverrides] = useState<ProcessOverrides>({});
  const [activePlate, setActivePlate] = useState(1);
  const [lastSlice, setLastSlice] = useState<CompletedSlice | null>(null);
  const [pendingJobId, setPendingJobId] = useState<number | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Same query key as SliceModal's, so arriving here from the modal (or going
  // back to it) reuses the cached plate metadata instead of re-parsing the 3MF.
  const platesQuery = useQuery({
    queryKey: ['slicePlates', source?.kind, source?.id],
    queryFn: async () => {
      if (!source) throw new Error('no source');
      return source.kind === 'libraryFile'
        ? api.getLibraryFilePlates(source.id)
        : api.getArchivePlates(source.id);
    },
    enabled: source != null,
    staleTime: 60_000,
  });

  const filename = platesQuery.data?.filename ?? '';
  const platesMeta = useMemo(() => platesQuery.data?.plates ?? [], [platesQuery.data]);
  const isMultiPlate = !!platesQuery.data?.is_multi_plate && platesMeta.length > 1;

  // Has this file been sliced before? (#31, step-6.2.) `slice_count` is a
  // server-derived COUNT of non-trashed sliced children — the only thing on
  // this page that reads it is which step the phone wizard opens on. Library
  // files only: an archive has no such field, and so always starts at step 1.
  const sourceFileQuery = useQuery({
    queryKey: ['libraryFile', source?.id],
    queryFn: async () => api.getLibraryFile(source!.id),
    enabled: source?.kind === 'libraryFile',
    staleTime: 60_000,
  });

  // Saved arrangement (spec §4). Library files only — archives carry the same
  // column but expose no endpoint yet. Absent / null / wrong-version leaves
  // every object as designed, which `buildStagePlates` handles.
  const layoutQuery = useQuery({
    queryKey: ['libraryFileLayout', source?.id],
    queryFn: async () => api.getLibraryFileLayout(source!.id),
    enabled: source?.kind === 'libraryFile',
    staleTime: 60_000,
  });

  // What the gizmos have moved since the page loaded (#25). Held here, not in
  // `PlateStage`, because it has to reach `selection.plates` — that is what
  // makes a placement change invalidate a completed slice and disable Print
  // now. See the module header in `sliceSelection.ts`.
  const [transformEdits, setTransformEdits] = useState<PlateTransformEdits>({});
  // Whether those edits are still unwritten. A separate flag rather than
  // "are there any edits", because a successful save deliberately *keeps* the
  // edits: they are then identical to the saved baseline, and dropping them
  // would re-derive every transform through `anchor + delta - anchor` and move
  // the fingerprint by a rounding step, staling a slice that is still valid.
  const [layoutDirty, setLayoutDirty] = useState(false);
  // Per-object anchors, measured off the parsed 3MF. **Accumulated, not
  // replaced:** the viewport only measures the plate it is rendering, and a
  // plate switch would otherwise drop the anchors for every plate the user has
  // already visited — taking their saved arrangement with it.
  const [objectMetrics, setObjectMetrics] = useState<Record<string, ObjectMetrics>>({});

  // A different file is a different arrangement. Dropping the edits on the
  // source change rather than merging them stops one file's moves reappearing
  // on the next, which would be invisible until it was sliced. The anchors go
  // with them — another file's anchors would place this one's objects wrongly.
  useEffect(() => {
    setTransformEdits({});
    setObjectMetrics({});
    setLayoutDirty(false);
  }, [source?.kind, source?.id]);

  const storedLayout = layoutQuery.data?.layout ?? null;

  const basePlates = useMemo(
    () => buildStagePlates(platesMeta, storedLayout, objectMetrics),
    [platesMeta, storedLayout, objectMetrics],
  );
  const stagePlates = useMemo(
    () => applyTransformEdits(basePlates, transformEdits),
    [basePlates, transformEdits],
  );

  const handleTransformChange = useCallback(
    (plateIndex: number, objectId: string, transform: ObjectTransform) => {
      setTransformEdits((current) =>
        withTransformEdit(current, plateIndex, objectId, transform),
      );
      setLayoutDirty(true);
    },
    [],
  );

  const handleObjectMetrics = useCallback((next: Record<string, ObjectMetrics>) => {
    setObjectMetrics((current) => {
      let changed = false;
      const merged = { ...current };
      for (const [objectId, metrics] of Object.entries(next)) {
        if (sameMetrics(current[objectId], metrics)) continue;
        merged[objectId] = metrics;
        changed = true;
      }
      // Returning the same object when nothing is new keeps this off the
      // render → re-measure → render treadmill.
      return changed ? merged : current;
    });
  }, []);

  // Only library files have a layout endpoint. Handing the stage no
  // `onTransformChange` for an archive makes it read-only, which is the honest
  // state: a gizmo whose result can be neither saved nor sliced moves the
  // model on screen and changes nothing about the print.
  const layoutEditable = source?.kind === 'libraryFile';

  // What a save would write. Merged over what is stored, so plates the
  // viewport has never rendered keep their arrangement — see `toPlateLayout`.
  const pendingLayout = useCallback(
    () => toPlateLayout(stagePlates, objectMetrics, storedLayout),
    [stagePlates, objectMetrics, storedLayout],
  );

  const layoutMutation = useMutation({
    mutationFn: async (layout: PlateLayout | null) => {
      if (source?.kind !== 'libraryFile') throw new Error('layout: source has no layout endpoint');
      return api.updateLibraryFileLayout(source.id, layout);
    },
    onSuccess: (response) => {
      // Seed the cache from the response rather than refetching: the stage
      // reads `storedLayout` on the very next render, and a round trip would
      // show the pre-save arrangement in between.
      queryClient.setQueryData(['libraryFileLayout', source?.id], response);
      setLayoutDirty(false);
    },
    onError: (err: unknown) => {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    },
  });

  const handleSaveLayout = useCallback(() => {
    setErrorMessage(null);
    layoutMutation.mutate(pendingLayout(), {
      onSuccess: () => showToast(t('slicer.layoutSaved'), 'success'),
    });
  }, [layoutMutation, pendingLayout, showToast, t]);

  const handleResetLayout = useCallback(() => {
    setErrorMessage(null);
    // `null` clears the stored column; dropping the pending edits with it is
    // what puts the objects back as designed on screen.
    layoutMutation.mutate(null, {
      onSuccess: () => {
        setTransformEdits({});
        showToast(t('slicer.layoutReset'), 'success');
      },
    });
  }, [layoutMutation, showToast, t]);

  // `plate` mirrors SliceModal exactly: omitted for single-plate 3MFs, STLs and
  // anything whose metadata failed to load, so the backend's own default takes
  // over. Sending an explicit `1` there would be a *different* request.
  const platePayload = isMultiPlate ? activePlate : null;
  const effectivePlateId = isMultiPlate ? activePlate : 1;

  const filamentReqsQuery = useQuery({
    queryKey: ['sliceFilamentReqs', source?.kind, source?.id, effectivePlateId],
    queryFn: async () => {
      if (!source) throw new Error('no source');
      return source.kind === 'libraryFile'
        ? api.getLibraryFileFilamentRequirements(source.id, effectivePlateId)
        : api.getArchiveFilamentRequirements(source.id, effectivePlateId);
    },
    enabled: source != null && !platesQuery.isLoading,
    staleTime: 60_000,
  });

  // **Owned, not derived** (#45, rail.2). The slot list used to be
  // `filamentReqsQuery`'s answer read straight through; making it add/removable
  // means the page holds it and the plate only *seeds* it. `null` is "not
  // seeded yet", which is distinct from "the user deleted everything" — the
  // former re-seeds when the requirements arrive, the latter must not.
  const [filamentSlots, setFilamentSlots] = useState<FilamentSlotState[] | null>(null);
  const filamentReqs = filamentReqsQuery.data?.filaments;

  // Re-seed on a new source or a new plate: a different plate has different
  // requirements, and carrying the previous plate's edited slot list across
  // would map one plate's materials onto another's geometry. Keyed on the same
  // things `filamentReqsQuery` is keyed on, so the seed and its source cannot
  // disagree.
  useEffect(() => {
    setFilamentSlots(null);
  }, [source?.kind, source?.id, effectivePlateId]);

  useEffect(() => {
    if (filamentReqs === undefined) return;
    setFilamentSlots((current) => (current === null ? seedSlots(filamentReqs) : current));
  }, [filamentReqs]);

  // A stable empty-ish list for the window between mount and the first seed, so
  // the rail and `useSlicePresets` never see `null`. Seeded from nothing gives
  // the one synthetic slot STL / "no metadata" sources have always shown.
  const seededSlots = useMemo<FilamentSlotState[]>(
    () => filamentSlots ?? seedSlots(undefined),
    [filamentSlots],
  );

  // What the preset pre-pick scores against. Narrowed to (type, colour) on
  // purpose — the hook's contract is `SliceFilamentSlot`, shared with
  // `SliceModal`, and it must not learn about slot editing.
  const presetSlots = useMemo(
    () => seededSlots.map((slot) => ({ type: slot.type, color: slot.color })),
    [seededSlots],
  );

  const {
    presets,
    isLoading: presetsLoading,
    isError: presetsError,
    isRefreshing,
    refreshPresets,
    printerPreset,
    setPrinterPreset,
    processPreset,
    setProcessPreset,
    filamentPresets,
    setFilamentPresetAt,
    insertFilamentPresetAt,
    removeFilamentPresetAt,
    bedType,
    setBedType,
    useEmbedded,
    setUseEmbedded,
    canUseEmbedded,
    selectedPrinterName,
    compatIndex,
  } = useSlicePresets({
    filamentSlots: presetSlots,
    embeddedPrinter: platesQuery.data?.embedded_printer ?? null,
    embeddedProcess: platesQuery.data?.embedded_process ?? null,
    enabled: source != null && !platesQuery.isLoading,
  });

  // **Slot edits move both lists at once.** The slot list lives here and the
  // per-slot profile list lives in `useSlicePresets`, and `filament_presets` is
  // positional: splicing one without the other slides every later slot's
  // profile onto its neighbour, which slices cleanly and prints the wrong
  // material. Both setters run in the same handler, so React batches them and
  // the hook's pre-pick effect sees a matched pair.
  //
  // Each edit is refused when it would move a slot the plate paints with; the
  // rule and the reasoning are in `filamentSlots.ts`, and the rail renders the
  // refusal as a disabled control rather than hiding it. Re-checked here rather
  // than trusting the UI's own gating — a disabled button is a hint, not a
  // guarantee.
  const handleInsertSlotAfter = useCallback(
    (index: number) => {
      if (!canInsertAfter(seededSlots, index)) return;
      setFilamentSlots(insertSlotAfter(seededSlots, index));
      insertFilamentPresetAt(index + 1, null);
    },
    [seededSlots, insertFilamentPresetAt],
  );

  const handleAddSlot = useCallback(
    () => handleInsertSlotAfter(seededSlots.length - 1),
    [handleInsertSlotAfter, seededSlots.length],
  );

  const handleRemoveSlot = useCallback(
    (index: number) => {
      if (!canRemoveSlotAt(seededSlots, index)) return;
      setFilamentSlots(removeSlotAt(seededSlots, index));
      removeFilamentPresetAt(index);
    },
    [seededSlots, removeFilamentPresetAt],
  );

  const handleFilamentSlotColorChange = useCallback((index: number, color: string | null) => {
    setFilamentSlots((current) => (current ? setSlotColorAt(current, index, color) : current));
  }, []);

  // Curated field metadata, filtered server-side to the keys the configured
  // slicer actually has. That filtering depends on the sidecar exposing
  // `GET /schema`; against an image without it the backend falls back to the
  // curated file's whole key list, and the rail will offer settings the slicer
  // does not have — the slice then 422s rather than silently ignoring them.
  const processFieldsQuery = useQuery({
    queryKey: ['slicerProcessFields'],
    queryFn: () => api.getProcessFields(),
    staleTime: 5 * 60_000,
  });

  // The preset's *real* current values, so an untouched control shows what the
  // print will do. Re-fetched per process preset — which is exactly why the
  // override diff has to be re-sanitised below when it changes.
  const resolvedProcessQuery = useQuery({
    queryKey: ['slicerResolvedProcess', processPreset?.source, processPreset?.id],
    queryFn: () => api.getResolvedProcess(processPreset as PresetRef),
    enabled: processPreset != null,
    staleTime: 60_000,
  });

  const processFields = useMemo(
    () => processFieldsQuery.data?.fields ?? [],
    [processFieldsQuery.data],
  );
  const resolvedProcess = resolvedProcessQuery.data ?? null;

  // Changing the process preset moves the resolved defaults under a diff the
  // user already typed, which can turn a real override into a no-op one. The
  // editor never *emits* a no-op, but it will happily render one it is handed,
  // and a no-op override would invalidate Print now for no reason at all. So
  // the diff is re-sanitised whenever the defaults move.
  useEffect(() => {
    if (processFields.length === 0) return;
    const defaults = resolveDefaults(processFields, resolvedProcess);
    setOverrides((current) => {
      const cleaned = sanitizeOverrides(current, defaults);
      const sameSize = Object.keys(cleaned).length === Object.keys(current).length;
      return sameSize ? current : cleaned;
    });
  }, [processFields, resolvedProcess]);

  // The single object both the request and the Print-now gate are derived from.
  const filamentColors = useMemo(() => slotColorPayload(seededSlots), [seededSlots]);

  const selection = useMemo<SliceSelection>(
    () => ({
      printerPreset,
      processPreset,
      filamentPresets,
      filamentColors,
      bedType,
      // Mirrors SliceModal: the flag is meaningless without the gate.
      useEmbedded: useEmbedded && canUseEmbedded,
      plate: platePayload,
      processOverrides: overrides,
      plates: stagePlates,
    }),
    [
      printerPreset,
      processPreset,
      filamentPresets,
      filamentColors,
      bedType,
      useEmbedded,
      canUseEmbedded,
      platePayload,
      overrides,
      stagePlates,
    ],
  );
  const fingerprint = selectionFingerprint(selection);

  const sliceMutation = useMutation({
    mutationFn: async () => {
      const body = buildSliceBody(selection);
      if (!source) throw new Error('no source');
      // **The arrangement reaches the slicer only through the stored column.**
      // `SliceRequest` carries no layout; the backend applies
      // `LibraryFile.plate_layout` to the model bytes. Slicing with an unsaved
      // move would therefore slice the *previous* arrangement while the
      // viewport showed the new one — the exact silent mismatch this epic is
      // about. A failed write aborts the slice rather than quietly slicing
      // something else.
      if (source.kind === 'libraryFile' && layoutDirty) {
        await layoutMutation.mutateAsync(pendingLayout());
      }
      return source.kind === 'libraryFile'
        ? api.sliceLibraryFile(source.id, body)
        : api.sliceArchive(source.id, body);
    },
    onSuccess: (enqueued) => {
      // The existing tracker still owns the toasts, the progress ticker and
      // the failure modal; the page polls alongside it purely to learn *what
      // the slice produced*, which the tracker does not expose.
      trackJob(enqueued.job_id, source!.kind, filename || String(source!.id));
      setPendingJobId(enqueued.job_id);
    },
    onError: (err: unknown) => {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    },
  });

  // The fingerprint as it was when this job was dispatched. Captured at
  // dispatch, not at completion: the user is free to keep fiddling while the
  // slice runs, and the result describes the selection it *started* with.
  const [pendingFingerprint, setPendingFingerprint] = useState<string | null>(null);

  const jobQuery = useQuery({
    queryKey: ['sliceJob', pendingJobId],
    queryFn: () => api.getSliceJob(pendingJobId as number),
    enabled: pendingJobId != null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed' ? false : 1500;
    },
  });

  const jobState = jobQuery.data;
  useEffect(() => {
    if (!jobState || pendingJobId == null) return;
    if (jobState.status === 'failed') {
      // The tracker already raises the failure modal with the slicer's reason.
      setPendingJobId(null);
      setPendingFingerprint(null);
      return;
    }
    if (jobState.status !== 'completed') return;

    const result = jobState.result;
    setPendingJobId(null);
    if (result && pendingFingerprint != null) {
      const target =
        'library_file_id' in result
          ? ({ kind: 'libraryFile', id: (result as SliceResponse).library_file_id, name: result.name } as const)
          : ({ kind: 'archive', id: (result as SliceArchiveResponse).archive_id, name: result.name } as const);
      setLastSlice({
        fingerprint: pendingFingerprint,
        printTimeSeconds: result.print_time_seconds ?? null,
        filamentGrams: result.filament_used_g ?? null,
        target,
      });
    }
    setPendingFingerprint(null);
  }, [jobState, pendingJobId, pendingFingerprint]);

  const handleSlice = useCallback(() => {
    setErrorMessage(null);
    setPendingFingerprint(fingerprint);
    sliceMutation.mutate();
  }, [fingerprint, sliceMutation]);

  // **The rule.** Print now is live only while the completed slice still
  // describes what is on screen. Everything that can change the output is in
  // the fingerprint by construction — see `sliceSelection.ts`.
  const canPrintNow = lastSlice != null && lastSlice.fingerprint === fingerprint;

  const isSlicing = sliceMutation.isPending || pendingJobId != null;
  const canSlice =
    source != null && isSelectionComplete(selection) && filamentReqsQuery.isSuccess && !isSlicing;

  // Estimate: the last matching slice's real numbers when we have them, else
  // whatever the source's own plate metadata already knows (a re-sliced file
  // carries its previous print time). Never the two mixed.
  const activePlateMeta = platesMeta.find((plate) => plate.index === effectivePlateId) ?? null;
  const estimate = canPrintNow
    ? { printTimeSeconds: lastSlice.printTimeSeconds, filamentGrams: lastSlice.filamentGrams }
    : activePlateMeta
      ? {
          printTimeSeconds: activePlateMeta.print_time_seconds,
          filamentGrams: activePlateMeta.filament_used_grams,
        }
      : null;

  const contextLabel = [selectedPrinterName, bedType].filter(Boolean).join(' · ') || null;

  // Save is offered while the plate differs from what is stored. Reset is
  // offered while there is anything to go back *from* — pending edits or a
  // layout already on the file — so a file arranged in an earlier session can
  // be put back without touching it first.
  const canSaveLayout = layoutEditable && layoutDirty && !layoutMutation.isPending;
  const canResetLayout =
    layoutEditable && (layoutDirty || storedLayout != null) && !layoutMutation.isPending;
  const saveLayoutHint = !layoutEditable
    ? t('slicer.layoutArchiveUnsupported')
    : canSaveLayout
      ? t('slicer.saveLayoutTitle')
      : t('slicer.saveLayoutClean');
  const resetLayoutHint = !layoutEditable
    ? t('slicer.layoutArchiveUnsupported')
    : canResetLayout
      ? t('slicer.resetLayoutTitle')
      : t('slicer.resetLayoutClean');

  const handleBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate(source?.kind === 'archive' ? '/archives' : '/files');
  }, [navigate, source]);

  const modelUrl =
    source == null
      ? ''
      : source.kind === 'libraryFile'
        ? api.getLibraryFileDownloadUrl(source.id)
        : api.getArchiveDownload(source.id);

  // The phone's persistent model strip. Per-plate where the source has plates,
  // so the picture follows the plate tabs rather than always showing plate 1.
  const thumbnailUrl =
    source == null
      ? null
      : source.kind === 'archive'
        ? api.getArchiveThumbnail(source.id)
        : isMultiPlate
          ? api.getLibraryFilePlateThumbnail(source.id, effectivePlateId)
          : api.getLibraryFileThumbnailUrl(source.id);

  if (source == null) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-bambu-gray">
        <FileQuestion className="h-8 w-8" />
        <p className="text-sm">{t('slicer.noSource')}</p>
        <button
          type="button"
          onClick={() => navigate('/files')}
          className="rounded-md border border-bambu-dark-tertiary px-3 py-1.5 text-sm text-bambu-gray transition-colors hover:border-bambu-gray hover:text-white"
        >
          {t('slicer.backToFiles')}
        </button>
      </div>
    );
  }

  // Built once and handed to whichever layout is showing, so the phone and the
  // desktop are literally rendering the same values — not two lists that have
  // to be kept in step by hand.
  const railProps = {
    presets,
    presetsLoading: presetsLoading || platesQuery.isLoading,
    presetsError,
    isRefreshing,
    onRefreshPresets: refreshPresets,
    printerPreset,
    onPrinterPresetChange: setPrinterPreset,
    processPreset,
    onProcessPresetChange: setProcessPreset,
    filamentPresets,
    onFilamentPresetChange: setFilamentPresetAt,
    filamentSlots: seededSlots,
    filamentSlotsLoading: filamentReqsQuery.isLoading,
    onAddFilamentSlot: handleAddSlot,
    onInsertFilamentSlotAfter: handleInsertSlotAfter,
    onRemoveFilamentSlot: handleRemoveSlot,
    onFilamentSlotColorChange: handleFilamentSlotColorChange,
    bedType,
    onBedTypeChange: setBedType,
    useEmbedded,
    onUseEmbeddedChange: setUseEmbedded,
    canUseEmbedded,
    selectedPrinterName,
    compatIndex,
    processFields,
    resolvedProcess,
    processFieldsLoading: processFieldsQuery.isLoading,
    processFieldsError: processFieldsQuery.isError ? t('slicer.processFieldsFailed') : null,
    overrides,
    onOverridesChange: setOverrides,
    disabled: isSlicing,
  };

  const stageProps = {
    url: modelUrl,
    fileType: platesMeta.length > 0 ? ('3mf' as const) : undefined,
    plates: stagePlates,
    initialPlate: activePlate,
    onActivePlateChange: setActivePlate,
    // Archives get no handler, which is what makes the stage read-only —
    // the same rule on both layouts, decided in exactly one place.
    onTransformChange: layoutEditable ? handleTransformChange : undefined,
    onObjectMetricsChange: handleObjectMetrics,
  };

  const actionBarProps = {
    estimate,
    contextLabel,
    onSlice: handleSlice,
    canSlice,
    isSlicing,
    onPrintNow: () => setPrintOpen(true),
    canPrintNow,
    hasCompletedSlice: lastSlice != null,
    onSaveLayout: handleSaveLayout,
    canSaveLayout,
    saveLayoutHint,
    onResetLayout: handleResetLayout,
    canResetLayout,
    resetLayoutHint,
    isSavingLayout: layoutMutation.isPending,
  };

  // Print now hands the *produced* file to the existing PrintModal — the
  // slice's output, not the source that was sliced.
  const printModal =
    printOpen && lastSlice && canPrintNow ? (
      <PrintModal
        mode="create"
        archiveName={lastSlice.target.name}
        {...(lastSlice.target.kind === 'libraryFile'
          ? { libraryFileId: lastSlice.target.id }
          : { archiveId: lastSlice.target.id })}
        onClose={() => setPrintOpen(false)}
        onSuccess={() => {
          setPrintOpen(false);
          showToast(t('slicer.printQueued'), 'success');
        }}
      />
    ) : null;

  // The only fork. Everything above ran for both.
  if (isMobile) {
    // **Review-first is decided before the wizard exists, not after** (#31,
    // step-6.2). `initialStep` is read once, in a `useState` initialiser, on
    // purpose: an effect that moved the step later would move it out from under
    // a user who had already tapped Next. So the answer has to be in hand at
    // mount, and the page holds the wizard back for the one render or two that
    // `slice_count` takes to arrive. The alternative — mount at step 1 and
    // remount on a changing `key` — reaches Review too, but by throwing away
    // whatever the user did in between, which is the same bug wearing a hat.
    //
    // An errored query settles as "never sliced": `isPending` goes false, and
    // starting at step 1 is the honest fallback when the count is unknown. A
    // disabled query (archive) stays pending forever, hence the kind check
    // first — archives have no `slice_count` and never wait for one.
    const sliceCountSettled = source.kind !== 'libraryFile' || !sourceFileQuery.isPending;
    if (!sliceCountSettled) {
      return (
        <div
          data-testid="wizard-loading"
          className="flex min-h-[calc(100vh-64px)] items-center justify-center gap-2 p-8 text-sm text-bambu-gray"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.loading')}
        </div>
      );
    }
    return (
      <>
        <MobileSliceWizard
          filename={filename}
          onBack={handleBack}
          errorMessage={errorMessage}
          rail={railProps}
          stage={stageProps}
          actions={actionBarProps}
          thumbnailUrl={thumbnailUrl}
          // Never a gate on Print now — `actionBarProps.canPrintNow` is
          // untouched by this. A file having been sliced before says nothing
          // about whether that output matches what is on screen now.
          initialStep={initialStepForSource(sourceFileQuery.data?.slice_count)}
        />
        {printModal}
      </>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-64px)] flex-col gap-3 p-4 lg:h-[calc(100vh-64px)]">
      <header className="flex flex-shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex items-center gap-1.5 text-sm text-bambu-gray transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('slicer.back')}
        </button>
        <h1 className="min-w-0 truncate text-sm font-medium text-white" title={filename}>
          {filename || t('slicer.title')}
        </h1>
      </header>

      {errorMessage && (
        <div
          role="alert"
          className="flex-shrink-0 rounded border border-red-900/40 bg-red-900/20 p-2 text-sm text-red-700 dark:text-red-400"
        >
          {errorMessage}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        {/* `collapsible` is set here and not in `railProps` on purpose (#46):
            the phone already gives each of these groups its own step, so a
            chevron there would be a second, contradictory way to hide the
            step the user is standing on. `MobileSliceWizardProps` omits the
            prop so it cannot arrive by the other route either. */}
        <SlicerRail {...railProps} collapsible className="w-full lg:w-80 lg:flex-shrink-0" />

        <PlateStage
          {...stageProps}
          className="min-h-[24rem] flex-1 overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary lg:min-h-0"
          actionBar={<SliceActionBar {...actionBarProps} />}
        />
      </div>

      {printModal}
    </div>
  );
}
