/**
 * The rail's filament slot manager (#45, rail.2).
 *
 * **Every ordering assertion here reads the request body, not the DOM.** The
 * failure this ticket exists to prevent is invisible on screen: `filament_presets`
 * travels as a positional list (index 0 = slot 1), so an insert or a removal
 * that moves one list without the other hands the slicer a plausible-looking
 * request in which slot 3's material is now slot 4's. The slice succeeds. The
 * print comes out wrong. A UI assertion would pass throughout.
 *
 * The fixture is built so the two lists can actually be told apart: each plate
 * slot asks for a different colour, and the preset library has a filament in
 * each of those colours, so the pre-pick gives every slot a *distinguishable*
 * profile. An implementation that removed the last entry instead of the removed
 * slot's would still produce a well-formed 4-entry list — it just wouldn't be
 * this one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SlicerPage } from '../../pages/SlicerPage';
import { SliceJobTrackerProvider } from '../../contexts/SliceJobTrackerContext';
import { api, type SliceRequest, type UnifiedPresetsResponse } from '../../api/client';

vi.mock('../../components/ModelViewer', () => ({
  ModelViewer: () => <div data-testid="model-viewer" />,
}));

vi.mock('../../components/PrintModal', () => ({
  PrintModal: () => <div data-testid="print-modal" />,
}));

vi.mock('../../api/client', () => ({
  api: {
    getSlicerPresets: vi.fn(),
    getSlicerPrinterModels: vi.fn(),
    sliceLibraryFile: vi.fn(),
    sliceArchive: vi.fn(),
    getSliceJob: vi.fn(),
    getLibraryFile: vi.fn(),
    getLibraryFilePlates: vi.fn(),
    getArchivePlates: vi.fn(),
    getLibraryFileFilamentRequirements: vi.fn(),
    getArchiveFilamentRequirements: vi.fn(),
    getLibraryFileLayout: vi.fn(),
    updateLibraryFileLayout: vi.fn(),
    getProcessFields: vi.fn(),
    getResolvedProcess: vi.fn(),
    getLibraryFileDownloadUrl: vi.fn(() => '/dl'),
    getArchiveDownload: vi.fn(() => '/dl'),
    getLibraryFileThumbnailUrl: vi.fn(() => '/thumb'),
    getLibraryFilePlateThumbnail: vi.fn(() => '/thumb'),
    getArchiveThumbnail: vi.fn(() => '/thumb'),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),
    listSlicerPipelines: vi.fn(),
    createSlicerPipeline: vi.fn(),
  },
}));

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

// One filament per plate colour, so the pre-pick lands a *different* profile in
// every slot and the payload's order is readable.
const PRESETS: UnifiedPresetsResponse = {
  orca_cloud: { printer: [], process: [], filament: [] },
  cloud: { printer: [], process: [], filament: [] },
  local: {
    printer: [{ id: 'p1', name: 'Imported X1C 0.4', source: 'local' }],
    process: [{ id: 'q1', name: 'Imported 0.20mm', source: 'local' }],
    filament: [
      { id: 'red', name: 'PLA Red', source: 'local', filament_type: 'PLA', filament_colour: '#FF0000' },
      { id: 'green', name: 'PLA Green', source: 'local', filament_type: 'PLA', filament_colour: '#00FF00' },
      { id: 'blue', name: 'PLA Blue', source: 'local', filament_type: 'PLA', filament_colour: '#0000FF' },
      { id: 'yellow', name: 'PLA Yellow', source: 'local', filament_type: 'PLA', filament_colour: '#FFFF00' },
    ],
  },
  standard: { printer: [], process: [], filament: [] },
  cloud_status: 'ok',
  orca_cloud_status: 'ok',
};

/**
 * Slots 1–2 are painted by the plate, 3–4 are project slots it never touches.
 * That shape is what makes a *middle* edit legal at all: the plate's geometry
 * names its extruders by number, so only the tail is the user's to rearrange
 * (see `components/slicer/filamentSlots.ts`).
 */
const FILAMENTS = [
  { slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 5, used_meters: 2, used_in_plate: true },
  { slot_id: 2, type: 'PLA', color: '#00FF00', used_grams: 5, used_meters: 2, used_in_plate: true },
  { slot_id: 3, type: 'PLA', color: '#0000FF', used_grams: 0, used_meters: 0, used_in_plate: false },
  { slot_id: 4, type: 'PLA', color: '#FFFF00', used_grams: 0, used_meters: 0, used_in_plate: false },
];

const ref = (id: string) => ({ source: 'local', id });
const SEEDED = [ref('red'), ref('green'), ref('blue'), ref('yellow')];

const COMPLETED_JOB = {
  job_id: 42,
  status: 'completed' as const,
  kind: 'library_file' as const,
  source_id: 100,
  source_name: 'Multi.3mf',
  created_at: new Date().toISOString(),
  started_at: null,
  completed_at: new Date().toISOString(),
  progress: null,
  result: {
    library_file_id: 777,
    name: 'Multi.gcode.3mf',
    print_time_seconds: 1,
    filament_used_g: 1,
    filament_used_mm: 0,
    used_embedded_settings: false,
  },
};

