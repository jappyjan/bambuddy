/**
 * The rail's three collapsible sections (#46, rail.3).
 *
 * The interesting assertions here are not "the chevron works". They are the
 * two ways a disclosure panel silently breaks the page it is wrapped around:
 *
 * 1. **A closed section stops contributing.** Every value the rail edits is
 *    owned by `SlicerPage`, so hiding a control must not change the request —
 *    and the only honest way to check that is to close the section, slice, and
 *    read the body that reached the wire. A DOM assertion would pass either
 *    way, because the controls are gone from view in both the working and the
 *    broken version.
 * 2. **A closed section forgets what it was told.** Some of these controls own
 *    state nothing else records — the settings editor's search text, and
 *    `PrinterPicker`'s unmatched model/diameter pair, which is the only reason
 *    Slice is off when it happens. Unmounting on collapse throws that away, so
 *    the sections hide their contents rather than unmounting them, and the
 *    tests below prove the difference is real rather than incidental.
 *
 * Persistence is asserted against a real in-memory `localStorage` (the global
 * mock in `setup.ts` is call-recording only) and across an unmount/remount,
 * which is what "survives a reload" means for a preference read in a
 * `useState` initialiser.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SlicerPage } from '../../pages/SlicerPage';
import { SliceJobTrackerProvider } from '../../contexts/SliceJobTrackerContext';
import { RAIL_SECTION_STORAGE_KEYS } from '../../components/slicer/railSections';
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

const PRESETS: UnifiedPresetsResponse = {
  orca_cloud: { printer: [], process: [], filament: [] },
  cloud: { printer: [], process: [], filament: [] },
  local: {
    printer: [{ id: 'p1', name: 'Imported X1C 0.4 nozzle', source: 'local' }],
    process: [{ id: 'q1', name: 'Imported 0.20mm', source: 'local' }],
    filament: [
      { id: 'red', name: 'PLA Red', source: 'local', filament_type: 'PLA', filament_colour: '#FF0000' },
      { id: 'green', name: 'PLA Green', source: 'local', filament_type: 'PLA', filament_colour: '#00FF00' },
    ],
  },
  standard: { printer: [], process: [], filament: [] },
  cloud_status: 'ok',
  orca_cloud_status: 'ok',
};

const FILAMENTS = [
  { slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 5, used_meters: 2, used_in_plate: true },
  { slot_id: 2, type: 'PLA', color: '#00FF00', used_grams: 5, used_meters: 2, used_in_plate: true },
];

const ref = (id: string) => ({ source: 'local', id });
const SEEDED = [ref('red'), ref('green')];

const PROCESS_FIELDS = {
  slicer: 'bambu_studio',
  fields: [
    {
      key: 'sparse_infill_density',
      label: 'Sparse infill density',
      type: 'number' as const,
      category: 'infill',
      unit: '%',
      min: 0,
      max: 100,
      step: 1,
    },
  ],
};
const RESOLVED_PROCESS = { sparse_infill_density: '15%' };

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

async function waitForReady() {
  await waitFor(() => expect(sliceButton().disabled).toBe(false));
}

async function sliceAndCaptureBody(user: ReturnType<typeof userEvent.setup>) {
  await user.click(sliceButton());
  await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
  return mockApi.sliceLibraryFile.mock.calls[0][1] as SliceRequest;
}

/** The section header row — `Collapsible`'s toggle, named by its summary. */
const sectionToggle = (name: RegExp) => screen.getByRole('button', { name });

const PRINTER = /Printer & quality/;
const FILAMENT = /Filament/;
const PRINT_SETTINGS = /Print settings/;

