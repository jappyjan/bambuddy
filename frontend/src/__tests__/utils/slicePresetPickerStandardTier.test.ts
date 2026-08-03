/**
 * ⚠️ CHARACTERISATION TEST — this pins a KNOWN DEFECT, not desired behaviour.
 *
 * Investigated for #45 (ticket comment 153, from the owner's Bambu Studio
 * screenshot: every slot labelled `(ABS)` while every dropdown had auto-picked
 * `Custom Generic TPU`). It is a real defect. It is deliberately **not fixed
 * here** — a materials-selection change has no business riding along in a UI
 * diff — so these cases record what the code does today, and the follow-up
 * ticket flips them.
 *
 * ## The mechanism
 *
 * `pickFilamentForSlot` awards its dominant `+10` only when the slot's required
 * type AND the preset's `filament_type` are both non-empty:
 *
 *     if (reqType && presetType && reqType === presetType) score += 10;
 *
 * For the **Standard (bundled) tier** `filament_type` is always absent.
 * `_fetch_bundled_presets` fills it from `entry.get("filament_type")` on the
 * sidecar's `GET /profiles/bundled` response, and that response carries only
 * `{name, base_id}` — see the docstring on
 * `SlicerApiService.list_bundled_profiles` and the fixture in
 * `backend/tests/unit/test_slicer_presets.py`. So for a user whose library is
 * the bundled tier plus a handful of imports, the type term never fires at all
 * and every candidate is left holding nothing but its `TIER_BONUS`. Local's
 * 1.75 beats standard's 0.5 unconditionally, so one imported preset wins every
 * slot regardless of material — and with no import at all the winner is
 * whichever bundled preset happens to be listed first.
 *
 * Case A is the control: with the metadata present the scoring is correct, so
 * the fix belongs in the metadata pipeline (sidecar / `_fetch_bundled_presets`),
 * not in the scorer.
 */

import { describe, it, expect } from 'vitest';
import { pickFilamentForSlot } from '../../utils/slicePresetPicker';
import { buildCompatibilityIndex } from '../../utils/slicerPrinterMatch';
import type { UnifiedPreset, UnifiedPresetsResponse } from '../../api/client';

const H2S = 'Bambu Lab H2S 0.4 nozzle';
const index = buildCompatibilityIndex({ 'Bambu Lab H2S': 'H2S' });
const ABS_SLOT = { type: 'ABS', color: '#FF6A13' };

function unified(o: Partial<UnifiedPresetsResponse>): UnifiedPresetsResponse {
  const empty = () => ({ printer: [], process: [], filament: [] });
  return {
    orca_cloud: empty(),
    cloud: empty(),
    local: empty(),
    standard: empty(),
    cloud_status: 'ok',
    orca_cloud_status: 'ok',
    ...o,
  };
}

/** The one imported preset in the owner's library, and the wrong material. */
const CUSTOM_TPU: UnifiedPreset = {
  id: 'tpu',
  name: 'Custom Generic TPU',
  source: 'local',
  filament_type: 'TPU',
  filament_colour: '#000000',
  compatible_printers: [H2S],
};

const bundled = (name: string, filament_type?: string): UnifiedPreset => ({
  id: name,
  name,
  source: 'standard',
  ...(filament_type ? { filament_type } : {}),
});

describe('pickFilamentForSlot — the standard tier ships no filament_type', () => {
  it('CONTROL: scores type correctly when the metadata IS there', () => {
    const data = unified({
      local: { printer: [], process: [], filament: [CUSTOM_TPU] },
      standard: {
        printer: [],
        process: [],
        filament: [bundled('Bambu ABS @BBL H2S', 'ABS'), bundled('Bambu PLA Basic @BBL H2S', 'PLA')],
      },
    });
    // +10 for the type match swamps the local tier's +1.75 bonus, as intended.
    expect(pickFilamentForSlot(data, ABS_SLOT, H2S, index)).toEqual({
      source: 'standard',
      id: 'Bambu ABS @BBL H2S',
    });
  });

  it('DEFECT: picks the imported TPU for an ABS slot when the metadata is missing', () => {
    const data = unified({
      local: { printer: [], process: [], filament: [CUSTOM_TPU] },
      standard: {
        printer: [],
        process: [],
        filament: [
          bundled('Bambu ABS @BBL H2S'),
          bundled('Bambu PLA Basic @BBL H2S'),
          bundled('Bambu ASA @BBL H2S'),
        ],
      },
    });
    // The screenshot, exactly: a real ABS preset is available and on the right
    // printer, and TPU wins on the tier bonus alone.
    // WHEN FIXED: expect `{ source: 'standard', id: 'Bambu ABS @BBL H2S' }`.
    expect(pickFilamentForSlot(data, ABS_SLOT, H2S, index)).toEqual({
      source: 'local',
      id: 'tpu',
    });
  });

  it('DEFECT: with nothing imported, the winner is just whichever is listed first', () => {
    const data = unified({
      standard: {
        printer: [],
        process: [],
        filament: [bundled('Bambu PLA Basic @BBL H2S'), bundled('Bambu ABS @BBL H2S')],
      },
    });
    // Every candidate scores an identical 0.5, and `score > best` is strict, so
    // the answer is alphabetical order rather than a material decision.
    // WHEN FIXED: expect `{ source: 'standard', id: 'Bambu ABS @BBL H2S' }`.
    expect(pickFilamentForSlot(data, ABS_SLOT, H2S, index)).toEqual({
      source: 'standard',
      id: 'Bambu PLA Basic @BBL H2S',
    });
  });
});
