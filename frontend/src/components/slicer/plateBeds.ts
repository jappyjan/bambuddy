/**
 * The plate beds of the multi-plate stage (#41).
 *
 * Split out of `ModelViewer.tsx` for the same reason `parse3mf.ts` was: eslint
 * forbids a component module from exporting anything else, and every line here
 * is scene-graph construction that can be checked without a WebGL context.
 * That matters more than usual for this ticket — the one thing that must not
 * regress is that a plate's bed lands exactly where that plate's *geometry*
 * already is, and `plateGrid.test.ts` plus `parse3mf.test.ts` can only pin the
 * arithmetic. These functions are what turn it into meshes.
 *
 * Everything below is in three.js space (Y-up), where the 3MF's `y` — and so a
 * `PlateCell`'s — is the scene's `z`.
 */

import * as THREE from 'three';
import type { PlateScreenAnchor } from '../../types/plateStage';
import type { BedSize, PlateCell } from './plateGrid';

/** Spacing of a plate's own grid lines, in millimetres. */
const BED_GRID_STEP_MM = 10;

/**
 * Spacing of the **single-plate** bed's grid, in millimetres. 16 reproduces
 * exactly what `GridHelper(256, ceil(256 / 16))` drew before that grid stopped
 * being square (#69).
 */
export const SINGLE_PLATE_GRID_STEP_MM = 16;

/** Bed colours: the active plate reads as "this is what Slice will cut". */
const BED_ACTIVE_COLOR = 0x00ae42;
const BED_IDLE_COLOR = 0x8a8a8a;
const BED_ACTIVE_OPACITY = 0.2;
const BED_IDLE_OPACITY = 0.07;

/** How far a projected anchor must move before the labels are re-reported. */
const ANCHOR_EPSILON_PX = 0.5;

/** One plate's furniture: a pickable bed surface, its outline and its grid. */
export interface PlateBed {
  plateIndex: number;
  group: THREE.Group;
  surface: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  outline: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  /** Where the name label goes: centre of the far edge, at bed height. */
  labelAnchor: THREE.Vector3;
  /** Where the `01` badge goes: the near-right corner, inset a little. */
  badgeAnchor: THREE.Vector3;
}

/**
 * A rectangular grid of lines covering `width` x `depth` in the XZ plane,
 * centred on the origin.
 *
 * `THREE.GridHelper` is square, and every bed that is not square — an H2S is
 * 340 x 320 — would either overhang its plate or leave a strip bare. Cheap
 * enough to build per plate: a 340 x 320 bed is 68 segments.
 */
export function createBedGridGeometry(width: number, depth: number, step: number): THREE.BufferGeometry {
  const points: number[] = [];
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  for (let offset = -halfWidth; offset <= halfWidth + 1e-6; offset += step) {
    const x = Math.min(offset, halfWidth);
    points.push(x, 0, -halfDepth, x, 0, halfDepth);
  }
  for (let offset = -halfDepth; offset <= halfDepth + 1e-6; offset += step) {
    const z = Math.min(offset, halfDepth);
    points.push(-halfWidth, 0, z, halfWidth, 0, z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return geometry;
}

/**
 * Build one plate's bed at its grid cell.
 *
 * `cell` is in the 3MF's Z-up bed space; three.js is Y-up, so the cell's `y`
 * becomes the scene's `z`. The surface sits a hair below y=0 for the same
 * reason the single-plate bed does — so models rest *on* it rather than z-fight
 * with it — and carries `plateIndex` in `userData`, which is what makes a click
 * on empty bed select that plate.
 */
export function createPlateBed(cell: PlateCell, bed: BedSize): PlateBed {
  const centerX = cell.x + bed.x / 2;
  const centerZ = cell.y + bed.y / 2;

  const group = new THREE.Group();
  group.position.set(centerX, 0, centerZ);

  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(bed.x, bed.y),
    new THREE.MeshBasicMaterial({
      color: BED_IDLE_COLOR,
      transparent: true,
      opacity: BED_IDLE_OPACITY,
      side: THREE.DoubleSide,
    }),
  );
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = -0.5;
  surface.userData.plateIndex = cell.index;
  group.add(surface);

  const grid = new THREE.LineSegments(
    createBedGridGeometry(bed.x, bed.y, BED_GRID_STEP_MM),
    new THREE.LineBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.6 }),
  );
  grid.position.y = -0.4;
  group.add(grid);

  const halfWidth = bed.x / 2;
  const halfDepth = bed.y / 2;
  const border = new THREE.BufferGeometry();
  border.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        -halfWidth, 0, -halfDepth, halfWidth, 0, -halfDepth,
        halfWidth, 0, -halfDepth, halfWidth, 0, halfDepth,
        halfWidth, 0, halfDepth, -halfWidth, 0, halfDepth,
        -halfWidth, 0, halfDepth, -halfWidth, 0, -halfDepth,
      ],
      3,
    ),
  );
  const outline = new THREE.LineSegments(
    border,
    new THREE.LineBasicMaterial({ color: BED_IDLE_COLOR }),
  );
  outline.position.y = -0.3;
  group.add(outline);

  return {
    plateIndex: cell.index,
    group,
    surface,
    outline,
    labelAnchor: new THREE.Vector3(centerX, 0, cell.y),
    badgeAnchor: new THREE.Vector3(cell.x + bed.x * 0.94, 0, cell.y + bed.y * 0.94),
  };
}

