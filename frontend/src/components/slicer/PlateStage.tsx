/**
 * PlateStage — the slicer page's 3D viewport (#14, step-5.2; gizmos in #25,
 * step-8.1).
 *
 * Standalone by design: models and a bed size come in as props, camera and
 * selection state stay inside, and nothing here knows what a preset or a
 * slice job is. That is what lets the slicer page (#15) and the mobile
 * wizard (#11) mount the same viewport without dragging their state into it.
 *
 * ## Interactive, but not stateful
 *
 * `#25` added `TransformControls`, a gizmo toolbar and numeric entry, and it
 * added them **controlled**: the transforms come in on `plates` and every
 * change goes straight back out on `onTransformChange`. Nothing about a
 * model's placement is stored here.
 *
 * That is not a style preference. `SlicerPage` gates **Print now** on
 * `selectionFingerprint(selection)`, which hashes `selection.plates` — so a
 * transform that lands in the caller's selection invalidates a completed slice
 * for free, and a transform kept in local state here would not. The user would
 * then be able to print a layout they had already changed on screen, and no
 * test would fail. See the module header in `sliceSelection.ts`.
 *
 * **The stage is read-only unless it is given somewhere to put a change.** With
 * no `onTransformChange` there is no gizmo, no toolbar and no numeric entry,
 * only the display-only readout #14 shipped — because an editable control whose
 * edits go nowhere is worse than no control at all.
 *
 * ## Where the numbers mean things
 *
 * An `ObjectTransform` is a **delta from the object as designed**, in bed
 * millimetres / degrees XYZ / scale multipliers, pivoting about the object's
 * anchor. The conversion to and from three.js space, and the reason the pivot
 * matters, are in `transformMath.ts`.
 *
 * **For #32 (persistence):** a saved `plate_layout` entry's `position` is an
 * *absolute* bed coordinate, not a delta — the backend composes
 * `T(position) · R · S · T(-anchor)`. Convert with the anchors reported on
 * {@link PlateStageProps.onObjectMetricsChange}: `position = anchor + delta`,
 * with `rotation` and `scale` passed through unchanged. Writing the delta
 * straight out would drag every object to the bed's front-left corner.
 *
 * ## Every plate at once (#41)
 *
 * On anything wider than a phone the stage shows **all** the plates side by
 * side, the way Bambu Studio does — a 3-wide grid of beds on one floor that you
 * orbit across (`plateGrid.ts` reconstructs where each bed goes). The plate
 * names that used to live in a tab strip are now **labels in the scene**, each
 * a real button pinned over its own bed by the projection the viewport reports
 * on `onPlateAnchors`. That is what makes the tab strip redundant rather than
 * merely missing: the labels select, they are focusable, and a screen reader
 * still reads a list of plates.
 *
 * Two things survive that change and must keep surviving it:
 *
 * 1. **There is still an active plate.** Slicing targets one
 *    (`SliceRequest.plate`), and `onActivePlateChange` is what carries it into
 *    `selection.plates` → `selectionFingerprint` → the Print-now gate. Clicking
 *    a bed, a label, or an object standing on another plate all change it.
 * 2. **The phone keeps one plate at a time.** Eight beds on a 375 px screen are
 *    unreadable and unhittable, and it is strictly more geometry on the device
 *    least able to draw it — so `multiPlate` defaults to "not a phone", and the
 *    wizard keeps the name strip it always had.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Grid2x2, Maximize, Move, RotateCw, SendToBack } from 'lucide-react';
import { ModelViewer, type GizmoMode } from '../ModelViewer';
import { useIsMobile } from '../../hooks/useIsMobile';
import type {
  ObjectTransform,
  PlateScreenAnchor,
  StageObject,
  StagePlate,
} from '../../types/plateStage';
import { plateNumberBadge, type BedSize } from './plateGrid';
import { resolveBuildVolume, type BuildVolume } from './buildVolume';
import {
  autoArrangeTransforms,
  layFlatTransform,
  transformsEqual,
  type ObjectMetrics,
} from './transformMath';

/** Scale can be typed as a percentage; 0 or negative collapses the geometry. */
const MIN_SCALE = 0.01;
const MAX_SCALE = 100;

