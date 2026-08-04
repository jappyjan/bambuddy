/**
 * Parity tests for useSlicePresets — the preset pre-pick logic extracted
 * verbatim out of SliceModal (`SliceModal.tsx:411-465` before the move).
 *
 * This is the regression guard for the extraction, and it is written against
 * the *old* behaviour on purpose. The logic decides which profiles every
 * slice runs with; if it regresses nothing errors, the slice just comes out
 * with the wrong profiles and only a physical inspection of the print shows
 * it. So each case here states the pre-move behaviour it pins:
 *
 * - printer pre-pick honours the 3MF's embedded printer name, else first listed
 * - process pre-pick prefers a printer-compatible process, re-picks when a
 *   printer change makes the current one incompatible, keeps a still-compatible
 *   manual pick
 * - each filament slot is scored independently against its required
 *   (type, colour)
 * - `canUseEmbedded` gates on the picked printer matching the design's target,
 *   and losing the gate drops `useEmbedded`
 * - applying a pipeline overwrites the slots and right-pads from current state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '../utils';
import { useSlicePresets, type SliceFilamentSlot } from '../../hooks/useSlicePresets';
import {
  api,
  type PresetRef,
  type SlicerPipeline,
  type UnifiedPreset,
  type UnifiedPresetsResponse,
} from '../../api/client';

vi.mock('../../api/client', () => ({
  api: {
    getSlicerPresets: vi.fn(),
    getSlicerPrinterModels: vi.fn(),
  },
}));

const mockApi = api as unknown as {
  getSlicerPresets: ReturnType<typeof vi.fn>;
  getSlicerPrinterModels: ReturnType<typeof vi.fn>;
};

const X1C = 'Bambu Lab X1 Carbon 0.4 nozzle';
const A1 = 'Bambu Lab A1 0.4 nozzle';

function makeUnified(overrides: Partial<UnifiedPresetsResponse> = {}): UnifiedPresetsResponse {
  const empty = () => ({ printer: [], process: [], filament: [] });
  return {
    orca_cloud: empty(),
    cloud: empty(),
    local: empty(),
    standard: empty(),
    cloud_status: 'ok',
    orca_cloud_status: 'ok',
    ...overrides,
  };
}

// All fixtures live in the local tier so `compatible_printers` is the
// deciding rule (it is authoritative when set) and the tests don't depend on
// the @BBL name-parsing fallback, which slicerPrinterMatch.test.ts covers.
function local(
  printer: UnifiedPreset[],
  process: UnifiedPreset[],
  filament: UnifiedPreset[],
): UnifiedPresetsResponse {
  return makeUnified({ local: { printer, process, filament } });
}

const printers: UnifiedPreset[] = [
  { id: 'x1c', name: X1C, source: 'local' },
  { id: 'a1', name: A1, source: 'local' },
];

const processes: UnifiedPreset[] = [
  { id: 'p-x1c', name: '0.20mm Standard @X1C', source: 'local', compatible_printers: [X1C] },
  { id: 'p-a1', name: '0.20mm Standard @A1', source: 'local', compatible_printers: [A1] },
  { id: 'p-both', name: '0.16mm Fine anywhere', source: 'local', compatible_printers: [X1C, A1] },
];

const filaments: UnifiedPreset[] = [
  {
    id: 'f-pla-black',
    name: 'PLA Basic Black',
    source: 'local',
    filament_type: 'PLA',
    filament_colour: '#000000',
    compatible_printers: [X1C, A1],
  },
  {
    id: 'f-pla-red',
    name: 'PLA Basic Red',
    source: 'local',
    filament_type: 'PLA',
    filament_colour: '#FF0000',
    compatible_printers: [X1C, A1],
  },
  {
    id: 'f-petg-green',
    name: 'PETG Green',
    source: 'local',
    filament_type: 'PETG',
    filament_colour: '#00FF00',
    compatible_printers: [X1C, A1],
  },
  {
    id: 'f-abs-x1c-only',
    name: 'ABS X1C only',
    source: 'local',
    filament_type: 'ABS',
    filament_colour: '#FFFFFF',
    compatible_printers: [X1C],
  },
];

const ONE_SLOT: SliceFilamentSlot[] = [{ type: '', color: '' }];

function wrapper({ children }: { children: React.ReactNode }) {
  const client = createTestQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// `filamentSlots` identity drives the filament re-pick effect, exactly as it
// did when the effect lived in the modal (which memoised the array). Passing a
// stable array per render keeps renderHook's re-renders honest.
function renderPresets(opts: {
  filamentSlots?: SliceFilamentSlot[];
  embeddedPrinter?: string | null;
  embeddedProcess?: string | null;
  embeddedFilaments?: (string | null)[] | null;
  enabled?: boolean;
}) {
  const slots = opts.filamentSlots ?? ONE_SLOT;
  return renderHook(
    () =>
      useSlicePresets({
        filamentSlots: slots,
        embeddedPrinter: opts.embeddedPrinter ?? null,
        embeddedProcess: opts.embeddedProcess ?? null,
        embeddedFilaments: opts.embeddedFilaments ?? null,
        enabled: opts.enabled,
      }),
    { wrapper },
  );
}

function refOf(id: string): PresetRef {
  return { source: 'local', id };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getSlicerPresets.mockResolvedValue(local(printers, processes, filaments));
  mockApi.getSlicerPrinterModels.mockResolvedValue({});
});

describe('useSlicePresets — printer pre-pick', () => {
  it('pre-picks the printer the 3MF was prepared for', async () => {
    // A1 is second in the list, so only the embedded name can select it.
    const { result } = renderPresets({ embeddedPrinter: A1 });

    await waitFor(() => expect(result.current.printerPreset).not.toBeNull());
    expect(result.current.printerPreset).toEqual(refOf('a1'));
    expect(result.current.selectedPrinterName).toBe(A1);
  });

  it('falls back to the first listed printer when the embedded preset is absent', async () => {
    const { result } = renderPresets({ embeddedPrinter: 'Bambu Lab H2D 0.4 nozzle' });

    await waitFor(() => expect(result.current.printerPreset).not.toBeNull());
    expect(result.current.printerPreset).toEqual(refOf('x1c'));
  });

  it('falls back to the first listed printer when the source has no embedded printer', async () => {
    const { result } = renderPresets({});

    await waitFor(() => expect(result.current.printerPreset).not.toBeNull());
    expect(result.current.printerPreset).toEqual(refOf('x1c'));
  });

  it('keeps a manual printer pick when presets refetch', async () => {
    const { result, rerender } = renderPresets({});
    await waitFor(() => expect(result.current.printerPreset).not.toBeNull());

    act(() => result.current.setPrinterPreset(refOf('a1')));
    rerender();

    expect(result.current.printerPreset).toEqual(refOf('a1'));
  });

  it('picks nothing while the presets query is disabled', async () => {
    const { result } = renderPresets({ enabled: false });

    await waitFor(() => expect(mockApi.getSlicerPrinterModels).toHaveBeenCalled());
    expect(mockApi.getSlicerPresets).not.toHaveBeenCalled();
    expect(result.current.printerPreset).toBeNull();
    expect(result.current.processPreset).toBeNull();
  });
});

describe('useSlicePresets — process pre-pick and re-pick', () => {
  it('pre-picks a process compatible with the selected printer', async () => {
    const { result } = renderPresets({});

    await waitFor(() => expect(result.current.processPreset).not.toBeNull());
    // X1C is pre-picked, so the A1-only process must not win even though the
    // plain first-listed default would have been fine before #1325.
    expect(result.current.processPreset).toEqual(refOf('p-x1c'));
  });

  it('honours the embedded process when it is compatible', async () => {
    const { result } = renderPresets({ embeddedProcess: '0.16mm Fine anywhere' });

    await waitFor(() => expect(result.current.processPreset).not.toBeNull());
    expect(result.current.processPreset).toEqual(refOf('p-both'));
  });

  it('ignores the embedded process when it is incompatible with the printer', async () => {
    const { result } = renderPresets({ embeddedProcess: '0.20mm Standard @A1' });

    await waitFor(() => expect(result.current.processPreset).not.toBeNull());
    expect(result.current.processPreset).toEqual(refOf('p-x1c'));
  });

  it('re-picks the process when a printer change makes it incompatible', async () => {
    const { result } = renderPresets({});
    await waitFor(() => expect(result.current.processPreset).toEqual(refOf('p-x1c')));

    act(() => result.current.setPrinterPreset(refOf('a1')));

    await waitFor(() => expect(result.current.processPreset).toEqual(refOf('p-a1')));
  });

  it('keeps a still-compatible manual process pick across a printer change', async () => {
    const { result } = renderPresets({});
    await waitFor(() => expect(result.current.processPreset).not.toBeNull());

    act(() => result.current.setProcessPreset(refOf('p-both')));
    act(() => result.current.setPrinterPreset(refOf('a1')));

    await waitFor(() => expect(result.current.selectedPrinterName).toBe(A1));
    expect(result.current.processPreset).toEqual(refOf('p-both'));
  });

  it('keeps a manual process pick whose compatibility is unknown', async () => {
    mockApi.getSlicerPresets.mockResolvedValue(
      local(printers, [...processes, { id: 'p-mystery', name: 'Hand rolled', source: 'local' }], filaments),
    );
    const { result } = renderPresets({});
    await waitFor(() => expect(result.current.processPreset).not.toBeNull());

    act(() => result.current.setProcessPreset(refOf('p-mystery')));
    act(() => result.current.setPrinterPreset(refOf('a1')));

    await waitFor(() => expect(result.current.selectedPrinterName).toBe(A1));
    expect(result.current.processPreset).toEqual(refOf('p-mystery'));
  });
});

describe('useSlicePresets — filament pre-pick', () => {
  it('scores every slot of a multi-slot plate against its own (type, colour)', async () => {
    const slots: SliceFilamentSlot[] = [
      { type: 'PETG', color: '#00FF00' },
      { type: 'PLA', color: '#FF0000' },
      { type: 'PLA', color: '#000000' },
    ];
    const { result } = renderPresets({ filamentSlots: slots });

    await waitFor(() => expect(result.current.filamentPresets).toHaveLength(3));
    expect(result.current.filamentPresets).toEqual([
      refOf('f-petg-green'),
      refOf('f-pla-red'),
      refOf('f-pla-black'),
    ]);
  });

  it('keeps a compatible manual slot pick and re-picks the printer-incompatible ones', async () => {
    const slots: SliceFilamentSlot[] = [
      { type: 'PLA', color: '#FF0000' },
      { type: 'ABS', color: '#FFFFFF' },
    ];
    const { result } = renderPresets({ filamentSlots: slots });
    await waitFor(() =>
      expect(result.current.filamentPresets).toEqual([refOf('f-pla-red'), refOf('f-abs-x1c-only')]),
    );

    // Manual override on slot 0 that stays valid for both printers.
    act(() => result.current.setFilamentPresetAt(0, refOf('f-pla-black')));
    // Switching to A1 invalidates slot 1's X1C-only ABS but not slot 0.
    act(() => result.current.setPrinterPreset(refOf('a1')));

    await waitFor(() => expect(result.current.selectedPrinterName).toBe(A1));
    expect(result.current.filamentPresets[0]).toEqual(refOf('f-pla-black'));
    expect(result.current.filamentPresets[1]).not.toEqual(refOf('f-abs-x1c-only'));
  });

  it('grows the slot list when the plate’s slot count changes, keeping existing picks', async () => {
    const { result, rerender } = renderHook(
      ({ slots }: { slots: SliceFilamentSlot[] }) =>
        useSlicePresets({ filamentSlots: slots, embeddedPrinter: null, embeddedProcess: null }),
      { wrapper, initialProps: { slots: ONE_SLOT } },
    );
    // The synthetic single slot has no required type/colour, so scoring is
    // decided by tier bonus alone and the first listed filament wins.
    await waitFor(() => expect(result.current.filamentPresets).toEqual([refOf('f-pla-black')]));

    rerender({ slots: [{ type: 'PLA', color: '#FF0000' }, { type: 'PETG', color: '#00FF00' }] });

    await waitFor(() => expect(result.current.filamentPresets).toHaveLength(2));
    // Slot 0's pick is still printer-compatible so it survives the resize even
    // though the arriving metadata would now score PLA Red higher; only the
    // new slot is picked. That is the pre-extraction behaviour.
    expect(result.current.filamentPresets).toEqual([refOf('f-pla-black'), refOf('f-petg-green')]);
  });
});

/**
 * #56 — the 3MF names its own filament profiles (`filament_settings_id`), and
 * those beat anything the (type, colour) scorer can re-derive.
 *
 * The defect these pin: the scorer cannot tell two profiles of the same type
 * and colour apart, so a project that specified a particular vendor profile
 * came back with whichever one tier order happened to reach first — "shows
 * random filaments". Reading the file's own assignment removes the guess.
 */
