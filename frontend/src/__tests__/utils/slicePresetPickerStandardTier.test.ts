/**
 * The standard tier, filament type metadata, and the honesty guard (#47).
 *
 * This file used to be a **characterisation test**: it pinned the defect the
 * owner photographed during #45 — a plate declaring ABS in all four slots with
 * `Custom Generic TPU` auto-picked into every dropdown — rather than asserting
 * anything correct. #47 fixes it, so the cases now assert behaviour.
 *
 * ## What the defect actually was
 *
 * `pickFilamentForSlot` awards its dominant `+10` only when the slot's required
 * type AND the candidate's `filament_type` are both non-empty:
 *
 *     if (reqType && presetType && reqType === presetType) score += 10;
 *
 * The scorer is fine. The **Standard (slicer-bundled) tier carried no
 * `filament_type` at all**: `_fetch_bundled_presets` reads it off the sidecar's
 * `GET /profiles/bundled` response, and that response emitted only
 * `{name, base_id}`. With nothing to compare against, the type term never fired
 * and every candidate was left holding its `TIER_BONUS` alone — local's 1.75
 * beats standard's 0.5 unconditionally, so one imported preset won every slot
 * regardless of material, and with no import at all the winner was whichever
 * bundled preset happened to be listed first.
 *
 * So the repair has two halves, and this file covers both:
 *
 * 1. **Metadata** (the sidecar). Once `/profiles/bundled` carries
 *    `filament_type`, the scorer already does the right thing — no change to
 *    `pickFilamentForSlot` was needed. `TYPED` below is that world.
 * 2. **Honesty** (`filamentTypeWarningForSlot`). Until then — and afterwards,
 *    for any plate whose material genuinely is not in the library — the UI must
 *    say it cannot confirm the slot rather than presenting a wrong material as
 *    a confident choice. `UNTYPED` below is that world, and the pick there is
 *    still arbitrary *by necessity*: with no type on anything there is no
 *    better answer, only a more honest presentation of the same one.
 *
 * The guard's whole design problem is not firing everywhere. See the
 * `stays quiet` block: on a library with no type metadata at all it says
 * nothing, because "we cannot tell" is not the same claim as "no ABS exists".
 */

import { describe, it, expect } from 'vitest';
import {
  filamentTypeWarningForSlot,
  pickFilamentForSlot,
} from '../../utils/slicePresetPicker';
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

/** A bundled tier that states its materials — what the sidecar fix delivers. */
const TYPED = unified({
  local: { printer: [], process: [], filament: [CUSTOM_TPU] },
  standard: {
    printer: [],
    process: [],
    filament: [
      bundled('Bambu ABS @BBL H2S', 'ABS'),
      bundled('Bambu PLA Basic @BBL H2S', 'PLA'),
      bundled('Bambu ASA @BBL H2S', 'ASA'),
    ],
  },
});

