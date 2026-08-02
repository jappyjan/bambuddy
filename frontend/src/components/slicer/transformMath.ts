/**
 * Bed ↔ three.js transform conversion for the placement gizmos (#25, step-8.1).
 *
 * ## Two coordinate systems, one axis swap
 *
 * The persisted `plate_layout` (spec §4) and everything the user types is in
 * **bed space**: X right, Y back, **Z up**, millimetres — the 3MF convention.
 * `ModelViewer` renders in three.js space: X right, **Y up**, Z forward, and it
 * converts by swapping Y and Z on every vertex (`createGeometryFromMesh`).
 *
 * So the two spaces are related by the involution `S: (x, y, z) → (x, z, y)`.
 * Positions and scales swap componentwise; a rotation conjugates,
 * `R_three = S · R_bed · S`. `S` is a reflection, but the conjugation is not —
 * `det(S·R·S) = det(S)·det(R)·det(S) = +1` — so the result is still a proper
 * rotation and `Matrix4.decompose` stays well-behaved. Everything here is
 * expressed as that conjugation rather than as hand-derived per-axis sign flips,
 * because the sign flips are where this kind of code goes wrong.
 *
 * ## Transforms are deltas, applied about the object's anchor
 *
 * An `ObjectTransform` is a **delta from the object as designed**, which is why
 * {@link IDENTITY_TRANSFORM} means "unchanged" in `plateLayout.ts` and why the
 * fingerprint in `sliceSelection.ts` can treat identity as "nothing to see".
 *
 * Rotation and scale are applied **about the object's anchor**, matching
 * `backend/app/services/plate_layout.py`, which composes
 * `T(position) · R(rotation) · S(scale) · T(-anchor)` onto the 3MF build item.
 * Pivoting about anything else (the bounding-box centre, say) would preview one
 * arrangement and slice another. The anchor is the translation of the object's
 * first `<component>` transform plus the build item's own translation, which is
 * what `ModelViewer` reports back as `ObjectMetrics.anchor`.
 *
 * `rotation` is degrees XYZ composed as `Rx · Ry · Rz` — three.js `Euler` order
 * `'XYZ'`, which is also the order the backend applies.
 */

import * as THREE from 'three';
import type { ObjectTransform, StageObject } from '../../types/plateStage';
import { IDENTITY_TRANSFORM } from './plateLayout';

export type Vec3 = [number, number, number];

/** What `ModelViewer` measures for one object once the 3MF is parsed. */
export interface ObjectMetrics {
  /**
   * The object's as-designed anchor in bed millimetres — the point rotation
   * and scale pivot around, and the point a saved `position` would place.
   */
  anchor: Vec3;
  /** Axis-aligned size in bed millimetres, as designed. */
  size: Vec3;
}

/**
 * `(x, y, z) → (x, z, y)`. Its own inverse, so one function converts both ways.
 */
export function swapYZ(v: Vec3): Vec3 {
  return [v[0], v[2], v[1]];
}

const SWAP_MATRIX = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

const DEG = Math.PI / 180;

/** `S · m · S`, the change of basis between bed space and three.js space. */
function conjugate(m: THREE.Matrix4): THREE.Matrix4 {
  return m.premultiply(SWAP_MATRIX).multiply(SWAP_MATRIX);
}

/** Bed-space degrees XYZ → the equivalent rotation in three.js space. */
export function bedRotationToQuaternion(rotation: Vec3): THREE.Quaternion {
  const euler = new THREE.Euler(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG, 'XYZ');
  const matrix = conjugate(new THREE.Matrix4().makeRotationFromEuler(euler));
  return new THREE.Quaternion().setFromRotationMatrix(matrix);
}

/** The inverse of {@link bedRotationToQuaternion}. */
export function quaternionToBedRotation(quaternion: THREE.Quaternion): Vec3 {
  const matrix = conjugate(new THREE.Matrix4().makeRotationFromQuaternion(quaternion));
  const euler = new THREE.Euler().setFromRotationMatrix(matrix, 'XYZ');
  return [euler.x / DEG, euler.y / DEG, euler.z / DEG];
}

/**
 * Where the gizmo's object node has to sit for `transform` to be on screen.
 *
 * The node's parent holds the object's geometry offset by `-pivot`, so a node
 * sitting at `pivot` with no rotation is the object exactly as designed, and
 * rotation and scale turn about the anchor rather than about the world origin.
 */
export function transformToObjectNode(
  transform: ObjectTransform,
  pivotThree: Vec3,
): { position: Vec3; quaternion: THREE.Quaternion; scale: Vec3 } {
  const offset = swapYZ(transform.position as Vec3);
  return {
    position: [
      pivotThree[0] + offset[0],
      pivotThree[1] + offset[1],
      pivotThree[2] + offset[2],
    ],
    quaternion: bedRotationToQuaternion(transform.rotation as Vec3),
    scale: swapYZ(transform.scale as Vec3),
  };
}