export interface PlateStageProps {
  /** Model URL handed straight to `ModelViewer` (3MF or STL). */
  url: string;
  /** Explicit file type; `ModelViewer` sniffs the URL extension when absent. */
  fileType?: string;
  /**
   * Plates to show, in display order. A single-plate or non-3MF source passes
   * one plate and gets no plate labels at all.
   */
  plates: StagePlate[];
  /**
   * Lay every plate out side by side in one scene (#41). Defaults to "not a
   * phone": the mobile wizard renders this same viewport, and a grid of beds is
   * both illegible and needlessly heavy on a handset. `false` keeps the
   * one-plate-at-a-time view with a name strip.
   */
  multiPlate?: boolean;
  /**
   * The **selected printer's** build volume (#69).
   *
   * Not necessarily the bed that gets drawn: a 3MF that declares its own
   * `printable_area` outranks it, because the file's geometry is already placed
   * against that bed and a printer change must not slide the plates out from
   * under it. The viewport reports what the file said on `onFileBedSize`, and
   * `resolveBuildVolume` settles the two — so Auto-arrange lands on the bed the
   * user can actually see.
   */
  buildVolume?: BuildVolume;
  /** Per-slot filament colours, used to tint the meshes. */
  filamentColors?: string[];
  /** 1-indexed plate to open on. Defaults to the first plate given. */
  initialPlate?: number;
  /**
   * Fired when the user makes a different plate active — by its label, its bed,
   * or by selecting an object standing on it.
   *
   * **Load-bearing.** `SlicerPage` feeds this into `selection.plates`, which
   * feeds `selectionFingerprint`, which gates Print now. A plate change that
   * did not reach the caller would leave a completed slice looking valid while
   * the user prepared a different plate.
   */
  onActivePlateChange?: (plateIndex: number) => void;
  /** Fired when the selected object changes, including on a plate switch. */
  onSelectedObjectChange?: (objectId: string | null) => void;
  /**
   * Where a placement change goes. **Its absence is what makes the stage
   * read-only** — no handler, no gizmo, no numeric entry.
   *
   * The transform must reach `selection.plates`; see the module header.
   */
  onTransformChange?: (
    plateIndex: number,
    objectId: string,
    transform: ObjectTransform,
  ) => void;
  /**
   * Per-object anchors and sizes, measured from the parsed 3MF. Reported once
   * the model is on screen and again whenever it is rebuilt.
   *
   * #32 needs the anchors to turn a delta into a persisted absolute position.
   */
  onObjectMetricsChange?: (metrics: Record<string, ObjectMetrics>) => void;
  /**
   * Finger-sized gizmo handles and toolbar buttons. Defaults to `useIsMobile()`
   * — #11 renders this same viewport on a phone, where desktop handles are
   * unusable.
   */
  touchTargets?: boolean;
  /** Extra overlay content under the gizmo column, down the left edge. */
  toolbar?: ReactNode;
  /** Bar pinned under the viewport — #15's estimate, Slice and Print now. */
  actionBar?: ReactNode;
  className?: string;
}

