/**
 * Bridge between the API's plate metadata + the persisted `plate_layout`
 * column (spec §4) and the `StagePlate[]` shape `PlateStage` renders.
 *
 * Lives next to the component rather than inside it so the slicer page
 * (#15) and the mobile wizard (#11) can build the same input without
 * re-deriving the merge rules, and so the "absent means as-designed"
 * behaviour is testable on its own.
 */

import type { PlateMetadata } from '../../types/plates';
import type {
  ObjectTransform,
  PlateLayout,
  PlateLayoutEntry,
  StageObject,
  StagePlate,
} from '../../types/plateStage';

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
 */
export function buildStagePlates(
  plates: PlateMetadata[],
  layout?: PlateLayout | null,
): StagePlate[] {
  const usable = isSupportedPlateLayout(layout) ? layout : null;

  return plates.map((plate) => {
    const entries = usable?.plates?.[String(plate.index)] ?? [];
    const byObjectId = new Map(entries.map((entry) => [entry.object_id, entry]));

    const objects: StageObject[] = (plate.objects ?? []).map((objectId) => {
      const entry = byObjectId.get(objectId);
      return {
        id: objectId,
        transform: cloneTransform(entry ?? IDENTITY_TRANSFORM),
      };
    });

    return { index: plate.index, name: plate.name, objects };
  });
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
