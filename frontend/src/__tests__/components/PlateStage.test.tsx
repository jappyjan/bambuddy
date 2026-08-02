/**
 * Tests for PlateStage (#14, step-5.2) and its plate-layout bridge.
 *
 * ModelViewer is mocked: it stands up a real WebGL context and parses a 3MF
 * over the network, neither of which jsdom has. The mock echoes the props
 * that PlateStage is responsible for driving — that is exactly the contract
 * under test, since "the rendered plate changed" *is* "ModelViewer was told
 * a different selectedPlateId".
 */

import { describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { PlateStage } from '../../components/slicer/PlateStage';
import {
  IDENTITY_TRANSFORM,
  buildStagePlates,
  isSupportedPlateLayout,
} from '../../components/slicer/plateLayout';
import type { PlateMetadata } from '../../types/plates';
import type { PlateLayout, StagePlate } from '../../types/plateStage';

vi.mock('../../components/ModelViewer', () => ({
  ModelViewer: ({
    selectedPlateId,
    buildVolume,
  }: {
    selectedPlateId?: number | null;
    buildVolume?: { x: number; y: number; z: number };
  }) => (
    <div
      data-testid="model-viewer"
      data-selected-plate={String(selectedPlateId ?? '')}
      data-build-volume={buildVolume ? `${buildVolume.x}x${buildVolume.y}x${buildVolume.z}` : ''}
    />
  ),
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

describe('PlateStage', () => {
  describe('plate tabs', () => {
    it('opens on the first plate and drives the viewport with it', () => {
      renderStage();
      expect(viewer()).toHaveAttribute('data-selected-plate', '1');
      expect(screen.getByRole('tab', { name: 'Plate 1' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('changes the rendered plate when another tab is clicked', async () => {
      const user = userEvent.setup();
      renderStage();

      await user.click(screen.getByRole('tab', { name: 'Plate 2' }));

      expect(viewer()).toHaveAttribute('data-selected-plate', '2');
      expect(screen.getByRole('tab', { name: 'Plate 2' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: 'Plate 1' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });

    it('reports plate switches to the caller (#15 invalidates a slice on this)', async () => {
      const user = userEvent.setup();
      const onActivePlateChange = vi.fn();
      renderStage({ onActivePlateChange });

      await user.click(screen.getByRole('tab', { name: 'Plate 2' }));
      expect(onActivePlateChange).toHaveBeenCalledWith(2);

      // Re-clicking the active tab is not a change.
      onActivePlateChange.mockClear();
      await user.click(screen.getByRole('tab', { name: 'Plate 2' }));
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
      expect(screen.getByRole('tab', { name: 'Lid' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Body' })).toBeInTheDocument();
    });

    it('hides the tab strip for a single-plate source', () => {
      renderStage({ plates: [plate(1, ['2'])] });
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      expect(viewer()).toHaveAttribute('data-selected-plate', '1');
    });

    it('falls back to the first plate when the active one disappears', () => {
      const { rerender } = renderStage({ initialPlate: 2 });
      expect(viewer()).toHaveAttribute('data-selected-plate', '2');

      rerender(<PlateStage url="/model.3mf" plates={[plate(1, ['2'])]} />);
      expect(viewer()).toHaveAttribute('data-selected-plate', '1');
    });
  });

  describe('transform readout', () => {
    it('reflects the selected object', () => {
      renderStage();

      // Plate 1's object sits at [10, 20, 0] with a 45° Z rotation.
      expect(screen.getByLabelText('Position X')).toHaveTextContent('10.0');
      expect(screen.getByLabelText('Position Y')).toHaveTextContent('20.0');
      expect(screen.getByLabelText('Position Z')).toHaveTextContent('0.0');
      expect(screen.getByLabelText('Rotation Z')).toHaveTextContent('45.0°');
      expect(screen.getByLabelText('Scale X')).toHaveTextContent('100%');
    });

    it("follows the plate switch to that plate's object", async () => {
      const user = userEvent.setup();
      renderStage();

      await user.click(screen.getByRole('tab', { name: 'Plate 2' }));

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

      // Defaults to the first object.
      expect(screen.getByLabelText('Position X')).toHaveTextContent('1.0');
      expect(onSelectedObjectChange).toHaveBeenCalledWith('2');

      const picker = screen.getByRole('listbox', { name: 'Objects' });
      await user.click(within(picker).getByRole('option', { name: 'Bracket' }));

      expect(screen.getByLabelText('Position X')).toHaveTextContent('40.0');
      expect(screen.getByLabelText('Position Z')).toHaveTextContent('60.0');
      expect(screen.getByLabelText('Rotation Y')).toHaveTextContent('90.0°');
      expect(screen.getByLabelText('Scale Z')).toHaveTextContent('50%');
      expect(onSelectedObjectChange).toHaveBeenLastCalledWith('3');
    });

    it('shows no picker for a single-object plate but still reads it out', () => {
      renderStage({ plates: [plate(1, ['2'])] });
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
      expect(screen.getByLabelText('Position X')).toHaveTextContent('0.0');
      expect(screen.getByLabelText('Position X').textContent).not.toContain('-');
    });

    it('is read-only in this ticket — no editable inputs', () => {
      renderStage();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
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

  it('applies a stored layout by object id and leaves the rest as-designed', () => {
    const layout: PlateLayout = {
      version: 1,
      plates: {
        '1': [
          { object_id: '3', position: [128, 128, 0], rotation: [0, 0, 45], scale: [1, 1, 1] },
        ],
      },
    };

    const [built] = buildStagePlates(metadata, layout);
    expect(built.objects[0].transform).toEqual(IDENTITY_TRANSFORM);
    expect(built.objects[1].transform).toEqual({
      position: [128, 128, 0],
      rotation: [0, 0, 45],
      scale: [1, 1, 1],
    });
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

  it('gives each as-designed object its own arrays', () => {
    const [built] = buildStagePlates(metadata);
    expect(built.objects[0].transform.position).not.toBe(built.objects[1].transform.position);
    expect(built.objects[0].transform.position).not.toBe(IDENTITY_TRANSFORM.position);
  });
});
