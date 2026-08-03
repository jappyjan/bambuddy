/**
 * The rail's printer group on `/slicer` (#44) — model and nozzle diameter in
 * place of one flat preset dropdown.
 *
 * These are page-level on purpose. The unit rules live in
 * `utils/printerPresetAxes.test.ts`; what can only be observed here is whether
 * the two controls actually reach the *slice request*, and whether an
 * unmatched pair actually stops it. A picker that resolved correctly in
 * isolation but let a stale preset travel on the request would pass the unit
 * tests and print with the wrong machine profile.
 *
 * `ModelViewer` and `PrintModal` are mocked for the reasons given in
 * `SlicerPage.test.tsx` — WebGL and a large modal with its own queries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
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
    getLibraryFileDownloadUrl: vi.fn(() => '/api/v1/library/files/100/download'),
    getArchiveDownload: vi.fn(() => '/api/v1/archives/100/download'),
    getLibraryFileThumbnailUrl: vi.fn(() => '/api/v1/library/files/100/thumbnail'),
    getLibraryFilePlateThumbnail: vi.fn(() => '/api/v1/library/files/100/plate-thumbnail/1'),
    getArchiveThumbnail: vi.fn(() => '/api/v1/archives/7/thumbnail'),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),
    listSlicerPipelines: vi.fn(),
    createSlicerPipeline: vi.fn(),
  },
}));

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

/**
 * Real Bambu printer-preset names: the model and the nozzle size live in the
 * name and nowhere else. The H2S has a 0.6 profile and the A1 does not, which
 * is what makes an unmatched pair reachable from the controls.
 */
const PRESETS: UnifiedPresetsResponse = {
  orca_cloud: { printer: [], process: [], filament: [] },
  cloud: { printer: [], process: [], filament: [] },
  local: { printer: [], process: [], filament: [] },
  standard: {
    printer: [
      { id: 'h2s-04', name: 'Bambu Lab H2S 0.4 nozzle', source: 'standard' },
      { id: 'h2s-06', name: 'Bambu Lab H2S 0.6 nozzle', source: 'standard' },
      { id: 'a1-04', name: 'Bambu Lab A1 0.4 nozzle', source: 'standard' },
    ],
    process: [{ id: 'proc', name: '0.20mm Standard', source: 'standard' }],
    filament: [{ id: 'fil', name: 'Bambu PLA Basic', source: 'standard' }],
  },
  cloud_status: 'ok',
  orca_cloud_status: 'ok',
};

const COMPLETED_JOB = {
  job_id: 42,
  status: 'completed' as const,
  kind: 'library_file' as const,
  source_id: 100,
  source_name: 'Cube.stl',
  created_at: new Date().toISOString(),
  started_at: null,
  completed_at: new Date().toISOString(),
  progress: null,
  result: {
    library_file_id: 777,
    name: 'Cube.gcode.3mf',
    print_time_seconds: 8040,
    filament_used_g: 41.8,
    filament_used_mm: 0,
    used_embedded_settings: false,
  },
};

function renderSlicerPage() {
  window.history.pushState({}, '', '/slicer?file=100');
  return render(
    <SliceJobTrackerProvider>
      <SlicerPage />
    </SliceJobTrackerProvider>,
  );
}

const sliceButton = () => screen.getByRole('button', { name: /^Slice$/ }) as HTMLButtonElement;
const printNowButton = () => screen.getByRole('button', { name: /Print now/ }) as HTMLButtonElement;
const modelSelect = () => screen.getByLabelText('Printer') as HTMLSelectElement;
const diameterSelect = () => screen.getByLabelText('Diameter') as HTMLSelectElement;

async function waitForReady() {
  await waitFor(() => expect(sliceButton().disabled).toBe(false));
  // The controls must show the pre-pick by the time it can be sliced, not a
  // render later — a picker that lagged behind `printerPreset` would leave the
  // rail claiming one printer while the request carried another.
  await waitFor(() => expect(modelSelect().value).not.toBe(''));
}

