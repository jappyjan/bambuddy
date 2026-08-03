/**
 * Objects on the plate wear their assigned filament's colour (#42, plate.3).
 *
 * ## What was actually broken
 *
 * Nothing in the rendering. `ModelViewer` has always coloured per extruder and
 * `PlateStage` has always forwarded `filamentColors` — `SlicerPage` simply
 * never passed it, so every part on every plate came out the same as-designed
 * green. These cases pin the wire that was missing, at the only place it can be
 * observed end to end: the props that reach the viewport.
 *
 * ## Why the assertions read the viewport's props rather than the canvas
 *
 * There is no WebGL in jsdom, so `ModelViewer` is mocked and the array it is
 * handed is what gets asserted. The other half — that an entry at index `i`
 * lands on the geometry extruder `i + 1` paints, on every plate at once — is
 * pinned against the **real** multi-plate Attractap fixture in
 * `components/parse3mf.test.ts`. Together they cover the whole path; neither
 * alone does.
 *
 * ## The failure these exist to prevent
 *
 * An off-by-one. `filamentColors` is indexed by the parser's 0-based extruder
 * and slots are 1-based in the plate metadata, so a shift in either direction
 * still paints every part *a* colour from the user's own palette. It looks
 * deliberate. The fixture below therefore gives every slot a different colour
 * and leaves one slot deliberately colourless, so any shift moves a colour
 * somewhere it visibly does not belong.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SlicerPage } from '../../pages/SlicerPage';
import { SliceJobTrackerProvider } from '../../contexts/SliceJobTrackerContext';
import { api, type UnifiedPresetsResponse } from '../../api/client';
import { UNSET_SLOT_COLOR } from '../../components/slicer/filamentSlots';

let viewerProps: { filamentColors?: string[]; plates?: number[] | null } = {};

vi.mock('../../components/ModelViewer', () => ({
  ModelViewer: (props: { filamentColors?: string[]; plates?: number[] | null }) => {
    viewerProps = props;
    return <div data-testid="model-viewer" />;
  },
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

const RED = '#FF0000';
const BLUE = '#0000FF';
const GREEN = '#00FF00';
const YELLOW = '#FFFF00';

/**
 * `PETG Uncoloured` carries no `filament_colour` at all — plenty of real
 * profiles do not. It is what makes a genuinely colourless slot reachable: the
 * pre-pick always lands *some* profile, so "no colour anywhere" needs a profile
 * that has none rather than a slot with no profile.
 */
const PRESETS: UnifiedPresetsResponse = {
  orca_cloud: { printer: [], process: [], filament: [] },
  cloud: { printer: [], process: [], filament: [] },
  local: {
    printer: [{ id: 'p1', name: 'Imported X1C 0.4', source: 'local' }],
    process: [{ id: 'q1', name: 'Imported 0.20mm', source: 'local' }],
    filament: [
      { id: 'red', name: 'PLA Red', source: 'local', filament_type: 'PLA', filament_colour: RED },
      { id: 'blue', name: 'PLA Blue', source: 'local', filament_type: 'PLA', filament_colour: BLUE },
      { id: 'green', name: 'PLA Green', source: 'local', filament_type: 'PLA', filament_colour: GREEN },
      { id: 'yellow', name: 'PLA Yellow', source: 'local', filament_type: 'PLA', filament_colour: YELLOW },
      { id: 'plain', name: 'PETG Uncoloured', source: 'local', filament_type: 'PETG' },
    ],
  },
  standard: { printer: [], process: [], filament: [] },
  cloud_status: 'ok',
  orca_cloud_status: 'ok',
};

/**
 * Four slots, each resolving through a different branch of the precedence:
 *
 * 1. plate colour red
 * 2. plate colour blue
 * 3. **no colour at all** — PETG, and the only PETG profile carries none, so
 *    this is the neutral case
 * 4. plate colour green, and `used_in_plate: false` — a slot the plate never
 *    paints with, sitting *after* the colourless one so a mis-indexed neutral
 *    would visibly swallow it
 */
