/**
 * Types for `PlateStage` (#14, step-5.2) and the persisted plate layout
 * (design spec §4).
 *
 * `PlateStage` is deliberately ignorant of presets, slicing and file
 * provenance: the whole contract is "plates + objects + a bed size in,
 * plate/selection changes out". Everything it needs to render lives in
 * these shapes, so the slicer page (#15) and the gizmo work (#12) can
 * feed it from wherever the data happens to come from.
 */

/**
 * One object's placement on the bed.
 *
 * Units match the persisted `plate_layout` shape in spec §4 exactly, so a
 * layout entry converts to an `ObjectTransform` without any rescaling:
 * `position` is millimetres in bed coordinates, `rotation` is degrees XYZ,
 * `scale` is a multiplier per axis (1 = 100%).
 */
export interface ObjectTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

/** One model on a plate. */
export interface StageObject {
  /**
   * The 3MF object id. Matches `ObjectData.id` as `ModelViewer` parses it
   * and `object_id` in the persisted layout — the backend matches on these,
   * so anything else silently drops the transform (#12).
   */
  id: string;
  /** Display name; the UI falls back to "Object {id}" when absent. */
  name?: string | null;
  transform: ObjectTransform;
}

/** One plate of a (possibly multi-plate) 3MF. */
export interface StagePlate {
  /** 1-indexed plate number, matching `SliceRequest.plate` and layout keys. */
  index: number;
  /** Plate name from the 3MF, when it carries one. */
  name?: string | null;
  objects: StageObject[];
}

/**
 * Where one plate's on-screen furniture goes, in viewport pixels (#41).
 *
 * The multi-plate stage labels every plate *in the scene*, the way Bambu Studio
 * does — which means a DOM label has to follow a 3D bed as the camera orbits.
 * The viewport projects the two anchor points and reports them here; the stage
 * renders real buttons at those coordinates rather than drawing text into the
 * canvas, so the labels stay translatable, focusable and readable by a screen
 * reader, and clicking one is the same event as clicking the plate.
 */
export interface PlateScreenAnchor {
  /** Centre of the plate's back edge — where the name sits, above the bed. */
  label: { x: number; y: number };
  /** The plate's near-right corner — where Studio prints `01`, `02`, … */
  badge: { x: number; y: number };
  /** False while the plate is behind the camera, where a projection inverts. */
  visible: boolean;
}

/** One entry of the persisted `plate_layout` (spec §4). */
export interface PlateLayoutEntry {
  object_id: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

/**
 * The persisted `plate_layout` column. Plate keys are stringified 1-indexed
 * plate numbers. Objects absent from a plate's array keep their original
 * transform.
 */
export interface PlateLayout {
  version: number;
  plates: Record<string, PlateLayoutEntry[]>;
}
