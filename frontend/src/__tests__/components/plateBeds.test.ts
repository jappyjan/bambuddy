/**
 * The plate beds of the multi-plate stage (#41).
 *
 * The single failure this file exists to catch: **a bed that is not under its
 * own plate's models.** The geometry's positions come from the file and are not
 * negotiable (#40 established them); the beds are reconstructed from the plate
 * number alone. If the two drift apart the models appear to float in the gaps
 * between plates — which looks exactly like the bug this epic started with, and
 * no other test in the suite would notice.
 *
 * Everything here runs on the scene graph, with no renderer: three.js only
 * needs WebGL to draw, not to place.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  anchorsDiffer,
  createPlateBed,
  paintPlateBeds,
  projectToViewport,
  zoomedCameraPosition,
} from '../../components/slicer/plateBeds';
import { plateGridOrigin } from '../../components/slicer/plateGrid';
import { buildModelGroup, parse3MF } from '../../components/slicer/parse3mf';

const FIXTURE = resolve(process.cwd(), 'src/__tests__/fixtures/attractap-v3-reduced.3mf');
const H2S = { x: 340, y: 320 };

describe('zoomedCameraPosition', () => {
  it('moves the camera along its offset from the orbit target', () => {
    const zoomed = zoomedCameraPosition(
      new THREE.Vector3(150, 150, 150),
      new THREE.Vector3(0, 50, 0),
      0.8,
    );
    expect([zoomed.x, zoomed.y, zoomed.z]).toEqual([120, 130, 120]);
  });

  it('zooms towards the target, not the world origin', () => {
    // The multi-plate case: the stage's centre is far from the origin, and
    // scaling the position vector would fly the camera sideways across the grid
    // instead of moving it closer to what the user is looking at.
    const target = new THREE.Vector3(600, 0, -400);
    const zoomed = zoomedCameraPosition(new THREE.Vector3(600, 500, 100), target, 0.5);
    expect([zoomed.x, zoomed.y, zoomed.z]).toEqual([600, 250, -150]);
    // Half the distance, and still looking down the same line.
    expect(zoomed.distanceTo(target)).toBeCloseTo(
      new THREE.Vector3(600, 500, 100).distanceTo(target) * 0.5,
    );
  });

  it('does not collapse onto the target', () => {
    // Regression: writing this as `position.copy(target).addScaledVector(
    // position.clone().sub(target), factor)` mutates `position` while
    // evaluating its own argument, so the offset reads back as zero and every
    // zoom click teleports the camera onto the target.
    const position = new THREE.Vector3(150, 150, 150);
    const target = new THREE.Vector3(0, 50, 0);
    const zoomed = zoomedCameraPosition(position, target, 0.8);
    expect(zoomed.equals(target)).toBe(false);
    // And it leaves its inputs alone.
    expect([position.x, position.y, position.z]).toEqual([150, 150, 150]);
    expect([target.x, target.y, target.z]).toEqual([0, 50, 0]);
  });
});

function bedFor(plateIndex: number, bed = H2S) {
  return createPlateBed(plateGridOrigin(plateIndex, bed), bed);
}

/**
 * A bed's footprint in world space.
 *
 * The explicit `updateMatrixWorld` is what a renderer does once per frame:
 * `Box3.setFromObject` deliberately does not walk *up* the tree, so measuring a
 * child of a group that has never been rendered reports it at the origin.
 */
function bedBox(bed: ReturnType<typeof bedFor>): THREE.Box3 {
  bed.group.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(bed.surface);
}

describe('createPlateBed', () => {
  it('covers exactly its own grid cell', () => {
    const box = bedBox(bedFor(5));
    // Cell (1, 1) of a 340 x 320 bed: x from 408, z from -384.
    expect(box.min.x).toBeCloseTo(408, 3);
    expect(box.max.x).toBeCloseTo(748, 3);
    expect(box.min.z).toBeCloseTo(-384, 3);
    expect(box.max.z).toBeCloseTo(-64, 3);
  });

  it('sits just below the models rather than through them', () => {
    const box = bedBox(bedFor(1));
    expect(box.max.y).toBeLessThan(0);
    expect(box.max.y).toBeGreaterThan(-1);
  });

  it('carries the plate number a click has to resolve to', () => {
    // The bed *is* the plate picker now that the tab strip is gone; without
    // this the raycast hits an anonymous quad and nothing gets selected.
    expect(bedFor(3).surface.userData.plateIndex).toBe(3);
  });

  it('anchors the name above the back edge and the badge at the near corner', () => {
    const plateOne = bedFor(1);
    expect(plateOne.labelAnchor.x).toBeCloseTo(170, 3);
    expect(plateOne.labelAnchor.z).toBeCloseTo(0, 3);
    // Studio prints the number in the plate's lower-right; in a scene viewed
    // from +x/+z that is the corner with the larger coordinates.
    expect(plateOne.badgeAnchor.x).toBeGreaterThan(plateOne.labelAnchor.x);
    expect(plateOne.badgeAnchor.z).toBeGreaterThan(plateOne.labelAnchor.z);
    expect(plateOne.badgeAnchor.x).toBeLessThan(H2S.x);
    expect(plateOne.badgeAnchor.z).toBeLessThan(H2S.y);
  });

  it('fits a non-square bed without overhanging it', () => {
    // `THREE.GridHelper` is square; a 340 x 320 bed drawn with one would either
    // spill over the plate or leave a strip of it bare.
    const bed = bedFor(1);
    bed.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(bed.group);
    expect(box.max.x - box.min.x).toBeCloseTo(H2S.x, 3);
    expect(box.max.z - box.min.z).toBeCloseTo(H2S.y, 3);
  });
});

