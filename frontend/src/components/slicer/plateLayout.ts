/**
 * Bridge between the API's plate metadata + the persisted `plate_layout`
 * column (spec §4) and the `StagePlate[]` shape `PlateStage` renders.
 *
 * Lives next to the component rather than inside it so the slicer page
 * (#15) and the mobile wizard (#11) can build the same input without
 * re-deriving the merge rules, and so the "absent means as-designed"
 * behaviour is testable on its own.
 *
 * ## Two different meanings of `position` (#32, step-8.2)
 *
 * This is the whole reason the conversion lives here rather than being inlined
 * at the call site:
 *
 * - An **`ObjectTransform`** — what `PlateStage` renders and what the gizmos
 *   emit — is a **delta from the object as designed**. `IDENTITY_TRANSFORM`
 *   means "unchanged".
 * - A **`PlateLayoutEntry.position`** — what is persisted and what the slicer
 *   applies — is an **absolute bed coordinate**:
 *   `backend/app/services/plate_layout.py` composes
 *   `T(position) · R(rotation) · S(scale) · T(-anchor)` onto the build item, so
 *   the object's anchor lands exactly on `position`.
 *
 * The two are related by the object's anchor, which `ModelViewer` measures off
 * the parsed 3MF and reports as {@link ObjectMetrics.anchor}:
 *
 *     entry.position = anchor + delta.position       (save)
 *     delta.position = entry.position - anchor       (restore)
 *
 * with `rotation` and `scale` passing through untouched. Writing the delta
 * straight out would drag every object towards the bed's front-left corner —
 * and the save would report success, because the backend cannot tell the two
 * apart. Nothing downstream catches it; the mistake only shows up as a
 * misplaced print.
 *
 * ## Anchors arrive late, and that must not destroy data
 *
 * The anchors come from the 3MF parse, so they land *after* the stored layout
 * does, and `ModelViewer` only measures the objects on the plate it is
 * currently showing. Both are handled by never recomputing an entry whose
 * anchor is unknown: {@link buildStagePlates} leaves such an object as designed
 * on screen, and {@link toPlateLayout} copies its stored entry through
 * verbatim. Recomputing from a missing anchor would quietly rewrite every
 * object on the plates the user never opened.
 */

import type { PlateMetadata } from '../../types/plates';
import type {
  ObjectTransform,
  PlateLayout,
  PlateLayoutEntry,
  StageObject,
  StagePlate,
} from '../../types/plateStage';
// Type-only: `transformMath` imports IDENTITY_TRANSFORM from here, and a value
// import back would close a module cycle.
import type { ObjectMetrics, Vec3 } from './transformMath';

/** The only `plate_layout` version readers accept (spec §4). */
export const PLATE_LAYOUT_VERSION = 1;

/**
 * "As designed" — the transform an object gets when the layout says nothing
 * about it. Frozen so a caller spreading it around cannot mutate the shared
 * default out from under every other object.
 */
export const IDENTITY_TRANSFORM: ObjectTransform = Object.freeze({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
}) as ObjectTransform;

/**
 * True when `layout` is a layout this build understands. A `version` other
 * than 1 is rejected rather than guessed at — spec §4 makes the version
 * field the whole point of being able to change the shape later.
 */
export function isSupportedPlateLayout(
  layout: PlateLayout | null | undefined,
): layout is PlateLayout {
  return !!layout && layout.version === PLATE_LAYOUT_VERSION;
}

/**
 * Merge plate metadata with a persisted layout into `PlateStage` input.
 *
 * Objects the layout does not mention keep {@link IDENTITY_TRANSFORM}
 * ("as designed"), and an absent, null or unsupported-version layout leaves
 * every object at its original transform — degraded, never a hard failure.
 *
 * `metrics` carries the anchors needed to turn a stored *absolute* position
 * back into the delta the stage renders (see the module header). An object
 * whose anchor has not been measured yet stays as designed rather than being
 * placed from a guessed anchor: the arrangement then appears a frame later,
 * once the parse reports, instead of appearing in the wrong place immediately.
 */
export function buildStagePlates(
  plates: PlateMetadata[],
  layout?: PlateLayout | null,
  metrics?: Record<string, ObjectMetrics>,
): StagePlate[] {
  const usable = isSupportedPlateLayout(layout) ? layout : null;

  return plates.map((plate) => {
    const entries = usable?.plates?.[String(plate.index)] ?? [];
    const byObjectId = new Map(entries.map((entry) => [entry.object_id, entry]));

    const objects: StageObject[] = stageObjectIds(plate).map((objectId) => {
      const entry = byObjectId.get(objectId);
      const anchor = metrics?.[objectId]?.anchor;
      return {
        id: objectId,
        transform:
          entry && anchor
            ? entryToTransform(entry, anchor)
            : cloneTransform(IDENTITY_TRANSFORM),
      };
    });

    return { index: plate.index, name: plate.name, objects };
  });
}

/**
 * The ids the stage addresses this plate's objects by.
 *
 * `object_ids` — the 3MF `<object id>` values — when the backend supplies
 * them, because that is what `ModelViewer` attaches gizmos to, what the
 * persisted layout is keyed on, and what the slicer matches placements
 * against. `objects` holds display *names* for the file grid; keying a layout
 * on those saves cleanly and is dropped at slice time without a word.
 *
 * Falls back to `objects` only when `object_ids` is absent altogether (an
 * older backend), where it at least keeps the read-only readout populated.
 */
function stageObjectIds(plate: PlateMetadata): string[] {
  if (plate.object_ids != null) return plate.object_ids;
  return plate.objects ?? [];
}