describe('useSlicePresets — embedded filament profiles (#56)', () => {
  // Two profiles the scorer scores *identically* (same type, same colour).
  // Only the embedded name can separate them, which is the whole ticket.
  const twins: UnifiedPreset[] = [
    {
      id: 'f-twin-a',
      name: 'Vendor A PLA Black',
      source: 'local',
      filament_type: 'PLA',
      filament_colour: '#000000',
      compatible_printers: [X1C, A1],
    },
    {
      id: 'f-twin-b',
      name: 'Vendor B PLA Black',
      source: 'local',
      filament_type: 'PLA',
      filament_colour: '#000000',
      compatible_printers: [X1C, A1],
    },
  ];

  it('pre-selects the profile the file names, over an equally-scoring twin', async () => {
    mockApi.getSlicerPresets.mockResolvedValue(local(printers, processes, twins));
    const slots: SliceFilamentSlot[] = [{ type: 'PLA', color: '#000000' }];

    const { result } = renderPresets({
      filamentSlots: slots,
      embeddedFilaments: ['Vendor B PLA Black'],
    });

    await waitFor(() => expect(result.current.filamentPresets).toHaveLength(1));
    // Scoring alone would have returned the first-listed twin.
    expect(result.current.filamentPresets).toEqual([refOf('f-twin-b')]);
  });

  it('honours the named profile even when the scorer would pick a different one', async () => {
    // The slot asks for PLA/black and the named profile is PETG/green — the
    // file's own assignment still wins. This is what makes the mapping match
    // Bambu Studio for the same file rather than our re-derivation of it.
    const slots: SliceFilamentSlot[] = [{ type: 'PLA', color: '#000000' }];
    const { result } = renderPresets({ filamentSlots: slots, embeddedFilaments: ['PETG Green'] });

    await waitFor(() => expect(result.current.filamentPresets).toEqual([refOf('f-petg-green')]));
  });

  it('maps every slot from its own entry, in slot order', async () => {
    const slots: SliceFilamentSlot[] = [
      { type: 'PLA', color: '#000000' },
      { type: 'PLA', color: '#000000' },
      { type: 'PLA', color: '#000000' },
    ];
    const { result } = renderPresets({
      filamentSlots: slots,
      embeddedFilaments: ['PETG Green', 'PLA Basic Red', 'PLA Basic Black'],
    });

    await waitFor(() => expect(result.current.filamentPresets).toHaveLength(3));
    expect(result.current.filamentPresets).toEqual([
      refOf('f-petg-green'),
      refOf('f-pla-red'),
      refOf('f-pla-black'),
    ]);
  });

  it('falls back to the scored pick for a profile the user does not have installed', async () => {
    // A file may name a profile from a library we never imported. That must
    // degrade to today's guess, not to an empty slot.
    const slots: SliceFilamentSlot[] = [{ type: 'PETG', color: '#00FF00' }];
    const { result } = renderPresets({
      filamentSlots: slots,
      embeddedFilaments: ['Some Vendor PETG We Never Imported'],
    });

    await waitFor(() => expect(result.current.filamentPresets).toEqual([refOf('f-petg-green')]));
  });

  it('falls back when the named profile is incompatible with the selected printer', async () => {
    // The user switched to A1 since the file was made; the named X1C-only
    // profile would be rejected by the slicer CLI outright.
    const slots: SliceFilamentSlot[] = [{ type: 'PLA', color: '#FF0000' }];
    const { result } = renderPresets({
      filamentSlots: slots,
      embeddedPrinter: A1,
      embeddedFilaments: ['ABS X1C only'],
    });

    await waitFor(() => expect(result.current.selectedPrinterName).toBe(A1));
    await waitFor(() => expect(result.current.filamentPresets).toEqual([refOf('f-pla-red')]));
  });

  it('tolerates a list shorter than the slot count', async () => {
    const slots: SliceFilamentSlot[] = [
      { type: 'PLA', color: '#000000' },
      { type: 'PETG', color: '#00FF00' },
    ];
    const { result } = renderPresets({ filamentSlots: slots, embeddedFilaments: ['PLA Basic Red'] });

    await waitFor(() => expect(result.current.filamentPresets).toHaveLength(2));
    expect(result.current.filamentPresets).toEqual([refOf('f-pla-red'), refOf('f-petg-green')]);
  });

  it('tolerates a list longer than the slot count and null / empty entries', async () => {
    const slots: SliceFilamentSlot[] = [
      { type: 'PLA', color: '#000000' },
      { type: 'PLA', color: '#FF0000' },
    ];
    const { result } = renderPresets({
      filamentSlots: slots,
      // Slot 0 unassigned in the project, slot 1 named, then two slots the
      // plate does not have.
      embeddedFilaments: [null, 'PETG Green', '', 'PLA Basic Black'],
    });

    await waitFor(() => expect(result.current.filamentPresets).toHaveLength(2));
    // Slot 0 has no usable name, so it keeps the scored pick.
    expect(result.current.filamentPresets).toEqual([refOf('f-pla-black'), refOf('f-petg-green')]);
  });

  it('does not override a manual pick the user already made', async () => {
    const slots: SliceFilamentSlot[] = [{ type: 'PLA', color: '#000000' }];
    const { result, rerender } = renderPresets({
      filamentSlots: slots,
      embeddedFilaments: ['PLA Basic Red'],
    });
    await waitFor(() => expect(result.current.filamentPresets).toEqual([refOf('f-pla-red')]));

    act(() => result.current.setFilamentPresetAt(0, refOf('f-petg-green')));
    rerender();

    expect(result.current.filamentPresets).toEqual([refOf('f-petg-green')]);
  });

  it('behaves exactly as before when the source names no filaments', async () => {
    const slots: SliceFilamentSlot[] = [{ type: 'PLA', color: '#FF0000' }];
    const withList = renderPresets({ filamentSlots: slots, embeddedFilaments: [] });
    await waitFor(() => expect(withList.result.current.filamentPresets).toEqual([refOf('f-pla-red')]));

    const withNull = renderPresets({ filamentSlots: slots });
    await waitFor(() => expect(withNull.result.current.filamentPresets).toEqual([refOf('f-pla-red')]));
  });

  it('does not re-render forever when the caller rebuilds the list every render', async () => {
    // The list arrives from a query response, but a caller writing
    // `embedded_filaments ?? []` hands the hook a fresh array each render.
    // The pre-pick effect sets state, so an identity-keyed dependency would
    // loop. Value-keyed, it settles.
    let renders = 0;
    const slots: SliceFilamentSlot[] = [{ type: 'PLA', color: '#000000' }];
    const { result } = renderHook(
      () => {
        renders++;
        return useSlicePresets({
          filamentSlots: slots,
          embeddedFilaments: ['PLA Basic Red'],
        });
      },
      { wrapper },
    );

    await waitFor(() => expect(result.current.filamentPresets).toEqual([refOf('f-pla-red')]));
    const settled = renders;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(renders).toBe(settled);
  });
});

