/**
 * 3MF project parsing for the model viewer.
 *
 * Split out of `ModelViewer.tsx` so it can be unit-tested directly: eslint's
 * `react-refresh/only-export-components` rule forbids a component module from
 * exporting anything else, and this is pure data work with no React in it.
 *
 * Everything here stays in the file's own coordinate space (3MF is Z-up, and
 * `createGeometryFromMesh` is the single point where that becomes three.js's
 * Y-up). Placing the result on a bed is the viewer's job, not this module's.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import JSZip from 'jszip';
import { swapYZ, type ObjectMetrics, type Vec3 } from './transformMath';
import type { BedSize } from './plateGrid';
// The one definition of "this slot has no colour" (#45). Imported rather than
// restated so the stage's neutral and the rail badge's neutral are the same
// grey; `filamentSlots` pulls in nothing but pure helpers.
import { UNSET_SLOT_COLOR } from './filamentSlots';

export interface MeshData {
  vertices: number[];
  triangles: number[];
  extruder: number; // Per-mesh extruder index for coloring
}

export interface ObjectData {
  id: string;
  meshes: MeshData[];
  defaultExtruder: number; // Default extruder for object (used if mesh doesn't have specific one)
  plateId?: number | null;
  /**
   * Translation of this object's first `<component>` transform, in 3MF space.
   *
   * This is where a slicer-authored 3MF actually records placement — real
   * exports leave `<build><item>` on identity — so it is the anchor
   * `backend/app/services/plate_layout.py` measures a saved `position` from,
   * and the point the step-8 gizmo pivots rotation and scale about.
   */
  componentAnchor?: Vec3;
}

export interface BuildItem {
  objectId: string;
  transform: THREE.Matrix4;
  extruder?: number; // Can override object's extruder
  plateId?: number | null;
}

export interface Parsed3MFData {
  objects: Map<string, ObjectData>;
  buildItems: BuildItem[];
  plateBounds: Map<number, { minX: number; minY: number; maxX: number; maxY: number }>;
  plateOffsets: Map<number, { offsetX: number; offsetY: number }>;
  /**
   * The bed this project was authored for, from `printable_area` in
   * `Metadata/project_settings.config`; `null` when the file does not say.
   *
   * Not the same thing as the printer selected in the rail, and #41 needs
   * exactly this one: a multi-plate export bakes each plate's grid offset into
   * its build items, and the stride of that grid is a function of the bed the
   * *authoring* slicer used. See `plateGrid.ts`.
   */
  bedSize: BedSize | null;
}

// Yield to the browser event loop so the main thread can repaint, process
// user input (especially the modal's close button), and avoid the
// "page unresponsive" dialog while we crunch through large 3MFs in
// straight-line JS. setTimeout(_, 0) is sufficient — we don't need rAF
// here, the goal is just to surrender control so queued tasks run.
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Yield once per N iterations of a hot loop. Picked so each batch is
// ~5-10 ms of work on a typical desktop — fine-grained enough to keep
// frames flowing, coarse enough not to drown the loop in setTimeout
// dispatch overhead. Adjust if profiling shows otherwise.
const YIELD_EVERY_N_VERTICES = 20000;
const YIELD_EVERY_N_TRIANGLES = 20000;

// Parse 3MF transform - keep in 3MF coordinate space (Z-up)
function parseTransform3MF(transformStr: string | null): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  if (!transformStr) {
    return matrix; // Identity matrix
  }

  // A 3MF `transform` is 12 numbers, "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30
  // m31 m32", written under the **row-vector** convention: the spec's matrix
  // multiplies on the right (`v' = v · M`), so consecutive triples are the
  // *rows* of that matrix and (m30, m31, m32) is the translation.
  //
  // THREE.js is **column-vector** (`v' = M · v`), so the 3x3 linear part has to
  // be transposed on the way in: consecutive triples become the *columns* of
  // the THREE linear block. Feeding them in as rows loads the transpose, which
  // for a rotation is its inverse — the object comes out rotated the wrong way
  // while the (correctly placed) translation still assumes the authored
  // rotation, so it lands askew and often partly below z=0 (#54). An identity,
  // pure-translation or pure-scale transform is symmetric and hides this,
  // which is why only *some* parts looked wrong.
  //
  // The backend reads the same attribute the same way — see
  // `plate_layout.py::_parse_transform`, `L[i][j] = v[3 * j + i]`.
  const values = transformStr.trim().split(/\s+/).map(parseFloat);
  if (values.length >= 12) {
    // Three.js Matrix4.set takes its arguments in row-major order:
    // set(n11, n12, n13, n14, n21, n22, n23, n24, n31, n32, n33, n34, ...)
    matrix.set(
      values[0], values[3], values[6], values[9],   // m00, m10, m20, tx
      values[1], values[4], values[7], values[10],  // m01, m11, m21, ty
      values[2], values[5], values[8], values[11],  // m02, m12, m22, tz
      0, 0, 0, 1
    );
  }
  return matrix;
}

