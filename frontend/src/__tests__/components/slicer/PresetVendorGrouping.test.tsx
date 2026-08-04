/**
 * Filament presets group by manufacturer, then material (#58).
 *
 * The owner's report was one line: "group by manufacturer, then sub group by
 * type, same as bambustudio". What the dropdown did instead was group by
 * SOURCE TIER — Imported / Orca Cloud / Bambu Cloud / Standard — which is
 * where Bambuddy happens to keep a profile, not what the profile is.
 *
 * A native `<select>` is flat two-level, so the two keys are synthesised into
 * one `<optgroup>` label ("Bambu Lab – PLA") rather than nested. A real tree
 * would mean a custom listbox, and re-implementing mobile, keyboard and
 * screen-reader behaviour to win a heading indent is a bad trade.
 *
 * The cases that carry real risk, each pinned below:
 *
 *  - **The degrade.** `filament_vendor` is brand new and `filament_type` is
 *    null across the entire bundled tier until the sidecar ships #51. An
 *    install where neither field resolves must keep the tier headings, not
 *    render every preset under one "Other" bucket — that would be a downgrade
 *    shipped as a fix.
 *  - **No empty groups under #57's filter.** The vendor groups are built from
 *    the presets that survive the printer filter, so a vendor whose only
 *    preset was hidden must not leave a heading behind.
 *  - **`SliceModal` untouched.** It is the legacy slice path and renders this
 *    same component; #57 deliberately left its grouping alone and #58 does
 *    not ask for it either.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import { PresetDropdown } from '../../../components/slicer/PresetControls';
import { buildCompatibilityIndex } from '../../../utils/slicerPrinterMatch';
import type { UnifiedPreset, UnifiedPresetsResponse } from '../../../api/client';

const PRINTER_NAME = 'Bambu Lab X1 Carbon 0.4 nozzle';
const COMPAT_INDEX = buildCompatibilityIndex({
  'Bambu Lab X1 Carbon': 'X1C',
  'Bambu Lab P1S': 'P1S',
});

function response(over: {
  local?: UnifiedPreset[];
  standard?: UnifiedPreset[];
  cloud?: UnifiedPreset[];
}): UnifiedPresetsResponse {
  return {
    orca_cloud: { printer: [], process: [], filament: [] },
    cloud: { printer: [], process: [], filament: over.cloud ?? [] },
    local: { printer: [], process: [], filament: over.local ?? [] },
    standard: { printer: [], process: [], filament: over.standard ?? [] },
    cloud_status: 'ok',
    orca_cloud_status: 'ok',
  };
}

function optgroupLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('optgroup')).map((g) => g.label);
}

function optionsUnder(container: HTMLElement, label: string): string[] {
  const group = Array.from(container.querySelectorAll('optgroup')).find((g) => g.label === label);
  return group ? Array.from(group.querySelectorAll('option')).map((o) => o.textContent ?? '') : [];
}

function renderFilament(
  data: UnifiedPresetsResponse,
  props: Partial<React.ComponentProps<typeof PresetDropdown>> = {},
) {
  return render(
    <PresetDropdown
      label="Filament 1"
      slot="filament"
      data={data}
      value={null}
      onChange={vi.fn()}
      groupByVendor
      {...props}
    />,
  );
}

describe('PresetDropdown — vendor / material grouping', () => {
  it('replaces the tier headings with manufacturer – material', () => {
    const { container } = renderFilament(
      response({
        local: [
          { id: '1', name: 'Bambu PLA Basic', source: 'local', filament_vendor: 'Bambu Lab', filament_type: 'PLA' },
        ],
        standard: [
          { id: 's1', name: 'Overture PETG', source: 'standard', filament_vendor: 'Overture', filament_type: 'PETG' },
        ],
      }),
    );
    const labels = optgroupLabels(container);
    expect(labels).toEqual(['Bambu Lab – PLA', 'Overture – PETG']);
    // The tier headings are what this replaces, not something it sits beside.
    expect(labels).not.toContain('Imported');
    expect(labels).not.toContain('Standard');
  });

  it('subgroups one manufacturer by material', () => {
    const { container } = renderFilament(
      response({
        local: [
          { id: '1', name: 'Bambu PLA Basic', source: 'local', filament_vendor: 'Bambu Lab', filament_type: 'PLA' },
          { id: '2', name: 'Bambu ABS', source: 'local', filament_vendor: 'Bambu Lab', filament_type: 'ABS' },
          { id: '3', name: 'Bambu PLA Matte', source: 'local', filament_vendor: 'Bambu Lab', filament_type: 'PLA' },
        ],
      }),
    );
    expect(optgroupLabels(container)).toEqual(['Bambu Lab – ABS', 'Bambu Lab – PLA']);
    expect(optionsUnder(container, 'Bambu Lab – PLA')).toEqual(['Bambu PLA Basic', 'Bambu PLA Matte']);
  });

  it('merges a manufacturer spelled two ways into one heading', () => {
    // The import column says "eSUN", the name parse says "ESUN". One
    // manufacturer, and two headings for it would read as two vendors.
    const { container } = renderFilament(
      response({
        local: [{ id: '1', name: 'eSUN PLA+', source: 'local', filament_vendor: 'eSUN', filament_type: 'PLA' }],
        standard: [{ id: 's1', name: 'ESUN PLA', source: 'standard', filament_vendor: 'ESUN', filament_type: 'PLA' }],
      }),
    );
    expect(optgroupLabels(container)).toEqual(['eSUN – PLA']);
    expect(optionsUnder(container, 'eSUN – PLA')).toEqual(['ESUN PLA', 'eSUN PLA+']);
  });

  it('sorts manufacturers alphabetically', () => {
    const { container } = renderFilament(
      response({
        local: [
          { id: '1', name: 'z', source: 'local', filament_vendor: 'Polymaker', filament_type: 'PLA' },
          { id: '2', name: 'a', source: 'local', filament_vendor: 'Bambu Lab', filament_type: 'PLA' },
          { id: '3', name: 'm', source: 'local', filament_vendor: 'eSUN', filament_type: 'PLA' },
        ],
      }),
    );
    expect(optgroupLabels(container)).toEqual(['Bambu Lab – PLA', 'eSUN – PLA', 'Polymaker – PLA']);
  });

  it('derives the material from the name when the field is null', () => {
    // The entire bundled tier reports `filament_type: null` until the sidecar
    // ships #51. Without the name fallback every standard preset would be
    // filed under its vendor's "Other".
    const { container } = renderFilament(
      response({
        standard: [
          { id: 's1', name: 'Bambu PETG HF @BBL X1C', source: 'standard', filament_vendor: 'Bambu Lab' },
        ],
      }),
    );
    expect(optgroupLabels(container)).toEqual(['Bambu Lab – PETG']);
  });

  it('prefers the real material over the one in the name', () => {
    // Name parsing is a last resort, never an override: a preset that states
    // its material is the authority on its own material.
    const { container } = renderFilament(
      response({
        local: [
          { id: '1', name: 'PLA Support Interface', source: 'local', filament_vendor: 'Bambu Lab', filament_type: 'PVA' },
        ],
      }),
    );
    expect(optgroupLabels(container)).toEqual(['Bambu Lab – PVA']);
  });

  it('files a known manufacturer with an unknown material under its own Other', () => {
    const { container } = renderFilament(
      response({
        local: [
          { id: '1', name: 'Bambu Basic', source: 'local', filament_vendor: 'Bambu Lab' },
          { id: '2', name: 'Bambu PLA Basic', source: 'local', filament_vendor: 'Bambu Lab', filament_type: 'PLA' },
        ],
      }),
    );
    // Unknown material sorts last within its manufacturer — an "Other" bucket
    // is where you look after the specific headings failed you.
    expect(optgroupLabels(container)).toEqual(['Bambu Lab – PLA', 'Bambu Lab – Other']);
  });

  it('collects every vendorless preset into one trailing Other group', () => {
    const { container } = renderFilament(
      response({
        local: [
          { id: '1', name: 'Spool 7', source: 'local', filament_type: 'PLA' },
          { id: '2', name: 'Spool 8', source: 'local', filament_type: 'ABS' },
        ],
        standard: [
          { id: 's1', name: 'Overture PETG', source: 'standard', filament_vendor: 'Overture', filament_type: 'PETG' },
        ],
      }),
    );
    // One group, at the end — not one per material, and not scattered.
    expect(optgroupLabels(container)).toEqual(['Overture – PETG', 'Other']);
    expect(optionsUnder(container, 'Other')).toEqual(['Spool 7', 'Spool 8']);
  });

  it('degrades to the tier grouping when neither field resolves anywhere', () => {
    // The un-upgraded-sidecar fixture: no vendor, no material, and no material
    // recoverable from the names either. One giant "Other" heading would be
    // worse than headings that at least say where a preset came from.
    const { container } = renderFilament(
      response({
        local: [{ id: '1', name: 'Spool 7', source: 'local' }],
        standard: [{ id: 's1', name: 'Spool 8', source: 'standard' }],
      }),
    );
    expect(optgroupLabels(container)).toEqual(['Imported', 'Standard']);
    expect(screen.getByRole('option', { name: 'Spool 7' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Spool 8' })).toBeInTheDocument();
  });

  it('regroups as soon as a single preset resolves either key', () => {
    // The gate is "no data at all", not "incomplete data" — one preset with a
    // material is enough for the new grouping to beat the tier headings.
    const { container } = renderFilament(
      response({
        local: [
          { id: '1', name: 'Spool 7', source: 'local' },
          { id: '2', name: 'Spool 8', source: 'local', filament_type: 'PLA' },
        ],
      }),
    );
    expect(optgroupLabels(container)).toEqual(['Other']);
  });

  it('leaves the process slot on tier grouping', () => {
    const { container } = render(
      <PresetDropdown
        label="Process"
        slot="process"
        data={{
          ...response({}),
          local: { printer: [], process: [{ id: '1', name: '0.20mm Standard', source: 'local' }], filament: [] },
        }}
        value={null}
        onChange={vi.fn()}
        groupByVendor
      />,
    );
    expect(optgroupLabels(container)).toEqual(['Imported']);
  });

  it('keeps the tier grouping when the flag is off', () => {
    // `SliceModal` renders this same component without the flag.
    const { container } = renderFilament(
      response({
        local: [
          { id: '1', name: 'Bambu PLA Basic', source: 'local', filament_vendor: 'Bambu Lab', filament_type: 'PLA' },
        ],
      }),
      { groupByVendor: false },
    );
    expect(optgroupLabels(container)).toEqual(['Imported']);
  });
});

describe('PresetDropdown — vendor grouping alongside #57 compatibility hiding', () => {
  const DATA = response({
    local: [
      { id: '1', name: 'Bambu PLA Basic @BBL X1C', source: 'local', filament_vendor: 'Bambu Lab', filament_type: 'PLA' },
    ],
    standard: [
      // The only Overture preset, and it belongs to another printer.
      { id: 's1', name: 'Overture PETG @BBL P1S', source: 'standard', filament_vendor: 'Overture', filament_type: 'PETG' },
    ],
  });

  it('leaves no empty vendor group behind when a preset is hidden', () => {
    const { container } = renderFilament(DATA, {
      selectedPrinterName: PRINTER_NAME,
      compatIndex: COMPAT_INDEX,
      hideIncompatible: true,
    });
    expect(screen.queryByRole('option', { name: 'Overture PETG @BBL P1S' })).toBeNull();
    // The heading is derived from the survivors, so it cannot outlive them.
    expect(optgroupLabels(container)).toEqual(['Bambu Lab – PLA']);
  });

  it('shows the hidden vendor again with the filter off', () => {
    const { container } = renderFilament(DATA, {
      selectedPrinterName: PRINTER_NAME,
      compatIndex: COMPAT_INDEX,
    });
    // Without `hideIncompatible` the mismatch is demoted, not dropped — it
    // lands in #57's untouched "Other printers" group rather than under a
    // vendor heading, which is the pre-existing behaviour for that flag.
    expect(optgroupLabels(container)).toEqual(['Bambu Lab – PLA', 'Other printers']);
  });

  it('still explains an empty control the filter emptied', () => {
    renderFilament(
      response({
        standard: [
          { id: 's1', name: 'Overture PETG @BBL P1S', source: 'standard', filament_vendor: 'Overture', filament_type: 'PETG' },
        ],
      }),
      { selectedPrinterName: PRINTER_NAME, compatIndex: COMPAT_INDEX, hideIncompatible: true },
    );
    expect(screen.getByRole('option', { name: 'No presets for this printer' })).toBeInTheDocument();
  });

  it('keeps a selected mismatch visible, under its own vendor heading', () => {
    // #57 keeps the in-force preset listed because a `<select>` whose value
    // is absent from its options renders blank. It has to land somewhere in
    // the new grouping, and its own vendor is the honest place.
    const { container } = renderFilament(DATA, {
      value: { source: 'standard', id: 's1' },
      selectedPrinterName: PRINTER_NAME,
      compatIndex: COMPAT_INDEX,
      hideIncompatible: true,
    });
    expect(optgroupLabels(container)).toEqual(['Bambu Lab – PLA', 'Overture – PETG']);
    expect(screen.getByRole('combobox')).toHaveValue('standard:s1');
  });
});