describe('paintPlateBeds', () => {
  it('distinguishes exactly one plate — the one that will be sliced', () => {
    const beds = [bedFor(1), bedFor(2)];
    paintPlateBeds(beds, 2);

    expect(beds[1].surface.material.color.getHex()).toBe(0x00ae42);
    expect(beds[1].surface.material.opacity).toBeGreaterThan(beds[0].surface.material.opacity);
    expect(beds[0].surface.material.color.getHex()).not.toBe(0x00ae42);
  });

  it('leaves nothing highlighted when there is no active plate', () => {
    const beds = [bedFor(1)];
    paintPlateBeds(beds, null);
    expect(beds[0].surface.material.color.getHex()).not.toBe(0x00ae42);
  });
});

describe('projectToViewport', () => {
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 10000);

  it('puts what the camera is aimed at in the middle of the viewport', () => {
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const middle = projectToViewport(new THREE.Vector3(0, 0, 0), camera, 800, 400);
    expect(middle.x).toBeCloseTo(400, 3);
    expect(middle.y).toBeCloseTo(200, 3);
    expect(middle.visible).toBe(true);
  });

  it('reports a point behind the camera as not visible', () => {
    // Behind the camera a perspective projection mirrors: a label placed at the
    // returned coordinates would sit over a plate that is not there.
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    expect(projectToViewport(new THREE.Vector3(0, 0, 500), camera, 800, 400).visible).toBe(false);
  });

  it('measures y downwards, the way the DOM does', () => {
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const above = projectToViewport(new THREE.Vector3(0, 20, 0), camera, 800, 400);
    expect(above.y).toBeLessThan(200);
  });
});

describe('anchorsDiffer', () => {
  const anchor = { label: { x: 10, y: 20 }, badge: { x: 30, y: 40 }, visible: true };

  it('ignores sub-pixel drift, so an idle scene re-renders nothing', () => {
    expect(anchorsDiffer(anchor, { ...anchor, label: { x: 10.2, y: 20.1 } })).toBe(false);
  });

  it('notices a real move, or a plate going out of view', () => {
    expect(anchorsDiffer(anchor, { ...anchor, label: { x: 14, y: 20 } })).toBe(true);
    expect(anchorsDiffer(anchor, { ...anchor, badge: { x: 30, y: 47 } })).toBe(true);
    expect(anchorsDiffer(anchor, { ...anchor, visible: false })).toBe(true);
  });
});

describe('the beds and the models of a real multi-plate file', () => {
  it('draws every plate under its own objects', async () => {
    // End to end for #41, against the owner's reference file: parse it, build
    // the whole scene the way the viewport does (no plate filter, no
    // re-centring), and check each object stands on the bed of the plate the
    // file assigns it to — and on no other.
    const parsed = await parse3MF(
      new Uint8Array(readFileSync(FIXTURE)) as unknown as ArrayBuffer,
    );
    expect(parsed.bedSize).toEqual(H2S);

    const { group } = buildModelGroup(parsed, null);
    const plateIndexes = [1, 2, 3, 4, 5, 6, 7, 8];
    const beds = new Map(
      plateIndexes.map((index) => [index, bedFor(index, parsed.bedSize!)] as const),
    );

    for (const node of group.children) {
      const objectId = node.userData.objectId as string;
      const plateId = parsed.objects.get(objectId)!.plateId!;
      const objectBox = new THREE.Box3().setFromObject(node);

      for (const [index, bed] of beds) {
        const footprint = bedBox(bed);
        // Ignore height: the bed is a plane and the model stands on it.
        footprint.min.y = -Infinity;
        footprint.max.y = Infinity;
        const on = footprint.containsBox(objectBox);
        expect(on, `object ${objectId} (plate ${plateId}) on plate ${index}`).toBe(
          index === plateId,
        );
      }
    }
  }, 30000);
});