// The honesty guard (#47) lives on the hook so `SliceModal` and the `/slicer`
// rail cannot say different things about the same selection. The rule itself
// is exercised in `utils/slicePresetPickerStandardTier.test.ts`; these cases
// pin that the hook produces one entry per slot, in slot order, against the
// selection it actually made.
describe('useSlicePresets — filament type warnings', () => {
  it('flags only the slot whose material the library cannot supply', async () => {
    const slots: SliceFilamentSlot[] = [
      { type: 'PLA', color: '#FF0000' },
      { type: 'PC', color: '#FFFFFF' },
    ];
    const { result } = renderPresets({ filamentSlots: slots });

    await waitFor(() =>
      expect(result.current.filamentTypeWarnings[1]).toMatchObject({
        kind: 'mismatch',
        required: 'PC',
      }),
    );
    expect(result.current.filamentTypeWarnings).toHaveLength(2);
    expect(result.current.filamentTypeWarnings[0]).toBeNull();
  });

  it('clears the warning once the user picks the right material', async () => {
    const slots: SliceFilamentSlot[] = [{ type: 'ABS', color: '#FFFFFF' }];
    const { result } = renderPresets({ filamentSlots: slots });

    await waitFor(() => expect(result.current.filamentPresets).toEqual([refOf('f-abs-x1c-only')]));
    expect(result.current.filamentTypeWarnings[0]).toBeNull();

    act(() => result.current.setFilamentPresetAt(0, refOf('f-pla-black')));
    await waitFor(() =>
      expect(result.current.filamentTypeWarnings[0]).toMatchObject({
        kind: 'mismatch',
        required: 'ABS',
        selectedType: 'PLA',
      }),
    );

    act(() => result.current.setFilamentPresetAt(0, refOf('f-abs-x1c-only')));
    await waitFor(() => expect(result.current.filamentTypeWarnings[0]).toBeNull());
  });

  it('says nothing for a slot that declares no material', async () => {
    const { result } = renderPresets({});
    await waitFor(() => expect(result.current.filamentPresets).toHaveLength(1));
    expect(result.current.filamentTypeWarnings).toEqual([null]);
  });
});

