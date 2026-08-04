/**
 * Other printers' presets are hidden, not demoted (#57).
 *
 * `slicerPrinterMatch.test.ts` already pins *which* preset resolves to which
 * printer. What is asserted here is the display decision the owner overruled:
 * on the `/slicer` rail a preset that resolves to a different printer is gone
 * from the list rather than parked in a trailing "Other printers" group.
 *
 * The three cases that make this a fix rather than a new bug get their own
 * tests, because each of them fails silently:
 *
 *  - 'unknown' presets stay. Custom and untagged imports match no rule, and
 *    hiding those would lose the profiles a user actually authored — a worse
 *    bug than the one being fixed.
 *  - a dropdown emptied *by the filter* says so. The select disables itself at
 *    zero entries, and "No presets available" would be a lie about an install
 *    that has plenty, just not for this printer.
 *  - the preset already selected stays listed even when it mismatches. A
 *    `<select>` whose value is absent from its options renders blank, so
 *    hiding it would show an empty control while the slice request still
 *    carries that preset.
 *
 * `SliceModal` is deliberately untouched (it is the legacy fallback), so the
 * grouping behaviour is pinned here too — from the same component, with the
 * flag off.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import { PresetDropdown } from '../../../components/slicer/PresetControls';
import { SlicerRail } from '../../../components/slicer/SlicerRail';
import { seedSlots } from '../../../components/slicer/filamentSlots';
import { buildCompatibilityIndex } from '../../../utils/slicerPrinterMatch';
import type { UnifiedPresetsResponse } from '../../../api/client';

const PRINTER_NAME = 'Bambu Lab X1 Carbon 0.4 nozzle';
const COMPAT_INDEX = buildCompatibilityIndex({
  'Bambu Lab X1 Carbon': 'X1C',
  'Bambu Lab P1S': 'P1S',
});

const MATCHING_PROCESS = '0.20mm Standard @BBL X1C';
const OTHER_PROCESS = '0.20mm Standard @BBL P1S';
const UNTAGGED_PROCESS = 'My Own Fast Draft';

const MATCHING_FILAMENT = 'Bambu PLA Basic @BBL X1C';
const OTHER_FILAMENT = 'Bambu PLA Basic @BBL P1S';
const UNTAGGED_FILAMENT = 'Warehouse PLA (opened 2026-01)';

const PRESETS: UnifiedPresetsResponse = {
  orca_cloud: { printer: [], process: [], filament: [] },
  cloud: { printer: [], process: [], filament: [] },
  local: {
    printer: [{ id: 'x1c', name: PRINTER_NAME, source: 'local' }],
    process: [{ id: 'mine', name: UNTAGGED_PROCESS, source: 'local' }],
    filament: [
      { id: 'mine', name: UNTAGGED_FILAMENT, source: 'local', filament_type: 'PLA' },
    ],
  },
  standard: {
    printer: [],
    process: [
      { id: 'ok', name: MATCHING_PROCESS, source: 'standard' },
      { id: 'nope', name: OTHER_PROCESS, source: 'standard' },
    ],
    filament: [
      { id: 'ok', name: MATCHING_FILAMENT, source: 'standard', filament_type: 'PLA' },
      { id: 'nope', name: OTHER_FILAMENT, source: 'standard', filament_type: 'PLA' },
    ],
  },
  cloud_status: 'ok',
  orca_cloud_status: 'ok',
};

/** Only mismatches — the case where hiding empties the control outright. */
const ALL_OTHER_PRINTERS: UnifiedPresetsResponse = {
  ...PRESETS,
  local: { printer: PRESETS.local.printer, process: [], filament: [] },
  standard: {
    printer: [],
    process: [{ id: 'nope', name: OTHER_PROCESS, source: 'standard' }],
    filament: [{ id: 'nope', name: OTHER_FILAMENT, source: 'standard', filament_type: 'PLA' }],
  },
};

function optgroupLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('optgroup')).map((g) => g.label);
}

