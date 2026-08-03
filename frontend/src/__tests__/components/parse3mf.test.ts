/**
 * Regression tests for the 3MF parser in `ModelViewer` (#40).
 *
 * ## The defect these pin down
 *
 * Bambu Studio writes a "split model" 3MF: the root `3D/3dmodel.model` carries
 * no geometry at all. Every `<object>` there is a `<components>` container, and
 * each `<component p:path="/3D/Objects/object_N.model" objectid="K"/>` picks
 * *one* object out of a part file that holds many.
 *
 * The parser used to load the referenced file and take
 * `getElementsByTagName('mesh')` from it — i.e. **every** mesh in the file,
 * ignoring `objectid`. So each component dragged in all of its siblings and
 * stamped them at its own component transform. In the reference file
 * `Attractap - V3 with Logo.3mf`, object 16 ("body") has 15 components that all
 * point into `object_25.model`, so the 26,924-triangle body was emitted 15
 * times, once at each logo part's offset. Across the file that turned 292,460
 * triangles into 3,169,500 — the "single enormous fused slab" the owner saw,
 * instead of discrete parts.
 *
 * ## The fixture
 *
 * `fixtures/attractap-v3-reduced.3mf` **is** the owner's reference file, with
 * every mesh in the part files replaced by an 8-vertex box spanning that mesh's
 * original bounding box. Structure, transforms, `model_settings.config`, plate
 * assignments and per-part extruders are byte-for-byte the original; only the
 * triangle soup is gone, which takes it from 2.5 MB to 17 KB and lets it be
 * committed. Bounding boxes are preserved exactly, so the world-position
 * assertions below are the real placements Bambu Studio renders.
 *
 * Expected values were computed independently of this parser, straight from the
 * XML, so they pin behaviour rather than restating the implementation.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import * as THREE from 'three';
import { parse3MF, buildModelGroup, type Parsed3MFData } from '../../components/slicer/parse3mf';

// Relative to the vitest root (`frontend/`). `import.meta.url` is an http URL
// under the jsdom environment, so it cannot be resolved to a path here.
const FIXTURE = resolve(process.cwd(), 'src/__tests__/fixtures/attractap-v3-reduced.3mf');

/**
 * JSZip identity-checks `ArrayBuffer` against its own realm's global, and an
 * `ArrayBuffer` produced from a Node `Buffer` fails that check under jsdom. A
 * `Uint8Array` is accepted by both, and in the browser this argument is a real
 * `ArrayBuffer` straight off `fetch`.
 */
function readFixture(path: string): ArrayBuffer {
  return new Uint8Array(readFileSync(path)) as unknown as ArrayBuffer;
}

/**
 * Placement tolerance in millimetres. Geometry is stored in a `Float32Array`,
 * and these coordinates run past 1000 mm, where float32 spacing is ~0.06 mm.
 * The defect displaced parts by tens of millimetres.
 */
const MM = 0.1;

