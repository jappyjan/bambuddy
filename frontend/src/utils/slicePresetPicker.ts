// Pure-function helpers for the SliceModal's per-slot preset selection.
//
// Extracted out of `SliceModal.tsx` so they can be unit-tested directly and
// so the modal component file only exports React components (the
// `react-refresh/only-export-components` lint rule requires this for HMR to
// work correctly — exporting a non-component from a component file breaks
// fast-refresh).
//
// Selection rules:
// - Tier order is local → orca_cloud → cloud → standard. Local imports
//   outrank everything else because the user explicitly imported them
//   for this install; standard (bundled) is the final fallback.
// - The backend does NOT dedup tiers, so each helper walks all four
//   and the caller relies on the order, not a single merged list.
// - `pickProcessDefault` honours a 3MF's embedded process preset when
//   it exists and isn't printer-incompatible; otherwise prefers a
//   match-on-printer pick, then unknown-compat, then plain priority.
// - `pickFilamentForSlot` partitions candidates into compatible/unknown
//   vs mismatch buckets and only consults the mismatch bucket when
//   the compatible bucket is empty (#1851).

import type {
  PresetRef,
  PresetSource,
  UnifiedPreset,
  UnifiedPresetsResponse,
} from '../api/client';
import { colorsAreSimilar, normalizeColorForCompare } from './amsHelpers';
import {
  presetCompatibility,
  type PrinterCompatibilityIndex,
} from './slicerPrinterMatch';

export type Slot = 'printer' | 'process' | 'filament';

export const SLICE_MODAL_TIER_ORDER = ['local', 'orca_cloud', 'cloud', 'standard'] as const;

const TIER_BONUS: Record<PresetSource, number> = {
  local: 1.75,
  orca_cloud: 1.5,
  cloud: 1.0,
  standard: 0.5,
};

export function pickDefault(by: UnifiedPresetsResponse, slot: Slot): PresetRef | null {
  for (const tier of SLICE_MODAL_TIER_ORDER) {
    const list = by[tier][slot];
    if (list.length > 0) {
      return { source: list[0].source, id: list[0].id };
    }
  }
  return null;
}

// Resolve a PresetRef back to its UnifiedPreset within the named slot, or
// null if it no longer resolves (e.g. the preset was deleted between the
// listing fetch and selection).
export function findPreset(
  by: UnifiedPresetsResponse,
  ref: PresetRef | null,
  slot: Slot,
): UnifiedPreset | null {
  if (!ref) return null;
  return by[ref.source][slot].find((p) => p.id === ref.id) ?? null;
}

// Find a preset by exact name across tiers (local → cloud → standard). Used
// to honour the printer / process preset names a 3MF was prepared with.
export function findPresetByName(
  by: UnifiedPresetsResponse,
  slot: Slot,
  name: string | null | undefined,
): PresetRef | null {
  if (!name) return null;
  for (const tier of SLICE_MODAL_TIER_ORDER) {
    const p = by[tier][slot].find((x) => x.name === name);
    if (p) return { source: p.source, id: p.id };
  }
  return null;
}

// Process default: honour the process preset the 3MF was prepared with
// (preferredName) when it's available and not incompatible with the selected
// printer; otherwise the first preset compatible with the printer in tier
// order, then the first whose compatibility is merely unknown, then plain
// priority. Keeps the pre-pick honest with both the embedded config and the
// printer filter instead of blindly taking list[0] (#1325).
export function pickProcessDefault(
  by: UnifiedPresetsResponse,
  printerName: string | null,
  compatIndex: PrinterCompatibilityIndex,
  preferredName?: string | null,
): PresetRef | null {
  const preferred = findPresetByName(by, 'process', preferredName);
  if (preferred) {
    const p = findPreset(by, preferred, 'process');
    if (p && presetCompatibility(p, 'process', printerName, compatIndex) !== 'mismatch') {
      return preferred;
    }
  }
  for (const wanted of ['match', 'unknown'] as const) {
    for (const tier of SLICE_MODAL_TIER_ORDER) {
      for (const p of by[tier].process) {
        if (presetCompatibility(p, 'process', printerName, compatIndex) === wanted) {
          return { source: p.source, id: p.id };
        }
      }
    }
  }
  return pickDefault(by, 'process');
}