describe('SlicerPage — printer model / nozzle diameter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSlicerPresets.mockResolvedValue(PRESETS);
    mockApi.getSlicerPrinterModels.mockResolvedValue({});
    mockApi.getLibraryFile.mockResolvedValue({ id: 100, filename: 'Cube.stl', slice_count: 0 });
    mockApi.getLibraryFilePlates.mockResolvedValue({
      file_id: 100,
      filename: 'Cube.stl',
      plates: [],
      is_multi_plate: false,
    });
    mockApi.getLibraryFileFilamentRequirements.mockResolvedValue({
      file_id: 100,
      filename: 'Cube.stl',
      plate_id: 1,
      filaments: [],
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

  it('offers each printer model once, with the diameters that model has', async () => {
    renderSlicerPage();
    await waitForReady();

    // Two models, not the three preset names the flat dropdown listed.
    expect([...modelSelect().options].map((o) => o.textContent)).toEqual([
      'Select a printer',
      'Bambu Lab H2S',
      'Bambu Lab A1',
    ]);
    expect([...diameterSelect().options].map((o) => o.textContent)).toEqual([
      'Select a diameter',
      '0.4',
      '0.6',
    ]);
  });

  it('slices with the preset the chosen model and diameter name', async () => {
    const user = userEvent.setup();
    renderSlicerPage();
    await waitForReady();

    await user.selectOptions(diameterSelect(), '0.6');
    await user.click(sliceButton());

    await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
    const body = mockApi.sliceLibraryFile.mock.calls[0][1] as SliceRequest;
    // The 0.6 H2S profile — not the 0.4 one that was selected a moment ago.
    expect(body.printer_preset).toEqual({ source: 'standard', id: 'h2s-06' });
  });

  it('says a combination has no profile instead of substituting a different one', async () => {
    const user = userEvent.setup();
    renderSlicerPage();
    await waitForReady();

    await user.selectOptions(diameterSelect(), '0.6');
    // The A1 has no 0.6 profile. Quietly falling back to the A1's 0.4 would
    // slice for a nozzle the rail is not showing — the whole reason this is
    // stated out loud.
    await user.selectOptions(modelSelect(), 'bambu lab a1');

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('No printer profile for Bambu Lab A1 with a 0.6 mm nozzle'),
    );
    await waitFor(() => expect(sliceButton().disabled).toBe(true));
    expect(mockApi.sliceLibraryFile).not.toHaveBeenCalled();

    // And the way out is one click: the diameter the A1 does have.
    await user.selectOptions(diameterSelect(), '0.4');
    await waitFor(() => expect(sliceButton().disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(sliceButton());
    await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
    const body = mockApi.sliceLibraryFile.mock.calls[0][1] as SliceRequest;
    expect(body.printer_preset).toEqual({ source: 'standard', id: 'a1-04' });
  });

  it('still pre-picks the printer the 3MF was prepared with, on both axes', async () => {
    mockApi.getLibraryFilePlates.mockResolvedValue({
      file_id: 100,
      filename: 'Vase.3mf',
      plates: [],
      is_multi_plate: false,
      embedded_printer: 'Bambu Lab H2S 0.6 nozzle',
      embedded_process: '0.20mm Standard',
    });
    renderSlicerPage();
    await waitForReady();

    // The split controls have to *show* the pre-pick, not just hold it: the
    // whole point of the embedded printer is that the user can see the file
    // will be sliced for the machine it was designed for.
    await waitFor(() => expect(modelSelect().value).toBe('bambu lab h2s'));
    expect(diameterSelect().value).toBe('0.6');
  });

  it('leaves an imported profile with no nozzle in its name selectable', async () => {
    // Not every printer preset is a Bambu one. "Imported X1C 0.4" carries no
    // "<size> nozzle" segment, so it has nothing for the diameter axis — and
    // must still be pickable, which a model-times-diameter grid could easily
    // have made it not.
    mockApi.getSlicerPresets.mockResolvedValue({
      ...PRESETS,
      local: {
        ...PRESETS.local,
        printer: [{ id: 'imported', name: 'Imported X1C 0.4', source: 'local' }],
      },
    });
    const user = userEvent.setup();
    renderSlicerPage();
    await waitForReady();

    expect(modelSelect().value).toBe('imported x1c 0.4');
    expect(diameterSelect().disabled).toBe(true);
    expect(diameterSelect().options[0].textContent).toBe('Not specified by this profile');

    await user.click(sliceButton());
    await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
    const body = mockApi.sliceLibraryFile.mock.calls[0][1] as SliceRequest;
    expect(body.printer_preset).toEqual({ source: 'local', id: 'imported' });
  });

  it('disables Print now when the nozzle diameter changes after a slice', async () => {
    // Printer choice feeds `selectionFingerprint`; splitting the control must
    // not have taken a change out of it. A 0.6 nozzle printing a 0.4-sliced
    // file is exactly the kind of wrong that looks like a plausible print.
    const user = userEvent.setup();
    renderSlicerPage();
    await waitForReady();
    await user.click(sliceButton());
    await waitFor(() => expect(printNowButton().disabled).toBe(false));

    await user.selectOptions(diameterSelect(), '0.6');

    await waitFor(() => expect(printNowButton().disabled).toBe(true));
    expect(screen.getByTestId('print-now-stale')).toBeDefined();
  });

  it('disables Print now when the printer model changes after a slice', async () => {
    const user = userEvent.setup();
    renderSlicerPage();
    await waitForReady();
    await user.click(sliceButton());
    await waitFor(() => expect(printNowButton().disabled).toBe(false));

    await user.selectOptions(modelSelect(), 'bambu lab a1');

    await waitFor(() => expect(printNowButton().disabled).toBe(true));
  });
});
