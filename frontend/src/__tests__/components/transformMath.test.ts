/**
 * Tests for the bed ↔ three.js transform conversion behind the placement
 * gizmos (#25, step-8.1).
 *
 * This is the part of step-8 that can be wrong *silently*: an axis swapped or
 * a rotation sign flipped still produces a viewport that moves when you drag
 * it, and the mistake only surfaces as a print that came out mirrored or
 * turned. So the conversion is checked against hand-computed points rather
 * than only round-tripped — a round trip agrees with itself even when both
 * directions are wrong the same way.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  autoArrangeTransforms,
  bedRotationToQuaternion,
  layFlatTransform,
  objectNodeToTransform,
  quaternionToBedRotation,
  roundTransform,
  swapYZ,
  transformToObjectNode,
  transformsEqual,
  type ObjectMetrics,
} from '../../components/slicer/transformMath';
import type { ObjectTransform, StageObject } from '../../types/plateStage';

function transform(partial: Partial<ObjectTransform> = {}): ObjectTransform {
  return {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    ...partial,
  };
}

describe('bed ↔ three.js conversion', () => {
  it('swaps Y and Z, and is its own inverse', () => {
    expect(swapYZ([1, 2, 3])).toEqual([1, 3, 2]);
    expect(swapYZ(swapYZ([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it('turns a bed-Z rotation into a rotation about the viewport vertical', () => {
    // 45° about the bed's vertical axis takes the bed point (1, 0, 0) to
    // (cos45, sin45, 0). In three.js space those are (1, 0, 0) and
    // (cos45, 0, sin45) — the same physical turn, expressed Y-up.
    const quaternion = bedRotationToQuaternion([0, 0, 45]);
    const rotated = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);

    expect(rotated.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(rotated.y).toBeCloseTo(0, 6);
    expect(rotated.z).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('turns a bed-X rotation into one that stands the object up, not over', () => {
    // 90° about bed X takes bed (0, 1, 0) — "back" — to (0, 0, 1), "up".
    // Bed (0, 1, 0) is three (0, 0, 1); bed (0, 0, 1) is three (0, 1, 0).
    const quaternion = bedRotationToQuaternion([90, 0, 0]);
    const rotated = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);

    expect(rotated.x).toBeCloseTo(0, 6);
    expect(rotated.y).toBeCloseTo(1, 6);
    expect(rotated.z).toBeCloseTo(0, 6);
  });

  it('round-trips a compound rotation', () => {
    const original: [number, number, number] = [12, -34, 56];
    const back = quaternionToBedRotation(bedRotationToQuaternion(original));
    back.forEach((value, axis) => expect(value).toBeCloseTo(original[axis], 6));
  });

  it('produces a proper rotation, not a reflection', () => {
    // The bed↔three change of basis is a reflection; conjugating by it must
    // not leak that reflection into the object, or the model prints mirrored.
    const matrix = new THREE.Matrix4().makeRotationFromQuaternion(
      bedRotationToQuaternion([30, 40, 50]),
    );
    expect(matrix.determinant()).toBeCloseTo(1, 6);
  });
});

describe('object node placement', () => {
  const pivot: [number, number, number] = [128, 0, 128];

  it('parks an unchanged object exactly on its anchor', () => {
    const node = transformToObjectNode(transform(), pivot);
    expect(node.position).toEqual([128, 0, 128]);
    expect(node.scale).toEqual([1, 1, 1]);
    expect(node.quaternion.equals(new THREE.Quaternion())).toBe(true);
  });

  it('offsets by the delta, in three.js axis order', () => {
    // A +10 mm move along the bed's Y ("back") is a +10 move along three's Z.
    const node = transformToObjectNode(transform({ position: [5, 10, 2] }), pivot);
    expect(node.position).toEqual([133, 2, 138]);
  });

  it('round-trips a node back to the transform that produced it', () => {
    const original = transform({ position: [12.5, -4, 3], rotation: [0, 0, 90], scale: [1, 1, 2] });
    const node = transformToObjectNode(original, pivot);

    const read = objectNodeToTransform(
      {
        position: new THREE.Vector3(...node.position),
        quaternion: node.quaternion,
        scale: new THREE.Vector3(...node.scale),
      },
      pivot,
    );

    expect(read.position).toEqual(original.position);
    expect(read.scale).toEqual(original.scale);
    read.rotation.forEach((value, axis) => expect(value).toBeCloseTo(original.rotation[axis], 4));
  });
});

describe('roundTransform', () => {
  it('rounds away the float dust a gizmo drag leaves behind', () => {
    const rounded = roundTransform({
      position: [1.0000000000000002, 0, 0],
      rotation: [0, 0, 0],
      scale: [0.9999999999999998, 1, 1],
    });
    // Not cosmetic: these values reach `selectionFingerprint`, so dust means a
    // completed slice stays invalidated after a drag that changed nothing.
    expect(transformsEqual(rounded, transform({ position: [1, 0, 0] }))).toBe(true);
  });

  it('never keeps a negative zero', () => {
    const rounded = roundTransform({ position: [-0.001, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(Object.is(rounded.position[0], -0)).toBe(false);
  });

  it('folds equivalent angles together so 370° and 10° are one arrangement', () => {
    expect(roundTransform(transform({ rotation: [370, -450, 180] })).rotation).toEqual([10, -90, 180]);
  });
});

describe('layFlatTransform', () => {
  it('removes tilt and drops the object back onto the bed', () => {
    const flat = layFlatTransform(transform({ position: [10, 20, 30], rotation: [37, -12, 45] }));
    expect(flat.rotation).toEqual([0, 0, 45]);
    expect(flat.position).toEqual([10, 20, 0]);
  });

  it('leaves an already-flat object alone, so the button cannot invalidate a slice', () => {
    const already = transform({ position: [10, 20, 0], rotation: [0, 0, 45] });
    expect(transformsEqual(layFlatTransform(already), already)).toBe(true);
  });
});

describe('autoArrangeTransforms', () => {
  const buildVolume = { x: 256, y: 256 };

  function object(id: string, t: Partial<ObjectTransform> = {}): StageObject {
    return { id, transform: transform(t) };
  }

  const metrics = (entries: Record<string, [number, number]>): Record<string, ObjectMetrics> =>
    Object.fromEntries(
      Object.entries(entries).map(([id, anchor]) => [
        id,
        { anchor: [anchor[0], anchor[1], 0], size: [40, 40, 40] } as ObjectMetrics,
      ]),
    );

  it('centres a single object on the bed', () => {
    const arranged = autoArrangeTransforms(
      [object('2')],
      metrics({ '2': [10, 10] }),
      buildVolume,
    );
    // `position` is a delta, so the anchor comes back off the target.
    expect(arranged['2'].position[0]).toBeCloseTo(118, 6);
    expect(arranged['2'].position[1]).toBeCloseTo(118, 6);
  });

  it('spreads objects out without overlapping their footprints', () => {
    const objects = [object('2'), object('3'), object('4')];
    const anchors = metrics({ '2': [0, 0], '3': [0, 0], '4': [0, 0] });
    const arranged = autoArrangeTransforms(objects, anchors, buildVolume);

    const xs = objects.map((o) => arranged[o.id].position[0]);
    const gaps = xs.slice(1).map((x, i) => Math.abs(x - xs[i]));
    // Footprint is 40 mm; every neighbour has to clear that.
    for (const gap of gaps) expect(gap).toBeGreaterThan(40);
  });

  it('is idempotent — arranging an arrangement changes nothing', () => {
    const objects = [object('2'), object('3')];
    const anchors = metrics({ '2': [0, 0], '3': [0, 0] });

    const first = autoArrangeTransforms(objects, anchors, buildVolume);
    const moved = objects.map((o) => ({ ...o, transform: first[o.id] }));
    const second = autoArrangeTransforms(moved, anchors, buildVolume);

    for (const o of objects) expect(transformsEqual(second[o.id], first[o.id])).toBe(true);
  });

  it('does not depend on the order objects arrive in', () => {
    const anchors = metrics({ '2': [0, 0], '3': [0, 0] });
    const forwards = autoArrangeTransforms([object('2'), object('3')], anchors, buildVolume);
    const backwards = autoArrangeTransforms([object('3'), object('2')], anchors, buildVolume);
    expect(backwards['2']).toEqual(forwards['2']);
    expect(backwards['3']).toEqual(forwards['3']);
  });

  it('keeps rotation and scale — arrange places, it does not reset', () => {
    const arranged = autoArrangeTransforms(
      [object('2', { rotation: [0, 0, 45], scale: [2, 2, 2] })],
      metrics({ '2': [0, 0] }),
      buildVolume,
    );
    expect(arranged['2'].rotation).toEqual([0, 0, 45]);
    expect(arranged['2'].scale).toEqual([2, 2, 2]);
  });

  it('still arranges when nothing has been measured yet', () => {
    const arranged = autoArrangeTransforms([object('2'), object('3')], {}, buildVolume);
    expect(arranged['2'].position[0]).not.toBe(arranged['3'].position[0]);
  });
});