// Alias for backwards compatibility
const parseTransform = parseTransform3MF;

/** Direct children of `el` with the given tag name, ignoring any namespace prefix. */
function directChildren(el: Element, tagName: string): Element[] {
  return Array.from(el.children).filter(
    (child) => child.tagName === tagName || child.tagName.endsWith(`:${tagName}`)
  );
}

/**
 * Read the `<mesh>` elements out of `meshElements` into plain vertex/triangle arrays.
 *
 * Shared by the whole-document path (`parseMeshFromDoc`, used only by the
 * no-main-model fallback) and the object-scoped path (`parseObjectMeshes`),
 * which is what every real Bambu Studio export goes through.
 */
async function parseMeshElements(
  meshElements: Element[],
  defaultExtruder: number
): Promise<MeshData[]> {
  const meshes: MeshData[] = [];

  for (let j = 0; j < meshElements.length; j++) {
    const meshEl = meshElements[j];
    const vertices: number[] = [];
    const triangles: number[] = [];

    const vertexElements = meshEl.getElementsByTagName('vertex');
    for (let k = 0; k < vertexElements.length; k++) {
      const v = vertexElements[k];
      vertices.push(
        parseFloat(v.getAttribute('x') || '0'),
        parseFloat(v.getAttribute('y') || '0'),
        parseFloat(v.getAttribute('z') || '0')
      );
      if (k > 0 && k % YIELD_EVERY_N_VERTICES === 0) {
        await nextTick();
      }
    }

    const triangleElements = meshEl.getElementsByTagName('triangle');
    for (let k = 0; k < triangleElements.length; k++) {
      const t = triangleElements[k];
      triangles.push(
        parseInt(t.getAttribute('v1') || '0'),
        parseInt(t.getAttribute('v2') || '0'),
        parseInt(t.getAttribute('v3') || '0')
      );
      if (k > 0 && k % YIELD_EVERY_N_TRIANGLES === 0) {
        await nextTick();
      }
    }

    if (vertices.length > 0 && triangles.length > 0) {
      meshes.push({ vertices, triangles, extruder: defaultExtruder });
    }
  }
  return meshes;
}

/** Every `<mesh>` in a document, regardless of which object owns it. */
async function parseMeshFromDoc(doc: Document, defaultExtruder: number = 0): Promise<MeshData[]> {
  return parseMeshElements(Array.from(doc.getElementsByTagName('mesh')), defaultExtruder);
}

/** Only the mesh belonging to `objEl` itself — never a sibling object's. */
async function parseObjectMeshes(objEl: Element, defaultExtruder: number): Promise<MeshData[]> {
  return parseMeshElements(directChildren(objEl, 'mesh'), defaultExtruder);
}

/** Apply a 3MF-space matrix to a mesh's vertices, leaving the winding alone. */
function transformMesh(mesh: MeshData, matrix: THREE.Matrix4): MeshData {
  const vertices: number[] = new Array(mesh.vertices.length);
  const v = new THREE.Vector3();
  for (let k = 0; k < mesh.vertices.length; k += 3) {
    v.set(mesh.vertices[k], mesh.vertices[k + 1], mesh.vertices[k + 2]).applyMatrix4(matrix);
    vertices[k] = v.x;
    vertices[k + 1] = v.y;
    vertices[k + 2] = v.z;
  }
  return { vertices, triangles: mesh.triangles, extruder: mesh.extruder };
}