describe('useSlicePresets — embedded-settings gating', () => {
  it('offers "slice as designed" only when the picked printer is the design target', async () => {
    const { result } = renderPresets({ embeddedPrinter: X1C, embeddedProcess: '0.20mm Standard @X1C' });

    await waitFor(() => expect(result.current.canUseEmbedded).toBe(true));

    act(() => result.current.setPrinterPreset(refOf('a1')));

    await waitFor(() => expect(result.current.canUseEmbedded).toBe(false));
  });

  it('does not offer it without both embedded printer and process', async () => {
    const { result } = renderPresets({ embeddedPrinter: X1C });

    await waitFor(() => expect(result.current.printerPreset).not.toBeNull());
    expect(result.current.canUseEmbedded).toBe(false);
  });

  it('matches the design target ignoring a "# " prefix and case', async () => {
    const { result } = renderPresets({
      embeddedPrinter: `# ${X1C.toUpperCase()}`,
      embeddedProcess: '0.20mm Standard @X1C',
    });

    await waitFor(() => expect(result.current.canUseEmbedded).toBe(true));
  });

  it('drops useEmbedded when the toggle stops being offered', async () => {
    const { result } = renderPresets({ embeddedPrinter: X1C, embeddedProcess: '0.20mm Standard @X1C' });
    await waitFor(() => expect(result.current.canUseEmbedded).toBe(true));

    act(() => result.current.setUseEmbedded(true));
    expect(result.current.useEmbedded).toBe(true);

    act(() => result.current.setPrinterPreset(refOf('a1')));

    await waitFor(() => expect(result.current.useEmbedded).toBe(false));
  });
});

