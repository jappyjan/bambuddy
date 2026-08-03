/**
 * The printer model / nozzle-diameter split (#44).
 *
 * The rules worth pinning are the ones whose failure is invisible in the UI:
 * a pair resolving to the *wrong* preset, a preset becoming unreachable
 * because two names collapsed onto one option, and — most of all — an
 * unmatched pair resolving to something rather than to null.
 */

import { describe, it, expect } from 'vitest';
import type { UnifiedPresetsResponse } from '../../api/client';
import {
  axesOfPrinterPreset,
  buildPrinterAxes,
  diametersForModel,
  resolvePrinterPreset,
  splitPrinterPresetName,
} from '../../utils/printerPresetAxes';

function presets(
  tiers: Partial<Record<'local' | 'orca_cloud' | 'cloud' | 'standard', { id: string; name: string }[]>>,
): UnifiedPresetsResponse {
  const empty = { printer: [], process: [], filament: [] };
  const slot = (source: 'local' | 'orca_cloud' | 'cloud' | 'standard') => ({
    ...empty,
    printer: (tiers[source] ?? []).map((p) => ({ ...p, source })),
  });
  return {
    local: slot('local'),
    orca_cloud: slot('orca_cloud'),
    cloud: slot('cloud'),
    standard: slot('standard'),
    cloud_status: 'ok',
    orca_cloud_status: 'ok',
  } as UnifiedPresetsResponse;
}

const BAMBU = presets({
  standard: [
    { id: 'h2s04', name: 'Bambu Lab H2S 0.4 nozzle' },
    { id: 'h2s06', name: 'Bambu Lab H2S 0.6 nozzle' },
    { id: 'a104', name: 'Bambu Lab A1 0.4 nozzle' },
  ],
});

describe('splitPrinterPresetName', () => {
  it('splits a Bambu printer preset into model and nozzle diameter', () => {
    expect(splitPrinterPresetName('Bambu Lab H2S 0.4 nozzle')).toEqual({
      model: 'Bambu Lab H2S',
      diameter: '0.4',
    });
  });

  it('keeps a name with no nozzle segment whole, with no diameter', () => {
    expect(splitPrinterPresetName('Imported X1C 0.4')).toEqual({
      model: 'Imported X1C 0.4',
      diameter: null,
    });
  });
});

describe('buildPrinterAxes', () => {
  it('lists each model once and each of its diameters, numerically ordered', () => {
    const axes = buildPrinterAxes(BAMBU);
    expect(axes.models.map((m) => m.label)).toEqual(['Bambu Lab H2S', 'Bambu Lab A1']);
    expect(diametersForModel(axes, axes.models[0].key)).toEqual(['0.4', '0.6']);
  });

  it('keeps a user-saved variant reachable instead of collapsing it into the stock model', () => {
    // "… (Custom)" is a different profile with different settings. Merging it
    // into "Bambu Lab H2D" would leave one of the two unpickable, which the
    // flat dropdown it replaces never did.
    const axes = buildPrinterAxes(
      presets({
        local: [{ id: 'custom', name: 'Bambu Lab H2D 0.4 nozzle (Custom)' }],
        standard: [{ id: 'stock', name: 'Bambu Lab H2D 0.4 nozzle' }],
      }),
    );
    expect(axes.models.map((m) => m.label)).toEqual(['Bambu Lab H2D 0.4 nozzle (Custom)', 'Bambu Lab H2D']);
    expect(resolvePrinterPreset(axes, axes.models[1].key, '0.4')).toEqual({
      source: 'standard',
      id: 'stock',
    });
  });

  it('treats "0.40" and "0.4" as one diameter', () => {
    const axes = buildPrinterAxes(
      presets({ standard: [{ id: 'p', name: 'Bambu Lab P1S 0.40 nozzle' }] }),
    );
    expect(resolvePrinterPreset(axes, axes.models[0].key, '0.4')).toEqual({
      source: 'standard',
      id: 'p',
    });
  });
});

describe('resolvePrinterPreset', () => {
  it('resolves a model + diameter pair to that exact preset', () => {
    const axes = buildPrinterAxes(BAMBU);
    const h2s = axes.models[0].key;
    expect(resolvePrinterPreset(axes, h2s, '0.6')).toEqual({ source: 'standard', id: 'h2s06' });
  });

  it('returns null for a pair no preset carries — never a near miss', () => {
    // The A1 has no 0.6 profile here. Returning the 0.4 one would slice with a
    // machine profile the rail is not showing.
    const axes = buildPrinterAxes(BAMBU);
    const a1 = axes.models[1].key;
    expect(resolvePrinterPreset(axes, a1, '0.6')).toBeNull();
  });

  it('prefers the user\'s own import when two tiers ship the same name', () => {
    const axes = buildPrinterAxes(
      presets({
        cloud: [{ id: 'cloud-h2s', name: 'Bambu Lab H2S 0.4 nozzle' }],
        local: [{ id: 'local-h2s', name: 'Bambu Lab H2S 0.4 nozzle' }],
      }),
    );
    expect(resolvePrinterPreset(axes, axes.models[0].key, '0.4')).toEqual({
      source: 'local',
      id: 'local-h2s',
    });
  });

  it('resolves a diameter-less model by asking for no diameter', () => {
    const axes = buildPrinterAxes(presets({ local: [{ id: '1', name: 'Imported X1C 0.4' }] }));
    expect(diametersForModel(axes, axes.models[0].key)).toEqual([]);
    expect(resolvePrinterPreset(axes, axes.models[0].key, null)).toEqual({
      source: 'local',
      id: '1',
    });
  });
});

describe('axesOfPrinterPreset', () => {
  it('places an externally-set preset (the 3MF pre-pick) on both axes', () => {
    const axes = buildPrinterAxes(BAMBU);
    expect(axesOfPrinterPreset(axes, { source: 'standard', id: 'h2s06' })).toEqual({
      modelKey: 'bambu lab h2s',
      model: 'Bambu Lab H2S',
      diameter: '0.6',
    });
  });

  it('returns null for a ref that no longer resolves', () => {
    expect(axesOfPrinterPreset(buildPrinterAxes(BAMBU), { source: 'local', id: 'gone' })).toBeNull();
  });
});