export function PlateStage({
  url,
  fileType,
  plates,
  multiPlate,
  buildVolume,
  filamentColors,
  initialPlate,
  onActivePlateChange,
  onSelectedObjectChange,
  onTransformChange,
  onObjectMetricsChange,
  touchTargets,
  toolbar,
  actionBar,
  className = '',
}: PlateStageProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const touch = touchTargets ?? isMobile;

  const firstPlateIndex = plates[0]?.index ?? 1;
  const [activePlate, setActivePlate] = useState(initialPlate ?? firstPlateIndex);
  const [pickedObjectId, setPickedObjectId] = useState<string | null>(null);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const [metrics, setMetrics] = useState<Record<string, ObjectMetrics>>({});
  // Where the viewport says each plate's label currently is. Empty until the
  // scene has drawn a frame — and always empty where there is no WebGL at all,
  // which is why the labels fall back to a strip rather than disappearing.
  const [plateAnchors, setPlateAnchors] = useState<Record<number, PlateScreenAnchor>>({});
  // The bed the *file* declares, as reported by the viewport — the only place
  // the 3MF is parsed. `null` until a parse lands, and for a file that declares
  // none, which is the same thing as far as the rule is concerned.
  const [fileBedSize, setFileBedSize] = useState<BedSize | null>(null);

  /** The bed that is actually drawn, and so the bed Auto-arrange must use. */
  const bedVolume = useMemo(
    () => resolveBuildVolume(fileBedSize, buildVolume),
    [fileBedSize, buildVolume],
  );

  const showAllPlates = (multiPlate ?? !isMobile) && plates.length > 1;

  // A plate the caller no longer offers (the file was swapped, or a layout
  // reload dropped a plate) would leave the viewport pointed at nothing, so
  // fall back to the first plate that does exist.
  const activePlateExists = plates.some((plate) => plate.index === activePlate);
  const resolvedPlate = activePlateExists ? activePlate : firstPlateIndex;

  const currentPlate = useMemo(
    () => plates.find((plate) => plate.index === resolvedPlate) ?? null,
    [plates, resolvedPlate],
  );
  const objects = useMemo(() => currentPlate?.objects ?? [], [currentPlate]);

  // Selection is derived, not stored: switching plates, or a reload that drops
  // the picked object, leaves **nothing** selected (#55). No fallback to the
  // plate's first object — the stage opens with an empty selection, and every
  // deselect gesture has somewhere to land. Deriving rather than syncing in an
  // effect means there is never a render where the readout shows an object that
  // is no longer on the plate.
  const selectedObject = useMemo(
    () => objects.find((object) => object.id === pickedObjectId) ?? null,
    [objects, pickedObjectId],
  );
  const selectedObjectId = selectedObject?.id ?? null;

  // Report selection changes without making the callback a dependency —
  // callers routinely pass an inline arrow, and depending on it would fire
  // this on every parent render.
  const selectionCallbackRef = useRef(onSelectedObjectChange);
  selectionCallbackRef.current = onSelectedObjectChange;
  useEffect(() => {
    selectionCallbackRef.current?.(selectedObjectId);
  }, [selectedObjectId]);

  const metricsCallbackRef = useRef(onObjectMetricsChange);
  metricsCallbackRef.current = onObjectMetricsChange;
  const handleObjectMetrics = useCallback((next: Record<string, ObjectMetrics>) => {
    setMetrics(next);
    metricsCallbackRef.current?.(next);
  }, []);

  const handlePlateClick = useCallback(
    (plateIndex: number) => {
      if (plateIndex === resolvedPlate) return;
      if (!plates.some((plate) => plate.index === plateIndex)) return;
      setActivePlate(plateIndex);
      onActivePlateChange?.(plateIndex);
    },
    [plates, resolvedPlate, onActivePlateChange],
  );

  /**
   * Select an object — and, with every plate on screen at once, follow it to
   * whichever plate it is standing on.
   *
   * Without that, clicking a part on plate 5 would attach the gizmo to it while
   * the page still sliced plate 1, and every transform it emitted would be
   * filed against the wrong plate.
   *
   * `null` is the deselect (#55): the viewport reports it for a click that hits
   * no object. There is no owner plate to follow in that case — the active
   * plate is the bed's business, and `onPlatePick` carries it separately.
   */
  const handleObjectClick = useCallback(
    (objectId: string | null) => {
      if (objectId == null) {
        setPickedObjectId(null);
        return;
      }
      const owner = plates.find((plate) =>
        plate.objects.some((object) => object.id === objectId),
      );
      if (owner && owner.index !== resolvedPlate) handlePlateClick(owner.index);
      setPickedObjectId(objectId);
    },
    [handlePlateClick, plates, resolvedPlate],
  );

  // Escape deselects (#55). Bound to the window because the pick that made the
  // selection gave nothing focus — the canvas is not a focusable control — so
  // there is no element to hang a `keydown` on. Bound only while something is
  // selected, which keeps the key free for everything else on the page.
  useEffect(() => {
    if (pickedObjectId == null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickedObjectId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pickedObjectId]);

  const objectLabel = useCallback(
    (object: StageObject) => object.name || t('plateStage.objectFallback', { id: object.id }),
    [t],
  );

  const editable = onTransformChange != null;

  /** The plates whose geometry is on screen — all of them, or just the active one. */
  const renderedPlates = useMemo(
    () => (showAllPlates ? plates : currentPlate ? [currentPlate] : []),
    [showAllPlates, plates, currentPlate],
  );

  // Every rendered object's placement, keyed by 3MF object id (unique across
  // plates). It has to cover *all* the plates on screen, not just the active
  // one: `ModelViewer` resets any node it is not given a transform for back to
  // as-designed, so a partial map would silently un-arrange the other plates.
  //
  // Identity is stable per plate render, so `ModelViewer`'s apply effect does
  // not churn the scene graph on unrelated parent renders.
  const objectTransforms = useMemo(() => {
    const map: Record<string, ObjectTransform> = {};
    for (const plate of renderedPlates) {
      for (const object of plate.objects) map[object.id] = object.transform;
    }
    return map;
  }, [renderedPlates]);

  /** Which plate an object stands on, so a transform is filed against it. */
  const plateOfObject = useCallback(
    (objectId: string) =>
      renderedPlates.find((plate) => plate.objects.some((object) => object.id === objectId)) ??
      null,
    [renderedPlates],
  );

  const emitTransform = useCallback(
    (objectId: string, transform: ObjectTransform) => {
      // The object's own plate, not the active one. They agree today — picking
      // an object activates its plate — but a transform filed against the wrong
      // plate saves cleanly and applies to nothing.
      const owner = plateOfObject(objectId);
      onTransformChange?.(owner?.index ?? resolvedPlate, objectId, transform);
    },
    [onTransformChange, plateOfObject, resolvedPlate],
  );

  const handleGizmoTransform = useCallback(
    (objectId: string, transform: ObjectTransform) => {
      // The gizmo can only move what is selected, but the pick that selected it
      // is the caller's state; guard so a stale drag cannot address an object
      // that has since left the stage.
      if (!plateOfObject(objectId)) return;
      emitTransform(objectId, transform);
    },
    [emitTransform, plateOfObject],
  );

  const handleLayFlat = useCallback(() => {
    if (!selectedObject) return;
    const next = layFlatTransform(selectedObject.transform);
    if (transformsEqual(next, selectedObject.transform)) return;
    emitTransform(selectedObject.id, next);
  }, [emitTransform, selectedObject]);

  const handleAutoArrange = useCallback(() => {
    const arranged = autoArrangeTransforms(objects, metrics, bedVolume);
    for (const object of objects) {
      const next = arranged[object.id];
      // Only genuinely-moved objects are reported: an arrange that is already
      // an arrange must not invalidate a completed slice.
      if (next && !transformsEqual(next, object.transform)) emitTransform(object.id, next);
    }
  }, [bedVolume, emitTransform, metrics, objects]);

  const showPlateLabels = plates.length > 1;
  const showObjectPicker = objects.length > 1;
  // A label pinned to its own bed is out of the toolbar's way; a strip along
  // the top is not.
  const anchored = showAllPlates && Object.keys(plateAnchors).length > 0;
  const toolbarTop = showPlateLabels && !anchored ? 'top-12' : 'top-2';

  const plateIndexes = useMemo(() => plates.map((plate) => plate.index), [plates]);

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="relative flex-1 min-h-0">
        <ModelViewer
          url={url}
          fileType={fileType}
          buildVolume={buildVolume}
          filamentColors={filamentColors}
          selectedPlateId={resolvedPlate}
          plates={showAllPlates ? plateIndexes : null}
          interactive={editable}
          objectTransforms={objectTransforms}
          selectedObjectId={selectedObjectId}
          gizmoMode={editable ? gizmoMode : null}
          touchTargets={touch}
          onObjectTransform={handleGizmoTransform}
          onObjectPick={handleObjectClick}
          onObjectMetrics={handleObjectMetrics}
          onPlatePick={handlePlateClick}
          onPlateAnchors={setPlateAnchors}
          onFileBedSize={setFileBedSize}
          className="w-full h-full"
        />

        {showPlateLabels && (
          <PlateLabels
            plates={plates}
            activePlate={resolvedPlate}
            anchors={anchored ? plateAnchors : null}
            onSelect={handlePlateClick}
            touch={touch}
          />
        )}

        {(editable || toolbar) && (
          <div className={`absolute left-2 flex flex-col gap-1 ${toolbarTop}`}>
            {editable && (
              <GizmoToolbar
                mode={gizmoMode}
                onModeChange={setGizmoMode}
                onLayFlat={handleLayFlat}
                onAutoArrange={handleAutoArrange}
                hasSelection={selectedObject != null}
                hasObjects={objects.length > 0}
                touch={touch}
              />
            )}
            {toolbar}
          </div>
        )}

        {/* Top-right: the mockup's left edge belongs to the gizmo column
            and the bottom-right to ModelViewer's own view controls. */}
        {showObjectPicker && (
          <div
            role="listbox"
            aria-label={t('plateStage.objects')}
            className="absolute top-2 right-2 flex flex-wrap justify-end gap-1 max-w-[45%]"
          >
            {objects.map((object) => {
              const active = object.id === selectedObjectId;
              return (
                <button
                  key={object.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => handleObjectClick(object.id)}
                  className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
                    active
                      ? 'bg-bambu-dark-tertiary border-bambu-gray text-white'
                      : 'bg-black/45 border-bambu-dark-tertiary text-bambu-gray-light hover:text-white'
                  }`}
                >
                  {objectLabel(object)}
                </button>
              );
            })}
          </div>
        )}

        {/* Bottom-right per the mockup, lifted clear of ModelViewer's own
            zoom/reset row which sits at bottom-4 right-4. */}
        <div
          className={`absolute bottom-16 right-4 rounded-md border border-bambu-dark-tertiary bg-bambu-dark/95 p-2 ${
            editable ? 'w-52' : 'w-40'
          }`}
        >
          <p className="text-[10px] uppercase tracking-wider text-bambu-gray mb-1">
            {t('plateStage.transform')}
          </p>
          {selectedObject ? (
            <TransformReadout
              key={selectedObject.id}
              label={objectLabel(selectedObject)}
              transform={selectedObject.transform}
              onChange={
                editable
                  ? (transform) => emitTransform(selectedObject.id, transform)
                  : undefined
              }
              touch={touch}
            />
          ) : (
            <p className="text-[11px] text-bambu-gray">
              {objects.length === 0 ? t('plateStage.emptyPlate') : t('plateStage.noSelection')}
            </p>
          )}
        </div>
      </div>

      {actionBar && (
        <div className="border-t border-bambu-dark-tertiary bg-bambu-dark/95">{actionBar}</div>
      )}
    </div>
  );
}

/**
 * The plate names, as labels in the scene (#41) — Bambu Studio's affordance,
 * and the reason the tab strip is gone rather than merely hidden.
 *
 * Two layouts, one control:
 *
 * - **Anchored**, once the viewport has projected the beds: each name is pinned
 *   above its own plate and a `01`-style badge sits at the plate's near corner,
 *   both following the camera.
 * - **Stripped**, when there are no projections to use — the phone's
 *   one-plate-at-a-time view, and any environment without WebGL. The same
 *   buttons, laid along the top edge.
 *
 * They are `<button>`s in both layouts, not canvas text, so the plate list
 * stays keyboard-reachable and screen-reader-readable. A plate the camera
 * cannot see keeps its button in the tab order rather than vanishing from it;
 * it is simply invisible until focused.
 */
function PlateLabels({
  plates,
  activePlate,
  anchors,
  onSelect,
  touch,
}: {
  plates: StagePlate[];
  activePlate: number;
  /** Projected positions, or `null` for the strip layout. */
  anchors: Record<number, PlateScreenAnchor> | null;
  onSelect: (plateIndex: number) => void;
  touch: boolean;
}) {
  const { t } = useTranslation();

  const label = (plate: StagePlate) =>
    plate.name || t('modelViewer.plateNumber', { number: plate.index });

  const buttonClass = (active: boolean) =>
    `rounded border transition-colors ${touch ? 'px-3 py-1.5 text-xs' : 'px-2 py-1 text-xs'} ${
      active
        ? 'bg-bambu-green border-bambu-green text-white'
        : 'bg-black/45 border-bambu-dark-tertiary text-bambu-gray-light hover:text-white'
    }`;

  if (!anchors) {
    return (
      <div
        role="group"
        aria-label={t('modelViewer.plates')}
        className="absolute top-2 left-2 flex flex-wrap gap-1"
      >
        {plates.map((plate) => (
          <button
            key={plate.index}
            type="button"
            aria-pressed={plate.index === activePlate}
            onClick={() => onSelect(plate.index)}
            className={buttonClass(plate.index === activePlate)}
          >
            {label(plate)}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={t('modelViewer.plates')}
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {plates.map((plate) => {
        const anchor = anchors[plate.index];
        if (!anchor) return null;
        const active = plate.index === activePlate;
        return (
          <div key={plate.index}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(plate.index)}
              style={{
                left: `${anchor.label.x}px`,
                top: `${anchor.label.y}px`,
                transform: 'translate(-50%, calc(-100% - 10px))',
              }}
              className={`pointer-events-auto absolute whitespace-nowrap ${buttonClass(active)} ${
                anchor.visible ? '' : 'opacity-0 focus:opacity-100'
              }`}
            >
              {label(plate)}
            </button>
            <span
              aria-hidden="true"
              style={{
                left: `${anchor.badge.x}px`,
                top: `${anchor.badge.y}px`,
                transform: 'translate(-50%, -50%)',
              }}
              className={`absolute select-none text-sm font-semibold tabular-nums ${
                active ? 'text-bambu-green' : 'text-bambu-gray'
              } ${anchor.visible ? '' : 'opacity-0'}`}
            >
              {plateNumberBadge(plate.index)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const AXES = ['X', 'Y', 'Z'] as const;

/**
 * The mockup's gizmo column: move / rotate / scale, then lay flat and
 * auto-arrange.
 *
 * The first three are modes — exactly one is active, so they are toggle
 * buttons carrying `aria-pressed`. The last two are one-shot actions. Hit
 * targets grow to 44px on touch, the minimum a finger can reliably hit.
 */
function GizmoToolbar({
  mode,
  onModeChange,
  onLayFlat,
  onAutoArrange,
  hasSelection,
  hasObjects,
  touch,
}: {
  mode: GizmoMode;
  onModeChange: (mode: GizmoMode) => void;
  onLayFlat: () => void;
  onAutoArrange: () => void;
  hasSelection: boolean;
  hasObjects: boolean;
  touch: boolean;
}) {
  const { t } = useTranslation();

  const size = touch ? 'h-11 w-11' : 'h-8 w-8';
  const icon = touch ? 'h-5 w-5' : 'h-4 w-4';

  const modes: Array<{ id: GizmoMode; label: string; Icon: typeof Move }> = [
    { id: 'translate', label: t('plateStage.move'), Icon: Move },
    { id: 'rotate', label: t('plateStage.rotate'), Icon: RotateCw },
    { id: 'scale', label: t('plateStage.scale'), Icon: Maximize },
  ];

  return (
    <div
      role="toolbar"
      aria-label={t('plateStage.tools')}
      aria-orientation="vertical"
      className="flex flex-col gap-1"
    >
      {modes.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          aria-label={label}
          aria-pressed={mode === id}
          title={label}
          disabled={!hasSelection}
          onClick={() => onModeChange(id)}
          className={`${size} inline-flex items-center justify-center rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            mode === id
              ? 'bg-bambu-green border-bambu-green text-white'
              : 'bg-black/50 border-bambu-dark-tertiary text-bambu-gray-light hover:text-white'
          }`}
        >
          <Icon className={icon} />
        </button>
      ))}

      <button
        type="button"
        aria-label={t('plateStage.layFlat')}
        title={t('plateStage.layFlat')}
        disabled={!hasSelection}
        onClick={onLayFlat}
        className={`${size} inline-flex items-center justify-center rounded border border-bambu-dark-tertiary bg-black/50 text-bambu-gray-light transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <SendToBack className={icon} />
      </button>

      <button
        type="button"
        aria-label={t('plateStage.autoArrange')}
        title={t('plateStage.autoArrange')}
        disabled={!hasObjects}
        onClick={onAutoArrange}
        className={`${size} inline-flex items-center justify-center rounded border border-bambu-dark-tertiary bg-black/50 text-bambu-gray-light transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <Grid2x2 className={icon} />
      </button>
    </div>
  );
}

interface TransformRow {
  key: keyof ObjectTransform;
  title: string;
  suffix: string;
  decimals: number;
  /** Stored value → the number the user reads and types. */
  toDisplay: (value: number) => number;
  /** Typed number → stored value. */
  fromDisplay: (value: number) => number;
}

/**
 * Position / rotation / scale for one object — editable when a change handler
 * is supplied, the display-only readout #14 shipped when it is not.
 *
 * Scale is shown and typed as a percentage because that is what a slicer UI
 * shows, and clamped away from zero because a zero scale is a degenerate
 * matrix the gizmo can never grow back.
 */
function TransformReadout({
  label,
  transform,
  onChange,
  touch,
}: {
  label: string;
  transform: ObjectTransform;
  onChange?: (transform: ObjectTransform) => void;
  touch: boolean;
}) {
  const { t } = useTranslation();

  const rows: TransformRow[] = [
    {
      key: 'position',
      title: t('plateStage.position'),
      suffix: 'mm',
      decimals: 1,
      toDisplay: (value) => value,
      fromDisplay: (value) => value,
    },
    {
      key: 'rotation',
      title: t('plateStage.rotation'),
      suffix: '°',
      decimals: 1,
      toDisplay: (value) => value,
      fromDisplay: (value) => value,
    },
    {
      key: 'scale',
      title: t('plateStage.scale'),
      suffix: '%',
      decimals: 0,
      toDisplay: (value) => value * 100,
      fromDisplay: (value) => clamp(value / 100, MIN_SCALE, MAX_SCALE),
    },
  ];

  const commit = (row: TransformRow, axis: number, raw: string) => {
    if (!onChange) return;
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) return;
    const next = row.fromDisplay(parsed);
    const values = [...transform[row.key]] as [number, number, number];
    if (values[axis] === next) return;
    values[axis] = next;
    onChange({ ...cloneTransform(transform), [row.key]: values });
  };

  return (
    <div>
      <p className="text-[11px] text-white truncate mb-1" title={label}>
        {label}
      </p>
      {rows.map((row) => (
        <div key={row.title} className="mb-1 last:mb-0">
          <p className="text-[9px] uppercase tracking-wider text-bambu-gray">
            {row.title}
            {/* The unit moves into the header once the cells are inputs — a
                number input cannot carry a suffix, and "45" with no degree
                sign anywhere is a guess. */}
            {onChange && (
              <span className="ml-1 normal-case tracking-normal opacity-60">{row.suffix}</span>
            )}
          </p>
          <div className="flex gap-1">
            {transform[row.key].map((value, axis) => {
              const name = `${row.title} ${AXES[axis]}`;
              const display = formatNumber(row.toDisplay(value), row.decimals);
              return onChange ? (
                <NumberCell
                  key={AXES[axis]}
                  name={name}
                  // Unrounded on purpose: an input showing the *displayed*
                  // rounding would quantise the value every time the user
                  // tabbed through it, so a 42.25 mm drag would creep to
                  // 42.3 mm just by being looked at.
                  value={String(round(row.toDisplay(value), 4))}
                  touch={touch}
                  onCommit={(raw) => commit(row, axis, raw)}
                />
              ) : (
                <span
                  key={AXES[axis]}
                  aria-label={name}
                  className="flex-1 min-w-0 truncate rounded border border-bambu-dark-tertiary bg-bambu-dark-secondary px-1 py-0.5 text-center text-[10px] text-bambu-gray-light"
                >
                  {row.key === 'rotation' ? `${display}°` : row.key === 'scale' ? `${display}%` : display}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One numeric cell.
 *
 * Holds the keystrokes locally and only reports on blur or Enter. Reporting
 * per keystroke would send `-` and `1.` through `Number()` as `NaN` and `1`,
 * so typing `-12.5` would first jump the model to 1 mm and then to 12 mm —
 * and each of those intermediate values is a fingerprint change that
 * invalidates a completed slice.
 */
function NumberCell({
  name,
  value,
  touch,
  onCommit,
}: {
  name: string;
  value: string;
  touch: boolean;
  onCommit: (raw: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={name}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        onCommit(event.target.value);
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        onCommit((event.target as HTMLInputElement).value);
        setDraft(null);
      }}
      className={`w-full flex-1 min-w-0 rounded border border-bambu-dark-tertiary bg-bambu-dark-secondary px-1 text-center text-[10px] text-bambu-gray-light focus:border-bambu-green focus:text-white focus:outline-none ${
        touch ? 'h-9' : 'h-6'
      }`}
    />
  );
}

function cloneTransform(transform: ObjectTransform): ObjectTransform {
  return {
    position: [...transform.position] as [number, number, number],
    rotation: [...transform.rotation] as [number, number, number],
    scale: [...transform.scale] as [number, number, number],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Trim float dust without imposing the readout's display precision. */
function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Fixed-decimal formatting that never renders "-0". A negative value that
 * rounds to zero is zero, and showing "-0.0 mm" for a model sitting on the
 * bed reads like a bug.
 */
function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '—';
  const fixed = value.toFixed(decimals);
  return /^-0(\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed;
}