const FILAMENTS = [
  { slot_id: 1, type: 'PLA', color: RED, used_grams: 5, used_meters: 2, used_in_plate: true },
  { slot_id: 2, type: 'PLA', color: BLUE, used_grams: 5, used_meters: 2, used_in_plate: true },
  { slot_id: 3, type: 'PETG', color: '', used_grams: 5, used_meters: 2, used_in_plate: true },
  { slot_id: 4, type: 'PLA', color: GREEN, used_grams: 0, used_meters: 0, used_in_plate: false },
];

/** What the stage must be handed for the fixture above, untouched. */
const SEEDED_COLORS = [RED, BLUE, UNSET_SLOT_COLOR, GREEN];

const PLATES = [1, 2].map((index) => ({
  index,
  name: null,
  objects: [`o${index}`],
  has_thumbnail: false,
  thumbnail_url: null,
  print_time_seconds: null,
  filament_used_grams: null,
  filaments: [],
}));

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
  // The pre-pick runs in an effect after the presets land, so the first render
  // with a live Slice button can still be a frame behind on colours.
  await waitFor(() => expect(viewerProps.filamentColors).toEqual(SEEDED_COLORS));
}

/** The colour the rail's numbered badge for `slot` is actually filled with. */
function badgeStyleColor(slot: number): string {
  const input = screen.getByLabelText(`Colour of filament ${slot}`);
  return (input.parentElement as HTMLElement).style.backgroundColor;
}