describe('PresetDropdown — hideIncompatible', () => {
  it('drops presets that resolve to another printer', () => {
    render(
      <PresetDropdown
        label="Process"
        slot="process"
        data={PRESETS}
        value={null}
        onChange={vi.fn()}
        selectedPrinterName={PRINTER_NAME}
        compatIndex={COMPAT_INDEX}
        hideIncompatible
      />,
    );
    expect(screen.getByRole('option', { name: MATCHING_PROCESS })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: OTHER_PROCESS })).toBeNull();
  });

  it('keeps presets whose compatibility is unknown', () => {
    // The whole reason `presetCompatibility` has three answers rather than
    // two: an untagged import is not evidence of incompatibility.
    render(
      <PresetDropdown
        label="Process"
        slot="process"
        data={PRESETS}
        value={null}
        onChange={vi.fn()}
        selectedPrinterName={PRINTER_NAME}
        compatIndex={COMPAT_INDEX}
        hideIncompatible
      />,
    );
    expect(screen.getByRole('option', { name: UNTAGGED_PROCESS })).toBeInTheDocument();
  });

  it('renders no "Other printers" group', () => {
    const { container } = render(
      <PresetDropdown
        label="Process"
        slot="process"
        data={PRESETS}
        value={null}
        onChange={vi.fn()}
        selectedPrinterName={PRINTER_NAME}
        compatIndex={COMPAT_INDEX}
        hideIncompatible
      />,
    );
    expect(optgroupLabels(container)).not.toContain('Other printers');
  });

  it('says why the list is empty when the filter emptied it', () => {
    render(
      <PresetDropdown
        label="Process"
        slot="process"
        data={ALL_OTHER_PRINTERS}
        value={null}
        onChange={vi.fn()}
        selectedPrinterName={PRINTER_NAME}
        compatIndex={COMPAT_INDEX}
        hideIncompatible
      />,
    );
    expect(screen.getByRole('option', { name: 'No presets for this printer' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'No presets available' })).toBeNull();
  });

  it('still says "no presets" when there were none to begin with', () => {
    // No printer selected — nothing was filtered, so blaming the printer
    // would send the user looking for the wrong problem.
    render(
      <PresetDropdown
        label="Process"
        slot="process"
        data={{ ...PRESETS, local: { ...PRESETS.local, process: [] }, standard: { ...PRESETS.standard, process: [] } }}
        value={null}
        onChange={vi.fn()}
        selectedPrinterName={null}
        compatIndex={COMPAT_INDEX}
        hideIncompatible
      />,
    );
    expect(screen.getByRole('option', { name: 'No presets available' })).toBeInTheDocument();
  });

  it('keeps a mismatching preset that is currently selected', () => {
    render(
      <PresetDropdown
        label="Process"
        slot="process"
        data={PRESETS}
        value={{ source: 'standard', id: 'nope' }}
        onChange={vi.fn()}
        selectedPrinterName={PRINTER_NAME}
        compatIndex={COMPAT_INDEX}
        hideIncompatible
      />,
    );
    expect(screen.getByRole('option', { name: OTHER_PROCESS })).toBeInTheDocument();
    // The point of keeping it: the control shows what will be sliced.
    expect(screen.getByRole('combobox')).toHaveValue('standard:nope');
  });

  it('leaves the "Other printers" grouping alone when the flag is off', () => {
    // `SliceModal` is the legacy slice path and still renders this control
    // without the flag; nobody asked for it to change.
    const { container } = render(
      <PresetDropdown
        label="Process"
        slot="process"
        data={PRESETS}
        value={null}
        onChange={vi.fn()}
        selectedPrinterName={PRINTER_NAME}
        compatIndex={COMPAT_INDEX}
      />,
    );
    expect(screen.getByRole('option', { name: OTHER_PROCESS })).toBeInTheDocument();
    expect(optgroupLabels(container)).toContain('Other printers');
  });

  it('does not filter the printer slot itself', () => {
    render(
      <PresetDropdown
        label="Printer"
        slot="printer"
        data={PRESETS}
        value={null}
        onChange={vi.fn()}
        selectedPrinterName={PRINTER_NAME}
        compatIndex={COMPAT_INDEX}
        hideIncompatible
      />,
    );
    expect(screen.getByRole('option', { name: PRINTER_NAME })).toBeInTheDocument();
  });
});

describe('SlicerRail — process and filament pickers hide other printers', () => {
  function renderRail(data: UnifiedPresetsResponse = PRESETS) {
    const slots = seedSlots([
      {
        slot_id: 1,
        type: 'PLA',
        color: '#FF6A13',
        used_grams: 5,
        used_meters: 2,
        used_in_plate: true,
      },
    ]);
    return render(
      <SlicerRail
        presets={data}
        presetsLoading={false}
        presetsError={false}
        isRefreshing={false}
        onRefreshPresets={vi.fn()}
        printerPreset={{ source: 'local', id: 'x1c' }}
        onPrinterPresetChange={vi.fn()}
        processPreset={null}
        onProcessPresetChange={vi.fn()}
        filamentPresets={[null]}
        onFilamentPresetChange={vi.fn()}
        filamentSlots={slots}
        filamentSlotsLoading={false}
        onAddFilamentSlot={vi.fn()}
        onInsertFilamentSlotAfter={vi.fn()}
        onRemoveFilamentSlot={vi.fn()}
        onFilamentSlotColorChange={vi.fn()}
        bedType={null}
        onBedTypeChange={vi.fn()}
        useEmbedded={false}
        onUseEmbeddedChange={vi.fn()}
        canUseEmbedded={false}
        selectedPrinterName={PRINTER_NAME}
        compatIndex={COMPAT_INDEX}
        processFields={[]}
        resolvedProcess={null}
        processFieldsLoading={false}
        processFieldsError={null}
        overrides={{}}
        onOverridesChange={vi.fn()}
      />,
    );
  }

  it('offers only this printer\'s process presets, plus untagged ones', () => {
    const { container } = renderRail();
    expect(screen.getByRole('option', { name: MATCHING_PROCESS })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: UNTAGGED_PROCESS })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: OTHER_PROCESS })).toBeNull();
    expect(optgroupLabels(container)).not.toContain('Other printers');
  });

  it('offers only this printer\'s filament presets in every slot', () => {
    renderRail();
    expect(screen.getByRole('option', { name: MATCHING_FILAMENT })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: UNTAGGED_FILAMENT })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: OTHER_FILAMENT })).toBeNull();
  });

  it('explains an empty filament slot rather than disabling it silently', () => {
    renderRail(ALL_OTHER_PRINTERS);
    expect(
      screen.getAllByRole('option', { name: 'No presets for this printer' }).length,
    ).toBeGreaterThanOrEqual(2);
  });
});