describe('SlicerPage — collapsible rail sections', () => {
  /**
   * A working store behind `setup.ts`'s call-recording mock. Without it
   * `getItem` answers `undefined` forever and "remembers across a reload"
   * cannot be told apart from "always opens with the defaults".
   */
  let store: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new Map();
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string) => store.get(key) ?? null,
    );
    (localStorage.setItem as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string, value: string) => {
        store.set(key, value);
      },
    );

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
    mockApi.getProcessFields.mockResolvedValue(PROCESS_FIELDS);
    mockApi.getResolvedProcess.mockResolvedValue(RESOLVED_PROCESS);
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

  it('groups the rail into Printer & quality / Filament / Print settings, all open on a first visit', async () => {
    renderPage();
    await waitForReady();

    // The owner's three names, in the owner's order.
    const headings = screen
      .getByTestId('slicer-rail')
      .querySelectorAll('[data-testid^="rail-section-"] h2');
    expect(Array.from(headings).map((h) => h.textContent)).toEqual([
      'Printer & quality',
      'Filament',
      'Print settings',
    ]);

    for (const name of [PRINTER, FILAMENT, PRINT_SETTINGS]) {
      expect(sectionToggle(name).getAttribute('aria-expanded')).toBe('true');
    }
    // Nothing stored yet: the defaults are what is on screen, and they are the
    // rail exactly as it looked before this ticket. Merely rendering must not
    // write a preference — that would freeze today's defaults onto every user
    // and make a later change to them invisible.
    for (const key of Object.values(RAIL_SECTION_STORAGE_KEYS)) {
      expect(store.has(key)).toBe(false);
    }
    expect(screen.getByTestId('printer-picker')).toBeVisible();
    expect(screen.getByTestId('filament-slots')).toBeVisible();
    expect(screen.getByTestId('process-settings-editor')).toBeVisible();
  });

  it('collapses one section without touching the others, and remembers it across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    await waitForReady();

    await user.click(sectionToggle(FILAMENT));

    await waitFor(() => expect(screen.getByTestId('filament-slots')).not.toBeVisible());
    expect(screen.getByTestId('printer-picker')).toBeVisible();
    expect(screen.getByTestId('process-settings-editor')).toBeVisible();
    expect(store.get(RAIL_SECTION_STORAGE_KEYS.filaments)).toBe('false');
    // Only the section the user touched is recorded; the untouched two keep
    // their defaults rather than being frozen at today's values.
    expect(store.has(RAIL_SECTION_STORAGE_KEYS.presets)).toBe(false);
    expect(store.has(RAIL_SECTION_STORAGE_KEYS.settings)).toBe(false);

    // "Across a reload": the preference is read in a `useState` initialiser,
    // so a fresh mount is the same code path a page load takes.
    unmount();
    renderPage();
    await waitForReady();

    expect(sectionToggle(FILAMENT).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('filament-slots')).not.toBeVisible();
    expect(sectionToggle(PRINTER).getAttribute('aria-expanded')).toBe('true');
    expect(sectionToggle(PRINT_SETTINGS).getAttribute('aria-expanded')).toBe('true');
  });

  it('reopens a section that was closed, and remembers that too', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    await user.click(sectionToggle(PRINT_SETTINGS));
    await waitFor(() => expect(screen.getByTestId('process-settings-editor')).not.toBeVisible());
    expect(store.get(RAIL_SECTION_STORAGE_KEYS.settings)).toBe('false');

    await user.click(sectionToggle(PRINT_SETTINGS));
    await waitFor(() => expect(screen.getByTestId('process-settings-editor')).toBeVisible());
    expect(store.get(RAIL_SECTION_STORAGE_KEYS.settings)).toBe('true');
  });

  it('sends a collapsed Filament section’s presets and colours on the slice request', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    // Colour slot 2, so the request carries something a *derived* read of the
    // visible DOM could not have produced.
    fireEvent.change(screen.getByLabelText('Colour of filament 2'), {
      target: { value: '#123456' },
    });

    await user.click(sectionToggle(FILAMENT));
    await waitFor(() => expect(screen.getByTestId('filament-slots')).not.toBeVisible());
    await waitForReady();

    const body = await sliceAndCaptureBody(user);
    expect(body.filament_presets).toEqual(SEEDED);
    expect(body.filament_colours).toEqual([null, '#123456']);
  });

  it('sends a collapsed Print settings section’s overrides on the slice request', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    const infill = (await screen.findByLabelText('Sparse infill density')) as HTMLInputElement;
    expect(infill.value).toBe('15');
    await user.clear(infill);
    await user.type(infill, '25');
    await user.tab();
    await waitFor(() => expect(screen.getByTestId('override-count').textContent).toMatch(/1/));

    await user.click(sectionToggle(PRINT_SETTINGS));
    await waitFor(() => expect(screen.getByTestId('process-settings-editor')).not.toBeVisible());
    await waitForReady();

    const body = await sliceAndCaptureBody(user);
    expect(body.process_overrides).toEqual({ sparse_infill_density: 25 });
  });

  it('keeps a collapsed section mounted, so its controls do not lose state of their own', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    // The search box is the settings editor's own state — nothing outside the
    // component records it, so an unmount on collapse would silently clear it.
    const search = screen.getByLabelText('Search settings') as HTMLInputElement;
    await user.type(search, 'infill');
    expect(search.value).toBe('infill');

    await user.click(sectionToggle(PRINT_SETTINGS));
    await waitFor(() => expect(screen.getByTestId('process-settings-editor')).not.toBeVisible());
    // Hidden, not gone.
    expect(screen.getByTestId('process-settings-editor')).toBeInTheDocument();

    await user.click(sectionToggle(PRINT_SETTINGS));
    await waitFor(() => expect(screen.getByTestId('process-settings-editor')).toBeVisible());
    expect((screen.getByLabelText('Search settings') as HTMLInputElement).value).toBe('infill');
  });

  it('says what a closed section is holding, and stops saying it once the section is open', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    expect(screen.queryByTestId('rail-section-filaments-summary')).toBeNull();

    await user.click(sectionToggle(FILAMENT));
    await waitFor(() =>
      expect(screen.getByTestId('rail-section-filaments-summary').textContent).toBe(
        '2 of 2 slots set',
      ),
    );
  });

  it('nests the settings editor without adding a second scroll area to the rail', async () => {
    renderPage();
    await waitForReady();

    // The editor's field list is the rail's only scroller — a section that
    // scrolled on its own would trap the chips and the search box above a
    // second, inner scrollbar.
    const scrollers = screen
      .getByTestId('slicer-rail')
      .querySelectorAll('.overflow-y-auto, .overflow-auto, .overflow-y-scroll');
    expect(scrollers).toHaveLength(1);
    expect(screen.getByTestId('process-settings-editor').contains(scrollers[0])).toBe(true);
  });
});

describe('MobileSliceWizard — unaffected by the rail sections', () => {
  let matchMedia: typeof window.matchMedia;

  beforeEach(() => {
    vi.clearAllMocks();
    matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

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
    mockApi.getProcessFields.mockResolvedValue(PROCESS_FIELDS);
    mockApi.getResolvedProcess.mockResolvedValue(RESOLVED_PROCESS);
    mockApi.listSlicerPipelines.mockResolvedValue({ pipelines: [] });
  });

  afterEach(() => {
    cleanup();
    window.matchMedia = matchMedia;
    window.history.pushState({}, '', '/');
  });

  it('gives each step its controls straight, with no chevron to hide the step you are on', async () => {
    renderPage();
    await screen.findByTestId('mobile-slice-wizard');
    await waitFor(() => expect(screen.getByTestId('printer-picker')).toBeVisible());

    const rail = screen.getByTestId('slicer-rail');
    expect(rail.querySelectorAll('[data-testid^="rail-section-"]')).toHaveLength(0);
    expect(rail.querySelectorAll('[aria-expanded]')).toHaveLength(0);
  });
});
