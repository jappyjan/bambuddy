/**
 * Printer presets, split into the axes Bambu Studio's Printer panel offers
 * (#44): a **printer model** and a **nozzle diameter**.
 *
 * ## There is no third axis, and that is a finding rather than an omission
 *
 * Bambu Studio's Nozzle group has two controls, Diameter and Flow. Only
 * Diameter exists in the data Bambuddy has:
 *
 * - A printer preset arrives as `{ id, name, source }` (`UnifiedPreset` —
 *   `backend/app/schemas/slicer_presets.py`). There is no nozzle field of any
 *   kind on it, so **the name is the only carrier of nozzle information**, and
 *   every Bambu printer-preset name in the wild spells exactly one nozzle
 *   fact: `Bambu Lab <model> <size> nozzle`.
 * - Flow ("Standard" / "High Flow") is real elsewhere in this codebase — a
 *   3MF's `extruder_nozzle_stats` records it per extruder
 *   (`backend/app/utils/threemf_tools.py`), and the K-profile views classify
 *   physical nozzle IDs `HH*` as high-flow. Neither is preset data: neither
 *   reaches `GET /slicer/presets`, and `SliceRequest` has no field that would
 *   carry a flow choice to the slicer.
 *
 * So a Flow control could not resolve to a preset and could not change a
 * slice. It is deliberately not modelled here. Adding it needs the preset
 * payload to carry the printer profile's `nozzle_volume_type` first — a
 * backend change, and a separate ticket.
 *
 * ## How a name is split
 *
 * The trailing "<size> nozzle" segment is the diameter; everything before it
 * is the model label, kept verbatim. Verbatim matters: a user-saved
 * "Bambu Lab H2D 0.4 nozzle (Custom)" keeps its "(Custom)" tag and so stays a
 * *distinct* model entry from the stock "Bambu Lab H2D 0.4 nozzle". Collapsing
 * the two would make one of them unreachable from these controls, which is the
 * regression this split is most likely to introduce — the flat dropdown it
 * replaces could offer both.
 *
 * A name with no nozzle segment (an imported non-Bambu preset, say
 * "Prusa MK4 profile") becomes a model with a `null` diameter. It is still
 * selectable; it simply has nothing to put on the diameter axis.
 *
 * ## Resolution never substitutes
 *
 * `resolvePrinterPreset` returns `null` for a (model, diameter) pair no preset
 * carries. Callers must say so. Falling back to "some preset for that model"
 * is how a user slices for a 0.4 nozzle with 0.8 selected on screen.
 */

import type { PresetRef, UnifiedPresetsResponse } from '../api/client';
import { splitNozzleSuffix } from './slicerPrinterMatch';
import { SLICE_MODAL_TIER_ORDER } from './slicePresetPicker';

/** One printer preset, with its name split into the two axes. */
export interface PrinterPresetAxisEntry {
  ref: PresetRef;
  /** The preset name, unmodified. */
  name: string;
  /** Display label for the model axis — the name minus the nozzle segment. */
  model: string;
  /** Case/whitespace-normalised `model`, for matching. */
  modelKey: string;
  /** Nozzle size as written in the name ("0.4"), or null when it carries none. */
  diameter: string | null;
  /** Numerically normalised `diameter` ("0.40" → "0.4"), or null. */
  diameterKey: string | null;
}

export interface PrinterAxes {
  /**
   * Every printer preset across every tier, in tier order
   * (local → orca_cloud → cloud → standard). Order is load-bearing:
   * `resolvePrinterPreset` takes the first entry that matches, which is how a
   * user's own import outranks a bundled copy of the same name.
   */
  entries: PrinterPresetAxisEntry[];
  /** Distinct models, first-seen order, deduped on `modelKey`. */
  models: { key: string; label: string }[];
}

export const EMPTY_PRINTER_AXES: PrinterAxes = { entries: [], models: [] };