/** The same library before the sidecar carried `filament_type`. */
const UNTYPED = unified({
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

describe('pickFilamentForSlot — material wins once the tier states one', () => {
  it('picks the ABS profile over an imported TPU, across tiers', () => {
    // +10 for the type match swamps the local tier's +1.75 bonus, as intended.
    // This is the screenshot's exact library, with the metadata gap closed.
    expect(pickFilamentForSlot(TYPED, ABS_SLOT, H2S, index)).toEqual({
      source: 'standard',
      id: 'Bambu ABS @BBL H2S',
    });
  });

  it('picks by material rather than list order when nothing is imported', () => {
    const data = unified({
      standard: {
        printer: [],
        process: [],
        filament: [
          bundled('Bambu PLA Basic @BBL H2S', 'PLA'),
          bundled('Bambu ABS @BBL H2S', 'ABS'),
        ],
      },
    });
    expect(pickFilamentForSlot(data, ABS_SLOT, H2S, index)).toEqual({
      source: 'standard',
      id: 'Bambu ABS @BBL H2S',
    });
  });
});

describe('filamentTypeWarningForSlot — says so instead of substituting', () => {
  it('flags the reported defect: an ABS slot holding a TPU profile', () => {
    // The screenshot, exactly. The pick is still TPU — with no type on any
    // bundled profile the scorer has nothing better to go on — but the slot no
    // longer *claims* to be resolved.
    const pick = pickFilamentForSlot(UNTYPED, ABS_SLOT, H2S, index);
    expect(pick).toEqual({ source: 'local', id: 'tpu' });
    expect(filamentTypeWarningForSlot(UNTYPED, ABS_SLOT.type, pick)).toEqual({
      kind: 'mismatch',
      required: 'ABS',
      selectedName: 'Custom Generic TPU',
      selectedType: 'TPU',
    });
  });

  it('flags a slot whose pick states nothing and whose material is not on offer', () => {
    // Every typed profile in the library is PLA, so nothing that states a
    // material is ABS. The bundled pick might be — we cannot confirm it, and
    // saying so is the whole point.
    const data = unified({
      local: {
        printer: [],
        process: [],
        filament: [{ id: 'pla', name: 'My PLA', source: 'local', filament_type: 'PLA' }],
      },
      standard: { printer: [], process: [], filament: [bundled('Bambu ABS @BBL H2S')] },
    });
    const pick = { source: 'standard', id: 'Bambu ABS @BBL H2S' } as const;
    expect(filamentTypeWarningForSlot(data, 'ABS', pick)).toEqual({
      kind: 'unavailable',
      required: 'ABS',
      selectedName: 'Bambu ABS @BBL H2S',
      selectedType: null,
    });
  });

  it('flags a deliberate override to the wrong material', () => {
    expect(
      filamentTypeWarningForSlot(TYPED, 'ABS', { source: 'local', id: 'tpu' }),
    ).toMatchObject({ kind: 'mismatch', selectedType: 'TPU' });
  });

  it('compares case- and whitespace-insensitively', () => {
    const data = unified({
      local: {
        printer: [],
        process: [],
        filament: [{ id: 'a', name: 'abs', source: 'local', filament_type: ' abs ' }],
      },
    });
    expect(filamentTypeWarningForSlot(data, 'ABS', { source: 'local', id: 'a' })).toBeNull();
  });
});

describe('filamentTypeWarningForSlot — stays quiet when it cannot tell', () => {
  it('says nothing when no profile anywhere states a material', () => {
    // The un-enriched Standard tier on its own — a stock install. We have no
    // evidence about any material, so we have no basis to call the pick wrong,
    // and the user has nothing better to switch to. Warning on every slot for
    // every user here would be worse than the bug.
    const data = unified({
      standard: {
        printer: [],
        process: [],
        filament: [bundled('Bambu ABS @BBL H2S'), bundled('Bambu PLA Basic @BBL H2S')],
      },
    });
    const pick = pickFilamentForSlot(data, ABS_SLOT, H2S, index);
    expect(filamentTypeWarningForSlot(data, ABS_SLOT.type, pick)).toBeNull();
  });

  it('says nothing when the slot asks for no material', () => {
    // A user-added slot, or an STL. There is nothing to be wrong about.
    expect(filamentTypeWarningForSlot(TYPED, '', { source: 'local', id: 'tpu' })).toBeNull();
    expect(filamentTypeWarningForSlot(TYPED, '  ', null)).toBeNull();
  });

  it('says nothing when the pick is the required material', () => {
    const pick = pickFilamentForSlot(TYPED, ABS_SLOT, H2S, index);
    expect(filamentTypeWarningForSlot(TYPED, ABS_SLOT.type, pick)).toBeNull();
  });

  it('says nothing while the presets have not loaded', () => {
    expect(filamentTypeWarningForSlot(undefined, 'ABS', null)).toBeNull();
  });

  it('says nothing when a typed profile of the required material does exist', () => {
    // Nothing picked yet, but the library demonstrably has ABS — the pre-pick
    // will find it. Claiming otherwise would be a guess of our own.
    expect(filamentTypeWarningForSlot(TYPED, 'ABS', null)).toBeNull();
  });
});
