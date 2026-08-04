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
 * `Metadata/project_settings.config` is the original's, carried over whole
 * (#41): its `printable_area` is the bed Studio strode the plate grid by, and
 * the grid test below is meaningless without it.
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
import { plateGridOrigin } from '../../components/slicer/plateGrid';
import { UNSET_SLOT_COLOR } from '../../components/slicer/filamentSlots';

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

/**
 * A palette with one visibly distinct colour per slot, index 0 = slot 1 (#42).
 *
 * Deliberately *not* a gradient: an off-by-one in the palette lookup has to be
 * unmistakable in the failure message, and "expected #0000ff, got #00ff00"
 * says more than two neighbouring shades of the same hue would.
 */
const SLOT_1 = '#ff0000';
const SLOT_2 = '#00ff00';
const SLOT_3 = '#0000ff';
const SLOT_4 = '#ffff00';
const PALETTE = [SLOT_1, SLOT_2, SLOT_3, SLOT_4];

/** Sorted, so an expectation states a set rather than a traversal order. */
const sorted = (colors: string[]): string[] => [...new Set(colors)].sort();

/** The distinct material colours under `node`, as sorted lowercase hex. */
function meshColors(node: THREE.Object3D): string[] {
  const colors: string[] = [];
  node.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    colors.push(`#${(mesh.material as THREE.MeshPhongMaterial).color.getHexString()}`);
  });
  return sorted(colors);
}

/**
 * What `meshColors` must return for an object: `PALETTE` looked up by the
 * extruders its meshes actually carry.
 *
 * Derived from the parsed meshes rather than hard-coded, so this expectation
 * cannot drift from the per-part extruders the `#40` test above pins — those
 * are the assertion of record for *which* extruder each part uses; this one is
 * only about the colour that extruder number selects.
 */
