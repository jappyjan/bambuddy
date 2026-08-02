/**
 * Tests for the `/slicer` page (#15, step-5.3).
 *
 * Three things are being pinned here, and they are the three the ticket names:
 *
 * 1. **Parity with `SliceModal`.** Slicing from the page for the same
 *    selections must produce the same request. This is checked against the
 *    modal's *real dispatch* — the modal is rendered, its Slice button clicked,
 *    and the captured body compared — rather than against a copy of its body
 *    builder. A copy would agree with itself forever; the modal is the thing
 *    that must not drift, because it stays reachable as the fallback (spec §10)
 *    and the two entry points slicing differently is invisible until someone
 *    inspects a print.
 * 2. **An override changes the result**, and reaches the wire as a native value.
 * 3. **Print now disables on any change after a slice.** The rule tested at the
 *    unit level in `sliceSelection.test.ts`; here it is tested through the UI,
 *    because "the button is enabled" is the thing that can actually dispatch.
 *
 * `ModelViewer` is mocked (WebGL + a network 3MF parse, neither of which jsdom
 * has) and so is `PrintModal` (a large modal with its own printer/AMS queries —
 * what matters here is *whether* it opens and with which file, not its
 * internals).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SlicerPage } from '../../pages/SlicerPage';
import { SliceModal } from '../../components/SliceModal';
import { SliceJobTrackerProvider } from '../../contexts/SliceJobTrackerContext';
import { api, type SliceRequest, type UnifiedPresetsResponse } from '../../api/client';

vi.mock('../../components/ModelViewer', () => ({
  ModelViewer: ({ selectedPlateId }: { selectedPlateId?: number | null }) => (
    <div data-testid="model-viewer" data-selected-plate={String(selectedPlateId ?? '')} />
  ),
}));

vi.mock('../../components/PrintModal', () => ({
  PrintModal: ({ libraryFileId, archiveName }: { libraryFileId?: number; archiveName: string }) => (
    <div data-testid="print-modal" data-library-file-id={String(libraryFileId ?? '')}>
      {archiveName}
    </div>
  ),
}));

vi.mock('../../api/client', () => ({
  api: {
    getSlicerPresets: vi.fn(),
    getSlicerPrinterModels: vi.fn(),
    sliceLibraryFile: vi.fn(),
    sliceArchive: vi.fn(),
    getSliceJob: vi.fn(),
    getLibraryFilePlates: vi.fn(),
    getArchivePlates: vi.fn(),
    getLibraryFileFilamentRequirements: vi.fn(),
    getArchiveFilamentRequirements: vi.fn(),
    getLibraryFileLayout: vi.fn(),
    getProcessFields: vi.fn(),
    getResolvedProcess: vi.fn(),
    getLibraryFileDownloadUrl: vi.fn(() => '/api/v1/library/files/100/download'),
    getArchiveDownload: vi.fn(() => '/api/v1/archives/100/download'),
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
    printer: [{ id: '1', name: 'Imported X1C 0.4', source: 'local' }],
    process: [{ id: '2', name: 'Imported 0.20mm', source: 'local' }],
    filament: [{ id: '3', name: 'Imported PLA Basic', source: 'local' }],
  },
  standard: { printer: [], process: [], filament: [] },
  cloud_status: 'ok',
  orca_cloud_status: 'ok',
};

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
    {
      key: 'layer_height',
      label: 'Layer height',
      type: 'number' as const,
      category: 'quality',
      unit: 'mm',
      min: 0.05,
      max: 0.6,
      step: 0.01,
    },
  ],
};

// Real process profiles spell everything as a string; `15%` is what the
// resolved preset actually carries for an infill density of 15.
const RESOLVED_PROCESS = { sparse_infill_density: '15%', layer_height: '0.2' };

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

function renderSlicerPage(search = '?file=100') {
  window.history.pushState({}, '', `/slicer${search}`);
  return render(
    <SliceJobTrackerProvider>
      <SlicerPage />
    </SliceJobTrackerProvider>,
  );
}

/** Wait until the rail has pre-picked its presets and Slice is live. */
async function waitForReady() {
  await waitFor(() => {
    const slice = screen.getByRole('button', { name: /^Slice$/ }) as HTMLButtonElement;
    expect(slice.disabled).toBe(false);
  });
}

