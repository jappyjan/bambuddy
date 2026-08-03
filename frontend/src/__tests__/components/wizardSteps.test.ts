/**
 * The mobile wizard's pure rules — where it opens (#31, step-6.2) and what the
 * Review chips report.
 *
 * The DOM-level behaviour is pinned in `pages/SlicerPageMobileWizard.test.tsx`;
 * what is worth stating without a DOM is the *rule*, because both of these are
 * one-liners that read as obviously right and are wrong in a specific way:
 *
 * - `slice_count` is a COUNT of **non-trashed** children, so a file whose only
 *   slice was thrown away is a never-sliced file again and must open at step 1.
 *   `> 0`, not `!= null`.
 * - a chip may only report a preset it can actually resolve; naming a profile
 *   the slice will not use is worse than saying nothing.
 */

import { describe, it, expect } from 'vitest';
import type { PresetRef, UnifiedPresetsResponse } from '../../api/client';
import type { PlateFilament } from '../../types/plates';
import {
  FIRST_STEP,
  initialStepForSource,
  REVIEW_STEP,
  wizardChips,
} from '../../components/slicer/wizardSteps';

const PRESETS = {
  orca_cloud: { printer: [], process: [], filament: [] },
  cloud: { printer: [], process: [], filament: [] },
  local: {
    printer: [{ id: '1', name: 'Imported X1C 0.4', source: 'local' }],
    process: [{ id: '2', name: 'Imported 0.20mm', source: 'local' }],
    filament: [{ id: '3', name: 'Imported PLA Basic', source: 'local' }],
  },
  standard: { printer: [], process: [], filament: [] },
  cloud_status: 'ok',
  orca_cloud_status: 'ok',
} as unknown as UnifiedPresetsResponse;

const PRINTER: PresetRef = { source: 'local', id: '1' };
const FILAMENT: PresetRef = { source: 'local', id: '3' };
const slot = (slotId: number): PlateFilament => ({
  slot_id: slotId,
  type: 'PLA',
  color: '#ffffff',
  used_grams: 1,
  used_meters: 1,
});

describe('initialStepForSource', () => {
  it('opens a previously-sliced file on Review', () => {
    expect(initialStepForSource(1)).toBe(REVIEW_STEP);
    expect(initialStepForSource(4)).toBe(REVIEW_STEP);
  });

  it('opens at step 1 when there is no surviving slice', () => {
    // 0 is the file whose slices were all trashed — indistinguishable from
    // never sliced, and correctly treated as such.
    expect(initialStepForSource(0)).toBe(FIRST_STEP);
    // undefined is an archive, or a response without the field at all.
    expect(initialStepForSource(undefined)).toBe(FIRST_STEP);
    expect(initialStepForSource(null)).toBe(FIRST_STEP);
  });
});

describe('wizardChips', () => {
  const base = {
    presets: PRESETS,
    printerPreset: PRINTER,
    filamentPresets: [FILAMENT],
    filamentSlots: [slot(1)],
    overrideCount: 0,
  };

  it('names the printer and a lone filament from the preset lists', () => {
    const [printer, filaments, settings] = wizardChips(base);
    expect(printer).toMatchObject({ step: 'printer', index: 1, name: 'Imported X1C 0.4' });
    expect(filaments).toMatchObject({ step: 'filaments', index: 2, name: 'Imported PLA Basic' });
    expect(settings).toMatchObject({ step: 'settings', index: 3, name: null, count: 0 });
  });

  it('counts filament slots rather than naming them once there is more than one', () => {
    const [, filaments] = wizardChips({
      ...base,
      filamentPresets: [FILAMENT, null],
      filamentSlots: [slot(1), slot(2)],
    });
    expect(filaments).toMatchObject({ name: null, count: 1, total: 2 });
  });

  it('reports nothing chosen rather than a stale name when a ref does not resolve', () => {
    // The preset was deleted between the listing and the pick, or the lists
    // have not arrived yet. Either way the chip has no name to show.
    expect(wizardChips({ ...base, printerPreset: { source: 'local', id: 'gone' } })[0]).toMatchObject(
      { name: null, count: 1 },
    );
    expect(wizardChips({ ...base, presets: undefined })[0].name).toBeNull();
    expect(wizardChips({ ...base, printerPreset: null })[0]).toMatchObject({ name: null, count: 0 });
  });

  it('passes the override diff size through for the settings chip', () => {
    expect(wizardChips({ ...base, overrideCount: 3 })[2]).toMatchObject({ count: 3 });
  });
});
