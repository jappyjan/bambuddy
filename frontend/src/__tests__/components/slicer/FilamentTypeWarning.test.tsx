/**
 * The material honesty guard, rendered (#47).
 *
 * `slicePresetPickerStandardTier.test.ts` pins *when* the guard fires and
 * `useSlicePresets.test.tsx` pins that the hook produces one verdict per slot.
 * What is left — and what actually protects the user — is that the verdict
 * reaches the screen next to the control it is about, on both slice surfaces.
 *
 * Both surfaces render the same `PresetDropdown`, so the warning is asserted
 * once on that control and once through `FilamentSlotGrid`, which is where the
 * rail and the mobile wizard mount it. The grid case also pins the one
 * suppression rule: a slot the plate does not paint with is auto-picked and
 * read-only, so warning about its material is noise the user cannot act on.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import { PresetDropdown } from '../../../components/slicer/PresetControls';
import { FilamentSlotGrid } from '../../../components/slicer/FilamentSlotGrid';
import { seedSlots } from '../../../components/slicer/filamentSlots';
import { EMPTY_COMPATIBILITY_INDEX } from '../../../utils/slicerPrinterMatch';
import type { FilamentTypeWarning } from '../../../utils/slicePresetPicker';
import type { UnifiedPresetsResponse } from '../../../api/client';

const PRESETS: UnifiedPresetsResponse = {
  orca_cloud: { printer: [], process: [], filament: [] },
  cloud: { printer: [], process: [], filament: [] },
  local: {
    printer: [],
    process: [],
    filament: [
      { id: 'tpu', name: 'Custom Generic TPU', source: 'local', filament_type: 'TPU' },
    ],
  },
  standard: { printer: [], process: [], filament: [] },
  cloud_status: 'ok',
  orca_cloud_status: 'ok',
};

const MISMATCH: FilamentTypeWarning = {
  kind: 'mismatch',
  required: 'ABS',
  selectedName: 'Custom Generic TPU',
  selectedType: 'TPU',
};

const UNAVAILABLE: FilamentTypeWarning = {
  kind: 'unavailable',
  required: 'ABS',
  selectedName: 'Bambu ABS @BBL H2S',
  selectedType: null,
};

describe('PresetDropdown — filament type warning', () => {
  it('names the required material and the one actually selected', () => {
    render(
      <PresetDropdown
        label="Filament 1 (ABS)"
        slot="filament"
        data={PRESETS}
        value={{ source: 'local', id: 'tpu' }}
        onChange={vi.fn()}
        typeWarning={MISMATCH}
      />,
    );
    const warning = screen.getByTestId('filament-type-warning');
    expect(warning).toHaveTextContent(/ABS/);
    expect(warning).toHaveTextContent(/Custom Generic TPU/);
    expect(warning).toHaveTextContent(/TPU/);
    // Announced, not merely coloured — the colour alone is not a statement.
    expect(warning).toHaveAttribute('role', 'alert');
  });

  it('leaves the selection intact so a deliberate slice is still possible', () => {
    render(
      <PresetDropdown
        label="Filament 1 (ABS)"
        slot="filament"
        data={PRESETS}
        value={{ source: 'local', id: 'tpu' }}
        onChange={vi.fn()}
        typeWarning={MISMATCH}
      />,
    );
    // Clearing the slot would be the *less* honest option here: `SliceModal`
    // refuses to enqueue while any filament slot is null, so an emptied
    // dropdown turns "we cannot confirm this material" into "you cannot slice".
    expect(screen.getByRole('combobox')).toHaveValue('local:tpu');
    expect(screen.getByRole('combobox')).not.toBeDisabled();
  });

  it('says a profile of the material was not found at all', () => {
    render(
      <PresetDropdown
        label="Filament 1 (ABS)"
        slot="filament"
        data={PRESETS}
        value={null}
        onChange={vi.fn()}
        typeWarning={UNAVAILABLE}
      />,
    );
    expect(screen.getByTestId('filament-type-warning')).toHaveTextContent(/ABS/);
  });

  it('renders nothing when there is no warning', () => {
    render(
      <PresetDropdown
        label="Filament 1 (ABS)"
        slot="filament"
        data={PRESETS}
        value={{ source: 'local', id: 'tpu' }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('filament-type-warning')).toBeNull();
  });
});

describe('FilamentSlotGrid — filament type warning', () => {
  function renderGrid(warnings: (FilamentTypeWarning | null)[], usedInPlate: boolean[]) {
    const slots = seedSlots(
      usedInPlate.map((used, i) => ({
        slot_id: i + 1,
        type: 'ABS',
        color: '#FF6A13',
        used_grams: 0,
        used_meters: 0,
        used_in_plate: used,
      })),
    );
    return render(
      <FilamentSlotGrid
        presets={PRESETS}
        slots={slots}
        slotsLoading={false}
        filamentPresets={slots.map(() => ({ source: 'local' as const, id: 'tpu' }))}
        filamentTypeWarnings={warnings}
        onFilamentPresetChange={vi.fn()}
        onAddSlot={vi.fn()}
        onInsertSlotAfter={vi.fn()}
        onRemoveSlot={vi.fn()}
        onSlotColorChange={vi.fn()}
        selectedPrinterName={null}
        compatIndex={EMPTY_COMPATIBILITY_INDEX}
      />,
    );
  }

  it('warns on the plate-used slot', () => {
    renderGrid([MISMATCH], [true]);
    expect(screen.getByTestId('filament-type-warning')).toHaveTextContent(/ABS/);
  });

  it('stays quiet on a slot the plate does not paint with', () => {
    renderGrid([MISMATCH], [false]);
    expect(screen.queryByTestId('filament-type-warning')).toBeNull();
  });

  it('warns once per affected slot, not once per slot', () => {
    renderGrid([MISMATCH, null, MISMATCH], [true, true, true]);
    expect(screen.getAllByTestId('filament-type-warning')).toHaveLength(2);
  });
});