function renderPage() {
  window.history.pushState({}, '', '/slicer?file=100');
  return render(
    <SliceJobTrackerProvider>
      <SlicerPage />
    </SliceJobTrackerProvider>,
  );
}

const sliceButton = () => screen.getByRole('button', { name: /^Slice$/ }) as HTMLButtonElement;
const printNowButton = () => screen.getByRole('button', { name: /Print now/ }) as HTMLButtonElement;

async function waitForReady() {
  await waitFor(() => expect(sliceButton().disabled).toBe(false));
}

/** Slice, and return the body that reached the wire. */
async function sliceAndCaptureBody(user: ReturnType<typeof userEvent.setup>) {
  await user.click(sliceButton());
  await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
  return mockApi.sliceLibraryFile.mock.calls[0][1] as SliceRequest;
}

/** Open a slot's `⋯` and click one of its items. */
async function useSlotMenu(
  user: ReturnType<typeof userEvent.setup>,
  slotIndex: number,
  itemName: RegExp,
) {
  await user.click(screen.getByRole('button', { name: `Options for filament ${slotIndex}` }));
  await user.click(await screen.findByRole('menuitem', { name: itemName }));
}

describe('SlicerPage — filament slots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSlicerPresets.mockResolvedValue(PRESETS);
    mockApi.getSlicerPrinterModels.mockResolvedValue({});
    mockApi.getLibraryFile.mockResolvedValue({ id: 100, filename: 'Multi.3mf', slice_count: 0 });
    mockApi.getLibraryFilePlates.mockResolvedValue({
      file_id: 100,
      filename: 'Multi.3mf',
      plates: [],
      is_multi_plate: false,
    });
    mockApi.getLibraryFileFilamentRequirements.mockResolvedValue({
      file_id: 100,
      filename: 'Multi.3mf',
      plate_id: 1,
      filaments: FILAMENTS,
    });
    mockApi.getLibraryFileLayout.mockResolvedValue({ file_id: 100, layout: null });
    mockApi.getProcessFields.mockResolvedValue({ slicer: 'bambu_studio', fields: [] });
    mockApi.getResolvedProcess.mockResolvedValue({});
    mockApi.listSlicerPipelines.mockResolvedValue({ pipelines: [] });
    mockApi.sliceLibraryFile.mockResolvedValue({
      job_id: 42,
      status: 'pending',
      status_url: '/api/v1/slice-jobs/42',
    });
    mockApi.getSliceJob.mockResolvedValue(COMPLETED_JOB);
  });

  afterEach(() => {
    cleanup();
    window.history.pushState({}, '', '/');
  });

  it('seeds one slot per plate requirement and sends them in plate order', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    expect(screen.getByTestId('filament-slot-1')).toBeDefined();
    expect(screen.getByTestId('filament-slot-4')).toBeDefined();
    expect(screen.queryByTestId('filament-slot-5')).toBeNull();

    const body = await sliceAndCaptureBody(user);
    expect(body.filament_presets).toEqual(SEEDED);
    // Nothing was coloured, so nothing about colour travels — which is what
    // keeps a plain slice from this page identical to `SliceModal`'s.
    expect(body.filament_colours).toBeUndefined();
  });

  it('appends a slot with + and sends it last', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    await user.click(screen.getByRole('button', { name: 'Add a filament slot' }));
    await waitFor(() => expect(screen.getByTestId('filament-slot-5')).toBeDefined());
    await waitForReady();

    const body = await sliceAndCaptureBody(user);
    expect(body.filament_presets).toHaveLength(5);
    expect(body.filament_presets?.slice(0, 4)).toEqual(SEEDED);
  });

  it('drops the last slot with −', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    await user.click(screen.getByRole('button', { name: 'Remove the last filament slot' }));
    await waitFor(() => expect(screen.queryByTestId('filament-slot-4')).toBeNull());

    const body = await sliceAndCaptureBody(user);
    expect(body.filament_presets).toEqual(SEEDED.slice(0, 3));
  });

  it('keeps every later slot with its own profile after a MIDDLE INSERT', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    // After slot 2 — the last one the plate paints with, so the insert is legal
    // and lands in the middle of a four-slot list.
    await useSlotMenu(user, 2, /Insert a slot after this one/);
    await waitFor(() => expect(screen.getByTestId('filament-slot-5')).toBeDefined());
    await waitForReady();

    const body = await sliceAndCaptureBody(user);
    expect(body.filament_presets).toHaveLength(5);
    // The two painted slots are untouched; blue and yellow moved down a
    // position **carrying their own profiles**. An implementation that grew
    // only the slot list would have produced [red, green, blue, yellow, <new>]
    // — well-formed, and printing the wrong material in three of five slots.
    expect(body.filament_presets?.[0]).toEqual(ref('red'));
    expect(body.filament_presets?.[1]).toEqual(ref('green'));
    expect(body.filament_presets?.[3]).toEqual(ref('blue'));
    expect(body.filament_presets?.[4]).toEqual(ref('yellow'));
  });

  it('closes the gap correctly after a MIDDLE REMOVAL', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    // Slot 3 — unpainted, and so is everything after it.
    await useSlotMenu(user, 3, /Remove this slot/);
    await waitFor(() => expect(screen.queryByTestId('filament-slot-4')).toBeNull());

    const body = await sliceAndCaptureBody(user);
    // Yellow moved up into position 3. Removing the *last* entry instead would
    // have given [red, green, blue] — the same length, the same shape, and the
    // wrong filament in the slot that survived.
    expect(body.filament_presets).toEqual([ref('red'), ref('green'), ref('yellow')]);
  });

  it('refuses to remove a slot the plate paints with, and says why', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    await user.click(screen.getByRole('button', { name: 'Options for filament 1' }));
    const remove = await screen.findByRole('menuitem', { name: /Remove this slot/ });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    expect(remove.getAttribute('title')).toMatch(/painted into the model/i);

    // Inserting *before* a painted slot would shift it just as badly.
    const insert = screen.getByRole('menuitem', { name: /Insert a slot after this one/ });
    expect((insert as HTMLButtonElement).disabled).toBe(true);
  });

  it('carries a slot colour into the slice request, aligned with its slot', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    // The numbered badge IS the colour control (comment 153).
    const badge = screen.getByLabelText('Colour of filament 2') as HTMLInputElement;
    fireEvent.change(badge, { target: { value: '#123456' } });

    const body = await sliceAndCaptureBody(user);
    expect(body.filament_colours).toEqual([null, '#123456', null, null]);
    // Colour is an override on top of the picks, never a replacement for them.
    expect(body.filament_presets).toEqual(SEEDED);
  });

  it('reverts a slot to its as-designed colour', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    const badge = screen.getByLabelText('Colour of filament 2') as HTMLInputElement;
    fireEvent.change(badge, { target: { value: '#123456' } });
    await useSlotMenu(user, 2, /Reset colour to as designed/);

    const body = await sliceAndCaptureBody(user);
    expect(body.filament_colours).toBeUndefined();
  });

  describe('Print now', () => {
    it('goes stale when a slot is added', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitForReady();
      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      await user.click(screen.getByRole('button', { name: 'Add a filament slot' }));
      await waitFor(() => expect(printNowButton().disabled).toBe(true));
      expect(screen.getByTestId('print-now-stale')).toBeDefined();
    });

    it('goes stale when a slot is removed', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitForReady();
      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      await user.click(screen.getByRole('button', { name: 'Remove the last filament slot' }));
      await waitFor(() => expect(printNowButton().disabled).toBe(true));
    });

    it('goes stale when only a slot COLOUR changes', async () => {
      // The subtlest of the three: the profile picks are identical before and
      // after, so a fingerprint built from presets alone would keep Print now
      // live and print the previous slice's colours.
      const user = userEvent.setup();
      renderPage();
      await waitForReady();
      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      fireEvent.change(screen.getByLabelText('Colour of filament 1') as HTMLInputElement, {
        target: { value: '#abcdef' },
      });
      await waitFor(() => expect(printNowButton().disabled).toBe(true));
    });

    it('goes stale when a slot profile changes', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitForReady();
      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      await user.selectOptions(
        screen.getByLabelText('Filament 1 (PLA)') as HTMLSelectElement,
        'local:blue',
      );
      await waitFor(() => expect(printNowButton().disabled).toBe(true));
    });
  });

  it('re-seeds from the plate when the plate changes, dropping edits', async () => {
    // A different plate has different requirements; carrying an edited slot
    // list across would map one plate's materials onto another's geometry.
    mockApi.getLibraryFilePlates.mockResolvedValue({
      file_id: 100,
      filename: 'Multi.3mf',
      plates: [
        { index: 1, name: null, objects: ['a'], has_thumbnail: false, thumbnail_url: null, print_time_seconds: null, filament_used_grams: null, filaments: [] },
        { index: 2, name: null, objects: ['b'], has_thumbnail: false, thumbnail_url: null, print_time_seconds: null, filament_used_grams: null, filaments: [] },
      ],
      is_multi_plate: true,
    });
    mockApi.getLibraryFileFilamentRequirements.mockImplementation(
      async (_id: number, plate: number) => ({
        file_id: 100,
        filename: 'Multi.3mf',
        plate_id: plate,
        filaments: plate === 1 ? FILAMENTS : FILAMENTS.slice(0, 2),
      }),
    );

    const user = userEvent.setup();
    renderPage();
    await waitForReady();
    await user.click(screen.getByRole('button', { name: 'Add a filament slot' }));
    await waitFor(() => expect(screen.getByTestId('filament-slot-5')).toBeDefined());

    // Since #41 the plates are labels in the scene, not a tab strip — the
    // plate change this test rides on is otherwise unchanged.
    await user.click(screen.getByRole('button', { name: /Plate 2/i }));
    await waitFor(() => expect(screen.queryByTestId('filament-slot-3')).toBeNull());
    expect(screen.getByTestId('filament-slot-2')).toBeDefined();
  });
});