/**
 * Re-cut the **single-plate** bed and its grid to `bed` (#69).
 *
 * The single-plate furniture is built in `ModelViewer`'s scene-setup effect,
 * which runs before the model has been fetched — so it can only be sized from
 * the printer selected in the rail. A 3MF that declares its own
 * `printable_area` outranks that, and is not known until the parse lands, so the
 * size has to be applied a second time rather than decided once.
 *
 * Here rather than in the component for the reason the module header gives: this
 * is the function that decides the on-screen bed size, and inside
 * `ModelViewer.tsx` nothing could check it. Geometry is disposed on the way out
 * — this runs on every file and every plate change.
 */
export function resizeSinglePlateBed(
  plate: THREE.Mesh | null,
  grid: THREE.LineSegments | null,
  bed: BedSize,
) {
  if (plate) {
    plate.geometry.dispose();
    plate.geometry = new THREE.PlaneGeometry(bed.x, bed.y);
  }
  if (grid) {
    grid.geometry.dispose();
    grid.geometry = createBedGridGeometry(bed.x, bed.y, SINGLE_PLATE_GRID_STEP_MM);
  }
}

/** Paint the beds so the active plate is the one that reads as selected. */
export function paintPlateBeds(beds: PlateBed[], activePlateIndex: number | null) {
  for (const bed of beds) {
    const active = bed.plateIndex === activePlateIndex;
    bed.surface.material.color.setHex(active ? BED_ACTIVE_COLOR : BED_IDLE_COLOR);
    bed.surface.material.opacity = active ? BED_ACTIVE_OPACITY : BED_IDLE_OPACITY;
    bed.outline.material.color.setHex(active ? BED_ACTIVE_COLOR : BED_IDLE_COLOR);
  }
}

/** A world point in viewport pixels, and whether it is in front of the camera. */
export function projectToViewport(
  point: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
): { x: number; y: number; visible: boolean } {
  const projected = point.clone().project(camera);
  return {
    x: (projected.x * 0.5 + 0.5) * width,
    y: (-projected.y * 0.5 + 0.5) * height,
    visible: projected.z > -1 && projected.z < 1,
  };
}

/**
 * Where the zoom buttons put the camera: `factor` of the way along its current
 * offset from what it is looking at.
 *
 * Zooming towards the **orbit target** rather than the world origin is what the
 * multi-plate stage needs — the origin is plate 1's front-left corner, so
 * scaling the position vector there flies the camera sideways across the grid
 * while appearing to zoom.
 *
 * Pure, and separate from the component, because the obvious one-liner for it
 * is wrong in a way no scene test would catch: `position.copy(target)
 * .addScaledVector(position.clone().sub(target), factor)` mutates `position`
 * while evaluating its own receiver, so the offset is read back as zero and the
 * camera teleports onto the target instead of zooming. The offset has to be
 * captured before anything is written.
 */
export function zoomedCameraPosition(
  position: THREE.Vector3,
  target: THREE.Vector3,
  factor: number,
): THREE.Vector3 {
  const offset = position.clone().sub(target);
  return target.clone().addScaledVector(offset, factor);
}

export function anchorsDiffer(a: PlateScreenAnchor, b: PlateScreenAnchor): boolean {
  return (
    a.visible !== b.visible ||
    Math.abs(a.label.x - b.label.x) > ANCHOR_EPSILON_PX ||
    Math.abs(a.label.y - b.label.y) > ANCHOR_EPSILON_PX ||
    Math.abs(a.badge.x - b.badge.x) > ANCHOR_EPSILON_PX ||
    Math.abs(a.badge.y - b.badge.y) > ANCHOR_EPSILON_PX
  );
}

