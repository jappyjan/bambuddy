/**
 * The slicer page's selection → slice request, and the fingerprint that keeps
 * "Print now" honest (#15, step-5.3).
 *
 * ## The one correctness rule in this ticket
 *
 * **Print now may only ever dispatch the slice that is currently on screen.**
 * The moment any input changes — a preset, an override, the plate, an object's
 * transform — the completed slice describes something the user is no longer
 * looking at, and offering to print it would print the wrong thing. Not a
 * cosmetic wrongness: a different process preset is a different layer height,
 * a different filament slot is a different material.
 *
 * The naive implementation is to listen for changes and clear a flag. That is
 * exactly the implementation that rots, because every input added later has to
 * remember to join the list, and forgetting is silent. So instead of tracking
 * *changes*, this module derives a **fingerprint from the request itself**:
 *
 *     selectionFingerprint(s) ≡ canonical(buildSliceBody(s)) + the stage layout
 *
 * Print now is enabled iff the fingerprint recorded at slice time still equals
 * the current one. Anything that alters the body alters the fingerprint by
 * construction — a field added to `buildSliceBody` tomorrow is covered without
 * touching this comment. The only thing that has to be remembered separately is
 * input that changes the *output* without appearing in the *body*, which today
 * is exactly one thing: the plate layout, applied server-side from the stored
 * `plate_layout` column rather than sent inline. Hence the second component.
 *
 * Everything here is pure so the rule can be tested without a DOM.
 */

import type { PresetRef, SliceRequest } from '../../api/client';
import type { StagePlate } from '../../types/plateStage';
import type { ProcessOverrides } from './processFields';

/**
 * Everything the page knows that can affect what comes out of the slicer.
 *
 * Deliberately a plain value: it is assembled once per render from the preset
 * hook, the editor's diff and the stage, and both the request and the
 * fingerprint are computed from this same object, so the two cannot disagree
 * about what "the current selection" means.
 */
export interface SliceSelection {
  printerPreset: PresetRef | null;
  processPreset: PresetRef | null;
  /** One ref per plate slot, in plate order. */
  filamentPresets: (PresetRef | null)[];
  /** Build-plate override (#1337); null inherits the process preset's. */
  bedType: string | null;
  /**
   * "Slice as designed" (#2611). Callers pass `useEmbedded && canUseEmbedded`,
   * mirroring `SliceModal` — the flag is meaningless without the gate.
   */
  useEmbedded: boolean;
  /**
   * 1-indexed plate to slice, or `null` to omit the field entirely.
   *
   * `null` is what a single-plate 3MF / STL sends, matching `SliceModal`,
   * where the backend's own default takes over. Not `1`: sending an explicit
   * plate on a source that has none is a different request.
   */
  plate: number | null;
  /** `ProcessSettingsEditor`'s diff — only genuinely-changed fields. */
  processOverrides: ProcessOverrides;
  /** What the stage is showing. Transforms reach the slicer via `plate_layout`. */
  plates: StagePlate[];
}

/** Every slot the slicer requires has a preset. */
export function isSelectionComplete(selection: SliceSelection): boolean {
  return (
    selection.printerPreset != null &&
    selection.processPreset != null &&
    selection.filamentPresets.length > 0 &&
    selection.filamentPresets.every((ref) => ref != null)
  );
}

/**
 * The `SliceRequest` for this selection.
 *
 * Field-for-field identical to `SliceModal.buildSliceBody` for the same
 * selection — including which keys are *omitted* rather than sent as null,
 * because the backend distinguishes the two. `process_overrides` is the one
 * addition, and it is omitted entirely when the diff is empty so a plain
 * preset slice from this page is byte-identical to one from the modal.
 * `__tests__/pages/SlicerPage.test.tsx` pins that parity against the modal's
 * real dispatch rather than against a copy of it.
 *
 * @throws when the selection is incomplete — callers gate on
 * {@link isSelectionComplete} and never reach this.
 */
export function buildSliceBody(selection: SliceSelection): SliceRequest {
  if (!isSelectionComplete(selection)) {
    throw new Error('buildSliceBody: incomplete selection');
  }
  const filaments = selection.filamentPresets as PresetRef[];
  return {
    printer_preset: selection.printerPreset as PresetRef,
    process_preset: selection.processPreset as PresetRef,
    filament_preset: filaments[0],
    filament_presets: filaments,
    ...(selection.plate != null ? { plate: selection.plate } : {}),
    ...(selection.bedType != null ? { bed_type: selection.bedType } : {}),
    ...(selection.useEmbedded ? { use_embedded_settings: true } : {}),
    ...(Object.keys(selection.processOverrides).length > 0
      ? { process_overrides: selection.processOverrides }
      : {}),
  };
}

/**
 * A stable string identifying this selection's slice output.
 *
 * Two selections share a fingerprint exactly when they would produce the same
 * slice. Built from {@link buildSliceBody} so it cannot fall behind the
 * request, plus the stage layout, which affects the output without travelling
 * in the body.
 *
 * An incomplete selection fingerprints as `null` for the body part, which can
 * never equal a recorded slice's — you cannot print a slice you could not have
 * started.
 */
export function selectionFingerprint(selection: SliceSelection): string {
  const body = isSelectionComplete(selection) ? buildSliceBody(selection) : null;
  return canonicalJson([body, layoutKey(selection.plates)]);
}

/**
 * The stage's transforms, flattened to the parts that reach the slicer.
 *
 * Object *order* within a plate is not meaningful, so plates and objects are
 * sorted — re-ordering the list must not read as a rearrangement. Read-only
 * this ticket; #12 makes these move, and this is already what will catch it.
 */
function layoutKey(plates: StagePlate[]): unknown {
  return [...plates]
    .sort((a, b) => a.index - b.index)
    .map((plate) => [
      plate.index,
      [...plate.objects]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((object) => [
          object.id,
          object.transform.position,
          object.transform.rotation,
          object.transform.scale,
        ]),
    ]);
}

/**
 * `JSON.stringify` with object keys sorted at every depth.
 *
 * Plain `stringify` follows insertion order, so `{a, b}` and `{b, a}` — the
 * same override diff typed in a different order — would fingerprint
 * differently and invalidate Print now for nothing.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = sortDeep(source[key]);
  return sorted;
}
