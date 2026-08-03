/**
 * The phone slicer — `MobileSliceWizard` mounted by `SlicerPage` (#24,
 * step-6.1; spec §6/§7 step 6, mockup phone option C).
 *
 * What these pin is that the *layout* is the only thing the breakpoint changes.
 * The wizard is a presentational shell over the page's own state, so the
 * failures worth catching here are the ones where the phone quietly decides
 * something for itself:
 *
 * 1. **It gets all the way to a real slice**, opening on step 1 for a file that
 *    has never been sliced.
 * 2. **Next is blocked while a step is unanswered** — and says why. A wizard
 *    that lets you walk past the printer step lands you on a Review whose Slice
 *    button is disabled for a reason you were never shown.
 * 3. **Print now is the page's gate, rendered.** The tempting phone shortcut is
 *    "a slice finished, so light the button up"; that prints the profile the
 *    user had *before* they changed it. Same rule as the desktop, same reason —
 *    see `sliceSelection.ts`.
 * 4. **The full viewport is one tap away, with the archive read-only rule
 *    intact**, because `onTransformChange` is passed through rather than
 *    re-decided.
 *
 * Review-first (#31, step-6.2) adds three more, and the third is the one that
 * matters: a file that has been sliced before opens on Review, its chips reach
 * back into the steps nobody walked — and **Print now is still dead on
 * arrival**. "Sliced before" is a fact about the file; Print now is a fact
 * about whether the output matches the selection on screen, and only a slice
 * completed in this session can establish it.
 *
 * The phone viewport is faked the way `pages/FileManagerInspectorSheet.test.tsx`
 * does it — by swapping `window.matchMedia`, narrowed to the max-width query so
 * every other media query on the page keeps its real answer. `ModelViewer` and
 * `PrintModal` are mocked for the same reasons as in `SlicerPage.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SlicerPage } from '../../pages/SlicerPage';
import { SliceJobTrackerProvider } from '../../contexts/SliceJobTrackerContext';
import { api, type SliceRequest, type UnifiedPresetsResponse } from '../../api/client';

let viewerProps: { interactive?: boolean; gizmoMode?: string | null } = {};

vi.mock('../../components/ModelViewer', () => ({
  ModelViewer: (props: { interactive?: boolean; gizmoMode?: string | null }) => {
    viewerProps = props;
    return <div data-testid="model-viewer" />;
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
    getArchiveDownload: vi.fn(() => '/api/v1/archives/7/download'),
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
  ],
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

function renderWizard(search = '?file=100') {
  window.history.pushState({}, '', `/slicer${search}`);
  return render(
    <SliceJobTrackerProvider>
      <SlicerPage />
    </SliceJobTrackerProvider>,
  );
}

const stepCounter = () => screen.getByTestId('wizard-step-counter').textContent ?? '';
// Back appears twice on steps 2+ — leaving the slicer, and leaving the step —
// so the wizard's own nav is addressed by test id rather than by label.
const nextButton = () => screen.getByTestId('wizard-next') as HTMLButtonElement;
const backButton = () => screen.getByTestId('wizard-back') as HTMLButtonElement;
const sliceButton = () => screen.getByRole('button', { name: /^Slice$/ }) as HTMLButtonElement;
const printNowButton = () => screen.getByRole('button', { name: /Print now/ }) as HTMLButtonElement;

/** Wait for the breakpoint effect to swap the desktop tree for the wizard. */
async function waitForWizard() {
  await screen.findByTestId('mobile-slice-wizard');
}

/** Step 1 → 2 → 3 → 4, taking the same route a thumb would. */
async function walkToReview(user: ReturnType<typeof userEvent.setup>) {
  for (const expected of [1, 2, 3]) {
    await waitFor(() => expect(stepCounter()).toContain(`Step ${expected} of 4`));
    await waitFor(() => expect(nextButton().disabled).toBe(false));
    await user.click(nextButton());
  }
  await waitFor(() => expect(stepCounter()).toContain('Step 4 of 4'));
}