/** A stored absolute placement, as the delta the stage renders. */
export function entryToTransform(entry: PlateLayoutEntry, anchor: Vec3): ObjectTransform {
  const transform = cloneTransform(entry);
  transform.position = [
    roundMm(entry.position[0] - anchor[0]),
    roundMm(entry.position[1] - anchor[1]),
    roundMm(entry.position[2] - anchor[2]),
  ];
  return transform;
}

/** The stage's delta, as the absolute placement the slicer applies. */
export function transformToEntry(
  objectId: string,
  transform: ObjectTransform,
  anchor: Vec3,
): PlateLayoutEntry {
  const entry = cloneTransform(transform);
  return {
    object_id: objectId,
    position: [
      roundMm(anchor[0] + transform.position[0]),
      roundMm(anchor[1] + transform.position[1]),
      roundMm(anchor[2] + transform.position[2]),
    ],
    rotation: entry.rotation,
    scale: entry.scale,
  };
}

/** True when this transform leaves the object exactly as designed. */
export function isIdentityTransform(transform: ObjectTransform): boolean {
  return (['position', 'rotation', 'scale'] as const).every((key) =>
    transform[key].every((value, index) => value === IDENTITY_TRANSFORM[key][index]),
  );
}

/**
 * The `plate_layout` to persist for what the stage is currently showing, or
 * `null` when nothing is arranged and the file should go back to as-designed.
 *
 * Built by **merging over `stored`**, not by rebuilding from scratch:
 *
 * - an object at {@link IDENTITY_TRANSFORM} has its entry dropped, because
 *   "absent" is how the shape spells "as designed" (spec §4);
 * - an object whose anchor is unknown — every object on a plate the viewport
 *   has not rendered — keeps whatever was stored for it, untouched;
 * - plates the caller does not know about at all are copied through, so a
 *   metadata fetch that came back short cannot wipe them.
 *
 * A rebuild-from-scratch would satisfy every test written against the plate in
 * front of you and silently discard the arrangement of every other plate.
 */
export function toPlateLayout(
  plates: StagePlate[],
  metrics: Record<string, ObjectMetrics>,
  stored?: PlateLayout | null,
): PlateLayout | null {
  const usable = isSupportedPlateLayout(stored) ? stored : null;
  const result: Record<string, PlateLayoutEntry[]> = {};

  for (const [key, entries] of Object.entries(usable?.plates ?? {})) {
    result[key] = entries.map((entry) => cloneEntry(entry));
  }

  for (const plate of plates) {
    const key = String(plate.index);
    const byObjectId = new Map((result[key] ?? []).map((entry) => [entry.object_id, entry]));

    for (const object of plate.objects) {
      const anchor = metrics[object.id]?.anchor;
      if (!anchor) continue;
      if (isIdentityTransform(object.transform)) byObjectId.delete(object.id);
      else byObjectId.set(object.id, transformToEntry(object.id, object.transform, anchor));
    }

    result[key] = [...byObjectId.values()];
  }

  const nonEmpty = Object.entries(result).filter(([, entries]) => entries.length > 0);
  if (nonEmpty.length === 0) return null;
  return { version: PLATE_LAYOUT_VERSION, plates: Object.fromEntries(nonEmpty) };
}

/**
 * The gizmos' pending edits, `{plateIndex: {objectId: transform}}` (#25).
 *
 * Kept apart from the plates the layout query produced so a refetch does not
 * silently discard what the user has just arranged, and so "has anything
 * moved?" — which is what #32's Save layout turns on — is a lookup rather than
 * a deep comparison against a moving baseline.
 */
export type PlateTransformEdits = Record<number, Record<string, ObjectTransform>>;

/** Merge pending gizmo edits over the plates the stored layout produced. */
export function applyTransformEdits(
  plates: StagePlate[],
  edits: PlateTransformEdits,
): StagePlate[] {
  if (Object.keys(edits).length === 0) return plates;

  return plates.map((plate) => {
    const forPlate = edits[plate.index];
    if (!forPlate) return plate;
    return {
      ...plate,
      objects: plate.objects.map((object) => {
        const transform = forPlate[object.id];
        return transform ? { ...object, transform: cloneTransform(transform) } : object;
      }),
    };
  });
}

/** Immutably record one object's new transform. */
export function withTransformEdit(
  edits: PlateTransformEdits,
  plateIndex: number,
  objectId: string,
  transform: ObjectTransform,
): PlateTransformEdits {
  return {
    ...edits,
    [plateIndex]: { ...(edits[plateIndex] ?? {}), [objectId]: cloneTransform(transform) },
  };
}

/**
 * Deep-copy a transform. The arrays matter: a shallow spread would hand
 * every "as designed" object the same three arrays as
 * {@link IDENTITY_TRANSFORM}, and the first gizmo drag (#12) would move all
 * of them at once.
 */
function cloneTransform(source: ObjectTransform | PlateLayoutEntry): ObjectTransform {
  const [px, py, pz] = source.position;
  const [rx, ry, rz] = source.rotation;
  const [sx, sy, sz] = source.scale;
  return { position: [px, py, pz], rotation: [rx, ry, rz], scale: [sx, sy, sz] };
}

function cloneEntry(entry: PlateLayoutEntry): PlateLayoutEntry {
  return { object_id: entry.object_id, ...cloneTransform(entry) };
}

/**
 * Millimetres at the precision the readout shows, matching
 * `transformMath.roundTransform` (not imported: that module imports this one).
 *
 * Load-bearing on the way back out of the anchor arithmetic. `anchor + delta`
 * and then `- anchor` is not the identity in binary floating point, and the
 * ~1e-14 mm of drift it leaves would flow into `selectionFingerprint` and
 * disable Print now the moment a layout was saved.
 */
function roundMm(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100 + 0;
}
