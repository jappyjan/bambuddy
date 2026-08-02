/**
 * PlateStage — the slicer page's 3D viewport (#14, step-5.2).
 *
 * Standalone by design: models and a bed size come in as props, camera and
 * selection state stay inside, and nothing here knows what a preset or a
 * slice job is. That is what lets the slicer page (#15) and the mobile
 * wizard (#11) mount the same viewport without dragging their state into it.
 *
 * **Read-only in this ticket.** Orbit and zoom come from `ModelViewer`'s
 * `OrbitControls`; the transform readout is display-only. #12 (step-8) adds
 * `TransformControls` to *this* component, so the seams it needs are already
 * cut:
 *
 * - the `toolbar` slot is the mockup's gizmo column down the left edge;
 * - selection lives here, keyed by 3MF object id, and is reported through
 *   `onSelectedObjectChange` — a gizmo attaches to the selected object
 *   without moving the state;
 * - `TransformReadout` takes its numbers from the selected `StageObject`,
 *   so making it editable is a change to that one subcomponent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ModelViewer } from '../ModelViewer';
import type { ObjectTransform, StageObject, StagePlate } from '../../types/plateStage';

interface BuildVolume {
  x: number;
  y: number;
  z: number;
}

export interface PlateStageProps {
  /** Model URL handed straight to `ModelViewer` (3MF or STL). */
  url: string;
  /** Explicit file type; `ModelViewer` sniffs the URL extension when absent. */
  fileType?: string;
  /**
   * Plates to offer as tabs, in display order. A single-plate or non-3MF
   * source passes one plate and gets no tab strip.
   */
  plates: StagePlate[];
  /** The selected printer's build volume — the bed is drawn at this size. */
  buildVolume?: BuildVolume;
  /** Per-slot filament colours, used to tint the meshes. */
  filamentColors?: string[];
  /** 1-indexed plate to open on. Defaults to the first plate given. */
  initialPlate?: number;
  /** Fired when the user picks a different plate tab. */
  onActivePlateChange?: (plateIndex: number) => void;
  /** Fired when the selected object changes, including on a plate switch. */
  onSelectedObjectChange?: (objectId: string | null) => void;
  /** Overlay column down the left edge of the stage — #12's gizmo toolbar. */
  toolbar?: ReactNode;
  /** Bar pinned under the viewport — #15's estimate, Slice and Print now. */
  actionBar?: ReactNode;
  className?: string;
}

export function PlateStage({
  url,
  fileType,
  plates,
  buildVolume,
  filamentColors,
  initialPlate,
  onActivePlateChange,
  onSelectedObjectChange,
  toolbar,
  actionBar,
  className = '',
}: PlateStageProps) {
  const { t } = useTranslation();

  const firstPlateIndex = plates[0]?.index ?? 1;
  const [activePlate, setActivePlate] = useState(initialPlate ?? firstPlateIndex);
  const [pickedObjectId, setPickedObjectId] = useState<string | null>(null);

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

  // Selection is derived, not stored: switching plates, or a reload that
  // drops the picked object, falls back to the plate's first object so the
  // readout always has a subject. Deriving rather than syncing in an effect
  // means there is never a render where the readout shows an object that is
  // no longer on the plate.
  const selectedObject = useMemo(
    () => objects.find((object) => object.id === pickedObjectId) ?? objects[0] ?? null,
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

  const handlePlateClick = useCallback(
    (plateIndex: number) => {
      if (plateIndex === resolvedPlate) return;
      setActivePlate(plateIndex);
      onActivePlateChange?.(plateIndex);
    },
    [resolvedPlate, onActivePlateChange],
  );

  const handleObjectClick = useCallback((objectId: string) => {
    setPickedObjectId(objectId);
  }, []);

  const objectLabel = useCallback(
    (object: StageObject) => object.name || t('plateStage.objectFallback', { id: object.id }),
    [t],
  );

  const showPlateTabs = plates.length > 1;
  const showObjectPicker = objects.length > 1;

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="relative flex-1 min-h-0">
        <ModelViewer
          url={url}
          fileType={fileType}
          buildVolume={buildVolume}
          filamentColors={filamentColors}
          selectedPlateId={resolvedPlate}
          className="w-full h-full"
        />

        {showPlateTabs && (
          <div
            role="tablist"
            aria-label={t('modelViewer.plates')}
            className="absolute top-2 left-2 flex flex-wrap gap-1"
          >
            {plates.map((plate) => {
              const active = plate.index === resolvedPlate;
              return (
                <button
                  key={plate.index}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => handlePlateClick(plate.index)}
                  className={`px-2 py-1 text-xs rounded border transition-colors ${
                    active
                      ? 'bg-bambu-green border-bambu-green text-white'
                      : 'bg-black/45 border-bambu-dark-tertiary text-bambu-gray-light hover:text-white'
                  }`}
                >
                  {plate.name || t('modelViewer.plateNumber', { number: plate.index })}
                </button>
              );
            })}
          </div>
        )}

        {toolbar && (
          <div
            className={`absolute left-2 flex flex-col gap-1 ${showPlateTabs ? 'top-12' : 'top-2'}`}
          >
            {toolbar}
          </div>
        )}

        {/* Top-right: the mockup's left edge belongs to the gizmo column
            (#12) and the bottom-right to ModelViewer's own view controls. */}
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
        <div className="absolute bottom-16 right-4 w-40 rounded-md border border-bambu-dark-tertiary bg-bambu-dark/95 p-2">
          <p className="text-[10px] uppercase tracking-wider text-bambu-gray mb-1">
            {t('plateStage.transform')}
          </p>
          {selectedObject ? (
            <TransformReadout
              label={objectLabel(selectedObject)}
              transform={selectedObject.transform}
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

const AXES = ['X', 'Y', 'Z'] as const;

/**
 * Display-only position / rotation / scale for one object.
 *
 * #12 turns each cell into a numeric input; keeping it a separate component
 * with a plain `ObjectTransform` in means that change does not reach into
 * `PlateStage` itself.
 */
function TransformReadout({
  label,
  transform,
}: {
  label: string;
  transform: ObjectTransform;
}) {
  const { t } = useTranslation();

  const rows: Array<{ title: string; values: string[] }> = [
    {
      title: t('plateStage.position'),
      values: transform.position.map((value) => formatNumber(value, 1)),
    },
    {
      title: t('plateStage.rotation'),
      values: transform.rotation.map((value) => `${formatNumber(value, 1)}°`),
    },
    {
      title: t('plateStage.scale'),
      values: transform.scale.map((value) => `${formatNumber(value * 100, 0)}%`),
    },
  ];

  return (
    <div>
      <p className="text-[11px] text-white truncate mb-1" title={label}>
        {label}
      </p>
      {rows.map((row) => (
        <div key={row.title} className="mb-1 last:mb-0">
          <p className="text-[9px] uppercase tracking-wider text-bambu-gray">{row.title}</p>
          <div className="flex gap-1">
            {row.values.map((value, axis) => (
              <span
                key={AXES[axis]}
                aria-label={`${row.title} ${AXES[axis]}`}
                className="flex-1 min-w-0 truncate rounded border border-bambu-dark-tertiary bg-bambu-dark-secondary px-1 py-0.5 text-center text-[10px] text-bambu-gray-light"
              >
                {value}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
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