describe('useSlicePresets — pipeline application', () => {
  function pipeline(overrides: Partial<SlicerPipeline> = {}): SlicerPipeline {
    return {
      id: 1,
      name: 'Nightly ABS',
      description: null,
      printer_preset: refOf('a1'),
      process_preset: refOf('p-a1'),
      filament_presets: [refOf('f-pla-black')],
      bed_type: 'Textured PEI Plate',
      target_kind: 'printer_class',
      target_printer_id: null,
      target_model_class: null,
      fanout_strategy: 'max_parallel',
      created_by: null,
      created_at: '',
      updated_at: '',
      ...overrides,
    } as SlicerPipeline;
  }

  it('applies every slot the pipeline defines', async () => {
    const { result } = renderPresets({});
    await waitFor(() => expect(result.current.processPreset).not.toBeNull());

    act(() => result.current.applyPipeline(pipeline()));

    expect(result.current.printerPreset).toEqual(refOf('a1'));
    expect(result.current.processPreset).toEqual(refOf('p-a1'));
    expect(result.current.bedType).toBe('Textured PEI Plate');
    expect(result.current.filamentPresets[0]).toEqual(refOf('f-pla-black'));
  });

  it('right-pads from current state when the pipeline has fewer filament slots', async () => {
    const slots: SliceFilamentSlot[] = [
      { type: 'PLA', color: '#FF0000' },
      { type: 'PETG', color: '#00FF00' },
    ];
    const { result } = renderPresets({ filamentSlots: slots });
    await waitFor(() => expect(result.current.filamentPresets).toHaveLength(2));

    act(() => result.current.applyPipeline(pipeline()));

    // Slot 0 comes from the pipeline; slot 1 keeps whatever was pre-picked.
    expect(result.current.filamentPresets).toHaveLength(2);
    expect(result.current.filamentPresets[0]).toEqual(refOf('f-pla-black'));
    expect(result.current.filamentPresets[1]).toEqual(refOf('f-petg-green'));
  });
});

describe('useSlicePresets — preset refresh', () => {
  it('refetches with refresh:true and seeds the cache with the fresh listing', async () => {
    const { result } = renderPresets({});
    await waitFor(() => expect(result.current.presets).toBeTruthy());

    const fresh = local([printers[1]], [processes[1]], filaments);
    mockApi.getSlicerPresets.mockResolvedValueOnce(fresh);

    await act(async () => {
      await result.current.refreshPresets();
    });

    expect(mockApi.getSlicerPresets).toHaveBeenLastCalledWith({ refresh: true });
    expect(result.current.presets).toEqual(fresh);
    expect(result.current.isRefreshing).toBe(false);
  });
});