export function pickFilamentForSlot(
  by: UnifiedPresetsResponse,
  required: { type: string; color: string },
  printerName: string | null,
  compatIndex: PrinterCompatibilityIndex,
): PresetRef | null {
  // Score every filament preset against the plate slot's required (type,
  // colour) and pick the highest. Mirrors the AMS slot-mapping match in the
  // print/schedule modal: type match dominates, exact-colour-match bumps over
  // similar-colour-match, and a small per-tier bonus breaks ties so cloud
  // user customisations win over standard bundled fallbacks of equal merit.
  //
  // Compatibility is a hard partition, not a soft penalty (#1851). The legacy
  // -100 demote let a printer-mismatched preset still win when the plate's
  // (type, colour) happened to match it better than the colour-default
  // standard preset on the right printer — e.g. an unused slot whose embedded
  // colour matched `Generic PLA @BBL H2C` but not the off-the-shelf
  // `Bambu PLA Basic @BBL A1`. The propagated slot-1 then poisoned every
  // unused slot via `substitute_unused_plate_filaments`, and the CLI rejected
  // the slice with "filament preset Generic PLA @BBL H2C (slot 1) is not
  // compatible with printer Bambu Lab A1 0.4 nozzle". Hard-skipping mismatches
  // while we still have any compatible/unknown candidate eliminates that
  // poisoning at the source; the mismatch tier is only consulted when no
  // printer-correct alternative exists, which preserves the graceful-degrade
  // behaviour for presets registries that genuinely have nothing for the
  // selected printer.
  const reqType = required.type.trim().toUpperCase();
  const reqColor = normalizeColorForCompare(required.color);

  let bestCompatible: { ref: PresetRef; score: number } | null = null;
  let bestMismatch: { ref: PresetRef; score: number } | null = null;
  for (const tier of SLICE_MODAL_TIER_ORDER) {
    for (const p of by[tier].filament) {
      let score = 0;
      const presetType = (p.filament_type ?? '').trim().toUpperCase();
      const presetColor = normalizeColorForCompare(p.filament_colour ?? '');
      if (reqType && presetType && reqType === presetType) score += 10;
      if (reqColor && presetColor) {
        if (presetColor === reqColor) score += 5;
        else if (colorsAreSimilar(p.filament_colour ?? '', required.color)) score += 2;
      }
      score += TIER_BONUS[tier];
      const ref = { source: p.source, id: p.id };
      if (presetCompatibility(p, 'filament', printerName, compatIndex) === 'mismatch') {
        if (bestMismatch == null || score > bestMismatch.score) {
          bestMismatch = { ref, score };
        }
      } else if (bestCompatible == null || score > bestCompatible.score) {
        bestCompatible = { ref, score };
      }
    }
  }
  if (bestCompatible != null) return bestCompatible.ref;
  if (bestMismatch != null) return bestMismatch.ref;
  // Final fallback when there are no filament presets at all (empty
  // registry) — pickDefault returns null in that case too, but keeping the
  // call mirrors the rest of the picker logic for shape consistency.
  return pickDefault(by, 'filament');
}

/**
 * What the honesty guard (#47) has to say about one slot's material.
 *
 * - `mismatch` — the picked profile states a `filament_type` and it is **not**
 *   the one the plate asks for. This is the reported defect exactly: a plate
 *   declaring ABS with `Custom Generic TPU` in every dropdown.
 * - `unavailable` — the picked profile states no type, and of the profiles
 *   that *do* state one, none is the required material. We cannot confirm the
 *   slot, and the metadata we have says a correct profile is not there.
 */
export interface FilamentTypeWarning {
  kind: 'mismatch' | 'unavailable';
  /** The material the plate asks for, as the plate spells it. */
  required: string;
  /** Name of the profile currently selected, or null when nothing is picked. */
  selectedName: string | null;
  /** The selected profile's own declared type, when it has one. */
  selectedType: string | null;
}

/**
 * Decide whether a filament slot's material can be trusted (#47).
 *
 * ## Why this exists
 *
 * `pickFilamentForSlot` awards its dominant `+10` only when the slot's required
 * type and the candidate's `filament_type` are *both* present. The Standard
 * (slicer-bundled) tier ships no `filament_type` at all, so on a library made
 * of bundled profiles plus a handful of imports the type term never fires and
 * the pick degrades to "tier bonus, then whatever is listed first". The result
 * is a confident-looking selection of an unrelated material, and a slice that
 * succeeds and prints badly.
 *
 * Fixing the metadata (the sidecar's `/profiles/bundled`) is the real repair.
 * This function is the guard that has to hold either way: **a visible unknown
 * beats a silent wrong material.**
 *
 * ## When it fires — and, more importantly, when it does not
 *
 * The one thing that would make this worse than the bug is firing on every slot
 * for every user. So it distinguishes *"no ABS profile exists"* from *"we
 * cannot tell"*:
 *
 * - **No slot requirement** (`type` empty — an STL, or a slot the user added
 *   themselves) → silent. There is nothing to be wrong about.
 * - **No filament profile anywhere carries a `filament_type`** → silent. That
 *   is the un-enriched Standard tier on its own: we have no evidence about any
 *   material, so we have no basis to claim the pick is wrong, and the user has
 *   no better information to act on either. Nagging here would be noise on a
 *   stock install.
 * - **The picked profile declares a type** → the answer is simply whether it
 *   equals the required one. A user who deliberately picked PLA for an ABS slot
 *   gets told, which is the point.
 * - **The picked profile declares nothing, but other profiles do** → we report
 *   `unavailable` only when *none* of the typed profiles is the required
 *   material. If a typed profile of the right material does exist, the pick was
 *   either a deliberate override or a printer-compatibility fallback, and
 *   second-guessing it would be a guess of our own.
 */
export function filamentTypeWarningForSlot(
  by: UnifiedPresetsResponse | undefined,
  requiredType: string,
  selected: PresetRef | null,
): FilamentTypeWarning | null {
  const required = (requiredType ?? '').trim();
  const reqType = required.toUpperCase();
  if (!reqType || !by) return null;

  let anyTyped = false;
  let anyTypedMatch = false;
  for (const tier of SLICE_MODAL_TIER_ORDER) {
    for (const p of by[tier].filament) {
      const presetType = (p.filament_type ?? '').trim().toUpperCase();
      if (!presetType) continue;
      anyTyped = true;
      if (presetType === reqType) {
        anyTypedMatch = true;
        break;
      }
    }
    if (anyTypedMatch) break;
  }
  // "We cannot tell" — no profile in the whole library states a material.
  if (!anyTyped) return null;

  const picked = findPreset(by, selected, 'filament');
  const selectedType = (picked?.filament_type ?? '').trim();
  const base = {
    required,
    selectedName: picked?.name ?? null,
    selectedType: selectedType || null,
  };
  if (selectedType) {
    return selectedType.toUpperCase() === reqType ? null : { kind: 'mismatch', ...base };
  }
  return anyTypedMatch ? null : { kind: 'unavailable', ...base };
}
