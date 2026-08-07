/**
 * Tests for PlateStage (#14, step-5.2; gizmos in #25, step-8.1) and its
 * plate-layout bridge.
 *
 * ModelViewer is mocked: it stands up a real WebGL context and parses a 3MF
 * over the network, neither of which jsdom has. The mock echoes the props
 * that PlateStage is responsible for driving — that is exactly the contract
 * under test, since "the rendered plate changed" *is* "ModelViewer was told
 * a different selectedPlateId", and "the model moved" *is* "ModelViewer was
 * handed a different objectTransforms".
 *
 * The mock also keeps hold of the viewport's callbacks, which is how a gizmo
 * drag is simulated: `TransformControls` needs a canvas and a raycast to
 * produce one, but everything #25 is responsible for happens *after* the
 * drag, in the `onObjectTransform` it reports. The controller's own behaviour
 * — that a drag does not also orbit — is pinned separately against the real
 * three.js controllers in `gizmoOrbit.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCallback, useState, type ComponentProps } from 'react';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { PlateStage } from '../../components/slicer/PlateStage';
import {
  IDENTITY_TRANSFORM,
  buildStagePlates,
  isSupportedPlateLayout,
  toPlateLayout,
} from '../../components/slicer/plateLayout';
import type { ObjectMetrics } from '../../components/slicer/transformMath';
import type { PlateMetadata } from '../../types/plates';
import type {
  ObjectTransform,
  PlateLayout,
  PlateScreenAnchor,
  StagePlate,
} from '../../types/plateStage';

interface MockViewerProps {
  selectedPlateId?: number | null;
  plates?: number[] | null;
  buildVolume?: { x: number; y: number; z: number };
  interactive?: boolean;
  gizmoMode?: string | null;
  selectedObjectId?: string | null;
  touchTargets?: boolean;
  objectTransforms?: Record<string, ObjectTransform>;
  onObjectTransform?: (objectId: string, transform: ObjectTransform) => void;
  onObjectPick?: (objectId: string | null) => void;
  onObjectMetrics?: (metrics: Record<string, ObjectMetrics>) => void;
  onPlatePick?: (plateIndex: number) => void;
  onPlateAnchors?: (anchors: Record<number, PlateScreenAnchor>) => void;
  onFileBedSize?: (bedSize: { x: number; y: number } | null) => void;
}

let viewerProps: MockViewerProps = {};

vi.mock('../../components/ModelViewer', () => ({
  ModelViewer: (props: MockViewerProps) => {
    viewerProps = props;
    return (
      <div
        data-testid="model-viewer"
        data-selected-plate={String(props.selectedPlateId ?? '')}
        data-build-volume={
          props.buildVolume
            ? `${props.buildVolume.x}x${props.buildVolume.y}x${props.buildVolume.z}`
            : ''
        }
        data-interactive={String(!!props.interactive)}
        data-gizmo-mode={String(props.gizmoMode ?? '')}
        data-selected-object={String(props.selectedObjectId ?? '')}
        data-touch-targets={String(!!props.touchTargets)}
        data-object-transforms={JSON.stringify(props.objectTransforms ?? {})}
        data-plates={(props.plates ?? []).join(',')}
      />
    );
  },
}));

function plate(index: number, objectIds: string[]): StagePlate {
  return {
    index,
    objects: objectIds.map((id) => ({
      id,
      transform: {
        position: [index * 10, index * 20, 0],
        rotation: [0, 0, index * 45],
        scale: [1, 1, 1],
      },
    })),
  };
}

const TWO_PLATES: StagePlate[] = [plate(1, ['2']), plate(2, ['7'])];

function renderStage(props: Partial<ComponentProps<typeof PlateStage>> = {}) {
  return render(<PlateStage url="/model.3mf" plates={TWO_PLATES} {...props} />);
}

function viewer() {
  return screen.getByTestId('model-viewer');
}

/** One of the plate labels — in the scene when the viewport has placed them. */
function plateButton(name: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Plates' })).getByRole('button', { name });
}

/** What the viewport is currently being told about one object's placement. */
function renderedTransform(objectId: string): ObjectTransform {
  return JSON.parse(viewer().getAttribute('data-object-transforms') ?? '{}')[objectId];
}

/**
 * A stage wired the way `SlicerPage` wires it — transforms held by the caller
 * and fed straight back in. Anything less would test a `PlateStage` that owns
 * its own placement state, which is precisely the design #12 forbids.
 */
function ControlledStage({
  initialPlates = TWO_PLATES,
  onChange,
  ...props
}: {
  initialPlates?: StagePlate[];
  onChange?: (plates: StagePlate[]) => void;
} & Partial<ComponentProps<typeof PlateStage>>) {
  const [plates, setPlates] = useState(initialPlates);

  const handleTransformChange = useCallback(
    (plateIndex: number, objectId: string, transform: ObjectTransform) => {
      setPlates((current) => {
        const next = current.map((entry) =>
          entry.index !== plateIndex
            ? entry
            : {
                ...entry,
                objects: entry.objects.map((object) =>
                  object.id === objectId ? { ...object, transform } : object,
                ),
              },
        );
        onChange?.(next);
        return next;
      });
    },
    [onChange],
  );

  return (
    <PlateStage
      url="/model.3mf"
      plates={plates}
      onTransformChange={handleTransformChange}
      {...props}
    />
  );
}

function renderControlled(props: Parameters<typeof ControlledStage>[0] = {}) {
  return render(<ControlledStage {...props} />);
}

