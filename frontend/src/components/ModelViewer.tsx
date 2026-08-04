import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Loader2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from './Button';
import { getAuthToken } from '../api/client';
import type { ObjectTransform, PlateScreenAnchor } from '../types/plateStage';
import { linkGizmoToOrbit } from './slicer/gizmoOrbit';
import { plateGridOrigins, type BedSize } from './slicer/plateGrid';
import {
  anchorsDiffer,
  createPlateBed,
  paintPlateBeds,
  projectToViewport,
  zoomedCameraPosition,
  type PlateBed,
} from './slicer/plateBeds';
import {
  identityTransform,
  objectNodeToTransform,
  transformToObjectNode,
  transformsEqual,
  type ObjectMetrics,
} from './slicer/transformMath';
import {
  buildModelGroup,
  parse3MF,
  type ObjectNode,
  type Parsed3MFData,
} from './slicer/parse3mf';

interface BuildVolume {
  x: number;
  y: number;
  z: number;
}

/** Gizmo modes offered by the stage toolbar (#25). `null` hides the gizmo. */
export type GizmoMode = 'translate' | 'rotate' | 'scale';

interface ModelViewerProps {
  url: string;
  fileType?: string;
  buildVolume?: BuildVolume;
  filamentColors?: string[];
  selectedPlateId?: number | null;
  className?: string;

  // ---- Multi-plate stage (#41) ---------------------------------------------

  /**
   * Every plate to lay out in one scene, in plate order — Bambu Studio's view
   * (#41). Two or more switches the viewport into multi-plate mode: geometry is
   * left at the world positions the file bakes into its build items, and one
   * bed is drawn per plate on the grid `slicer/plateGrid.ts` reconstructs.
   *
   * Absent, or one plate, keeps the original single-plate behaviour: only
   * `selectedPlateId`'s geometry, centred on a single bed. That is what the
   * phone still gets — see `PlateStage`.
   *
   * `selectedPlateId` does not stop meaning anything here: in multi-plate mode
   * it is the *active* plate, drawn highlighted, and it no longer filters.
   */
  plates?: number[] | null;
  /** Fired when a plate's bed — or an object standing on it — is clicked. */
  onPlatePick?: (plateIndex: number) => void;
  /**
   * Where each plate's label and number badge currently are on screen, in
   * viewport pixels. Emitted as the camera moves, and only when something
   * actually moved, so an idle scene is silent. See {@link PlateScreenAnchor}.
   */
  onPlateAnchors?: (anchors: Record<number, PlateScreenAnchor>) => void;

  // ---- Interactive placement (#25, step-8.1) --------------------------------
  // All optional and all inert unless `interactive` is set, so the modal and
  // inspector viewports keep exactly the behaviour they had.

  /**
   * Stand up `TransformControls` and object picking. A stable boolean: it is
   * read in the scene-setup effect, so flipping it rebuilds the scene.
   */
  interactive?: boolean;
  /**
   * Per-object placement deltas, keyed by 3MF object id. Absent ids are left
   * as designed. 3MF only — an STL has no object ids to key on, and its
   * placement is rewritten server-side after a sidecar conversion.
   */
  objectTransforms?: Record<string, ObjectTransform>;
  /** Which object the gizmo is attached to. */
  selectedObjectId?: string | null;
  /** Active gizmo; `null` leaves the objects unhandled (orbit only). */
  gizmoMode?: GizmoMode | null;
  /** Enlarge the gizmo handles for finger-sized targets (#11 renders this). */
  touchTargets?: boolean;
  /** Fired throughout a gizmo drag with the object's new delta. */
  onObjectTransform?: (objectId: string, transform: ObjectTransform) => void;
  /**
   * Fired when an object is clicked in the viewport — and with `null` when a
   * click lands on anything that is *not* an object, which is how the user
   * selects nothing (#55). A bed click reports both: `null` here and the plate
   * on {@link ModelViewerProps.onPlatePick}.
   */
  onObjectPick?: (objectId: string | null) => void;
  /**
   * Fired once per parse with each object's as-designed anchor and size in bed
   * millimetres. The anchor is what a persisted `position` is measured from
   * (#32) and what rotation and scale pivot about.
   */
  onObjectMetrics?: (metrics: Record<string, ObjectMetrics>) => void;
}