interface WorldBox {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Per root object: component count, and the world bounding box in three.js
 * space after its build item's transform.
 *
 * three.js is Y-up and 3MF is Z-up, so the y component here is the file's Z and
 * the z component is the file's Y. `buildModelGroup` emits geometry in the
 * file's own coordinates; the plate-centring translation is applied later by
 * the component, and is deliberately not part of this.
 */
const EXPECTED: Record<string, { components: number; box: WorldBox }> = {
  16: { components: 15, box: { min: [125.900, 0.000, 80.420], max: [214.100, 19.000, 239.580] } },
  18: { components: 1, box: { min: [170.500, -66.927, -675.002], max: [254.100, 84.744, -497.045] } },
  20: { components: 1, box: { min: [965.970, -38.640, 80.814], max: [1049.570, 47.867, 243.497] } },
  21: { components: 1, box: { min: [85.900, -38.640, -673.305], max: [169.500, 47.867, -510.623] } },
  31: { components: 9, box: { min: [556.250, 0.000, 139.400], max: [599.750, 9.611, 180.600] } },
  33: { components: 1, box: { min: [158.949, -6.630, -700.467], max: [201.489, 11.491, -671.020] } },
  34: { components: 1, box: { min: [922.430, -6.630, 154.237], max: [964.970, 11.491, 183.685] } },
  35: { components: 1, box: { min: [115.408, -6.630, -700.226], max: [157.949, 11.491, -670.779] } },
  37: { components: 15, box: { min: [125.900, 0.000, -303.580], max: [214.100, 19.000, -144.420] } },
  53: { components: 15, box: { min: [125.900, 0.000, 80.420], max: [214.100, 19.000, 239.580] } },
  63: { components: 9, box: { min: [556.250, 0.000, 139.400], max: [599.750, 9.611, 180.600] } },
  65: { components: 15, box: { min: [125.900, 0.000, -303.580], max: [214.100, 19.000, -144.420] } },
  67: { components: 15, box: { min: [533.900, 0.000, -303.580], max: [622.100, 19.000, -144.420] } },
  68: { components: 1, box: { min: [964.451, -66.927, -308.691], max: [1048.051, 84.744, -130.733] } },
  69: { components: 1, box: { min: [920.911, -6.630, -231.936], max: [963.451, 11.491, -202.489] } },
  71: { components: 15, box: { min: [533.901, 0.000, -687.580], max: [622.101, 19.000, -528.420] } },
};

/** `model_settings.config`'s plate -> object assignment, verbatim. */
const EXPECTED_PLATES: Record<number, string[]> = {
  1: ['16', '53'],
  2: ['31', '63'],
  3: ['20', '34'],
  4: ['37', '65'],
  5: ['67'],
  6: ['68', '69'],
  7: ['18', '21', '33', '35'],
  8: ['71'],
};

function nodeFor(group: THREE.Group, objectId: string): THREE.Object3D {
  const node = group.children.find((child) => child.userData.objectId === objectId);
  expect(node, `no node rendered for object ${objectId}`).toBeDefined();
  return node!;
}

function expectBox(node: THREE.Object3D, expected: WorldBox, label: string) {
  const box = new THREE.Box3().setFromObject(node);
  const actual: WorldBox = {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
  for (let axis = 0; axis < 3; axis++) {
    expect(
      Math.abs(actual.min[axis] - expected.min[axis]),
      `${label} min[${axis}]: expected ${expected.min[axis]}, got ${actual.min[axis]}`,
    ).toBeLessThan(MM);
    expect(
      Math.abs(actual.max[axis] - expected.max[axis]),
      `${label} max[${axis}]: expected ${expected.max[axis]}, got ${actual.max[axis]}`,
    ).toBeLessThan(MM);
  }
}

describe('parse3MF — Attractap V3, a real multi-plate split-model 3MF', () => {
  let parsed: Parsed3MFData;

  beforeAll(async () => {
    parsed = await parse3MF(readFixture(FIXTURE));
  }, 30000);

  it('parses every object in the file', () => {
    expect([...parsed.objects.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(parsed.objects.size).toBe(16);
    expect(parsed.buildItems).toHaveLength(16);
  });

  it('gives each object exactly one mesh per component', () => {
    // This is the #40 assertion. Each `<component>` names one object inside a
    // shared part file; the old parser returned every object in that file, so
    // object 16 came back with 15 x 15 = 225 meshes instead of 15.
    for (const [objectId, { components }] of Object.entries(EXPECTED)) {
      expect(parsed.objects.get(objectId)!.meshes, `object ${objectId}`).toHaveLength(components);
    }
    const totalMeshes = [...parsed.objects.values()].reduce((n, o) => n + o.meshes.length, 0);
    expect(totalMeshes).toBe(116);
  });

  it('emits the file\'s real triangle count, not a multiplied one', () => {
    // Every mesh in the fixture is a 12-triangle box, so the count is a direct
    // proxy for duplication: 116 components -> 1392. Before the fix the same
    // structure yielded 1416 boxes' worth, and the unreduced file went from
    // 292,460 triangles to 3,169,500.
    const triangles = [...parsed.objects.values()].reduce(
      (n, o) => n + o.meshes.reduce((m, mesh) => m + mesh.triangles.length / 3, 0),
      0,
    );
    expect(triangles).toBe(116 * 12);
  });

  it('places every object at the world position its build item specifies', () => {
    // No plate selected: the whole file at once, which is also what #41 needs.
    const { group } = buildModelGroup(parsed, null);
    expect(group.children).toHaveLength(16);
    for (const [objectId, { box }] of Object.entries(EXPECTED)) {
      expectBox(nodeFor(group, objectId), box, `object ${objectId}`);
    }
  });

  it('keeps those positions when a single plate is rendered', () => {
    for (const [plateId, objectIds] of Object.entries(EXPECTED_PLATES)) {
      const { group } = buildModelGroup(parsed, Number(plateId));
      expect(
        group.children.map((child) => child.userData.objectId as string).sort(),
        `plate ${plateId}`,
      ).toEqual([...objectIds].sort());
      for (const objectId of objectIds) {
        expectBox(nodeFor(group, objectId), EXPECTED[objectId].box, `plate ${plateId} object ${objectId}`);
      }
    }
  });

  it('assigns each object to the plate model_settings.config puts it on', () => {
    for (const [plateId, objectIds] of Object.entries(EXPECTED_PLATES)) {
      for (const objectId of objectIds) {
        expect(parsed.objects.get(objectId)!.plateId, `object ${objectId}`).toBe(Number(plateId));
      }
    }
  });

  it('resolves per-part extruders rather than painting an object uniformly', () => {
    // The body is one object whose logo parts print in a different filament.
    // Extruders are 1-based in the file and 0-based here. The old parser gave
    // every mesh the extruder of whichever component happened to pull it in.
    const body = parsed.objects.get('16')!;
    expect(new Set(body.meshes.map((mesh) => mesh.extruder))).toEqual(new Set([1, 2]));
    // The floor prints entirely in filament 4 and has a single part.
    expect(parsed.objects.get('18')!.meshes.map((mesh) => mesh.extruder)).toEqual([3]);
  });

  it('splits an object into one mesh per extruder so #42 can colour them', () => {
    const { group } = buildModelGroup(parsed, 1);
    const meshes: THREE.Mesh[] = [];
    nodeFor(group, '16').traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
    });
    expect(meshes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Structural cases the reference file does not exercise
// ---------------------------------------------------------------------------

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PROD_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

/** An axis-aligned box as 8 vertices / 12 triangles, in 3MF (Z-up) space. */
function boxMesh(min: [number, number, number], max: [number, number, number]): string {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const corners = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  return [
    '<mesh><vertices>',
    ...corners.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`),
    '</vertices><triangles>',
    ...faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`),
    '</triangles></mesh>',
  ].join('');
}

const translate = (x: number, y: number, z: number) => `1 0 0 0 1 0 0 0 1 ${x} ${y} ${z}`;
const MODEL_OPEN =
  `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PROD_NS}">`;

describe('parse3MF — nested and same-file component references', () => {
  /**
   * Neither case appears in the Attractap file, but both are legal 3MF and both
   * would have been silently dropped: components were only followed when they
   * carried a `p:path`, and never recursively.
   */
  async function fixture(): Promise<ArrayBuffer> {
    const part =
      MODEL_OPEN +
      '<resources>' +
      // "1" is a components object wrapping "2" — the parser has to recurse.
      `<object id="1" type="model"><components>` +
      `<component objectid="2" transform="${translate(0, 0, 5)}"/>` +
      '</components></object>' +
      `<object id="2" type="model">${boxMesh([-1, -1, 0], [1, 1, 2])}</object>` +
      '</resources><build/></model>';
    const root =
      MODEL_OPEN +
      '<resources>' +
      // "9" lives in the root model and is referenced with no p:path at all.
      `<object id="9" type="model">${boxMesh([-2, -2, 0], [2, 2, 4])}</object>` +
      '<object id="10" type="model"><components>' +
      `<component p:path="/3D/Objects/object_1.model" objectid="1" transform="${translate(20, 0, 0)}"/>` +
      `<component objectid="9" transform="${translate(-20, 0, 0)}"/>` +
      '</components></object>' +
      '</resources>' +
      `<build><item objectid="10" transform="${translate(100, 100, 0)}"/></build></model>`;

    const zip = new JSZip();
    zip.file('3D/3dmodel.model', root);
    zip.file('3D/Objects/object_1.model', part);
    return (await zip.generateAsync({ type: 'uint8array' })) as unknown as ArrayBuffer;
  }

  it('follows a nested components object and composes both transforms', async () => {
    const parsed = await parse3MF(await fixture());
    expect(parsed.objects.get('10')!.meshes).toHaveLength(2);

    const { group } = buildModelGroup(parsed, null);
    // Nested box: local [-1,-1,0]..[1,1,2], lifted z+5 by the inner component,
    // shifted x+20 by the outer one, then x+100 y+100 by the build item.
    // Same-file box: [-2,-2,0]..[2,2,4], shifted x-20, then x+100 y+100.
    // In three.js space (y is the file's z, z is the file's y):
    expectBox(
      nodeFor(group, '10'),
      { min: [78.0, 0.0, 98.0], max: [121.0, 7.0, 102.0] },
      'nested + same-file object 10',
    );
  });

  it('does not fall over on a component cycle', async () => {
    const root =
      MODEL_OPEN +
      '<resources>' +
      '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
      '<object id="2" type="model"><components><component objectid="1"/></components></object>' +
      `<object id="3" type="model">${boxMesh([0, 0, 0], [1, 1, 1])}</object>` +
      '</resources>' +
      '<build><item objectid="1"/><item objectid="3"/></build></model>';
    const zip = new JSZip();
    zip.file('3D/3dmodel.model', root);
    const parsed = await parse3MF((await zip.generateAsync({ type: 'uint8array' })) as unknown as ArrayBuffer);
    // The cycle yields no geometry and so no object; the valid one still parses.
    expect([...parsed.objects.keys()]).toEqual(['3']);
  });
});
