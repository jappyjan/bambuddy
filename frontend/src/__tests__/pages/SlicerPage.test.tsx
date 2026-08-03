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
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SlicerPage } from '../../pages/SlicerPage';
import { SliceModal } from '../../components/SliceModal';
import { SliceJobTrackerProvider } from '../../contexts/SliceJobTrackerContext';
import { api, type SliceRequest, type UnifiedPresetsResponse } from '../../api/client';
import type { ObjectMetrics } from '../../components/slicer/transformMath';
import type { ObjectTransform, PlateLayout } from '../../types/plateStage';

/**
 * The mock keeps the viewport's placement callback so a gizmo drag can be
 * simulated (#25), and its anchor report so persistence can be driven (#32).
 * A real drag needs a canvas and a raycast; what this page is responsible for
 * begins at the transform the viewport reports. `objectTransforms` is captured
 * on the way *in*, which is how "the arrangement was restored" is observed —
 * that prop is what actually places the model on screen.
 */
let viewerProps: {
  interactive?: boolean;
  gizmoMode?: string | null;
  onObjectTransform?: (objectId: string, transform: ObjectTransform) => void;
  onObjectMetrics?: (metrics: Record<string, ObjectMetrics>) => void;
  objectTransforms?: Record<string, ObjectTransform>;
} = {};