/**
 * Module-level so the default is referentially stable. As a default *parameter*
 * it was a fresh object on every render, and it is in the scene-setup effect's
 * dependency list — every render of a caller that omits `buildVolume` tore the
 * WebGL context down and rebuilt it, which no gizmo can survive.
 */
const DEFAULT_BUILD_VOLUME: BuildVolume = { x: 256, y: 256, z: 256 };

/** Handle scale for pointer vs finger. 1 is three.js's desktop default. */
const GIZMO_SIZE_POINTER = 1;
const GIZMO_SIZE_TOUCH = 1.75;

/** A click that moves further than this is an orbit, not a selection. */
const PICK_SLOP_PX = 5;

/**
 * Dispose everything under `group`. Written against `geometry` / `material`
 * rather than `instanceof THREE.Mesh` because the plate beds are made of lines
 * as well as meshes, and a `Line`'s geometry leaks just as happily as a mesh's.
 */
function disposeGroup(group: THREE.Group) {
  group.traverse((child) => {
    const drawable = child as Partial<THREE.Mesh>;
    drawable.geometry?.dispose();
    const material = drawable.material;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material?.dispose();
    }
  });
}

export function ModelViewer({
  url,
  fileType,
  buildVolume = DEFAULT_BUILD_VOLUME,
  filamentColors,
  selectedPlateId = null,
  className = '',
  plates,
  onPlatePick,
  onPlateAnchors,
  interactive = false,
  objectTransforms,
  selectedObjectId = null,
  gizmoMode = null,
  touchTargets = false,
  onObjectTransform,
  onObjectPick,
  onObjectMetrics,
}: ModelViewerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const plateRef = useRef<THREE.Mesh | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const [loading, setLoading] = useState(true);
  // ---- Multi-plate stage (#41) ----------------------------------------------
  const plateBedsRef = useRef<PlateBed[]>([]);
  const plateBedGroupRef = useRef<THREE.Group | null>(null);
  const lastAnchorsRef = useRef<Record<number, PlateScreenAnchor> | null>(null);
  // Where the camera goes back to. In multi-plate mode "reset" cannot be the
  // hard-coded corner the single-plate view uses: the scene is metres wide and
  // that position is inside plate 1.
  const homeViewRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const [plateGeneration, setPlateGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [parsedData, setParsedData] = useState<Parsed3MFData | null>(null);
  const [stlGeometry, setStlGeometry] = useState<THREE.BufferGeometry | null>(null);

  // ---- Interactive placement (#25) ------------------------------------------
  const transformControlsRef = useRef<TransformControls | null>(null);
  const objectNodesRef = useRef<ObjectNode[]>([]);
  // Bumped whenever the model group is rebuilt, so the effects that reach into
  // the scene graph re-run without depending on the mutable refs themselves.
  const [sceneGeneration, setSceneGeneration] = useState(0);

  // Callbacks live in refs: callers pass inline arrows, and putting them in a
  // dependency array would tear down the WebGL scene on every parent render.
  const callbacksRef = useRef({
    onObjectTransform,
    onObjectPick,
    onObjectMetrics,
    onPlatePick,
    onPlateAnchors,
  });
  callbacksRef.current = {
    onObjectTransform,
    onObjectPick,
    onObjectMetrics,
    onPlatePick,
    onPlateAnchors,
  };
  // Read inside the pointer handler, which is bound once for the scene's life.
  const objectTransformsRef = useRef(objectTransforms);
  objectTransformsRef.current = objectTransforms;

  // The plate list as a stable value. Callers rebuild the array every render
  // and it feeds the effect that rebuilds the scene's geometry, so identity
  // matters more than elegance here.
  const plateKey = (plates ?? []).join(',');
  const plateList = useMemo(
    () => (plateKey === '' ? [] : plateKey.split(',').map(Number)),
    [plateKey],
  );
  const multiPlate = plateList.length > 1;
  // In multi-plate mode the selected plate is *highlighted*, not filtered — so
  // changing it must not rebuild the geometry. Keeping the filter argument out
  // of the effect's dependencies is what stops an 8-plate scene being re-parsed
  // into buffers every time the user clicks a different bed.
  const buildPlateId = multiPlate ? null : selectedPlateId;
  const selectedPlateIdRef = useRef(selectedPlateId);
  selectedPlateIdRef.current = selectedPlateId;

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    camera.position.set(150, 150, 150);
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controlsRef.current = controls;

    // Placement gizmo (#25). Only stood up for interactive viewports so the
    // read-only ones keep exactly the listener set they had before.
    const teardown: Array<() => void> = [];
    if (interactive) {
      const transformControls = new TransformControls(camera, renderer.domElement);
      transformControls.setSize(touchTargets ? GIZMO_SIZE_TOUCH : GIZMO_SIZE_POINTER);
      transformControlsRef.current = transformControls;
      scene.add(transformControls.getHelper());

      teardown.push(linkGizmoToOrbit(transformControls, controls));

      const onObjectChange = () => {
        const node = transformControls.object;
        if (!node) return;
        const objectId = node.userData.objectId as string | undefined;
        const entry = objectNodesRef.current.find((candidate) => candidate.objectId === objectId);
        if (!objectId || !entry) return;
        const next = objectNodeToTransform(node, entry.pivot);
        const current = objectTransformsRef.current?.[objectId] ?? identityTransform();
        // Rounded first, so a drag that ends where it started does not report a
        // change — a reported change would keep Print now disabled for nothing.
        if (transformsEqual(next, current)) return;
        callbacksRef.current.onObjectTransform?.(objectId, next);
      };
      transformControls.addEventListener('objectChange', onObjectChange);
      teardown.push(() => transformControls.removeEventListener('objectChange', onObjectChange));

      teardown.push(() => {
        transformControls.detach();
        scene.remove(transformControls.getHelper());
        transformControls.dispose();
        transformControlsRef.current = null;
      });
    }

    // Click-to-select, for objects and — since #41 — for the plate beds
    // themselves. Distinguished from an orbit by distance, and skipped outright
    // while the gizmo has the pointer, so grabbing a handle that happens to sit
    // over another object cannot steal the selection.
    //
    // Bound whether or not the viewport is `interactive`: picking a plate is
    // how the user chooses what to slice, and an archive — which is read-only
    // precisely because its arrangement cannot be saved — still has to be able
    // to choose one.
    {
      const raycaster = new THREE.Raycaster();
      const pointerDownAt = { x: 0, y: 0, valid: false };

      const onPointerDown = (event: PointerEvent) => {
        const gizmo = transformControlsRef.current;
        pointerDownAt.x = event.clientX;
        pointerDownAt.y = event.clientY;
        pointerDownAt.valid = !gizmo?.dragging && !gizmo?.axis;
      };
      const onPointerUp = (event: PointerEvent) => {
        if (!pointerDownAt.valid || transformControlsRef.current?.dragging) return;
        if (
          Math.abs(event.clientX - pointerDownAt.x) > PICK_SLOP_PX ||
          Math.abs(event.clientY - pointerDownAt.y) > PICK_SLOP_PX
        ) {
          return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        raycaster.setFromCamera(
          new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
          ),
          camera,
        );
        const hits = raycaster.intersectObjects(
          objectNodesRef.current.map((entry) => entry.node),
          true,
        );
        const picked = hits[0]?.object?.userData?.objectId as string | undefined;
        if (picked) {
          callbacksRef.current.onObjectPick?.(picked);
          return;
        }
        // No object hit: the click selects nothing (#55). Reported for every
        // miss — a bed, or empty space past the beds entirely — so there is
        // always a gesture that gets the user back to no selection.
        callbacksRef.current.onObjectPick?.(null);
        // Then fall through to the beds, so clicking the empty part of a plate
        // also makes it active. Objects win the tie — an object standing on a
        // plate is always in front of it, and the caller resolves which plate
        // that object belongs to.
        const bedHits = raycaster.intersectObjects(
          plateBedsRef.current.map((bed) => bed.surface),
          false,
        );
        const plateIndex = bedHits[0]?.object?.userData?.plateIndex as number | undefined;
        if (plateIndex != null) callbacksRef.current.onPlatePick?.(plateIndex);
      };

      renderer.domElement.addEventListener('pointerdown', onPointerDown);
      renderer.domElement.addEventListener('pointerup', onPointerUp);
      teardown.push(() => {
        renderer.domElement.removeEventListener('pointerdown', onPointerDown);
        renderer.domElement.removeEventListener('pointerup', onPointerUp);
      });
    }

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(100, 100, 100);
    scene.add(directionalLight);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight2.position.set(-100, 50, -100);
    scene.add(directionalLight2);

    // Grid - use the larger dimension for the grid size
    const gridSize = Math.max(buildVolume.x, buildVolume.y);
    const gridDivisions = Math.ceil(gridSize / 16);
    const gridHelper = new THREE.GridHelper(gridSize, gridDivisions, 0x444444, 0x333333);
    scene.add(gridHelper);
    gridRef.current = gridHelper;

    // Build plate indicator
    const plateGeometry = new THREE.PlaneGeometry(buildVolume.x, buildVolume.y);
    const plateMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ae42,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
    });
    const plate = new THREE.Mesh(plateGeometry, plateMaterial);
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = -0.5; // Slightly below Y=0 so models sit on top
    scene.add(plate);
    plateRef.current = plate;

    /**
     * Tell the caller where each plate's label belongs on screen (#41).
     *
     * Runs per frame but reports only on movement: the plate labels are React
     * elements, and re-rendering eight of them sixty times a second while the
     * scene sits still is exactly the kind of cost a multi-plate view cannot
     * afford. An idle camera emits nothing at all.
     */
    const emitPlateAnchors = () => {
      const beds = plateBedsRef.current;
      if (beds.length === 0) {
        if (lastAnchorsRef.current !== null) {
          lastAnchorsRef.current = null;
          callbacksRef.current.onPlateAnchors?.({});
        }
        return;
      }
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;

      const previous = lastAnchorsRef.current;
      const next: Record<number, PlateScreenAnchor> = {};
      let changed = previous == null || Object.keys(previous).length !== beds.length;
      for (const bed of beds) {
        const label = projectToViewport(bed.labelAnchor, camera, width, height);
        const badge = projectToViewport(bed.badgeAnchor, camera, width, height);
        const anchor: PlateScreenAnchor = {
          label: { x: label.x, y: label.y },
          badge: { x: badge.x, y: badge.y },
          visible: label.visible,
        };
        next[bed.plateIndex] = anchor;
        const before = previous?.[bed.plateIndex];
        if (!before || anchorsDiffer(before, anchor)) changed = true;
      }
      if (!changed) return;
      lastAnchorsRef.current = next;
      callbacksRef.current.onPlateAnchors?.(next);
    };

    // Animation loop - keep it simple for reliability
    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      controls.update();
      emitPlateAnchors();
      renderer.render(scene, camera);
    };
    animate();

    setLoading(true);
    setError(null);
    setParsedData(null);
    setStlGeometry(null);

    const normalizedType = (fileType || url.split('?')[0].split('.').pop() || '').toLowerCase();

    // Build auth headers for fetch
    const headers: HeadersInit = {};
    const token = getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (normalizedType === 'stl') {
      fetch(url, { headers })
        .then((res) => {
          if (!res.ok) throw new Error(t('modelViewer.errors.failedToLoad'));
          return res.arrayBuffer();
        })
        .then((buffer) => {
          const loader = new STLLoader();
          const geometry = loader.parse(buffer);
          geometry.computeVertexNormals();
          geometry.rotateX(-Math.PI / 2);
          setStlGeometry(geometry);
        })
        .catch((err) => {
          setError(err.message);
          setLoading(false);
        });
    } else if (normalizedType === '3mf') {
      fetch(url, { headers })
        .then((res) => {
          if (!res.ok) throw new Error(t('modelViewer.errors.failedToLoad'));
          return res.arrayBuffer();
        })
        .then(parse3MF)
        .then((parsed) => {
          if (parsed.objects.size === 0) {
            throw new Error(t('modelViewer.errors.noMeshes'));
          }
          setParsedData(parsed);
        })
        .catch((err) => {
          setError(err.message);
          setLoading(false);
        });
    } else {
      setError(t('modelViewer.errors.unsupportedFormat'));
      setLoading(false);
    }

    // Handle resize (window + container)
    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(container);

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      cancelAnimationFrame(animationId);
      for (const undo of teardown) undo();
      controls.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      modelGroupRef.current = null;
      objectNodesRef.current = [];
      plateRef.current = null;
      gridRef.current = null;
      if (plateBedGroupRef.current) disposeGroup(plateBedGroupRef.current);
      plateBedGroupRef.current = null;
      plateBedsRef.current = [];
      lastAnchorsRef.current = null;
      homeViewRef.current = null;
    };
  }, [url, buildVolume, fileType, t, interactive, touchTargets]);

  useEffect(() => {
    if (!sceneRef.current || !cameraRef.current || !controlsRef.current) return;
    if (!parsedData && !stlGeometry) return;

    if (modelGroupRef.current) {
      // Detach first: the gizmo is holding a node that is about to leave the
      // scene graph, and three.js logs an error every frame it is asked to
      // track an object that is no longer in it.
      transformControlsRef.current?.detach();
      sceneRef.current.remove(modelGroupRef.current);
      disposeGroup(modelGroupRef.current);
    }

    const isStlModel = !!stlGeometry;
    // An STL has no object ids, so it gets no placeable nodes: its placement is
    // rewritten server-side after the sidecar converts it to a project 3MF
    // (see `backend/app/services/plate_layout.py`), and there is nothing here
    // to key a transform on.
    const built = isStlModel
      ? (() => {
          const materialColor = filamentColors?.[0] || '#00ae42';
          const material = new THREE.MeshPhongMaterial({ color: new THREE.Color(materialColor), shininess: 30 });
          const mesh = new THREE.Mesh(stlGeometry!, material);
          const stlGroup = new THREE.Group();
          stlGroup.add(mesh);
          return { group: stlGroup, nodes: [] as ObjectNode[] };
        })()
      : buildModelGroup(parsedData!, buildPlateId ?? null, filamentColors);
    const group = built.group;
    modelGroupRef.current = group;
    objectNodesRef.current = built.nodes;
    sceneRef.current.add(group);

    // Whatever was on the floor before belongs to a previous file or plate list.
    if (plateBedGroupRef.current) {
      sceneRef.current.remove(plateBedGroupRef.current);
      disposeGroup(plateBedGroupRef.current);
      plateBedGroupRef.current = null;
    }
    plateBedsRef.current = [];
    lastAnchorsRef.current = null;

    /**
     * The multi-plate stage (#41).
     *
     * Requires build items: without them `buildModelGroup` falls back to
     * emitting every object at its own origin, so the plates would all coincide
     * and a grid of beds under them would be a lie. An STL has no plates at all.
     */
    const multiPlateStage = !isStlModel && multiPlate && parsedData!.buildItems.length > 0;

    if (multiPlateStage) {
      // **No centring, no drop to the bed.** The file already places every
      // object in one shared multi-plate space — that is exactly what #40
      // verified — so the only correct thing to do with those coordinates is
      // nothing. Re-centring here would slide all eight plates' contents on top
      // of each other again, which is the bug this epic started with. An object
      // the file puts below z=0 is drawn below its bed, as Studio draws it.
      group.position.set(0, 0, 0);

      // The bed the *authoring* slicer used, not the printer picked in the
      // rail: the grid offsets are baked into the transforms above, and they
      // were computed against this bed. Falling back to the build volume keeps
      // a file that does not say at least self-consistent.
      const bed: BedSize = parsedData!.bedSize ?? { x: buildVolume.x, y: buildVolume.y };
      const cells = plateGridOrigins(plateList, bed);

      const bedGroup = new THREE.Group();
      const beds = cells.map((cell) => createPlateBed(cell, bed));
      for (const entry of beds) bedGroup.add(entry.group);
      // Read through a ref: the active plate must not be a dependency of the
      // effect that rebuilds the geometry, or every plate click would re-parse
      // the whole scene. The highlight effect below owns it from here.
      paintPlateBeds(beds, selectedPlateIdRef.current);
      sceneRef.current.add(bedGroup);
      plateBedGroupRef.current = bedGroup;
      plateBedsRef.current = beds;

      // The single-plate furniture would sit under plate 1, at a different size.
      if (plateRef.current) plateRef.current.visible = false;
      if (gridRef.current) gridRef.current.visible = false;

      // Frame the whole grid of beds rather than the geometry: a plate with
      // nothing on it is still a plate the user has to be able to see and click.
      const stageBox = new THREE.Box3();
      for (const cell of cells) {
        stageBox.expandByPoint(new THREE.Vector3(cell.x, 0, cell.y));
        stageBox.expandByPoint(new THREE.Vector3(cell.x + bed.x, 0, cell.y + bed.y));
      }
      stageBox.union(new THREE.Box3().setFromObject(group));
      const stageCenter = stageBox.getCenter(new THREE.Vector3());
      const stageSize = stageBox.getSize(new THREE.Vector3());
      const stageDistance = Math.max(stageSize.x, stageSize.y, stageSize.z) * 0.9;
      const home = {
        position: new THREE.Vector3(
          stageCenter.x,
          stageCenter.y + stageDistance * 0.85,
          stageCenter.z + stageDistance * 0.85,
        ),
        target: stageCenter.clone(),
      };
      homeViewRef.current = home;
      cameraRef.current.position.copy(home.position);
      controlsRef.current.target.copy(home.target);
      controlsRef.current.update();

      const metrics: Record<string, ObjectMetrics> = {};
      for (const entry of built.nodes) metrics[entry.objectId] = entry.metrics;
      callbacksRef.current.onObjectMetrics?.(metrics);

      setPlateGeneration((generation) => generation + 1);
      setSceneGeneration((generation) => generation + 1);
      setLoading(false);
      return;
    }

    if (plateRef.current) plateRef.current.visible = true;
    if (gridRef.current) gridRef.current.visible = true;
    // Back to the single-plate view's own reset position; a home recorded for a
    // grid of beds points at empty space once there is only one.
    homeViewRef.current = null;

    // Get bounding box to position model
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());

    // Always place models on the build plate (Y=0)
    group.position.y = -box.min.y;

    const selectedPlateBounds = (!isStlModel && buildPlateId != null && parsedData!.buildItems.length > 0)
      ? parsedData!.plateBounds.get(buildPlateId)
      : undefined;
    const selectedPlateOffset = (!isStlModel && buildPlateId != null)
      ? parsedData!.plateOffsets.get(buildPlateId)
      : undefined;
    const shouldCenterOnPlate = isStlModel
      || parsedData!.buildItems.length === 0
      || (buildPlateId != null && !selectedPlateBounds && !selectedPlateOffset);
    const centerOffsetX = shouldCenterOnPlate ? -center.x : 0;
    const centerOffsetZ = shouldCenterOnPlate ? -center.z : 0;

    let plateOffsetX = 0;
    let plateOffsetZ = 0;
    if (!isStlModel && buildPlateId != null && parsedData!.buildItems.length > 0 && selectedPlateBounds) {
      const plateBox = new THREE.Box3().setFromObject(group);
      plateOffsetX = plateBox.min.x - selectedPlateBounds.minX;
      plateOffsetZ = plateBox.min.z - selectedPlateBounds.minY;
    }

    const plateCenterX = buildVolume.x / 2;
    const plateCenterZ = buildVolume.y / 2;

    if (!isStlModel && buildPlateId != null && parsedData!.buildItems.length > 0 && selectedPlateBounds) {
      group.position.x = centerOffsetX - plateOffsetX;
      group.position.z = centerOffsetZ - plateOffsetZ;
    } else if (!isStlModel && buildPlateId != null && selectedPlateOffset) {
      group.position.x = centerOffsetX + (plateCenterX - selectedPlateOffset.offsetX);
      group.position.z = centerOffsetZ + (plateCenterZ - selectedPlateOffset.offsetY);
    } else if (shouldCenterOnPlate) {
      group.position.x = centerOffsetX + plateCenterX;
      group.position.z = centerOffsetZ + plateCenterZ;
    } else {
      group.position.x = centerOffsetX;
      group.position.z = centerOffsetZ;
    }

    if (plateRef.current) {
      plateRef.current.position.x = plateCenterX;
      plateRef.current.position.z = plateCenterZ;
    }

    if (gridRef.current) {
      gridRef.current.position.x = plateCenterX;
      gridRef.current.position.z = plateCenterZ;
    }

    // Recalculate bounding box after positioning
    const finalBox = new THREE.Box3().setFromObject(group);
    const finalCenter = finalBox.getCenter(new THREE.Vector3());
    const finalSize = finalBox.getSize(new THREE.Vector3());

    // Adjust camera to fit model
    const maxDim = Math.max(finalSize.x, finalSize.y, finalSize.z);
    const cameraDistance = maxDim * 1.8;
    cameraRef.current.position.set(
      finalCenter.x + cameraDistance * 0.7,
      finalCenter.y + cameraDistance * 0.5,
      finalCenter.z + cameraDistance * 0.7
    );
    controlsRef.current.target.copy(finalCenter);
    controlsRef.current.update();

    const metrics: Record<string, ObjectMetrics> = {};
    for (const entry of built.nodes) metrics[entry.objectId] = entry.metrics;
    callbacksRef.current.onObjectMetrics?.(metrics);

    setSceneGeneration((generation) => generation + 1);
    setLoading(false);
  }, [parsedData, stlGeometry, buildPlateId, filamentColors, buildVolume, plateList, multiPlate]);

  /** Keep the active plate's bed distinguished, without rebuilding anything. */
  useEffect(() => {
    paintPlateBeds(plateBedsRef.current, selectedPlateId);
  }, [selectedPlateId, plateGeneration]);

  /**
   * Push the caller's placement deltas onto the scene graph.
   *
   * Skipped mid-drag: `TransformControls` is authoring the node's transform
   * while the pointer is down, and writing the round-tripped value back on
   * every `objectChange` would fight the drag by a fraction of a millimetre
   * per frame.
   */
  useEffect(() => {
    if (transformControlsRef.current?.dragging) return;
    for (const entry of objectNodesRef.current) {
      const transform = objectTransforms?.[entry.objectId] ?? identityTransform();
      const next = transformToObjectNode(transform, entry.pivot);
      entry.node.position.set(next.position[0], next.position[1], next.position[2]);
      entry.node.quaternion.copy(next.quaternion);
      entry.node.scale.set(next.scale[0], next.scale[1], next.scale[2]);
    }
  }, [objectTransforms, sceneGeneration]);

  /** Attach the gizmo to the selected object, in the selected mode. */
  useEffect(() => {
    const transformControls = transformControlsRef.current;
    if (!transformControls) return;

    const entry = gizmoMode
      ? objectNodesRef.current.find((candidate) => candidate.objectId === selectedObjectId)
      : undefined;

    if (!entry) {
      transformControls.detach();
      return;
    }
    transformControls.setMode(gizmoMode as GizmoMode);
    transformControls.attach(entry.node);
    return () => {
      transformControls.detach();
    };
  }, [selectedObjectId, gizmoMode, sceneGeneration]);

  const resetView = () => {
    if (!cameraRef.current || !controlsRef.current) return;
    // The multi-plate stage records where "the whole thing in frame" was; a
    // grid of eight beds is metres across and the single-plate view's fixed
    // corner is inside plate 1, which reads as the model having vanished.
    const home = homeViewRef.current;
    if (home) {
      cameraRef.current.position.copy(home.position);
      controlsRef.current.target.copy(home.target);
    } else {
      cameraRef.current.position.set(150, 150, 150);
      controlsRef.current.target.set(0, 50, 0);
    }
    controlsRef.current.update();
  };

  const zoom = (factor: number) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera) return;
    // Towards what the camera is looking at, not towards the world origin: on
    // the multi-plate stage the origin is plate 1's front-left corner, and
    // scaling the position vector there flies the camera sideways across the
    // grid while appearing to zoom.
    const target = controls?.target ?? new THREE.Vector3();
    camera.position.copy(zoomedCameraPosition(camera.position, target, factor));
    controls?.update();
  };

  return (
    <div className={`relative ${className}`}>
      <div ref={containerRef} className="w-full h-full min-h-[400px]" />

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-bambu-dark/80">
          <Loader2 className="w-8 h-8 text-bambu-green animate-spin" />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-bambu-dark/80">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <div className="absolute bottom-4 right-4 flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => zoom(0.8)}>
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => zoom(1.25)}>
            <ZoomOut className="w-4 h-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={resetView}>
            <RotateCcw className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