const PRODUCTION_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

/** The external part file a `<component>` points at, or null for a same-file reference. */
function componentPath(compEl: Element): string | null {
  return compEl.getAttribute('p:path') || compEl.getAttributeNS(PRODUCTION_NS, 'path') || null;
}

/**
 * The bed footprint from a project's `printable_area`, or `null`.
 *
 * The value is the bed outline as `"XxY"` corner strings — `["0x0", "340x0",
 * "340x320", "0x320"]` for an H2S — so the footprint is the extent of those
 * corners rather than the last one. Anything unparseable, degenerate or
 * non-rectangular-looking yields `null`, and the caller falls back to the
 * printer's own build volume.
 */
function parsePrintableArea(raw: unknown): BedSize | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const corner of raw) {
    if (typeof corner !== 'string') return null;
    const [xPart, yPart] = corner.split('x');
    const x = Number.parseFloat(xPart);
    const y = Number.parseFloat(yPart);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const x = maxX - minX;
  const y = maxY - minY;
  return x > 0 && y > 0 ? { x, y } : null;
}

function parsePlateIdFromAttributes(element: Element): number | null {
  const plateAttribute = Array.from(element.attributes).find((attr) => {
    const name = attr.name.toLowerCase();
    return (
      name === 'plate_id' ||
      name === 'plater_id' ||
      name === 'plateid' ||
      name === 'platerid' ||
      name.endsWith(':plate_id') ||
      name.endsWith(':plater_id')
    );
  });

  if (!plateAttribute?.value) return null;
  const parsed = Number.parseInt(plateAttribute.value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function parse3MF(arrayBuffer: ArrayBuffer): Promise<Parsed3MFData> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch {
    throw new Error('Unsupported file format');
  }
  const objects = new Map<string, ObjectData>();
  const buildItems: BuildItem[] = [];
  const plateBounds = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
  const plateOffsets = new Map<number, { offsetX: number; offsetY: number }>();
  let bedSize: BedSize | null = null;
  const parser = new DOMParser();

  // The authoring slicer's bed, which is what the multi-plate grid strides by
  // (#41). Read before anything else so every exit below can report it.
  const projectSettingsFile = zip.files['Metadata/project_settings.config'];
  if (projectSettingsFile) {
    try {
      const settings = JSON.parse(await projectSettingsFile.async('string')) as Record<string, unknown>;
      bedSize = parsePrintableArea(settings.printable_area);
    } catch {
      // A missing or malformed project config is not a parse failure: the
      // viewer falls back to the selected printer's build volume.
    }
  }

  // Helper to load and parse a model file from the zip
  async function loadModelFile(path: string): Promise<Document | null> {
    // Normalize path (remove leading slash)
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const file = zip.files[normalizedPath];
    if (!file) return null;
    const content = await file.async('string');
    return parser.parseFromString(content, 'application/xml');
  }

  /**
   * `<object id>` -> element, per model part file. Keyed by the zip path, with
   * `''` reserved for the root `3dmodel.model`.
   *
   * A Bambu Studio export splits geometry across `3D/Objects/object_N.model`,
   * each holding *many* `<object>`s, and the root model's `<component>`s pick
   * one out by `objectid`. So the index is what makes a component resolve to
   * its own mesh rather than the whole file's — and it is memoised because one
   * part file is routinely referenced by dozens of components across several
   * root objects (`object_25.model` is loaded 60 times by the reference file
   * `Attractap - V3 with Logo.3mf`), and re-parsing megabytes of XML per
   * reference is what made large multi-plate projects crawl.
   */
  const objectIndexByPath = new Map<string, Map<string, Element> | null>();

  function indexObjects(doc: Document): Map<string, Element> {
    const index = new Map<string, Element>();
    const elements = doc.getElementsByTagName('object');
    for (let i = 0; i < elements.length; i++) {
      const id = elements[i].getAttribute('id');
      if (id && !index.has(id)) index.set(id, elements[i]);
    }
    return index;
  }

  async function getObjectIndex(path: string): Promise<Map<string, Element> | null> {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const cached = objectIndexByPath.get(normalizedPath);
    if (cached !== undefined) return cached;
    const doc = await loadModelFile(normalizedPath);
    const index = doc ? indexObjects(doc) : null;
    objectIndexByPath.set(normalizedPath, index);
    return index;
  }

  /**
   * Meshes belonging to one referenced object, in that object's own coordinate
   * space, with nested `<components>` resolved and their transforms composed.
   *
   * `visited` guards against a malformed file whose components form a cycle,
   * which would otherwise recurse until the stack blew.
   */
  async function collectObjectMeshes(
    path: string,
    objectId: string,
    extruder: number,
    visited: Set<string>
  ): Promise<MeshData[]> {
    const key = `${path}#${objectId}`;
    if (visited.has(key)) return [];
    visited.add(key);
    try {
      const index = await getObjectIndex(path);
      const objEl = index?.get(objectId);
      if (!objEl) return [];

      const meshes = await parseObjectMeshes(objEl, extruder);

      for (const compEl of directChildren(objEl, 'components').flatMap((el) =>
        directChildren(el, 'component')
      )) {
        const nestedId = compEl.getAttribute('objectid');
        if (!nestedId) continue;
        // A component with no p:path references an object in its own file.
        const nested = await collectObjectMeshes(
          componentPath(compEl) ?? path,
          nestedId,
          extruder,
          visited
        );
        const nestedTransformStr = compEl.getAttribute('transform');
        if (!nestedTransformStr) {
          meshes.push(...nested);
        } else {
          const nestedTransform = parseTransform(nestedTransformStr);
          for (const mesh of nested) meshes.push(transformMesh(mesh, nestedTransform));
        }
      }

      return meshes;
    } finally {
      visited.delete(key);
    }
  }

  // Parse model_settings.config to get extruder assignments
  // Maps: object ID -> default extruder, and (object ID, part ID) -> part-specific extruder
  const extruderMapById = new Map<string, number>();
  const partExtruderMap = new Map<string, number>(); // Key: "objectId:partId"
  const objectNameById = new Map<string, string>();
  const plateAssignmentsByObjectId = new Map<string, number>();
  const modelSettingsFile = zip.files['Metadata/model_settings.config'];
  if (modelSettingsFile) {
    try {
      const content = await modelSettingsFile.async('string');
      const doc = parser.parseFromString(content, 'application/xml');
      const objectElements = doc.getElementsByTagName('object');
      for (let i = 0; i < objectElements.length; i++) {
        const objEl = objectElements[i];
        const objectId = objEl.getAttribute('id');
        if (!objectId) continue;

        // Find object-level extruder + name
        const directMetadata = Array.from(objEl.children).filter(
          (el) => el.tagName === 'metadata' && el.getAttribute('key') === 'extruder'
        );
        if (directMetadata.length > 0) {
          const extruderVal = directMetadata[0].getAttribute('value');
          if (extruderVal) {
            extruderMapById.set(objectId, Math.max(0, parseInt(extruderVal, 10) - 1));
          }
        }

        const nameMetadata = Array.from(objEl.children).find(
          (el) => el.tagName === 'metadata' && el.getAttribute('key') === 'name'
        );
        const objectName = nameMetadata?.getAttribute('value');
        if (objectName) {
          objectNameById.set(objectId, objectName);
        }

        // Find part-level extruders
        const partElements = objEl.getElementsByTagName('part');
        for (let j = 0; j < partElements.length; j++) {
          const partEl = partElements[j];
          const partId = partEl.getAttribute('id');
          if (!partId) continue;

          // Look for extruder in part's direct children
          const partMetadata = Array.from(partEl.children).filter(
            (el) => el.tagName === 'metadata' && el.getAttribute('key') === 'extruder'
          );
          if (partMetadata.length > 0) {
            const extruderVal = partMetadata[0].getAttribute('value');
            if (extruderVal) {
              partExtruderMap.set(`${objectId}:${partId}`, Math.max(0, parseInt(extruderVal, 10) - 1));
            }
          }
        }
      }

      // Parse plate -> object assignments
      const plateElements = doc.getElementsByTagName('plate');
      for (let i = 0; i < plateElements.length; i++) {
        const plateEl = plateElements[i];
        let plateId: number | null = null;
        const metadataElements = plateEl.getElementsByTagName('metadata');
        let plateOffsetX = 0;
        let plateOffsetY = 0;
        for (let j = 0; j < metadataElements.length; j++) {
          const metaEl = metadataElements[j];
          const key = metaEl.getAttribute('key');
          if (key === 'plater_id' || key === 'plate_id') {
            const value = metaEl.getAttribute('value');
            if (value) {
              const parsed = Number.parseInt(value, 10);
              if (Number.isFinite(parsed)) {
                plateId = parsed;
              }
            }
          } else if (key === 'pos_x') {
            const value = metaEl.getAttribute('value');
            const parsed = value ? Number.parseFloat(value) : Number.NaN;
            if (Number.isFinite(parsed)) {
              plateOffsetX = parsed;
            }
          } else if (key === 'pos_y') {
            const value = metaEl.getAttribute('value');
            const parsed = value ? Number.parseFloat(value) : Number.NaN;
            if (Number.isFinite(parsed)) {
              plateOffsetY = parsed;
            }
          }
        }
        if (plateId == null) continue;
        if (plateOffsetX !== 0 || plateOffsetY !== 0) {
          plateOffsets.set(plateId, { offsetX: plateOffsetX, offsetY: plateOffsetY });
        }

        const modelInstances = plateEl.getElementsByTagName('model_instance');
        for (let j = 0; j < modelInstances.length; j++) {
          const instanceEl = modelInstances[j];
          const instanceMetadata = instanceEl.getElementsByTagName('metadata');
          for (let k = 0; k < instanceMetadata.length; k++) {
            const metaEl = instanceMetadata[k];
            if (metaEl.getAttribute('key') === 'object_id') {
              const value = metaEl.getAttribute('value');
              if (value) {
                plateAssignmentsByObjectId.set(value, plateId);
              }
            }
          }
        }
      }
    } catch {
      // Silently ignore model_settings.config parsing errors
    }
  }

  // Parse plate_*.json for plate assignments by object name (source-only / unsliced files)
  const plateAssignmentsByName = new Map<string, number>();
  const plateJsonNames = Object.keys(zip.files).filter(
    (name) => name.startsWith('Metadata/plate_') && name.endsWith('.json')
  );
  for (const name of plateJsonNames) {
    const match = name.match(/^Metadata\/plate_(\d+)\.json$/);
    if (!match) continue;
    const plateIndex = Number.parseInt(match[1], 10);
    if (!Number.isFinite(plateIndex)) continue;
    try {
      const payload = await zip.files[name].async('string');
      const json = JSON.parse(payload) as { bbox_objects?: Array<{ name?: string }>; bbox_all?: number[] };
      const objectsList = json.bbox_objects ?? [];
      for (const entry of objectsList) {
        if (entry?.name) {
          plateAssignmentsByName.set(entry.name, plateIndex);
        }
      }
      if (Array.isArray(json.bbox_all) && json.bbox_all.length >= 4) {
        const [minX, minY, maxX, maxY] = json.bbox_all;
        if ([minX, minY, maxX, maxY].every((value) => Number.isFinite(value))) {
          plateBounds.set(plateIndex, { minX, minY, maxX, maxY });
        }
      }
    } catch {
      // Ignore plate json parsing errors
    }
  }

  // Find the main 3D model file
  const mainModelPath = Object.keys(zip.files).find(
    (name) => name === '3D/3dmodel.model' || name.endsWith('/3dmodel.model')
  );

  if (!mainModelPath) {
    // Fallback: try to find any .model file
    const anyModelPath = Object.keys(zip.files).find((name) => name.endsWith('.model'));
    if (anyModelPath) {
      const doc = await loadModelFile(anyModelPath);
      if (doc) {
        const meshes = await parseMeshFromDoc(doc, 0);
        if (meshes.length > 0) {
          objects.set('1', { id: '1', meshes, defaultExtruder: 0 });
        }
      }
    }
    return { objects, buildItems, plateBounds, plateOffsets, bedSize };
  }

  const mainDoc = await loadModelFile(mainModelPath);
  if (!mainDoc) return { objects, buildItems, plateBounds, plateOffsets, bedSize };

  // Seed the index with the root model so a same-file `<component>` (one with
  // no `p:path`) resolves through exactly the same code path as an external one.
  const mainIndex = indexObjects(mainDoc);
  objectIndexByPath.set('', mainIndex);
  objectIndexByPath.set(
    mainModelPath.startsWith('/') ? mainModelPath.slice(1) : mainModelPath,
    mainIndex
  );

  // Parse objects - Bambu Studio uses components to reference external files
  const objectElements = mainDoc.getElementsByTagName('object');
  for (let i = 0; i < objectElements.length; i++) {
    // Yield once per top-level object so the modal stays interactive
    // throughout the parse (#1412). Inner vertex/triangle/component
    // loops yield on their own. See nextTick() comment near the top.
    if (i > 0) {
      await nextTick();
    }
    const objEl = objectElements[i];
    const objectId = objEl.getAttribute('id');
    if (!objectId) continue;

    const objectPlateId = parsePlateIdFromAttributes(objEl) ?? plateAssignmentsByObjectId.get(objectId) ?? null;

    // Get default extruder from model_settings.config map, falling back to attribute or default
    let defaultExtruder = extruderMapById.get(objectId) ?? -1;
    if (defaultExtruder < 0) {
      const extruderAttr = objEl.getAttribute('p:extruder') || objEl.getAttributeNS('http://schemas.microsoft.com/3dmanufacturing/production/2015/06', 'extruder') || '1';
      defaultExtruder = Math.max(0, parseInt(extruderAttr, 10) - 1);
    }

    let componentAnchor: Vec3 | undefined;

    // A `<mesh>` belonging to this object directly, if any. Scoped to direct
    // children: `getElementsByTagName` would also reach into whatever the
    // object's components pull in.
    const meshes: MeshData[] = await parseObjectMeshes(objEl, defaultExtruder);

    // Check for component references (Bambu Studio style)
    const componentElements = directChildren(objEl, 'components').flatMap((el) =>
      directChildren(el, 'component')
    );
    for (const compEl of componentElements) {
      // Yield before each component — each one triggers another async file
      // load + DOM parse + vertex/triangle iteration. Multi-color "parted"
      // statues from MakerWorld can have dozens of components; without
      // this yield the whole chain runs as one long synchronous burst
      // between awaits and freezes the modal close button (#1412).
      await nextTick();
      // p:path is the external file reference; absent means "this file".
      const extPath = componentPath(compEl);
      // objectid names one `<object>` *inside* that file, and also corresponds
      // to the part id in model_settings.config.
      const compObjectId = compEl.getAttribute('objectid');
      if (!compObjectId) continue;

      // Look up per-part extruder, falling back to object's default
      const compExtruder = partExtruderMap.get(`${objectId}:${compObjectId}`) ?? defaultExtruder;

      // Resolve *only* the referenced object. Reading every `<mesh>` in the
      // part file instead was the #40 defect: Bambu Studio packs each object's
      // parts into one shared file, so every component dragged in all of its
      // siblings and stamped them at its own component transform. The reference
      // file `Attractap - V3 with Logo.3mf` rendered 3.17M triangles instead of
      // 292K — 15 overlapping copies of the body — which is the "fused slab".
      const compMeshes = await collectObjectMeshes(
        extPath ?? '',
        compObjectId,
        compExtruder,
        new Set<string>()
      );

      // Apply component transform if present
      const compTransformStr = compEl.getAttribute('transform');
      const compTransform = parseTransform(compTransformStr);

      // First component wins: that is the one the backend's placement
      // contract names as the object's anchor.
      if (componentAnchor === undefined) {
        const t = new THREE.Vector3().setFromMatrixPosition(compTransform);
        componentAnchor = [t.x, t.y, t.z];
      }

      for (const mesh of compMeshes) {
        // Transform in 3MF coordinate space, before the Y/Z swap.
        meshes.push(compTransformStr ? transformMesh(mesh, compTransform) : mesh);
      }
    }

    if (meshes.length > 0) {
      objects.set(objectId, {
        id: objectId,
        meshes,
        defaultExtruder,
        plateId: objectPlateId,
        componentAnchor,
      });
    }
  }

  // Parse build items (placement on build plate)
  const buildElements = mainDoc.getElementsByTagName('build');
  if (buildElements.length > 0) {
    const itemElements = buildElements[0].getElementsByTagName('item');
    for (let i = 0; i < itemElements.length; i++) {
      const itemEl = itemElements[i];
      const objectId = itemEl.getAttribute('objectid');
      if (!objectId) continue;

      const transform = parseTransform(itemEl.getAttribute('transform'));
      const itemPlateId = parsePlateIdFromAttributes(itemEl);
      const objectPlateId = objects.get(objectId)?.plateId ?? null;
      const objectName = objectNameById.get(objectId);
      const namePlateId = objectName ? plateAssignmentsByName.get(objectName) ?? null : null;
      buildItems.push({ objectId, transform, plateId: itemPlateId ?? objectPlateId ?? namePlateId ?? null });
    }
  }

  return { objects, buildItems, plateBounds, plateOffsets, bedSize };
}

function createGeometryFromMesh(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  // Convert from 3MF Z-up to Three.js Y-up coordinate system
  // 3MF: X right, Y back, Z up -> Three.js: X right, Y up, Z forward
  const positions = new Float32Array(mesh.vertices.length);
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    positions[i] = mesh.vertices[i];       // X stays X
    positions[i + 1] = mesh.vertices[i + 2]; // Y becomes Z (up)
    positions[i + 2] = mesh.vertices[i + 1]; // Z becomes Y
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(mesh.triangles);

  // Compute normals
  geometry.computeVertexNormals();

  return geometry;
}

/**
 * One placeable object in the scene graph.
 *
 * `node` is what `TransformControls` attaches to, and its local transform *is*
 * the object's placement delta. Its single child holds the geometry offset by
 * `-pivot`, so a node parked at `pivot` renders the object exactly as designed
 * and rotation and scale turn about the anchor — matching how the backend
 * composes the same numbers onto the 3MF build item.
 */
export interface ObjectNode {
  objectId: string;
  node: THREE.Group;
  /** The anchor in three.js space (`swapYZ` of the bed-space anchor). */
  pivot: Vec3;
  metrics: ObjectMetrics;
}

export function buildModelGroup(
  parsedData: Parsed3MFData,
  selectedPlateId: number | null,
  filamentColors?: string[],
): { group: THREE.Group; nodes: ObjectNode[] } {
  const { objects, buildItems } = parsedData;
  const group = new THREE.Group();

  // Create materials for each extruder color.
  //
  // `extruder` is already 0-based here — the parser subtracts one off the
  // 1-based `extruder` metadata — so `filamentColors` indexes straight in:
  // `[0]` is slot 1. Adding a shift on either side paints every part with its
  // neighbour's filament, which looks entirely plausible.
  //
  // A caller that supplies colours at all gets the neutral for an extruder its
  // list does not reach (#42) rather than the as-designed green, so a slot the
  // rail knows nothing about reads as "no filament here" instead of as a
  // deliberate colour. Without a list — an STL, or a viewer with no slot state
  // — the green stays.
  const getMaterial = (extruder: number): THREE.MeshPhongMaterial => {
    const fallback = filamentColors ? UNSET_SLOT_COLOR : '#00ae42';
    const colorStr = filamentColors?.[extruder] || fallback;
    // Convert hex color string to THREE.js color
    const color = new THREE.Color(colorStr);
    return new THREE.MeshPhongMaterial({
      color,
      shininess: 30,
      flatShading: false,
    });
  };

  const hasPlateAssignments = buildItems.some((item) => item.plateId != null);
  const plateFilteredItems = selectedPlateId == null || !hasPlateAssignments
    ? buildItems
    : buildItems.filter((item) => item.plateId === selectedPlateId);
  const activeBuildItems = plateFilteredItems.length > 0 ? plateFilteredItems : buildItems;

  // Geometry is bucketed per (object, extruder) rather than per extruder alone,
  // so every object keeps its own node for the gizmo to grab. Objects still
  // merge internally, so the draw-call count is per object rather than per
  // triangle soup — the visual result is identical to the pre-#25 single merge.
  const geometriesByObject = new Map<string, Map<number, THREE.BufferGeometry[]>>();
  const anchorByObject = new Map<string, Vec3>();

  const bucket = (objectId: string, extruder: number, geometry: THREE.BufferGeometry) => {
    let byExtruder = geometriesByObject.get(objectId);
    if (!byExtruder) {
      byExtruder = new Map();
      geometriesByObject.set(objectId, byExtruder);
    }
    const list = byExtruder.get(extruder);
    if (list) list.push(geometry);
    else byExtruder.set(extruder, [geometry]);
  };

  // If we have build items, use them for positioning
  if (activeBuildItems.length > 0) {
    for (const item of activeBuildItems) {
      const objectData = objects.get(item.objectId);
      if (!objectData) continue;

      if (!anchorByObject.has(item.objectId)) {
        // The backend's contract: component translation plus the build item's
        // own translation. Real slicer exports carry identity on the item, so
        // this is normally just the component's.
        const itemTranslation = new THREE.Vector3().setFromMatrixPosition(item.transform);
        const componentAnchor = objectData.componentAnchor ?? [0, 0, 0];
        anchorByObject.set(item.objectId, [
          componentAnchor[0] + itemTranslation.x,
          componentAnchor[1] + itemTranslation.y,
          componentAnchor[2] + itemTranslation.z,
        ]);
      }

      for (const meshData of objectData.meshes) {
        // Use mesh's extruder, or item override, or object default
        const extruder = item.extruder ?? meshData.extruder;

        // Apply build transform to vertices in 3MF space BEFORE coordinate conversion
        const transformedVertices: number[] = [];
        for (let k = 0; k < meshData.vertices.length; k += 3) {
          const v = new THREE.Vector3(
            meshData.vertices[k],
            meshData.vertices[k + 1],
            meshData.vertices[k + 2]
          );
          v.applyMatrix4(item.transform);
          transformedVertices.push(v.x, v.y, v.z);
        }
        // Now create geometry with coordinate conversion
        const geometry = createGeometryFromMesh({
          vertices: transformedVertices,
          triangles: meshData.triangles,
          extruder: extruder,
        });

        bucket(item.objectId, extruder, geometry);
      }
    }
  } else {
    // Fallback: just add all objects without transforms
    for (const objectData of objects.values()) {
      anchorByObject.set(objectData.id, objectData.componentAnchor ?? [0, 0, 0]);
      for (const meshData of objectData.meshes) {
        // Use per-mesh extruder
        const extruder = meshData.extruder;
        bucket(objectData.id, extruder, createGeometryFromMesh(meshData));
      }
    }
  }

  const nodes: ObjectNode[] = [];

  for (const [objectId, byExtruder] of geometriesByObject) {
    const inner = new THREE.Group();

    for (const [extruder, geometries] of byExtruder) {
      if (geometries.length === 0) continue;

      const mergedGeometry = geometries.length === 1
        ? geometries[0]
        : mergeGeometries(geometries, false);

      if (mergedGeometry) {
        const material = getMaterial(extruder);
        const mesh = new THREE.Mesh(mergedGeometry, material);
        mesh.userData.objectId = objectId;
        inner.add(mesh);
      }

      // Dispose individual geometries if merged
      if (geometries.length > 1) {
        for (const geom of geometries) {
          geom.dispose();
        }
      }
    }

    if (inner.children.length === 0) continue;

    const box = new THREE.Box3().setFromObject(inner);
    const sizeThree = box.getSize(new THREE.Vector3());
    const pivot = swapYZ(anchorByObject.get(objectId) ?? [0, 0, 0]);

    inner.position.set(-pivot[0], -pivot[1], -pivot[2]);

    const node = new THREE.Group();
    node.name = `object-${objectId}`;
    node.userData.objectId = objectId;
    node.position.set(pivot[0], pivot[1], pivot[2]);
    node.add(inner);
    group.add(node);

    nodes.push({
      objectId,
      node,
      pivot,
      metrics: {
        anchor: anchorByObject.get(objectId) ?? [0, 0, 0],
        size: swapYZ([sizeThree.x, sizeThree.y, sizeThree.z]),
      },
    });
  }

  return { group, nodes };
}