vi.mock('../../components/ModelViewer', () => ({
  ModelViewer: (props: {
    selectedPlateId?: number | null;
    interactive?: boolean;
    gizmoMode?: string | null;
    onObjectTransform?: (objectId: string, transform: ObjectTransform) => void;
    onObjectMetrics?: (metrics: Record<string, ObjectMetrics>) => void;
    objectTransforms?: Record<string, ObjectTransform>;
  }) => {
    viewerProps = props;
    return (
      <div data-testid="model-viewer" data-selected-plate={String(props.selectedPlateId ?? '')} />
    );
  },
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
    // `slice_count` — the phone's review-first mount reads it (#31); the
    // desktop fetches it too and ignores it.
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
    // The phone's model strip (#24) — the page builds its URL on every render.
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
    mockApi.updateLibraryFileLayout.mockImplementation((fileId: number, layout: PlateLayout | null) =>
      Promise.resolve({ file_id: fileId, layout }),
    );
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

    it('disables again when an object is moved after the slice', async () => {
      // **The one thing step-8 can break silently.** A transform kept inside
      // `PlateStage` would still move the model on screen, and the fingerprint
      // would never see it: Print now would stay lit and dispatch a print of
      // the arrangement the user had *before* they moved anything. Nothing
      // else in the suite would fail. Hence this test, at the level where the
      // button can actually dispatch.
      mockApi.getLibraryFilePlates.mockResolvedValue({
        file_id: 100,
        filename: 'Two.3mf',
        plates: [
          { index: 1, name: null, objects: ['2', '3'], has_thumbnail: false, thumbnail_url: null, print_time_seconds: null, filament_used_grams: null, filaments: [] },
        ],
        is_multi_plate: false,
      });
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      act(() => {
        viewerProps.onObjectTransform?.('2', {
          position: [40, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        });
      });

      await waitFor(() => expect(printNowButton().disabled).toBe(true));
      expect(screen.getByTestId('print-now-stale')).toBeDefined();
    });

    it('comes back when the object is moved back', async () => {
      mockApi.getLibraryFilePlates.mockResolvedValue({
        file_id: 100,
        filename: 'Two.3mf',
        plates: [
          { index: 1, name: null, objects: ['2'], has_thumbnail: false, thumbnail_url: null, print_time_seconds: null, filament_used_grams: null, filaments: [] },
        ],
        is_multi_plate: false,
      });
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      const move = (position: [number, number, number]) =>
        act(() => {
          viewerProps.onObjectTransform?.('2', {
            position,
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          });
        });

      move([40, 0, 0]);
      await waitFor(() => expect(printNowButton().disabled).toBe(true));

      move([0, 0, 0]);
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

  /**
   * Persistence (#32, step-8.2).
   *
   * The failure mode being pinned throughout is that **a wrong save looks
   * exactly like a right one**: the endpoint accepts whatever numbers it is
   * given, the response echoes them, and the mistake only surfaces as a
   * misplaced print. So these assert the numbers on the wire, not just that a
   * request went out.
   */
  describe('layout persistence', () => {
    const ANCHORS: Record<string, ObjectMetrics> = {
      '2': { anchor: [100, 100, 0], size: [20, 20, 20] },
      '3': { anchor: [88, 60, 0], size: [30, 30, 30] },
    };

    /**
     * A 3MF plate shaped the way the endpoint really answers: `objects` holds
     * display *names*, `object_ids` holds the 3MF `<object id>` values. Keying
     * a saved layout on the names is accepted by the backend and applied to
     * nothing, so these tests deliberately keep the two different.
     */
    function useThreeMf(objectIds: string[] = ['2', '3']) {
      mockApi.getLibraryFilePlates.mockResolvedValue({
        file_id: 100,
        filename: 'Two.3mf',
        plates: [
          {
            index: 1,
            name: null,
            objects: objectIds.map((_, index) => `part_${index}.stl`),
            object_ids: objectIds,
            has_thumbnail: false,
            thumbnail_url: null,
            print_time_seconds: null,
            filament_used_grams: null,
            filaments: [],
          },
        ],
        is_multi_plate: false,
      });
    }

    /** The viewport reporting its anchors once the 3MF is on screen. */
    const reportAnchors = (metrics = ANCHORS) =>
      act(() => {
        viewerProps.onObjectMetrics?.(metrics);
      });

    const move = (objectId: string, position: [number, number, number]) =>
      act(() => {
        viewerProps.onObjectTransform?.(objectId, {
          position,
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        });
      });

    const saveButton = () =>
      screen.getByRole('button', { name: /Save layout/i }) as HTMLButtonElement;
    const resetButton = () =>
      screen.getByRole('button', { name: /Reset layout/i }) as HTMLButtonElement;

    it('is not offered until something has moved', async () => {
      useThreeMf();
      renderSlicerPage('?file=100');
      await waitForReady();
      reportAnchors();

      expect(saveButton().disabled).toBe(true);
      expect(saveButton().title).toMatch(/already matches/i);
      // Nothing stored either, so there is nothing to reset back to.
      expect(resetButton().disabled).toBe(true);
    });

    it('saves the anchor-relative move as an absolute bed coordinate', async () => {
      // **The bug this ticket exists to not ship.** `position` is absolute in
      // the stored layout and a delta in the viewport. Writing the delta
      // straight out saves cleanly and drags the object to (40, -10) — the
      // bed's front-left corner — at slice time.
      useThreeMf();
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      reportAnchors();

      move('2', [40, -10, 0]);
      await waitFor(() => expect(saveButton().disabled).toBe(false));
      await user.click(saveButton());

      await waitFor(() => expect(mockApi.updateLibraryFileLayout).toHaveBeenCalled());
      const [fileId, layout] = mockApi.updateLibraryFileLayout.mock.calls[0] as [number, PlateLayout];
      expect(fileId).toBe(100);
      expect(layout).toEqual({
        version: 1,
        plates: {
          '1': [
            { object_id: '2', position: [140, 90, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          ],
        },
      });
    });

    it('writes an entry per object, keyed on the 3MF object ids', async () => {
      // A `object_id` the model does not carry is dropped by the backend
      // *silently*: the save succeeds and the slice comes out unarranged. The
      // ids here are the ones `ModelViewer` parses into `ObjectData.id` and
      // hands back on the transform callback, so this pins the whole chain.
      useThreeMf(['2', '3']);
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      reportAnchors();

      move('2', [40, -10, 0]);
      move('3', [-8, 12, 0]);
      await waitFor(() => expect(saveButton().disabled).toBe(false));
      await user.click(saveButton());

      await waitFor(() => expect(mockApi.updateLibraryFileLayout).toHaveBeenCalled());
      const [, layout] = mockApi.updateLibraryFileLayout.mock.calls[0] as [number, PlateLayout];
      expect(layout.plates['1']).toEqual([
        { object_id: '2', position: [140, 90, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        { object_id: '3', position: [80, 72, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      ]);
    });

    it('restores a stored arrangement on load, once the anchors are known', async () => {
      mockApi.getLibraryFileLayout.mockResolvedValue({
        file_id: 100,
        layout: {
          version: 1,
          plates: {
            '1': [
              { object_id: '2', position: [140, 90, 0], rotation: [0, 0, 45], scale: [1, 1, 1] },
            ],
          },
        },
      });
      useThreeMf();
      renderSlicerPage('?file=100');
      await waitForReady();
      reportAnchors();

      await waitFor(() =>
        expect(viewerProps.objectTransforms?.['2']).toEqual({
          position: [40, -10, 0],
          rotation: [0, 0, 45],
          scale: [1, 1, 1],
        }),
      );
      expect(viewerProps.objectTransforms?.['3']).toEqual({
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });
    });

    it('saving does not move the model, so a completed slice stays printable', async () => {
      // Save → reload the layout from the response → re-derive the deltas. If
      // that round trip is not exact, the fingerprint moves and Print now goes
      // stale the instant a layout is saved.
      useThreeMf();
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      reportAnchors();

      move('2', [40, -10, 0]);
      await user.click(sliceButton());
      await waitFor(() => expect(printNowButton().disabled).toBe(false));

      await user.click(saveButton());
      await waitFor(() => expect(saveButton().disabled).toBe(true));
      expect(printNowButton().disabled).toBe(false);
      expect(viewerProps.objectTransforms?.['2']).toEqual({
        position: [40, -10, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });
    });

    it('resets to the original arrangement, clearing the stored layout', async () => {
      mockApi.getLibraryFileLayout.mockResolvedValue({
        file_id: 100,
        layout: {
          version: 1,
          plates: {
            '1': [
              { object_id: '2', position: [140, 90, 0], rotation: [0, 0, 45], scale: [1, 1, 1] },
            ],
          },
        },
      });
      useThreeMf();
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      reportAnchors();
      await waitFor(() =>
        expect(viewerProps.objectTransforms?.['2'].position).toEqual([40, -10, 0]),
      );

      // And a pending move on top of it, so this covers both halves: the
      // stored layout and the edits that have not been written yet.
      move('3', [5, 5, 0]);
      await user.click(resetButton());

      await waitFor(() => expect(mockApi.updateLibraryFileLayout).toHaveBeenCalledWith(100, null));
      await waitFor(() =>
        expect(viewerProps.objectTransforms).toEqual({
          '2': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          '3': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        }),
      );
    });

    it('writes a pending arrangement before slicing it', async () => {
      // `SliceRequest` carries no layout — the backend applies the stored
      // column to the model bytes. Slicing an unsaved move would slice the
      // previous arrangement while the viewport showed the new one.
      useThreeMf();
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      reportAnchors();

      move('2', [40, -10, 0]);
      await user.click(sliceButton());

      await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
      expect(mockApi.updateLibraryFileLayout).toHaveBeenCalledTimes(1);
      const [, layout] = mockApi.updateLibraryFileLayout.mock.calls[0] as [number, PlateLayout];
      expect(layout.plates['1']).toEqual([
        { object_id: '2', position: [140, 90, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      ]);
      expect(mockApi.updateLibraryFileLayout.mock.invocationCallOrder[0]).toBeLessThan(
        mockApi.sliceLibraryFile.mock.invocationCallOrder[0],
      );
    });

    it('does not slice at all when the arrangement could not be saved', async () => {
      // Slicing anyway would quietly slice a different arrangement than the
      // one on screen, which is worse than not slicing.
      useThreeMf();
      mockApi.updateLibraryFileLayout.mockRejectedValue(new Error('layout write failed'));
      const user = userEvent.setup();
      renderSlicerPage('?file=100');
      await waitForReady();
      reportAnchors();

      move('2', [40, -10, 0]);
      await user.click(sliceButton());

      await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/layout write failed/));
      expect(mockApi.sliceLibraryFile).not.toHaveBeenCalled();
    });

    it('leaves the stage read-only for an archive, which has no layout endpoint', async () => {
      // An editable gizmo whose result can be neither saved nor sliced moves
      // the model on screen and changes nothing about the print.
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
      await waitForReady();

      // No gizmo, no toolbar — `PlateStage` is read-only exactly when it is
      // given no `onTransformChange`, and that is what it reports downstream.
      expect(viewerProps.interactive).toBe(false);
      expect(viewerProps.gizmoMode).toBeNull();
      // Anchored: accessible-name regexes match substrings, and the rail's
      // "Re*move* the last filament slot" (#45) is not a gizmo.
      expect(screen.queryByRole('button', { name: /^Move$/ })).toBeNull();
      expect(saveButton().disabled).toBe(true);
      expect(saveButton().title).toMatch(/library files/i);
    });
  });
});