function expectedColors(data: Parsed3MFData, objectId: string): string[] {
  const extruders = new Set(data.objects.get(objectId)!.meshes.map((mesh) => mesh.extruder));
  return sorted([...extruders].map((extruder) => PALETTE[extruder] ?? UNSET_SLOT_COLOR));
}

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

  it('reads the bed the project was authored for', () => {
    // `printable_area` in `Metadata/project_settings.config`, verbatim from the
    // owner's file: a Bambu Lab H2S. #41 strides the plate grid by this, not by
    // whatever printer happens to be selected in the rail — the offsets are
    // already baked into the transforms above, and Studio computed them against
    // *this* bed.
    expect(parsed.bedSize).toEqual({ x: 340, y: 320 });
  });

  it("puts every plate's objects inside its own bed on Studio's grid (#41)", () => {
    // **The assertion #41 stands on.** The file lays all eight plates out in
    // one shared space; `plateGrid` reconstructs where each bed goes from
    // nothing but the plate number and the bed size. If the two disagree the
    // models float between the plates — visually indistinguishable from the #40
    // defect this epic started with.
    const bed = parsed.bedSize!;
    for (const [plateId, objectIds] of Object.entries(EXPECTED_PLATES)) {
      const cell = plateGridOrigin(Number(plateId), bed);
      for (const objectId of objectIds) {
        const { box } = EXPECTED[objectId];
        // three.js x is the file's x; three.js z is the file's y.
        const label = `plate ${plateId} object ${objectId}`;
        expect(box.min[0] - cell.x, `${label} min x`).toBeGreaterThanOrEqual(0);
        expect(box.max[0] - cell.x, `${label} max x`).toBeLessThanOrEqual(bed.x);
        expect(box.min[2] - cell.y, `${label} min y`).toBeGreaterThanOrEqual(0);
        expect(box.max[2] - cell.y, `${label} max y`).toBeLessThanOrEqual(bed.y);
      }
    }
  });

  it('splits an object into one mesh per extruder so #42 can colour them', () => {
    const { group } = buildModelGroup(parsed, 1);
    const meshes: THREE.Mesh[] = [];
    nodeFor(group, '16').traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
    });
    expect(meshes).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // #42 — the slot colours actually reaching the geometry
  // -------------------------------------------------------------------------

  it('paints every plate at once, each mesh from its own slot (#42)', () => {
    // `selectedPlateId: null` is the #41 scene: all eight plates in one go.
    // Each object's material colours must be exactly the palette entries its
    // extruders name — no more, no fewer, on every plate simultaneously.
    const { group } = buildModelGroup(parsed, null, PALETTE);
    expect(group.children).toHaveLength(16);
    for (const objectId of Object.keys(EXPECTED)) {
      expect(meshColors(nodeFor(group, objectId)), `object ${objectId}`).toEqual(
        expectedColors(parsed, objectId),
      );
    }
  });

  it('indexes the palette by slot with no off-by-one (#42)', () => {
    // **The assertion the ticket asks for by name.** Extruders are 1-based in
    // the file and 0-based by the time `buildModelGroup` sees them, so
    // `PALETTE[0]` is slot 1. The body prints in slots 2 and 3; the floor in
    // slot 4. A shift either way is invisible on screen — every part still
    // gets *a* colour from the list — so it is pinned numerically here.
    const { group } = buildModelGroup(parsed, null, PALETTE);
    // Object 16 = "body", extruders [1, 2] -> slots 2 and 3.
    expect(meshColors(nodeFor(group, '16'))).toEqual(sorted([SLOT_2, SLOT_3]));
    expect(meshColors(nodeFor(group, '16'))).not.toContain(SLOT_1);
    expect(meshColors(nodeFor(group, '16'))).not.toContain(SLOT_4);
    // Object 18 = "floor", extruder [3] -> slot 4, the last one.
    expect(meshColors(nodeFor(group, '18'))).toEqual([SLOT_4]);
    // Object 31, extruders [0, 2] -> slots 1 and 3. The only object in the
    // file that reaches slot 1, so it is what distinguishes "indexed by slot"
    // from "everything shifted down one".
    expect(meshColors(nodeFor(group, '31'))).toEqual(sorted([SLOT_1, SLOT_3]));
  });

  it('keeps the same colours when a single plate is rendered (#42)', () => {
    for (const [plateId, objectIds] of Object.entries(EXPECTED_PLATES)) {
      const { group } = buildModelGroup(parsed, Number(plateId), PALETTE);
      for (const objectId of objectIds) {
        expect(
          meshColors(nodeFor(group, objectId)),
          `plate ${plateId} object ${objectId}`,
        ).toEqual(expectedColors(parsed, objectId));
      }
    }
  });

  it('does not let a slot the plate never uses shift the ones it does (#42)', () => {
    // Plate 1 paints with slots 2 and 3 only. Recolouring slot 1 — which
    // nothing on that plate uses — must leave it pixel-identical.
    const recoloured = [...PALETTE];
    recoloured[0] = '#ff00ff';
    const before = buildModelGroup(parsed, 1, PALETTE).group;
    const after = buildModelGroup(parsed, 1, recoloured).group;
    for (const objectId of EXPECTED_PLATES[1]) {
      expect(meshColors(nodeFor(after, objectId)), `object ${objectId}`).toEqual(
        meshColors(nodeFor(before, objectId)),
      );
      expect(meshColors(nodeFor(after, objectId))).not.toContain('#ff00ff');
    }
  });

  it('gives an extruder past the end of the list the neutral, not slot 1 (#42)', () => {
    // A two-slot list against a plate that paints with four. The parts it does
    // not reach must read as "no filament here" — the same neutral the rail
    // fills an unset badge with — rather than silently wrapping onto slot 1's
    // colour or falling back to the as-designed green.
    const { group } = buildModelGroup(parsed, null, [SLOT_1, SLOT_2]);
    // Object 18's only extruder is 3, i.e. slot 4, which the list has no entry for.
    expect(meshColors(nodeFor(group, '18'))).toEqual([UNSET_SLOT_COLOR]);
    // Object 16 spans both sides of the boundary: slot 2 is supplied, slot 3 is not.
    expect(meshColors(nodeFor(group, '16'))).toEqual(sorted([SLOT_2, UNSET_SLOT_COLOR]));
  });

  it('still uses the as-designed green when given no colours at all (#42)', () => {
    // Unchanged behaviour, pinned because the neutral above is a *new* branch:
    // a viewer with no slot state — `ModelViewerModal` against a printer with
    // no reported AMS colours — must keep the green it has always drawn.
    const { group } = buildModelGroup(parsed, null);
    expect(meshColors(nodeFor(group, '16'))).toEqual(['#00ae42']);
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

/**
 * A rotation of `deg` about the file's X axis, plus a translation, written the
 * way 3MF writes it (#54).
 *
 * 3MF uses the **row-vector** convention: `v' = v · M`, so consecutive triples
 * of the attribute are the *rows* of M. THREE.js is column-vector (`v' = M · v`)
 * and needs the transpose. A rotation's transpose is its inverse, so loading
 * the triples as rows spins the part the wrong way — which is the whole defect.
 *
 * Note the linear part written here is Rᵀ of the column-vector rotation
 * `[[1,0,0],[0,c,-s],[0,s,c]]`, exactly as Bambu Studio emits it.
 */
const rotateX = (deg: number, x: number, y: number, z: number) => {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return `1 0 0 0 ${c} ${s} 0 ${-s} ${c} ${x} ${y} ${z}`;
};

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

  it('reports no bed size for a file that does not carry one', async () => {
    // A hand-rolled or converted 3MF has no `project_settings.config`. The grid
    // then falls back to the selected printer's build volume rather than
    // guessing a bed — see `ModelViewer`.
    const parsed = await parse3MF(await fixture());
    expect(parsed.bedSize).toBeNull();
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

// ---------------------------------------------------------------------------
// #54 — the 3x3 linear part's convention
// ---------------------------------------------------------------------------

/**
 * The owner's report: "some parts lay flat in Bambu Studio but are rotated and
 * stuck in the floor in Bambuddy."
 *
 * `parseTransform3MF` loaded the 3MF transform's consecutive triples as the
 * *rows* of the THREE.js linear block. 3MF writes them under the row-vector
 * convention (`v' = v · M`) and THREE.js is column-vector (`v' = M · v`), so
 * they are the *columns* — the load was transposed. For a rotation the
 * transpose is the inverse, so a part Studio turned by R was drawn turned by
 * R⁻¹, while the translation (which was read correctly) still assumed R. The
 * backend reads the same attribute the right way round already:
 * `plate_layout.py::_parse_transform`, `L[i][j] = v[3 * j + i]`.
 *
 * ## Why the fixture above cannot catch this
 *
 * Not because its transforms are identity — eleven of the Attractap build
 * items carry a real rotation about X. It is because every part file's mesh is
 * centred on its own origin (object 17's bounds are exactly
 * ±[41.8, 78.28, 42.37]), and the axis-aligned bounds of an origin-symmetric
 * box are identical under R and Rᵀ. So the geometry there is blind to the
 * transpose, and the boxes in `EXPECTED` hold under either convention.
 *
 * The fixtures below are therefore deliberately **asymmetric about every
 * axis**, and use −90° about X, where R and Rᵀ = R⁻¹ are +90° apart.
 */
describe('parse3MF — a rotated transform is not loaded transposed (#54)', () => {
  /** Asymmetric about all three axes, with its minimum at the local origin. */
  const LOCAL_MIN: [number, number, number] = [0, 0, 0];
  const LOCAL_MAX: [number, number, number] = [2, 4, 6];

  /**
   * Where that box must land, in three.js space (y is the file's z, z is the
   * file's y), after −90° about X and a translation of (100, 50, 10).
   *
   * Worked out from the 3MF spec rather than from this parser: −90° about X
   * maps (x, y, z) -> (x, z, −y), so local [0,0,0]..[2,4,6] becomes
   * [0,0,−4]..[2,6,0] in file space, then +(100, 50, 10) gives
   * [100,50,6]..[102,56,10]. Swapping y/z for three.js gives the below.
   *
   * The transposed (old) load applies +90° instead — (x, y, z) -> (x, −z, y) —
   * and puts the same box at min [100, 10, 44], max [102, 14, 50]: unchanged on
   * X, which the rotation does not touch, and out by 4 mm and 6 mm on the two
   * axes it does. `MM` is 0.1, so either axis alone fails it.
   */
  const EXPECTED_BOX: WorldBox = { min: [100, 6, 50], max: [102, 10, 56] };

  async function zipOf(root: string): Promise<ArrayBuffer> {
    const zip = new JSZip();
    zip.file('3D/3dmodel.model', root);
    return (await zip.generateAsync({ type: 'uint8array' })) as unknown as ArrayBuffer;
  }

  it('rotates a build item the way the file says, not the inverse way', async () => {
    const root =
      MODEL_OPEN +
      '<resources>' +
      `<object id="1" type="model">${boxMesh(LOCAL_MIN, LOCAL_MAX)}</object>` +
      '</resources>' +
      `<build><item objectid="1" transform="${rotateX(-90, 100, 50, 10)}"/></build></model>`;

    const parsed = await parse3MF(await zipOf(root));
    const { group } = buildModelGroup(parsed, null);
    expectBox(nodeFor(group, '1'), EXPECTED_BOX, 'rotated build item');
  });

  it('rotates a component transform the same way', async () => {
    // The other call site into `parseTransform3MF`: the rotation is on the
    // `<component>` and only a translation on the `<item>`, which has to
    // compose to the identical placement.
    const root =
      MODEL_OPEN +
      '<resources>' +
      `<object id="2" type="model">${boxMesh(LOCAL_MIN, LOCAL_MAX)}</object>` +
      '<object id="1" type="model"><components>' +
      `<component objectid="2" transform="${rotateX(-90, 0, 0, 0)}"/>` +
      '</components></object>' +
      '</resources>' +
      `<build><item objectid="1" transform="${translate(100, 50, 10)}"/></build></model>`;

    const parsed = await parse3MF(await zipOf(root));
    const { group } = buildModelGroup(parsed, null);
    expectBox(nodeFor(group, '1'), EXPECTED_BOX, 'rotated component');
  });

  it('keeps a part the file lays flat on the bed flat on the bed', async () => {
    // The owner's actual symptom, stated as geometry. The file rotates a slab
    // spanning [0,−20,0]..[60,4,20] by −90° about X and lifts it by 4 so it
    // rests exactly on z=0. Read transposed it tips the other way and 16 mm of
    // it ends up below the bed — "stuck in the floor".
    const root =
      MODEL_OPEN +
      '<resources>' +
      `<object id="1" type="model">${boxMesh([0, -20, 0], [60, 4, 20])}</object>` +
      '</resources>' +
      `<build><item objectid="1" transform="${rotateX(-90, 10, 10, 4)}"/></build></model>`;

    const parsed = await parse3MF(await zipOf(root));
    const { group } = buildModelGroup(parsed, null);
    // Correct: (x,y,z) -> (x,z,−y) gives file z in [−4,20], +4 -> [0,24].
    // Transposed: (x,y,z) -> (x,−z,y) gives file z in [−20,4], +4 -> [−16,8].
    // three.js y is the file's z.
    const box = new THREE.Box3().setFromObject(nodeFor(group, '1'));
    expect(box.min.y, 'lowest point sits on z=0, not below it').toBeCloseTo(0, 3);
    expect(box.max.y).toBeCloseTo(24, 3);
  });

  it('leaves a pure translation alone', async () => {
    // The translation triple was always read correctly and must stay that way:
    // transposing only the 3x3 must not have been "fixed" by moving values[9..11].
    const root =
      MODEL_OPEN +
      '<resources>' +
      `<object id="1" type="model">${boxMesh(LOCAL_MIN, LOCAL_MAX)}</object>` +
      '</resources>' +
      `<build><item objectid="1" transform="${translate(100, 50, 10)}"/></build></model>`;

    const parsed = await parse3MF(await zipOf(root));
    const { group } = buildModelGroup(parsed, null);
    expectBox(
      nodeFor(group, '1'),
      { min: [100, 10, 50], max: [102, 16, 54] },
      'translated build item',
    );
  });
});