const sliceButton = () => screen.getByRole('button', { name: /^Slice$/ }) as HTMLButtonElement;
const printNowButton = () => screen.getByRole('button', { name: /Print now/ }) as HTMLButtonElement;

describe('SlicerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSlicerPresets.mockResolvedValue(PRESETS);
    mockApi.getSlicerPrinterModels.mockResolvedValue({});
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

  it('reads its source from the query string and renders the rail beside the stage', async () => {
    renderSlicerPage('?file=100');
    await waitForReady();

    expect(mockApi.getLibraryFilePlates).toHaveBeenCalledWith(100);
    expect(screen.getByTestId('slicer-rail')).toBeDefined();
    expect(screen.getByTestId('model-viewer')).toBeDefined();
    expect(screen.getByTestId('slice-action-bar')).toBeDefined();
    expect(screen.getByTestId('process-settings-editor')).toBeDefined();
  });

  it('takes ?archive=7 as well as ?file=42', async () => {
    mockApi.getArchivePlates.mockResolvedValue({
      archive_id: 7,
      filename: 'Vase.3mf',
      plates: [],
      is_multi_plate: false,
    });
    mockApi.getArchiveFilamentRequirements.mockResolvedValue({
      archive_id: 7,
      filename: 'Vase.3mf',
      plate_id: 1,
      filaments: [],
    });
    renderSlicerPage('?archive=7');

    await waitFor(() => expect(mockApi.getArchivePlates).toHaveBeenCalledWith(7));
    expect(mockApi.getLibraryFilePlates).not.toHaveBeenCalled();
    // Archives have no layout endpoint yet — the page must not ask for one.
    expect(mockApi.getLibraryFileLayout).not.toHaveBeenCalled();
  });

  it('explains itself instead of crashing when the URL names no source', () => {
    renderSlicerPage('');
    expect(screen.getByText(/No file to slice/i)).toBeDefined();
    expect(mockApi.getLibraryFilePlates).not.toHaveBeenCalled();
  });

  it('slices with the same request SliceModal sends for the same selections', async () => {
    const user = userEvent.setup();

    // The modal's real dispatch, captured from the modal itself.
    render(
      <SliceJobTrackerProvider>
        <SliceModal source={{ kind: 'libraryFile', id: 100, filename: 'Cube.stl' }} onClose={vi.fn()} />
      </SliceJobTrackerProvider>,
    );
    await waitForReady();
    await user.click(sliceButton());
    await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
    const modalBody = mockApi.sliceLibraryFile.mock.calls[0][1] as SliceRequest;

    cleanup();
    mockApi.sliceLibraryFile.mockClear();

    // The page's, from the same presets and the same source.
    renderSlicerPage('?file=100');
    await waitForReady();
    await user.click(sliceButton());
    await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
    const [pageFileId, pageBody] = mockApi.sliceLibraryFile.mock.calls[0] as [number, SliceRequest];

    expect(pageFileId).toBe(100);
    expect(pageBody).toEqual(modalBody);
    // Pinned explicitly too, so a change that breaks *both* sides at once
    // cannot pass by making them equally wrong.
    expect(pageBody).toEqual({
      printer_preset: { source: 'local', id: '1' },
      process_preset: { source: 'local', id: '2' },
      filament_preset: { source: 'local', id: '3' },
      filament_presets: [{ source: 'local', id: '3' }],
    });
    expect(pageBody.process_overrides).toBeUndefined();
  });

  it('sends an override on the request, and it changes the result', async () => {
    const user = userEvent.setup();
    renderSlicerPage('?file=100');
    await waitForReady();

    // The editor shows the preset's real resolved value (15, parsed out of
    // "15%"), so typing 25 is a genuine change rather than a re-statement.
    const infill = (await screen.findByLabelText('Sparse infill density')) as HTMLInputElement;
    expect(infill.value).toBe('15');
    await user.clear(infill);
    await user.type(infill, '25');
    await user.tab();

    await waitFor(() => expect(screen.getByTestId('override-count').textContent).toMatch(/1/));
    await user.click(sliceButton());

    await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
    const body = mockApi.sliceLibraryFile.mock.calls[0][1] as SliceRequest;
    // Native number, not "25%" — the backend coerces to the profile spelling.
    expect(body.process_overrides).toEqual({ sparse_infill_density: 25 });
  });

  it('drops an override that is set back to the preset value, rather than sending a no-op', async () => {
    const user = userEvent.setup();
    renderSlicerPage('?file=100');
    await waitForReady();

    const infill = (await screen.findByLabelText('Sparse infill density')) as HTMLInputElement;
    await user.clear(infill);
    await user.type(infill, '25');
    await user.tab();
    await waitFor(() => expect(screen.getByTestId('override-count').textContent).toMatch(/1/));

    await user.clear(infill);
    await user.type(infill, '15');
    await user.tab();
    await waitFor(() => expect(screen.getByTestId('override-count').textContent).not.toMatch(/1/));

    await user.click(sliceButton());
    await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
    const body = mockApi.sliceLibraryFile.mock.calls[0][1] as SliceRequest;
    expect(body.process_overrides).toBeUndefined();
  });

  describe('Print now', () => {
    it('is disabled until a slice has completed, then enabled', async () => {
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();

      expect(printNowButton().disabled).toBe(true);
      expect(printNowButton().title).toMatch(/Slice the model first/i);

      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      // And it prints the slice's *output*, not the source that was sliced.
      await user.click(printNowButton());
      const modal = await screen.findByTestId('print-modal');
      expect(modal.getAttribute('data-library-file-id')).toBe('777');
      expect(modal.textContent).toContain('Cube.gcode.3mf');
    });

    it('disables again when a preset changes after the slice', async () => {
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      // The build plate is part of the request, so changing it makes the
      // completed slice describe something else.
      const bedType = screen.getByLabelText('Build plate') as HTMLSelectElement;
      await user.selectOptions(bedType, 'Textured PEI Plate');

      await waitFor(() => expect(printNowButton().disabled).toBe(true));
      expect(screen.getByTestId('print-now-stale')).toBeDefined();
    });

    it('disables again when an override changes after the slice', async () => {
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      const infill = (await screen.findByLabelText('Sparse infill density')) as HTMLInputElement;
      await user.clear(infill);
      await user.type(infill, '30');
      await user.tab();

      await waitFor(() => expect(printNowButton().disabled).toBe(true));
    });

    it('disables again when the plate changes after the slice', async () => {
      mockApi.getLibraryFilePlates.mockResolvedValue({
        file_id: 100,
        filename: 'Two.3mf',
        plates: [
          { index: 1, name: null, objects: ['a'], has_thumbnail: false, thumbnail_url: null, print_time_seconds: null, filament_used_grams: null, filaments: [] },
          { index: 2, name: null, objects: ['b'], has_thumbnail: false, thumbnail_url: null, print_time_seconds: null, filament_used_grams: null, filaments: [] },
        ],
        is_multi_plate: true,
      });
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      // Multi-plate, so the plate travels on the request; switching tabs is a
      // different slice.
      await user.click(screen.getByRole('tab', { name: /Plate 2/i }));
      await waitFor(() => expect(printNowButton().disabled).toBe(true));
    });

    it('comes back when the change is undone', async () => {
      // A stale Print now that never recovers would cost a full re-slice for
      // every accidental keystroke, so reverting has to restore it.
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      const bedType = screen.getByLabelText('Build plate') as HTMLSelectElement;
      await user.selectOptions(bedType, 'Textured PEI Plate');
      await waitFor(() => expect(printNowButton().disabled).toBe(true));

      await user.selectOptions(bedType, '');
      await waitFor(() => expect(printNowButton().disabled).toBe(false));
    });

    it('does not enable when the slice job fails', async () => {
      mockApi.getSliceJob.mockResolvedValue({
        ...COMPLETED_JOB,
        status: 'failed',
        result: undefined,
        error_detail: 'objects over the bed boundary',
      });
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      await user.click(sliceButton());

      await waitFor(() => expect(sliceButton().disabled).toBe(false));
      expect(printNowButton().disabled).toBe(true);
    });
  });

  it('leaves Save layout disabled while the stage is read-only', async () => {
    renderSlicerPage('?file=100');
    await waitForReady();
    // #12 (step-8) adds the gizmos that make an arrangement editable. Until
    // then there is nothing to save, and writing identity transforms back would
    // turn "as designed" into an explicit arrangement the backend would apply.
    const save = screen.getByRole('button', { name: /Save layout/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});