/**
 * Pick an object in the viewport.
 *
 * Explicit in almost every test since #55: the stage opens with **nothing**
 * selected, so a test about the readout or the gizmos has to say what it is
 * reading out.
 */
function selectObject(objectId: string) {
  act(() => {
    viewerProps.onObjectPick?.(objectId);
  });
}

/**
 * Simulate the viewport finishing a parse and reporting the bed the **file**
 * declares — `null` for an STL, or a 3MF with no `printable_area` (#69).
 */
function reportFileBed(bedSize: { x: number; y: number } | null) {
  act(() => {
    viewerProps.onFileBedSize?.(bedSize);
  });
}

/** Simulate a gizmo drag: the viewport reporting a new placement. */
function dragGizmo(objectId: string, transform: ObjectTransform) {
  act(() => {
    viewerProps.onObjectTransform?.(objectId, transform);
  });
}

beforeEach(() => {
  viewerProps = {};
});

describe('PlateStage', () => {
  describe('plates (#41)', () => {
    it('opens on the first plate and drives the viewport with it', () => {
      renderStage();
      expect(viewer()).toHaveAttribute('data-selected-plate', '1');
      expect(plateButton('Plate 1')).toHaveAttribute('aria-pressed', 'true');
    });

    it('lays every plate out at once, without filtering to the active one', () => {
      // The whole point of #41: one scene, all the beds. `selectedPlateId`
      // stops meaning "the only plate drawn" and starts meaning "the plate that
      // will be sliced" — but it has to keep meaning the second one.
      renderStage();
      expect(viewer()).toHaveAttribute('data-plates', '1,2');
      expect(viewer()).toHaveAttribute('data-selected-plate', '1');
    });

    it('hands the viewport a transform for every plate on screen', () => {
      // Objects on the plates that are *not* active are still drawn, and
      // `ModelViewer` resets any node it is given no transform for. A map
      // covering only the active plate would quietly un-arrange the rest.
      renderStage();
      const transforms = JSON.parse(viewer().getAttribute('data-object-transforms') ?? '{}');
      expect(Object.keys(transforms).sort()).toEqual(['2', '7']);
    });

    it('changes the active plate when another plate label is clicked', async () => {
      const user = userEvent.setup();
      renderStage();

      await user.click(plateButton('Plate 2'));

      expect(viewer()).toHaveAttribute('data-selected-plate', '2');
      expect(plateButton('Plate 2')).toHaveAttribute('aria-pressed', 'true');
      expect(plateButton('Plate 1')).toHaveAttribute('aria-pressed', 'false');
      // Still every plate in the scene — activating one is not filtering.
      expect(viewer()).toHaveAttribute('data-plates', '1,2');
    });

    it('makes a plate active when its bed is clicked in the scene', () => {
      // The affordance that replaces the tab strip: the beds themselves.
      const onActivePlateChange = vi.fn();
      renderStage({ onActivePlateChange });

      act(() => viewerProps.onPlatePick?.(2));

      expect(viewer()).toHaveAttribute('data-selected-plate', '2');
      expect(onActivePlateChange).toHaveBeenCalledWith(2);
    });

    it('ignores a bed click naming a plate the caller does not offer', () => {
      const onActivePlateChange = vi.fn();
      renderStage({ onActivePlateChange });

      act(() => viewerProps.onPlatePick?.(9));

      expect(viewer()).toHaveAttribute('data-selected-plate', '1');
      expect(onActivePlateChange).not.toHaveBeenCalled();
    });

    it('follows an object picked on another plate to that plate', () => {
      // Selection works across plates now, and the active plate has to follow
      // it: otherwise the gizmo would move an object on plate 2 while Slice
      // still targeted plate 1.
      const onActivePlateChange = vi.fn();
      renderStage({ onActivePlateChange });

      act(() => viewerProps.onObjectPick?.('7'));

      expect(viewer()).toHaveAttribute('data-selected-plate', '2');
      expect(viewer()).toHaveAttribute('data-selected-object', '7');
      expect(onActivePlateChange).toHaveBeenCalledWith(2);
    });

    it('files a transform against the plate the object stands on', () => {
      const onTransformChange = vi.fn();
      renderStage({ onTransformChange });

      act(() => viewerProps.onObjectPick?.('7'));
      const moved: ObjectTransform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] };
      dragGizmo('7', moved);

      expect(onTransformChange).toHaveBeenCalledWith(2, '7', moved);
    });

    it('reports plate switches to the caller (#15 invalidates a slice on this)', async () => {
      const user = userEvent.setup();
      const onActivePlateChange = vi.fn();
      renderStage({ onActivePlateChange });

      await user.click(plateButton('Plate 2'));
      expect(onActivePlateChange).toHaveBeenCalledWith(2);

      // Re-selecting the active plate is not a change.
      onActivePlateChange.mockClear();
      await user.click(plateButton('Plate 2'));
      expect(onActivePlateChange).not.toHaveBeenCalled();
    });

    it('honours initialPlate and prefers a plate name over the number', () => {
      renderStage({
        initialPlate: 2,
        plates: [
          { ...TWO_PLATES[0], name: 'Body' },
          { ...TWO_PLATES[1], name: 'Lid' },
        ],
      });

      expect(viewer()).toHaveAttribute('data-selected-plate', '2');
      expect(plateButton('Lid')).toHaveAttribute('aria-pressed', 'true');
      expect(plateButton('Body')).toBeInTheDocument();
    });

    it('shows no plate labels for a single-plate source', () => {
      renderStage({ plates: [plate(1, ['2'])] });
      expect(screen.queryByRole('group', { name: 'Plates' })).not.toBeInTheDocument();
      expect(viewer()).toHaveAttribute('data-selected-plate', '1');
      // One plate is not a grid; the viewport keeps its single-bed layout.
      expect(viewer()).toHaveAttribute('data-plates', '');
    });

    it('falls back to the first plate when the active one disappears', () => {
      const { rerender } = renderStage({ initialPlate: 2 });
      expect(viewer()).toHaveAttribute('data-selected-plate', '2');

      rerender(<PlateStage url="/model.3mf" plates={[plate(1, ['2'])]} />);
      expect(viewer()).toHaveAttribute('data-selected-plate', '1');
    });

    describe('labels in the scene', () => {
      const ANCHORS: Record<number, PlateScreenAnchor> = {
        1: { label: { x: 120, y: 40 }, badge: { x: 200, y: 180 }, visible: true },
        2: { label: { x: 520, y: 44 }, badge: { x: 600, y: 184 }, visible: true },
      };

      it('pins each plate name over its own bed once the viewport projects them', () => {
        renderStage();

        // Before the scene has drawn: a strip, so the plates are still
        // reachable in an environment with no WebGL at all.
        expect(plateButton('Plate 2')).not.toHaveStyle({ position: 'absolute' });

        act(() => viewerProps.onPlateAnchors?.(ANCHORS));

        expect(plateButton('Plate 2')).toHaveStyle({ left: '520px', top: '44px' });
        expect(plateButton('Plate 1')).toHaveStyle({ left: '120px', top: '40px' });
      });

      it('numbers the plates the way Studio does', () => {
        renderStage({ plates: [plate(1, ['2']), plate(2, ['7']), plate(10, ['9'])] });
        act(() =>
          viewerProps.onPlateAnchors?.({
            ...ANCHORS,
            10: { label: { x: 90, y: 300 }, badge: { x: 150, y: 420 }, visible: true },
          }),
        );

        expect(screen.getByText('01')).toBeInTheDocument();
        expect(screen.getByText('02')).toBeInTheDocument();
        expect(screen.getByText('10')).toBeInTheDocument();
      });

      it('keeps a plate the camera cannot see in the tab order', () => {
        // Hidden, not removed: orbiting past a plate must not shuffle the
        // keyboard order of the ones that are left.
        renderStage();
        act(() =>
          viewerProps.onPlateAnchors?.({
            ...ANCHORS,
            2: { ...ANCHORS[2], visible: false },
          }),
        );

        expect(plateButton('Plate 2')).toBeInTheDocument();
        expect(plateButton('Plate 2').className).toContain('opacity-0');
      });

      it('still selects the plate when its label is clicked', async () => {
        const user = userEvent.setup();
        const onActivePlateChange = vi.fn();
        renderStage({ onActivePlateChange });
        act(() => viewerProps.onPlateAnchors?.(ANCHORS));

        await user.click(plateButton('Plate 2'));

        expect(onActivePlateChange).toHaveBeenCalledWith(2);
        expect(viewer()).toHaveAttribute('data-selected-plate', '2');
      });
    });

    describe('the phone (#11 renders this same stage)', () => {
      it('keeps one plate at a time and the name strip', async () => {
        // Eight beds on a 375 px screen are unreadable, unhittable and the most
        // geometry on the device least able to draw it.
        const user = userEvent.setup();
        renderStage({ multiPlate: false });

        expect(viewer()).toHaveAttribute('data-plates', '');
        expect(viewer()).toHaveAttribute('data-selected-plate', '1');

        await user.click(plateButton('Plate 2'));
        expect(viewer()).toHaveAttribute('data-selected-plate', '2');
      });

      it('renders only the active plate\'s transforms', () => {
        renderStage({ multiPlate: false });
        const transforms = JSON.parse(viewer().getAttribute('data-object-transforms') ?? '{}');
        expect(Object.keys(transforms)).toEqual(['2']);
      });
    });
  });

  describe('transform readout', () => {
    it('reflects the selected object', () => {
      renderStage();
      selectObject('2');

      // Plate 1's object sits at [10, 20, 0] with a 45° Z rotation.
      expect(screen.getByLabelText('Position X')).toHaveTextContent('10.0');
      expect(screen.getByLabelText('Position Y')).toHaveTextContent('20.0');
      expect(screen.getByLabelText('Position Z')).toHaveTextContent('0.0');
      expect(screen.getByLabelText('Rotation Z')).toHaveTextContent('45.0°');
      expect(screen.getByLabelText('Scale X')).toHaveTextContent('100%');
    });

    it("reads out an object picked on the plate the user switched to", async () => {
      const user = userEvent.setup();
      renderStage();
      selectObject('2');

      await user.click(plateButton('Plate 2'));

      // The picked object is not on this plate, and since #55 nothing takes
      // its place — the readout is empty until the user picks something here.
      expect(screen.getByText('No object selected')).toBeInTheDocument();

      selectObject('7');

      expect(screen.getByLabelText('Position X')).toHaveTextContent('20.0');
      expect(screen.getByLabelText('Position Y')).toHaveTextContent('40.0');
      expect(screen.getByLabelText('Rotation Z')).toHaveTextContent('90.0°');
      expect(screen.getByText('Object 7')).toBeInTheDocument();
    });

    it('switches subject when a different object is picked', async () => {
      const user = userEvent.setup();
      const onSelectedObjectChange = vi.fn();
      renderStage({
        plates: [
          {
            index: 1,
            objects: [
              {
                id: '2',
                name: 'Base',
                transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
              },
              {
                id: '3',
                name: 'Bracket',
                transform: { position: [40, 50, 60], rotation: [0, 90, 0], scale: [2, 2, 0.5] },
              },
            ],
          },
        ],
        onSelectedObjectChange,
      });

      // Nothing to begin with (#55) — not the first object.
      expect(screen.getByText('No object selected')).toBeInTheDocument();
      expect(onSelectedObjectChange).toHaveBeenCalledWith(null);

      const picker = screen.getByRole('listbox', { name: 'Objects' });
      await user.click(within(picker).getByRole('option', { name: 'Base' }));

      expect(screen.getByLabelText('Position X')).toHaveTextContent('1.0');
      expect(onSelectedObjectChange).toHaveBeenLastCalledWith('2');

      await user.click(within(picker).getByRole('option', { name: 'Bracket' }));

      expect(screen.getByLabelText('Position X')).toHaveTextContent('40.0');
      expect(screen.getByLabelText('Position Z')).toHaveTextContent('60.0');
      expect(screen.getByLabelText('Rotation Y')).toHaveTextContent('90.0°');
      expect(screen.getByLabelText('Scale Z')).toHaveTextContent('50%');
      expect(onSelectedObjectChange).toHaveBeenLastCalledWith('3');
    });

    it('shows no picker for a single-object plate but still reads it out', () => {
      renderStage({ plates: [plate(1, ['2'])] });
      selectObject('2');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Position X')).toHaveTextContent('10.0');
    });

    it('says so when the plate carries no objects', () => {
      renderStage({ plates: [{ index: 1, objects: [] }] });
      expect(screen.getByText('This plate has no objects')).toBeInTheDocument();
      expect(screen.queryByLabelText('Position X')).not.toBeInTheDocument();
    });

    it('never renders a negative zero', () => {
      renderStage({
        plates: [
          {
            index: 1,
            objects: [
              {
                id: '2',
                transform: { position: [-0.01, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              },
            ],
          },
        ],
      });
      selectObject('2');
      expect(screen.getByLabelText('Position X')).toHaveTextContent('0.0');
      expect(screen.getByLabelText('Position X').textContent).not.toContain('-');
    });

    it('stays display-only when the caller offers nowhere to put a change', () => {
      // An editable control whose edits go nowhere is worse than no control:
      // it would show a moved model that no slice would ever reflect.
      renderStage();
      expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
      expect(viewer()).toHaveAttribute('data-interactive', 'false');
      expect(viewer()).toHaveAttribute('data-gizmo-mode', '');
    });
  });

  /**
   * Selecting nothing (#55).
   *
   * The stage used to promote the plate's first object into the selection so
   * the readout always had a subject, which left the user with no way to have
   * nothing selected — and no way back out of a selection at all. The empty
   * state the UI already drew was unreachable.
   */
  describe('empty selection (#55)', () => {
    it('opens a populated plate with nothing selected', () => {
      renderStage();

      expect(screen.getByText('No object selected')).toBeInTheDocument();
      expect(screen.queryByLabelText('Position X')).not.toBeInTheDocument();
      expect(viewer()).toHaveAttribute('data-selected-object', '');
    });

    it('reports the empty selection to the caller', () => {
      const onSelectedObjectChange = vi.fn();
      renderStage({ onSelectedObjectChange });
      expect(onSelectedObjectChange).toHaveBeenCalledWith(null);
    });

    it('disables the transform tools but not auto-arrange', () => {
      renderControlled({ initialPlates: [plate(1, ['2'])] });

      for (const name of ['Move', 'Rotate', 'Scale', 'Lay flat']) {
        expect(screen.getByRole('button', { name })).toBeDisabled();
      }
      // Arranging a plate is not an operation on a selection.
      expect(screen.getByRole('button', { name: 'Auto-arrange' })).toBeEnabled();
    });

    it('leaves every picker chip unselected', () => {
      renderStage({ plates: [plate(1, ['2', '3'])] });

      const picker = screen.getByRole('listbox', { name: 'Objects' });
      for (const option of within(picker).getAllByRole('option')) {
        expect(option).toHaveAttribute('aria-selected', 'false');
      }
    });

    it('clears the selection when a click hits no object', () => {
      // What `ModelViewer` reports for a click landing on a bed or on empty
      // space: `null`, alongside whatever plate the bed belonged to.
      const onSelectedObjectChange = vi.fn();
      renderStage({ onSelectedObjectChange });
      selectObject('2');
      expect(viewer()).toHaveAttribute('data-selected-object', '2');

      act(() => viewerProps.onObjectPick?.(null));

      expect(viewer()).toHaveAttribute('data-selected-object', '');
      expect(screen.getByText('No object selected')).toBeInTheDocument();
      expect(onSelectedObjectChange).toHaveBeenLastCalledWith(null);
    });

    it('clears the selection on Escape', async () => {
      const user = userEvent.setup();
      renderStage();
      selectObject('2');
      expect(viewer()).toHaveAttribute('data-selected-object', '2');
      expect(screen.getByLabelText('Position X')).toBeInTheDocument();

      await user.keyboard('{Escape}');

      expect(viewer()).toHaveAttribute('data-selected-object', '');
      expect(screen.getByText('No object selected')).toBeInTheDocument();
    });

    it('still selects an object clicked in the viewport', () => {
      renderStage();
      selectObject('2');
      expect(viewer()).toHaveAttribute('data-selected-object', '2');
      expect(screen.queryByText('No object selected')).not.toBeInTheDocument();
    });
  });

  describe('gizmos (#25)', () => {
    it('offers the mockup\'s five placement tools once transforms have somewhere to go', () => {
      renderControlled();

      const toolbar = screen.getByRole('toolbar', { name: 'Placement tools' });
      for (const name of ['Move', 'Rotate', 'Scale', 'Lay flat', 'Auto-arrange']) {
        expect(within(toolbar).getByRole('button', { name })).toBeInTheDocument();
      }
      expect(viewer()).toHaveAttribute('data-interactive', 'true');
    });

    it('drives the viewport gizmo from the toolbar, one mode at a time', async () => {
      const user = userEvent.setup();
      renderControlled();
      selectObject('2');

      expect(viewer()).toHaveAttribute('data-gizmo-mode', 'translate');
      expect(screen.getByRole('button', { name: 'Move' })).toHaveAttribute('aria-pressed', 'true');

      await user.click(screen.getByRole('button', { name: 'Rotate' }));

      expect(viewer()).toHaveAttribute('data-gizmo-mode', 'rotate');
      expect(screen.getByRole('button', { name: 'Rotate' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Move' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('attaches the gizmo to whatever the readout is reading out', async () => {
      const user = userEvent.setup();
      renderControlled({
        initialPlates: [
          {
            index: 1,
            objects: [
              { id: '2', name: 'Base', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
              { id: '3', name: 'Bracket', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
            ],
          },
        ],
      });

      // Nothing until something is picked (#55).
      expect(viewer()).toHaveAttribute('data-selected-object', '');
      await user.click(screen.getByRole('option', { name: 'Base' }));
      expect(viewer()).toHaveAttribute('data-selected-object', '2');
      await user.click(screen.getByRole('option', { name: 'Bracket' }));
      expect(viewer()).toHaveAttribute('data-selected-object', '3');
    });

    it('selects an object clicked in the viewport itself', () => {
      renderControlled({
        initialPlates: [
          {
            index: 1,
            objects: [
              { id: '2', name: 'Base', transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] } },
              { id: '3', name: 'Bracket', transform: { position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] } },
            ],
          },
        ],
      });

      act(() => viewerProps.onObjectPick?.('3'));

      expect(viewer()).toHaveAttribute('data-selected-object', '3');
      expect(screen.getByLabelText('Position X')).toHaveValue(9);
    });

    it('updates the readout when a model is dragged', () => {
      renderControlled({ initialPlates: [plate(1, ['2'])] });
      selectObject('2');

      expect(screen.getByLabelText('Position X')).toHaveValue(10);

      dragGizmo('2', { position: [42.5, -7.25, 0], rotation: [0, 0, 30], scale: [1, 1, 1] });

      expect(screen.getByLabelText('Position X')).toHaveValue(42.5);
      // Shown unrounded: tabbing through the cell must not quantise the drag.
      expect(screen.getByLabelText('Position Y')).toHaveValue(-7.25);
      expect(screen.getByLabelText('Rotation Z')).toHaveValue(30);
    });

    it('reports the drag to the caller, keyed by the 3MF object id', () => {
      // The id is what the backend matches a saved transform on: a mismatch
      // is silent — the save succeeds and the slice comes out unarranged.
      const onTransformChange = vi.fn();
      render(
        <PlateStage
          url="/model.3mf"
          plates={[plate(2, ['7'])]}
          onTransformChange={onTransformChange}
        />,
      );

      const moved: ObjectTransform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] };
      dragGizmo('7', moved);

      expect(onTransformChange).toHaveBeenCalledWith(2, '7', moved);
    });

    it('ignores a drag naming an object that is no longer on the plate', () => {
      const onTransformChange = vi.fn();
      render(
        <PlateStage
          url="/model.3mf"
          plates={[plate(1, ['2'])]}
          onTransformChange={onTransformChange}
        />,
      );

      dragGizmo('999', { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] });
      expect(onTransformChange).not.toHaveBeenCalled();
    });

    it('moves the model when a number is typed into the readout', async () => {
      const user = userEvent.setup();
      renderControlled({ initialPlates: [plate(1, ['2'])] });
      selectObject('2');

      expect(renderedTransform('2').position).toEqual([10, 20, 0]);

      const x = screen.getByLabelText('Position X');
      await user.clear(x);
      await user.type(x, '75.5');
      await user.tab();

      // The viewport is what moved, not just the label above it.
      expect(renderedTransform('2').position).toEqual([75.5, 20, 0]);
      expect(screen.getByLabelText('Position X')).toHaveValue(75.5);
    });

    it('commits a typed value on Enter as well as on blur', async () => {
      const user = userEvent.setup();
      renderControlled({ initialPlates: [plate(1, ['2'])] });
      selectObject('2');

      const rotation = screen.getByLabelText('Rotation Z');
      await user.clear(rotation);
      await user.type(rotation, '90{Enter}');

      expect(renderedTransform('2').rotation).toEqual([0, 0, 90]);
    });

    it('does not report a half-typed number', async () => {
      // Committing per keystroke would send "-" through Number() as NaN and
      // "1." as 1, so typing -12.5 would drag the model to 1 mm on the way.
      const user = userEvent.setup();
      const onTransformChange = vi.fn();
      render(
        <PlateStage
          url="/model.3mf"
          plates={[plate(1, ['2'])]}
          onTransformChange={onTransformChange}
        />,
      );
      selectObject('2');

      const x = screen.getByLabelText('Position X');
      await user.clear(x);
      await user.type(x, '-12.5');

      expect(onTransformChange).not.toHaveBeenCalled();

      await user.tab();
      expect(onTransformChange).toHaveBeenCalledTimes(1);
      expect(onTransformChange).toHaveBeenCalledWith(1, '2', expect.objectContaining({
        position: [-12.5, 20, 0],
      }));
    });

    it('types scale as a percentage and stores it as a multiplier', async () => {
      const user = userEvent.setup();
      renderControlled({ initialPlates: [plate(1, ['2'])] });
      selectObject('2');

      expect(screen.getByLabelText('Scale X')).toHaveValue(100);

      const scale = screen.getByLabelText('Scale X');
      await user.clear(scale);
      await user.type(scale, '250');
      await user.tab();

      expect(renderedTransform('2').scale).toEqual([2.5, 1, 1]);
    });

    it('refuses a zero scale, which no gizmo could grow back', async () => {
      const user = userEvent.setup();
      renderControlled({ initialPlates: [plate(1, ['2'])] });
      selectObject('2');

      const scale = screen.getByLabelText('Scale Y');
      await user.clear(scale);
      await user.type(scale, '0');
      await user.tab();

      expect(renderedTransform('2').scale[1]).toBeGreaterThan(0);
    });

    it('lays the selected object flat and drops it back onto the bed', async () => {
      const user = userEvent.setup();
      renderControlled({
        initialPlates: [
          {
            index: 1,
            objects: [
              { id: '2', transform: { position: [10, 20, 30], rotation: [37, -12, 45], scale: [1, 1, 1] } },
            ],
          },
        ],
      });
      selectObject('2');

      await user.click(screen.getByRole('button', { name: 'Lay flat' }));

      expect(renderedTransform('2').rotation).toEqual([0, 0, 45]);
      expect(renderedTransform('2').position).toEqual([10, 20, 0]);
    });

    it('arranges every object on the plate from the measured footprints', async () => {
      const user = userEvent.setup();
      renderControlled({
        initialPlates: [
          {
            index: 1,
            objects: [
              { id: '2', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
              { id: '3', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
            ],
          },
        ],
        buildVolume: { x: 256, y: 256, z: 256 },
      });

      act(() =>
        viewerProps.onObjectMetrics?.({
          '2': { anchor: [0, 0, 0], size: [40, 40, 40] },
          '3': { anchor: [0, 0, 0], size: [40, 40, 40] },
        }),
      );

      await user.click(screen.getByRole('button', { name: 'Auto-arrange' }));

      const a = renderedTransform('2').position;
      const b = renderedTransform('3').position;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(40);
    });

    /**
     * Auto-arrange centres on the bed, so *which* bed it uses is visible in the
     * emitted transform (#69). One object, anchor at the origin, lands at the
     * bed's centre exactly — which makes the bed readable off the position.
     *
     * This is the stage half of the rule; `buildVolume.test.ts` pins the rule
     * itself. What is checked here is that the stage arranges onto the bed the
     * viewport actually **drew**, rather than onto the rail's printer — the two
     * differ for any 3MF that declares its own `printable_area`, and an arrange
     * that used the wrong one would put the model beside the visible plate.
     */
    describe('the bed Auto-arrange lands on (#69)', () => {
      async function arrangeOne(props: {
        buildVolume?: { x: number; y: number; z: number };
        fileBed?: { x: number; y: number } | null;
      }) {
        const user = userEvent.setup();
        renderControlled({
          initialPlates: [
            {
              index: 1,
              objects: [
                { id: '2', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
              ],
            },
          ],
          buildVolume: props.buildVolume,
        });
        act(() => viewerProps.onObjectMetrics?.({ '2': { anchor: [0, 0, 0], size: [40, 40, 40] } }));
        reportFileBed(props.fileBed ?? null);
        await user.click(screen.getByRole('button', { name: 'Auto-arrange' }));
        return renderedTransform('2').position;
      }

      it('uses the selected printer when the file declares no bed', async () => {
        // Rule 2 — an STL, or a 3MF without `printable_area`. An H2D's
        // 350 x 320 centres at (175, 160), not (128, 128).
        const position = await arrangeOne({ buildVolume: { x: 350, y: 320, z: 256 }, fileBed: null });
        expect(position[0]).toBe(175);
        expect(position[1]).toBe(160);
      });

      it('moves with the printer, which is the whole ask', async () => {
        // Same file, a different printer picked in the rail: an A1 mini is
        // 180 x 180 and centres at (90, 90) — the figure #70's spike measured
        // off a real slice.
        const position = await arrangeOne({ buildVolume: { x: 180, y: 180, z: 256 }, fileBed: null });
        expect(position[0]).toBe(90);
        expect(position[1]).toBe(90);
      });

      it('uses the FILE\'s bed when it declares one, whatever the rail says', async () => {
        // Rule 1, and the regression that matters most. The H2S reference file
        // (#41) is 340 x 320 and its plate-grid offsets are baked against that;
        // with an H2D selected the arrange must still land on 340, at 170 — not
        // on the H2D's 350, at 175.
        const position = await arrangeOne({
          buildVolume: { x: 350, y: 320, z: 256 },
          fileBed: { x: 340, y: 320 },
        });
        expect(position[0]).toBe(170);
        expect(position[1]).toBe(160);
      });

      it('falls back to 256 when neither the file nor the printer says', async () => {
        // Rule 3 — the live state of every deployment whose sidecar image
        // predates #68, so it has to stay exactly as it was.
        const position = await arrangeOne({ buildVolume: undefined, fileBed: null });
        expect(position[0]).toBe(128);
        expect(position[1]).toBe(128);
      });
    });

    it('hands the caller each object\'s anchor and size (#32 saves against these)', () => {
      const onObjectMetricsChange = vi.fn();
      renderControlled({ initialPlates: [plate(1, ['2'])], onObjectMetricsChange });

      const metrics = { '2': { anchor: [128, 128, 0] as [number, number, number], size: [30, 30, 74] as [number, number, number] } };
      act(() => viewerProps.onObjectMetrics?.(metrics));

      expect(onObjectMetricsChange).toHaveBeenCalledWith(metrics);
    });

    it('grows the hit targets on touch, where desktop handles are unusable (#11)', () => {
      renderControlled({ initialPlates: [plate(1, ['2'])], touchTargets: true });

      expect(viewer()).toHaveAttribute('data-touch-targets', 'true');
      // 44px is the smallest target a finger hits reliably; h-11 is 2.75rem.
      expect(screen.getByRole('button', { name: 'Move' }).className).toContain('h-11');
    });

    it('says nothing to move when the plate is empty', () => {
      renderControlled({ initialPlates: [{ index: 1, objects: [] }] });

      expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Auto-arrange' })).toBeDisabled();
      expect(screen.getByText('This plate has no objects')).toBeInTheDocument();
    });
  });

  describe('slots and pass-through', () => {
    it('renders the bed at the given build volume', () => {
      renderStage({ buildVolume: { x: 350, y: 320, z: 325 } });
      expect(viewer()).toHaveAttribute('data-build-volume', '350x320x325');
    });

    it('mounts the toolbar and action bar slots (#12 / #15 extension points)', () => {
      renderStage({
        toolbar: <button type="button">Move</button>,
        actionBar: <button type="button">Slice</button>,
      });
      expect(screen.getByRole('button', { name: 'Move' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Slice' })).toBeInTheDocument();
    });
  });
});

describe('buildStagePlates', () => {
  const metadata: PlateMetadata[] = [
    {
      index: 1,
      name: 'Plate 1',
      objects: ['2', '3'],
      has_thumbnail: false,
      thumbnail_url: null,
      print_time_seconds: null,
      filament_used_grams: null,
      filaments: [],
    },
  ];

  it('leaves every object as-designed when there is no layout', () => {
    const [built] = buildStagePlates(metadata);
    expect(built.index).toBe(1);
    expect(built.objects.map((o) => o.id)).toEqual(['2', '3']);
    expect(built.objects[0].transform).toEqual(IDENTITY_TRANSFORM);
  });

  const anchors: Record<string, ObjectMetrics> = {
    '2': { anchor: [100, 100, 0], size: [20, 20, 20] },
    '3': { anchor: [88, 60, 0], size: [20, 20, 20] },
  };

  it('applies a stored layout by object id and leaves the rest as-designed', () => {
    const layout: PlateLayout = {
      version: 1,
      plates: {
        '1': [
          { object_id: '3', position: [128, 128, 0], rotation: [0, 0, 45], scale: [1, 1, 1] },
        ],
      },
    };

    const [built] = buildStagePlates(metadata, layout, anchors);
    expect(built.objects[0].transform).toEqual(IDENTITY_TRANSFORM);
    // The stored position is *absolute*; the stage renders the delta from the
    // object's anchor. Passing it through unchanged would be a 128 mm jump.
    expect(built.objects[1].transform).toEqual({
      position: [40, 68, 0],
      rotation: [0, 0, 45],
      scale: [1, 1, 1],
    });
  });

  it('leaves an object as designed while its anchor is still unknown', () => {
    // The anchors come from the 3MF parse and land after the layout does. A
    // guessed anchor would place the object somewhere it has never been; as
    // designed is at least a position the file itself describes.
    const layout: PlateLayout = {
      version: 1,
      plates: {
        '1': [{ object_id: '3', position: [128, 128, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
      },
    };

    const [built] = buildStagePlates(metadata, layout, {});
    expect(built.objects[1].transform).toEqual(IDENTITY_TRANSFORM);
  });

  it('rejects an unsupported layout version rather than guessing (spec §4)', () => {
    const layout = {
      version: 2,
      plates: { '1': [{ object_id: '2', position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] }] },
    } as PlateLayout;

    expect(isSupportedPlateLayout(layout)).toBe(false);
    const [built] = buildStagePlates(metadata, layout);
    expect(built.objects[0].transform).toEqual(IDENTITY_TRANSFORM);
  });

  it('addresses objects by their 3MF ids, not by the display names', () => {
    // `PlateMetadata.objects` is what the file grid shows — "part_0.stl".
    // `object_ids` is what `ModelViewer` attaches a gizmo to and what the
    // slicer matches a placement against. Keying the stage on the names
    // produces a viewport nothing can move and a layout that saves cleanly
    // and applies to nothing.
    const named: PlateMetadata[] = [
      { ...metadata[0], objects: ['part_0.stl', 'part_1.stl'], object_ids: ['2', '3'] },
    ];
    const [built] = buildStagePlates(named);
    expect(built.objects.map((object) => object.id)).toEqual(['2', '3']);
  });

  it('falls back to the names when a backend sends no ids at all', () => {
    const [built] = buildStagePlates(metadata);
    expect(built.objects.map((object) => object.id)).toEqual(['2', '3']);
  });

  it('gives each as-designed object its own arrays', () => {
    const [built] = buildStagePlates(metadata);
    expect(built.objects[0].transform.position).not.toBe(built.objects[1].transform.position);
    expect(built.objects[0].transform.position).not.toBe(IDENTITY_TRANSFORM.position);
  });
});

/**
 * The delta → absolute half of the persistence bridge (#32, step-8.2).
 *
 * Every case here is one that would have "saved successfully" and sliced
 * wrongly: the backend takes whatever numbers it is handed and cannot tell an
 * anchor-relative delta from a bed coordinate.
 */
describe('toPlateLayout', () => {
  const metrics: Record<string, ObjectMetrics> = {
    '2': { anchor: [100, 100, 0], size: [20, 20, 20] },
    '3': { anchor: [88, 60, 0], size: [30, 30, 30] },
  };

  const stagePlate = (objects: StagePlate['objects']): StagePlate[] => [
    { index: 1, name: 'Plate 1', objects },
  ];

  it('writes the absolute bed coordinate, not the delta the stage holds', () => {
    const layout = toPlateLayout(
      stagePlate([
        {
          id: '2',
          transform: { position: [40, -10, 0], rotation: [0, 0, 90], scale: [1, 1, 1] },
        },
      ]),
      metrics,
    );

    expect(layout).toEqual({
      version: 1,
      plates: {
        '1': [
          { object_id: '2', position: [140, 90, 0], rotation: [0, 0, 90], scale: [1, 1, 1] },
        ],
      },
    });
  });

  it('round-trips every object of a multi-object plate', () => {
    const objects = [
      { id: '2', transform: { position: [40, -10, 0], rotation: [0, 0, 90], scale: [1, 1, 1] } },
      { id: '3', transform: { position: [-12, 4.5, 0], rotation: [0, 0, 0], scale: [2, 2, 2] } },
    ];
    const layout = toPlateLayout(stagePlate(objects), metrics);

    expect(layout?.plates['1']).toHaveLength(2);
    // Back through the reader, against the plate metadata — the same path a
    // page reload takes. Every object has to come back where it was, not just
    // the one that happened to be selected.
    const restored = buildStagePlates(
      [
        {
          index: 1,
          name: 'Plate 1',
          objects: ['2', '3'],
          has_thumbnail: false,
          thumbnail_url: null,
          print_time_seconds: null,
          filament_used_grams: null,
          filaments: [],
        },
      ],
      layout,
      metrics,
    );
    expect(restored[0].objects).toEqual(objects);
  });

  it('drops an object that is back as designed, so "absent" keeps meaning original', () => {
    const layout = toPlateLayout(
      stagePlate([
        { id: '2', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { id: '3', transform: { position: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ]),
      metrics,
    );

    expect(layout?.plates['1'].map((entry) => entry.object_id)).toEqual(['3']);
  });

  it('is null when nothing is arranged, so saving clears the stored layout', () => {
    const layout = toPlateLayout(
      stagePlate([
        { id: '2', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ]),
      metrics,
      { version: 1, plates: { '1': [{ object_id: '2', position: [140, 90, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }] } },
    );

    expect(layout).toBeNull();
  });

  it('keeps the stored arrangement of plates the viewport never measured', () => {
    // **The one that loses a user's work silently.** `ModelViewer` only
    // measures the plate it is rendering, so plate 2's objects sit at identity
    // in the stage while plate 1 is open. Rebuilding the layout from the stage
    // would write those out as "as designed" and drop plate 2's arrangement —
    // and the save would report success.
    const stored: PlateLayout = {
      version: 1,
      plates: {
        '1': [{ object_id: '2', position: [140, 90, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
        '2': [{ object_id: '9', position: [30, 30, 0], rotation: [0, 0, 15], scale: [1, 1, 1] }],
      },
    };
    const plates: StagePlate[] = [
      {
        index: 1,
        name: 'Plate 1',
        objects: [
          { id: '2', transform: { position: [40, -10, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        ],
      },
      {
        index: 2,
        name: 'Plate 2',
        objects: [{ id: '9', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      },
    ];

    const layout = toPlateLayout(plates, metrics, stored);
    expect(layout?.plates['2']).toEqual(stored.plates['2']);
    expect(layout?.plates['1']).toEqual([
      { object_id: '2', position: [140, 90, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    ]);
  });

  it('survives an anchor that is not a round number', () => {
    // `anchor + delta - anchor` is not the identity in binary floating point,
    // and the drift would flow into `selectionFingerprint` and stale a slice
    // the moment its layout was saved.
    const odd: Record<string, ObjectMetrics> = {
      '2': { anchor: [0.1, 33.33, 0], size: [1, 1, 1] },
    };
    const objects = [
      { id: '2', transform: { position: [0.2, 1.11, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    ];
    const layout = toPlateLayout(stagePlate(objects), odd);
    const [restored] = buildStagePlates(
      [
        {
          index: 1,
          name: 'Plate 1',
          objects: ['2'],
          has_thumbnail: false,
          thumbnail_url: null,
          print_time_seconds: null,
          filament_used_grams: null,
          filaments: [],
        },
      ],
      layout,
      odd,
    );
    expect(restored.objects[0].transform.position).toEqual([0.2, 1.11, 0]);
  });
});