function normalizeModelKey(model: string): string {
  return model.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Normalise a nozzle size for comparison, so "0.40" and "0.4" are one
 * diameter. Unparseable text is kept as-is rather than dropped — an odd size
 * in a preset name should still be selectable, just not merged with anything.
 */
export function normalizeDiameterKey(diameter: string | null): string | null {
  if (diameter == null) return null;
  const n = Number.parseFloat(diameter);
  if (Number.isNaN(n)) return diameter.trim() || null;
  return String(n);
}

/** Split a printer-preset name into its model label and nozzle diameter. */
export function splitPrinterPresetName(name: string): { model: string; diameter: string | null } {
  const { stripped, nozzle } = splitNozzleSuffix(name);
  // A name that is *only* a nozzle segment ("0.4 nozzle") leaves nothing to
  // label the model with; keep the whole name as the model in that case so the
  // preset never becomes an unlabelled option.
  if (!stripped) return { model: name.trim(), diameter: null };
  return { model: stripped, diameter: nozzle };
}

/** Build the model / diameter axes from the unified preset listing. */
export function buildPrinterAxes(data: UnifiedPresetsResponse | undefined): PrinterAxes {
  if (!data) return EMPTY_PRINTER_AXES;
  const entries: PrinterPresetAxisEntry[] = [];
  const models: { key: string; label: string }[] = [];
  const seenModels = new Set<string>();
  for (const tier of SLICE_MODAL_TIER_ORDER) {
    for (const preset of data[tier].printer) {
      const { model, diameter } = splitPrinterPresetName(preset.name);
      const modelKey = normalizeModelKey(model);
      entries.push({
        ref: { source: preset.source, id: preset.id },
        name: preset.name,
        model,
        modelKey,
        diameter,
        diameterKey: normalizeDiameterKey(diameter),
      });
      if (!seenModels.has(modelKey)) {
        seenModels.add(modelKey);
        models.push({ key: modelKey, label: model });
      }
    }
  }
  return { entries, models };
}

/**
 * The nozzle diameters this model actually has presets for, numerically
 * ascending. A model whose presets carry no nozzle segment yields an empty
 * list — there is nothing to offer on that axis, which the caller shows
 * rather than hiding.
 */
export function diametersForModel(axes: PrinterAxes, modelKey: string | null): string[] {
  if (!modelKey) return [];
  const seen = new Map<string, string>();
  for (const entry of axes.entries) {
    if (entry.modelKey !== modelKey || entry.diameterKey == null || entry.diameter == null) continue;
    if (!seen.has(entry.diameterKey)) seen.set(entry.diameterKey, entry.diameter);
  }
  return [...seen.values()].sort((a, b) => {
    const x = Number.parseFloat(a);
    const y = Number.parseFloat(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    return x - y;
  });
}

/**
 * The preset a (model, diameter) pair names, or **null when no preset carries
 * that pair**. Never a near-miss: see the module header.
 *
 * `diameter` of null asks for the model's preset that carries no nozzle
 * segment (the imported-profile case).
 */
export function resolvePrinterPreset(
  axes: PrinterAxes,
  modelKey: string | null,
  diameter: string | null,
): PresetRef | null {
  if (!modelKey) return null;
  const wanted = normalizeDiameterKey(diameter);
  for (const entry of axes.entries) {
    if (entry.modelKey === modelKey && entry.diameterKey === wanted) return entry.ref;
  }
  return null;
}

/**
 * Where a selected preset sits on the two axes, so the controls can show the
 * pre-pick made from the 3MF's embedded printer without the user touching
 * them. Null when the ref no longer resolves (a deleted preset).
 */
export function axesOfPrinterPreset(
  axes: PrinterAxes,
  ref: PresetRef | null,
): { modelKey: string; model: string; diameter: string | null } | null {
  if (!ref) return null;
  const entry = axes.entries.find((e) => e.ref.source === ref.source && e.ref.id === ref.id);
  if (!entry) return null;
  return { modelKey: entry.modelKey, model: entry.model, diameter: entry.diameter };
}