/** `#RRGGBB` as jsdom normalises it on a style property. */
function asRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe('SlicerPage — filament colours on the plate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    viewerProps = {};
    mockApi.getSlicerPresets.mockResolvedValue(PRESETS);
    mockApi.getSlicerPrinterModels.mockResolvedValue({});
    mockApi.getLibraryFile.mockResolvedValue({ id: 100, filename: 'Multi.3mf', slice_count: 0 });
    mockApi.getLibraryFilePlates.mockResolvedValue({
      file_id: 100,
      filename: 'Multi.3mf',
      plates: PLATES,
      is_multi_plate: true,
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
  });

  afterEach(() => {
    cleanup();
    window.history.pushState({}, '', '/');
  });

  it('hands the stage one colour per slot, in slot order', async () => {
    renderPage();
    await waitForReady();

    // **The mapping assertion the ticket asks for by name.** Index 0 is slot 1.
    expect(viewerProps.filamentColors).toEqual([RED, BLUE, UNSET_SLOT_COLOR, GREEN]);
    expect(viewerProps.filamentColors).toHaveLength(FILAMENTS.length);
  });

  it('paints every plate in the side-by-side scene from the same list (#41)', async () => {
    renderPage();
    await waitForReady();

    // #41 draws all plates at once, so the colours are not a property of the
    // active plate — the whole scene is painted from one list. If the viewport
    // were still being handed a single plate this would catch it.
    expect(viewerProps.plates).toEqual([1, 2]);
    expect(viewerProps.filamentColors).toEqual(SEEDED_COLORS);
  });

  it('gives a slot with no colour anywhere the neutral, at its own index', async () => {
    renderPage();
    await waitForReady();

    // Slot 3's profile carries no colour and the plate designed it with none.
    // It must resolve to the neutral *in place*: slot 4 keeps its green rather
    // than sliding up into the gap, and slot 1's red does not leak down.
    expect(viewerProps.filamentColors?.[2]).toBe(UNSET_SLOT_COLOR);
    expect(viewerProps.filamentColors?.[3]).toBe(GREEN);
    expect(viewerProps.filamentColors?.[0]).toBe(RED);
  });

  it('leaves the plate\'s own colours alone when an unused slot changes', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    // Slot 4 is `used_in_plate: false`. Recolouring it must not disturb the
    // three the plate does paint with.
    fireEvent.change(screen.getByLabelText('Colour of filament 4'), {
      target: { value: '#123456' },
    });
    await waitFor(() => expect(viewerProps.filamentColors?.[3]).toBe('#123456'));
    expect(viewerProps.filamentColors?.slice(0, 3)).toEqual([RED, BLUE, UNSET_SLOT_COLOR]);

    // And the reverse: changing a used slot leaves the unused one alone.
    await user.selectOptions(screen.getByLabelText('Filament 3 (PETG)'), 'local:yellow');
    await waitFor(() => expect(viewerProps.filamentColors?.[2]).toBe(YELLOW));
    expect(viewerProps.filamentColors?.[3]).toBe('#123456');
  });

  it('recolours the stage when the rail\'s filament choice changes', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    // Slot 3 has no colour of its own, so its profile's is what shows —
    // swapping the profile has to move the stage with it.
    await user.selectOptions(screen.getByLabelText('Filament 3 (PETG)'), 'local:yellow');
    await waitFor(() => expect(viewerProps.filamentColors?.[2]).toBe(YELLOW));
    expect(viewerProps.filamentColors).toEqual([RED, BLUE, YELLOW, GREEN]);
  });

  it('recolours the stage when the user picks a colour on the badge', async () => {
    renderPage();
    await waitForReady();

    fireEvent.change(screen.getByLabelText('Colour of filament 1'), {
      target: { value: '#123456' },
    });
    await waitFor(() => expect(viewerProps.filamentColors?.[0]).toBe('#123456'));
    // Only slot 1 moved.
    expect(viewerProps.filamentColors?.slice(1)).toEqual([BLUE, UNSET_SLOT_COLOR, GREEN]);
  });

  it('shows the same colour on the stage as on the rail badge, for every slot', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    // **The invariant #45 and #42 share.** Both views resolve through one
    // function; a second copy of the precedence would let the badge and the
    // model disagree, and neither would look wrong on its own.
    const expectAgreement = () => {
      for (let slot = 1; slot <= FILAMENTS.length; slot++) {
        expect(badgeStyleColor(slot), `slot ${slot}`).toBe(
          asRgb(viewerProps.filamentColors![slot - 1]),
        );
      }
    };

    expectAgreement();

    await user.selectOptions(screen.getByLabelText('Filament 3 (PETG)'), 'local:yellow');
    await waitFor(() => expect(viewerProps.filamentColors?.[2]).toBe(YELLOW));
    expectAgreement();

    fireEvent.change(screen.getByLabelText('Colour of filament 2'), {
      target: { value: '#123456' },
    });
    await waitFor(() => expect(viewerProps.filamentColors?.[1]).toBe('#123456'));
    expectAgreement();
  });

  it('grows and shrinks the list with the slots, keeping every colour in place', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForReady();

    // A slot added in the rail has to reach the stage as an entry of its own,
    // or every later extruder would index past the end of the list.
    await user.click(screen.getByRole('button', { name: 'Add a filament slot' }));
    await waitFor(() => expect(viewerProps.filamentColors).toHaveLength(5));
    expect(viewerProps.filamentColors?.slice(0, 4)).toEqual(SEEDED_COLORS);

    await user.click(screen.getByRole('button', { name: 'Remove the last filament slot' }));
    await waitFor(() => expect(viewerProps.filamentColors).toEqual(SEEDED_COLORS));
  });
});

describe('SlicerPage on a phone — filament colours', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    vi.clearAllMocks();
    viewerProps = {};
    originalMatchMedia = window.matchMedia;
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
      plates: PLATES,
      is_multi_plate: true,
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
  });

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
    window.history.pushState({}, '', '/');
  });

  it('paints the wizard\'s stage from the same list as the desktop', async () => {
    // The wizard renders the same `PlateStage` off the same `stageProps`, so
    // this is really a guard against the colours being wired into the desktop
    // branch alone — the phone would then be the one view still showing green.
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('wizard-thumbnail')).toBeDefined());

    // The phone keeps the stage behind the full-screen viewport, so that is
    // where the colours have to arrive.
    await user.click(screen.getByTestId('wizard-thumbnail'));
    await screen.findByTestId('wizard-viewport');
    await waitFor(() => expect(viewerProps.filamentColors).toEqual(SEEDED_COLORS));
    // `multiPlate={false}` on a phone (#41): one plate at a time, same colours.
    expect(viewerProps.plates).toBeNull();
  });
});
