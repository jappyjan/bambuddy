/**
 * Tests for the slicer page's selection → request → fingerprint chain
 * (#15, step-5.3).
 *
 * The fingerprint is what makes "Print now" safe: it is compared against the
 * one recorded at slice time, and a mismatch disables the button. So the
 * property that actually matters is not "some fields invalidate" — it is
 * **every field invalidates**. The `invalidates every input` case below walks
 * the whole `SliceSelection` shape rather than a hand-written list, so a field
 * added to the selection later cannot quietly escape the rule: the test fails
 * the moment a new key is added without a mutation for it.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSliceBody,
  isSelectionComplete,
  selectionFingerprint,
  type SliceSelection,
} from '../../components/slicer/sliceSelection';
import type { StagePlate } from '../../types/plateStage';

function stagePlate(index: number, x = 0): StagePlate {
  return {
    index,
    objects: [
      { id: `obj-${index}`, transform: { position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    ],
  };
}

function selection(overrides: Partial<SliceSelection> = {}): SliceSelection {
  return {
    printerPreset: { source: 'local', id: '1' },
    processPreset: { source: 'local', id: '2' },
    filamentPresets: [{ source: 'local', id: '3' }],
    bedType: null,
    useEmbedded: false,
    plate: null,
    processOverrides: {},
    plates: [stagePlate(1)],
    ...overrides,
  };
}

describe('sliceSelection — buildSliceBody', () => {
  it('omits plate, bed_type, use_embedded_settings and process_overrides when unset', () => {
    // Byte-for-byte what SliceModal sends for a bare single-plate slice. The
    // backend distinguishes "absent" from "null", so an extra key here is a
    // different request, not a cosmetic difference.
    expect(buildSliceBody(selection())).toEqual({
      printer_preset: { source: 'local', id: '1' },
      process_preset: { source: 'local', id: '2' },
      filament_preset: { source: 'local', id: '3' },
      filament_presets: [{ source: 'local', id: '3' }],
    });
  });

  it('carries every optional field when set', () => {
    const body = buildSliceBody(
      selection({
        plate: 2,
        bedType: 'Textured PEI Plate',
        useEmbedded: true,
        processOverrides: { sparse_infill_density: 25 },
      }),
    );
    expect(body).toMatchObject({
      plate: 2,
      bed_type: 'Textured PEI Plate',
      use_embedded_settings: true,
      process_overrides: { sparse_infill_density: 25 },
    });
  });

  it('sends the override diff with native types, not profile spellings', () => {
    // `process_overrides.py::_check` validates against native types and
    // `_coerce` re-spells for the profile. Pre-stringifying here would fail
    // the range check on the way in.
    const body = buildSliceBody(
      selection({ processOverrides: { sparse_infill_density: 25, enable_support: true, seam_position: 'aligned' } }),
    );
    expect(body.process_overrides).toEqual({
      sparse_infill_density: 25,
      enable_support: true,
      seam_position: 'aligned',
    });
  });

  it('refuses to build a body from an incomplete selection', () => {
    expect(isSelectionComplete(selection({ processPreset: null }))).toBe(false);
    expect(() => buildSliceBody(selection({ processPreset: null }))).toThrow();
    expect(isSelectionComplete(selection({ filamentPresets: [null] }))).toBe(false);
    expect(isSelectionComplete(selection({ filamentPresets: [] }))).toBe(false);
  });
});

describe('sliceSelection — the Print-now fingerprint', () => {
  it('is stable across renders of an unchanged selection', () => {
    expect(selectionFingerprint(selection())).toBe(selectionFingerprint(selection()));
  });

  it('ignores override key order — a reordered diff is the same slice', () => {
    const a = selection({ processOverrides: { layer_height: 0.2, wall_loops: 3 } });
    const b = selection({ processOverrides: { wall_loops: 3, layer_height: 0.2 } });
    expect(selectionFingerprint(a)).toBe(selectionFingerprint(b));
  });

  it('ignores plate and object ordering — a re-sorted list is not a rearrangement', () => {
    const a = selection({ plates: [stagePlate(1), stagePlate(2)] });
    const b = selection({ plates: [stagePlate(2), stagePlate(1)] });
    expect(selectionFingerprint(a)).toBe(selectionFingerprint(b));
  });

  it('invalidates on every input the selection carries', () => {
    // One mutation per key of SliceSelection. The exhaustiveness check below is
    // the point of the test: it is what stops a future field from being added
    // to the selection without joining the invalidation rule.
    const mutations: { [K in keyof SliceSelection]: Partial<SliceSelection> } = {
      printerPreset: { printerPreset: { source: 'standard', id: 'X1C' } },
      processPreset: { processPreset: { source: 'cloud', id: 'other' } },
      filamentPresets: { filamentPresets: [{ source: 'local', id: '99' }] },
      bedType: { bedType: 'Textured PEI Plate' },
      useEmbedded: { useEmbedded: true },
      plate: { plate: 2 },
      processOverrides: { processOverrides: { sparse_infill_density: 25 } },
      plates: { plates: [stagePlate(1, 12.5)] },
    };

    const base = selectionFingerprint(selection());
    for (const [key, mutation] of Object.entries(mutations)) {
      expect(selectionFingerprint(selection(mutation)), `${key} must invalidate`).not.toBe(base);
    }
  });

  it('never matches a recorded slice while the selection is incomplete', () => {
    const complete = selectionFingerprint(selection());
    expect(selectionFingerprint(selection({ processPreset: null }))).not.toBe(complete);
    expect(selectionFingerprint(selection({ filamentPresets: [null] }))).not.toBe(complete);
  });

  it('goes back to the recorded value when a change is undone', () => {
    // Print now must come *back* when the user reverts, not stay dead until
    // they re-slice — otherwise every accidental keystroke costs a slice.
    const recorded = selectionFingerprint(selection());
    const changed = selectionFingerprint(selection({ bedType: 'Cool Plate' }));
    const reverted = selectionFingerprint(selection({ bedType: null }));
    expect(changed).not.toBe(recorded);
    expect(reverted).toBe(recorded);
  });
});