/** The inverse of {@link transformToObjectNode} — what the gizmo drag produced. */
export function objectNodeToTransform(
  node: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 },
  pivotThree: Vec3,
): ObjectTransform {
  const offsetThree: Vec3 = [
    node.position.x - pivotThree[0],
    node.position.y - pivotThree[1],
    node.position.z - pivotThree[2],
  ];
  return roundTransform({
    position: swapYZ(offsetThree),
    rotation: quaternionToBedRotation(node.quaternion),
    scale: swapYZ([node.scale.x, node.scale.y, node.scale.z]),
  });
}

/**
 * Round to the precision the readout shows.
 *
 * Not cosmetic: an unrounded gizmo drag lands values like `1.0000000000000002`
 * on the scale, and those flow straight into `selectionFingerprint`, so a drag
 * that visually returns an object to where it started would still read as a
 * change and keep Print now disabled forever.
 */
export function roundTransform(transform: ObjectTransform): ObjectTransform {
  return {
    position: transform.position.map((v) => round(v, 2)) as Vec3,
    rotation: transform.rotation.map((v) => round(normalizeDegrees(v), 2)) as Vec3,
    scale: transform.scale.map((v) => round(v, 4)) as Vec3,
  };
}

function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  // `+ 0` collapses -0 to 0 so an identity check against IDENTITY_TRANSFORM
  // cannot fail on a sign nobody can see.
  return Math.round(value * factor) / factor + 0;
}

/** Fold into (-180, 180] so 370° and 10° are the same arrangement. */
function normalizeDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** Structural equality, so a no-op edit never invalidates a completed slice. */
export function transformsEqual(a: ObjectTransform, b: ObjectTransform): boolean {
  return (['position', 'rotation', 'scale'] as const).every((key) =>
    a[key].every((value, index) => value === b[key][index]),
  );
}

/**
 * Lay flat: remove tilt and drop the object back onto the bed.
 *
 * Zeroes the X and Y rotations and the Z offset, keeping the turn about the
 * vertical axis and the position on the bed. This is *not* the "pick a face,
 * put it down" lay-flat of a desktop slicer — that needs a picked face, and
 * there is nowhere to pick one from in a viewport whose objects are merged
 * per extruder. What it does do is undo an accidental rotate, which is the
 * case the button exists for.
 */
export function layFlatTransform(transform: ObjectTransform): ObjectTransform {
  return {
    position: [transform.position[0], transform.position[1], 0],
    rotation: [0, 0, transform.rotation[2]],
    scale: [...transform.scale] as Vec3,
  };
}

/** Fallback cell size when an object's footprint was never measured. */
const DEFAULT_FOOTPRINT_MM = 60;
/** Gap between neighbours, so arranged parts do not print fused together. */
const ARRANGE_GAP_MM = 6;

/**
 * Lay every object out on a grid centred on the bed.
 *
 * Deliberately a grid rather than a nesting solver: the viewport knows each
 * object's axis-aligned footprint and nothing about its outline, so anything
 * cleverer would be guessing. Objects are ordered by id, not by list order, so
 * pressing the button twice is a no-op rather than a reshuffle.
 *
 * Objects whose footprint was never measured (no metrics reported yet) get
 * {@link DEFAULT_FOOTPRINT_MM}; the arrangement is then coarse but still
 * non-overlapping for typical parts.
 */
export function autoArrangeTransforms(
  objects: StageObject[],
  metrics: Record<string, ObjectMetrics>,
  buildVolume: { x: number; y: number },
): Record<string, ObjectTransform> {
  if (objects.length === 0) return {};

  const ordered = [...objects].sort((a, b) => a.id.localeCompare(b.id));

  const cell =
    ordered.reduce((widest, object) => {
      const size = metrics[object.id]?.size;
      const footprint = size ? Math.max(size[0], size[1]) : DEFAULT_FOOTPRINT_MM;
      return Math.max(widest, footprint);
    }, 0) + ARRANGE_GAP_MM;

  const columns = Math.max(1, Math.min(ordered.length, Math.floor(buildVolume.x / cell) || 1));
  const rows = Math.ceil(ordered.length / columns);

  const originX = buildVolume.x / 2 - ((columns - 1) * cell) / 2;
  const originY = buildVolume.y / 2 - ((rows - 1) * cell) / 2;

  const result: Record<string, ObjectTransform> = {};
  ordered.forEach((object, index) => {
    const anchor = metrics[object.id]?.anchor ?? [0, 0, 0];
    const targetX = originX + (index % columns) * cell;
    const targetY = originY + Math.floor(index / columns) * cell;
    result[object.id] = roundTransform({
      // `position` is a delta from as-designed, so the target bed coordinate
      // has to have the anchor taken back off it.
      position: [targetX - anchor[0], targetY - anchor[1], object.transform.position[2]],
      rotation: [...object.transform.rotation] as Vec3,
      scale: [...object.transform.scale] as Vec3,
    });
  });
  return result;
}

/** A transform that leaves the object exactly as designed. */
export function identityTransform(): ObjectTransform {
  return {
    position: [...IDENTITY_TRANSFORM.position] as Vec3,
    rotation: [...IDENTITY_TRANSFORM.rotation] as Vec3,
    scale: [...IDENTITY_TRANSFORM.scale] as Vec3,
  };
}
