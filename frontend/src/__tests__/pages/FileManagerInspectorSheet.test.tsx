/**
 * Mobile presentation of the file inspector — the bottom sheet
 * (spec §7 step 3, ticket #28, mockup screen 1 option A phone column).
 *
 * What these tests protect is that the phone gets the *same* panel the desktop
 * rail gets, in a sheet: appears on tap, drags up to full height, and goes away
 * by drag-down or by backdrop tap. `FileManagerInspectorPanel.test.tsx` covers
 * the desktop rail (including the no-unmount property) at the default viewport.
 *
 * The phone viewport is faked the way `hooks/useIsMobile.test.ts` does it — by
 * swapping `window.matchMedia` — narrowed to the max-width query so the rest of
 * the page's media queries keep their real answers.
 *
 * The drag is driven with touch events because that is what the sheet listens
 * for: it only ever renders on a touch device, and jsdom implements TouchEvent
 * but not PointerEvent, so this is both the honest and the only faithful way to
 * simulate it here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FileManagerPage } from '../../pages/FileManagerPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const benchy = {
  id: 1,
  filename: 'benchy.3mf',
  file_path: '/library/benchy.3mf',
  file_size: 1048576,
  file_type: '3mf',
  folder_id: null,
  thumbnail_path: '/thumbnails/1.png',
  print_name: 'Benchy',
  print_time_seconds: 3600,
  print_count: 5,
  duplicate_count: 0,
  created_at: '2024-01-01T00:00:00Z',
};

const bracket = {
  ...benchy,
  id: 2,
  filename: 'bracket.stl',
  file_path: '/library/bracket.stl',
  file_type: 'stl',
  thumbnail_path: null,
  print_name: 'Bracket',
  print_time_seconds: null,
  print_count: 0,
  created_at: '2024-01-02T00:00:00Z',
};

function cardFor(name: string): HTMLElement {
  const card = screen.getByText(name).closest('div[class*="cursor-pointer"]');
  if (!card) throw new Error(`no clickable card for ${name}`);
  return card as HTMLElement;
}

/** Drag the sheet's grabber by `dy` px (negative is upwards). */
function dragHandle(dy: number) {
  const handle = screen.getByTestId('bottom-sheet-handle');
  fireEvent.touchStart(handle, { touches: [{ clientY: 400 }] });
  fireEvent.touchMove(handle, { touches: [{ clientY: 400 + dy }] });
  fireEvent.touchEnd(handle, { changedTouches: [{ clientY: 400 + dy }] });
}

/** Open the sheet on a file and hand back its root. */
async function openSheetOn(name: string) {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
  await user.click(cardFor(name));
  await waitFor(() => expect(screen.getByTestId('bottom-sheet')).toBeInTheDocument());
  return screen.getByTestId('bottom-sheet');
}

describe('FileManagerPage — inspector bottom sheet on a phone (#28)', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    localStorage.clear();
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

    server.use(
      http.get('/api/v1/library/folders', () => HttpResponse.json([])),
      http.get('/api/v1/library/files', () => HttpResponse.json([benchy, bracket])),
      http.get('/api/v1/library/stats', () =>
        HttpResponse.json({
          total_files: 2,
          total_folders: 0,
          total_size_bytes: 1572864,
          disk_free_bytes: 10737418240,
          disk_total_bytes: 107374182400,
        }),
      ),
      http.get('/api/v1/settings/', () =>
        HttpResponse.json({
          check_updates: false,
          check_printer_firmware: false,
          library_disk_warning_gb: 5,
        }),
      ),
    );
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('shows no sheet until a file is tapped, then the inspector arrives in one', async () => {
    render(<FileManagerPage />);

    await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());
    expect(screen.queryByTestId('bottom-sheet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-inspector-panel')).not.toBeInTheDocument();

    const sheet = await openSheetOn('Benchy');

    // The same component the desktop rail mounts, inside the sheet — not a
    // separate mobile panel rendered somewhere else on the page.
    const panel = screen.getByTestId('file-inspector-panel');
    expect(sheet).toContainElement(panel);
    expect(panel).toHaveAttribute('aria-label', 'Benchy');
    expect(sheet).toHaveAttribute('data-snap', 'peek');
  });

  it('expands to full height when the grabber is dragged up', async () => {
    render(<FileManagerPage />);

    const sheet = await openSheetOn('Benchy');
    expect(sheet).toHaveAttribute('data-snap', 'peek');

    dragHandle(-120);

    await waitFor(() => expect(screen.getByTestId('bottom-sheet')).toHaveAttribute('data-snap', 'full'));
    // Still the same sheet and the same panel — expanding is a resize, not a
    // remount.
    expect(screen.getByTestId('bottom-sheet')).toBe(sheet);
  });

  it('ignores a drag too short to commit to the next snap point', async () => {
    render(<FileManagerPage />);

    const sheet = await openSheetOn('Benchy');

    dragHandle(-10);
    expect(sheet).toHaveAttribute('data-snap', 'peek');

    dragHandle(12);
    expect(screen.getByTestId('bottom-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('bottom-sheet')).toHaveAttribute('data-snap', 'peek');
  });

  it('dismisses when the grabber is dragged down', async () => {
    render(<FileManagerPage />);

    await openSheetOn('Bracket');

    dragHandle(140);

    await waitFor(() => expect(screen.queryByTestId('bottom-sheet')).not.toBeInTheDocument());
    expect(screen.queryByTestId('file-inspector-panel')).not.toBeInTheDocument();
  });

  it('collapses full back to peek before a drag down can dismiss it', async () => {
    render(<FileManagerPage />);

    await openSheetOn('Benchy');

    dragHandle(-120);
    await waitFor(() => expect(screen.getByTestId('bottom-sheet')).toHaveAttribute('data-snap', 'full'));

    // From full, a drag down steps back to peek rather than throwing the
    // selection away in one stroke.
    dragHandle(140);
    await waitFor(() => expect(screen.getByTestId('bottom-sheet')).toHaveAttribute('data-snap', 'peek'));

    // A second one closes it.
    dragHandle(140);
    await waitFor(() => expect(screen.queryByTestId('bottom-sheet')).not.toBeInTheDocument());
  });

  it('dismisses on a backdrop tap', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await openSheetOn('Benchy');

    await user.click(screen.getByTestId('bottom-sheet-backdrop'));

    await waitFor(() => expect(screen.queryByTestId('bottom-sheet')).not.toBeInTheDocument());
    expect(screen.queryByTestId('file-inspector-panel')).not.toBeInTheDocument();
  });

  it('reopens at peek after a dismissal', async () => {
    render(<FileManagerPage />);

    await openSheetOn('Benchy');
    dragHandle(-120);
    await waitFor(() => expect(screen.getByTestId('bottom-sheet')).toHaveAttribute('data-snap', 'full'));
    dragHandle(140);
    dragHandle(140);
    await waitFor(() => expect(screen.queryByTestId('bottom-sheet')).not.toBeInTheDocument());

    const reopened = await openSheetOn('Bracket');
    expect(reopened).toHaveAttribute('data-snap', 'peek');
    expect(screen.getByTestId('file-inspector-panel')).toHaveAttribute('aria-label', 'Bracket');
  });
});