describe('SlicerPage on a phone', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    vi.clearAllMocks();
    originalMatchMedia = window.matchMedia;
    // Phone viewport: only the mobile max-width query matches, so useIsMobile
    // flips to true without lying about every other media query on the page.
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
    // Never sliced, unless a test says otherwise — `slice_count` is what
    // decides between step 1 and Review (#31).
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
    mockApi.updateLibraryFileLayout.mockImplementation((fileId: number, layout: unknown) =>
      Promise.resolve({ file_id: fileId, layout }),
    );
    mockApi.getProcessFields.mockResolvedValue(PROCESS_FIELDS);
    mockApi.getResolvedProcess.mockResolvedValue({ sparse_infill_density: '15%' });
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
    window.matchMedia = originalMatchMedia;
    window.history.pushState({}, '', '/');
  });

  it('replaces the desktop rail-and-stage with the wizard', async () => {
    renderWizard();
    await waitForWizard();

    expect(stepCounter()).toContain('Step 1 of 4');
    // The stage is behind the thumbnail now, not beside the rail.
    expect(screen.queryByTestId('model-viewer')).toBeNull();
    expect(screen.getByTestId('wizard-thumbnail')).toBeDefined();
  });

  it('opens at step 1 for a never-sliced file and walks through to a real slice', async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitForWizard();

    // Step 1 — the printer step, and only the printer step. The printer is
    // picked by model + nozzle diameter since #44, so the model select is what
    // identifies that step now.
    expect(stepCounter()).toContain('Step 1 of 4');
    expect(await screen.findByLabelText('Printer')).toBeDefined();
    expect(screen.queryByTestId('process-settings-editor')).toBeNull();

    await walkToReview(user);

    // Review — the estimate and both actions, nothing else claiming to slice.
    expect(screen.getByTestId('slice-action-bar')).toBeDefined();
    await waitFor(() => expect(sliceButton().disabled).toBe(false));
    await user.click(sliceButton());

    await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
    const [fileId, body] = mockApi.sliceLibraryFile.mock.calls[0] as [number, SliceRequest];
    expect(fileId).toBe(100);
    // Byte-for-byte the desktop's request for the same presets — the phone
    // picked nothing of its own.
    expect(body).toEqual({
      printer_preset: { source: 'local', id: '1' },
      process_preset: { source: 'local', id: '2' },
      filament_preset: { source: 'local', id: '3' },
      filament_presets: [{ source: 'local', id: '3' }],
    });

    // And the finished slice's own numbers land on the Review screen.
    await waitFor(() => expect(screen.getByTestId('slice-estimate').textContent).toContain('2h 14m'));
  });

  it('blocks Next, with a reason, while the step is unanswered', async () => {
    // No printer profile exists to auto-pick, so step 1 cannot be satisfied.
    mockApi.getSlicerPresets.mockResolvedValue({
      ...PRESETS,
      local: { ...PRESETS.local, printer: [] },
    });
    const user = userEvent.setup();
    renderWizard();
    await waitForWizard();

    await waitFor(() => expect(nextButton().disabled).toBe(true));
    expect(screen.getByText(/Choose a printer and a process profile/i)).toBeDefined();

    await user.click(nextButton());
    expect(stepCounter()).toContain('Step 1 of 4');
  });

  it('blocks Next on the filament step until every slot has a profile', async () => {
    // Nothing to auto-pick from, so both slots stay empty — the case a phone is
    // most likely to walk past, since an unanswered dropdown is off-screen the
    // moment you scroll.
    mockApi.getLibraryFileFilamentRequirements.mockResolvedValue({
      file_id: 100,
      filename: 'Two.3mf',
      plate_id: 1,
      filaments: [
        { slot_id: 1, type: 'PLA', color: '#d94f4f', used_grams: 10, used_meters: 3 },
        { slot_id: 2, type: 'ASA', color: '#2e2e2e', used_grams: 5, used_meters: 1 },
      ],
    });
    mockApi.getSlicerPresets.mockResolvedValue({
      ...PRESETS,
      local: { ...PRESETS.local, filament: [] },
    });
    const user = userEvent.setup();
    renderWizard();
    await waitForWizard();

    await waitFor(() => expect(nextButton().disabled).toBe(false));
    await user.click(nextButton());
    await waitFor(() => expect(stepCounter()).toContain('Step 2 of 4'));

    const slots = (await screen.findAllByLabelText(/Filament \d/)) as HTMLSelectElement[];
    expect(slots).toHaveLength(2);
    expect(slots.every((select) => select.value === '')).toBe(true);

    await waitFor(() => expect(nextButton().disabled).toBe(true));
    expect(screen.getByText(/Choose a filament profile for every slot/i)).toBeDefined();

    await user.click(nextButton());
    expect(stepCounter()).toContain('Step 2 of 4');
  });

  it("renders the page's Print now gate rather than deciding one of its own", async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitForWizard();
    await walkToReview(user);

    expect(printNowButton().disabled).toBe(true);
    expect(printNowButton().title).toMatch(/Slice the model first/i);

    await user.click(sliceButton());
    await waitFor(() => expect(printNowButton().disabled).toBe(false));

    // **The one place a phone shortcut prints the wrong thing.** A slice has
    // completed, but the build plate on the request has changed since — so the
    // completed slice no longer describes what is on screen.
    await user.click(backButton());
    await waitFor(() => expect(stepCounter()).toContain('Step 3 of 4'));
    await user.click(backButton());
    await user.click(backButton());
    await waitFor(() => expect(stepCounter()).toContain('Step 1 of 4'));

    const bedType = screen.getByLabelText('Build plate') as HTMLSelectElement;
    await user.selectOptions(bedType, 'Textured PEI Plate');

    await walkToReview(user);
    expect(printNowButton().disabled).toBe(true);
    expect(screen.getByTestId('print-now-stale')).toBeDefined();
  });

  it('prints the slice output when Print now is live', async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitForWizard();
    await walkToReview(user);

    await user.click(sliceButton());
    await waitFor(() => expect(printNowButton().disabled).toBe(false));
    await user.click(printNowButton());

    const modal = await screen.findByTestId('print-modal');
    expect(modal.getAttribute('data-library-file-id')).toBe('777');
    expect(modal.textContent).toContain('Cube.gcode.3mf');
  });

  it('puts the full viewport one tap from any step, with the gizmos live', async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitForWizard();

    await user.click(screen.getByTestId('wizard-thumbnail'));
    expect(await screen.findByTestId('wizard-viewport')).toBeDefined();
    expect(screen.getByTestId('model-viewer')).toBeDefined();
    // A library file has a layout endpoint, so the stage is editable (#25/#32).
    expect(viewerProps.interactive).toBe(true);

    await user.click(screen.getByRole('button', { name: /Close the 3D view/i }));
    await waitFor(() => expect(screen.queryByTestId('wizard-viewport')).toBeNull());
    // And the step you were on is still the step you are on.
    expect(stepCounter()).toContain('Step 1 of 4');
  });

  it('leaves the viewport read-only for an archive, which has no layout endpoint', async () => {
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
    const user = userEvent.setup();
    renderWizard('?archive=7');
    await waitForWizard();

    await user.click(screen.getByTestId('wizard-thumbnail'));
    await screen.findByTestId('wizard-viewport');

    // Passed through, not re-decided: no `onTransformChange`, no gizmo.
    expect(viewerProps.interactive).toBe(false);
    expect(viewerProps.gizmoMode).toBeNull();
  });

  /** The source already has a sliced child — the review-first condition (#31). */
  function previouslySliced(count = 2) {
    mockApi.getLibraryFile.mockResolvedValue({ id: 100, filename: 'Cube.stl', slice_count: count });
  }

  it('opens a previously-sliced file on Review and slices without visiting a step', async () => {
    previouslySliced();
    const user = userEvent.setup();
    renderWizard();
    await waitForWizard();

    // The *first* painted screen is Review — not step 1 that then jumps, which
    // is what seeding `initialStep` after mount would produce.
    expect(stepCounter()).toContain('Step 4 of 4');
    // Nothing from the editing steps is on screen: the printer controls live
    // on step 1 and the settings editor on step 3.
    expect(screen.queryByLabelText('Printer')).toBeNull();
    expect(screen.queryByTestId('process-settings-editor')).toBeNull();

    // The chips are a summary, so they say what the steps behind hold — the
    // pre-picked printer by name, and the untouched settings.
    await waitFor(() =>
      expect(screen.getByTestId('wizard-chip-value-printer').textContent).toBe('Imported X1C 0.4'),
    );
    expect(screen.getByTestId('wizard-chip-value-settings').textContent).toContain('Preset values');

    await waitFor(() => expect(sliceButton().disabled).toBe(false));
    await user.click(sliceButton());

    // And the request is the one the four-screen walk produces — review-first
    // skipped the confirming, not the choosing.
    await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalled());
    const [fileId, body] = mockApi.sliceLibraryFile.mock.calls[0] as [number, SliceRequest];
    expect(fileId).toBe(100);
    expect(body).toEqual({
      printer_preset: { source: 'local', id: '1' },
      process_preset: { source: 'local', id: '2' },
      filament_preset: { source: 'local', id: '3' },
      filament_presets: [{ source: 'local', id: '3' }],
    });
  });

  it('sends a chip back to its step, and Back to review returns', async () => {
    previouslySliced();
    const user = userEvent.setup();
    renderWizard();
    await waitForWizard();
    await waitFor(() => expect(stepCounter()).toContain('Step 4 of 4'));

    await user.click(screen.getByTestId('wizard-chip-printer'));
    await waitFor(() => expect(stepCounter()).toContain('Step 1 of 4'));
    expect(await screen.findByLabelText('Printer')).toBeDefined();

    // Back the way you came — one tap, not three Nexts.
    await user.click(screen.getByTestId('wizard-to-review'));
    await waitFor(() => expect(stepCounter()).toContain('Step 4 of 4'));

    // The filament chip goes to its own step, and Next from there is already
    // the way back, so no second button claims to be.
    await user.click(screen.getByTestId('wizard-chip-filaments'));
    await waitFor(() => expect(stepCounter()).toContain('Step 2 of 4'));
    await user.click(screen.getByTestId('wizard-to-review'));
    await waitFor(() => expect(stepCounter()).toContain('Step 4 of 4'));

    await user.click(screen.getByTestId('wizard-chip-settings'));
    await waitFor(() => expect(stepCounter()).toContain('Step 3 of 4'));
    expect(screen.queryByTestId('wizard-to-review')).toBeNull();
    await user.click(nextButton());
    await waitFor(() => expect(stepCounter()).toContain('Step 4 of 4'));
  });

  it('leaves Print now disabled on a review-first mount until a slice completes', async () => {
    previouslySliced();
    const user = userEvent.setup();
    renderWizard();
    await waitForWizard();
    await waitFor(() => expect(stepCounter()).toContain('Step 4 of 4'));

    // **The bug this exists to catch.** The file has been sliced before, and
    // Review is on screen from the first frame — neither is a reason to offer
    // the print. `lastSlice` is empty, so the page's gate is off, and the
    // wizard renders that gate rather than inferring one from the mount.
    expect(printNowButton().disabled).toBe(true);
    expect(printNowButton().title).toMatch(/Slice the model first/i);
    expect(screen.queryByTestId('print-now-stale')).toBeNull();

    await waitFor(() => expect(sliceButton().disabled).toBe(false));
    await user.click(sliceButton());
    await waitFor(() => expect(printNowButton().disabled).toBe(false));
  });

  it('keeps Save and Reset layout reachable', async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitForWizard();
    await walkToReview(user);

    expect(screen.getByRole('button', { name: /Save layout/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Reset layout/i })).toBeDefined();
  });
});
