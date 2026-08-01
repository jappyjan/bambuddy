/**
 * Desktop integration of the file inspector panel into FileManagerPage
 * (spec §7 step 3, ticket #27).
 *
 * The load-bearing property here is the one a screenshot cannot show: clicking
 * from one file to another must re-render the *same* panel instance with a new
 * `file`, never tear it down and build a new one. These tests assert that on
 * the DOM node identity, which is the observable consequence of React keeping
 * the component mounted — a `key={file.id}` or a conditional remount would
 * swap the node and fail.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FileManagerPage } from '../../pages/FileManagerPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const parentFile = {
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
  slice_count: 1,
  // A nested sliced child: the ?group=nested listing hangs slice outputs under
  // the file they came from, and the panel must inspect one exactly like a
  // top-level file.
  children: [
    {
      id: 3,
      filename: 'benchy_plate_1.gcode.3mf',
      file_path: '/library/benchy_plate_1.gcode.3mf',
      file_size: 2048576,
      file_type: 'gcode.3mf',
      folder_id: null,
      thumbnail_path: null,
      print_name: 'Benchy Plate 1',
      print_time_seconds: 1800,
      print_count: 0,
      duplicate_count: 0,
      created_at: '2024-01-03T00:00:00Z',
    },
  ],
};

const otherFile = {
  id: 2,
  filename: 'bracket.stl',
  file_path: '/library/bracket.stl',
  file_size: 524288,
  file_type: 'stl',
  folder_id: null,
  thumbnail_path: null,
  print_name: 'Bracket',
  print_time_seconds: null,
  print_count: 0,
  duplicate_count: 0,
  created_at: '2024-01-02T00:00:00Z',
};

/** The clickable card body for a file, as rendered by FileCard. */
function cardFor(name: string): HTMLElement {
  const card = screen.getByText(name).closest('div[class*="cursor-pointer"]');
  if (!card) throw new Error(`no clickable card for ${name}`);
  return card as HTMLElement;
}

const gridClasses = () => screen.getByTestId('file-grid').className;

describe('FileManagerPage — file inspector panel (#27)', () => {
  beforeEach(() => {
    localStorage.clear();
    server.use(
      http.get('/api/v1/library/folders', () => HttpResponse.json([])),
      http.get('/api/v1/library/files', () => HttpResponse.json([parentFile, otherFile])),
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

  it('is closed until a file is clicked, then opens on that file', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());
    expect(screen.queryByTestId('file-inspector-panel')).not.toBeInTheDocument();

    await user.click(cardFor('Benchy'));

    await waitFor(() => expect(screen.getByTestId('file-inspector-panel')).toBeInTheDocument());
    // The panel is labelled with the file it is showing.
    expect(screen.getByTestId('file-inspector-panel')).toHaveAttribute('aria-label', 'Benchy');
  });

  it('reflows the grid to fewer columns while open and restores full width on close', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

    const closedClasses = gridClasses();
    expect(closedClasses).toContain('xl:grid-cols-5');
    expect(closedClasses).toContain('2xl:grid-cols-6');

    await user.click(cardFor('Benchy'));
    await waitFor(() => expect(screen.getByTestId('file-inspector-panel')).toBeInTheDocument());

    const openClasses = gridClasses();
    expect(openClasses).not.toContain('xl:grid-cols-5');
    expect(openClasses).toContain('xl:grid-cols-3');
    expect(openClasses).toContain('2xl:grid-cols-4');

    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByTestId('file-inspector-panel')).not.toBeInTheDocument());
    expect(gridClasses()).toBe(closedClasses);
  });

  it('updates in place when another file is clicked — the panel is not unmounted', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

    await user.click(cardFor('Benchy'));
    await waitFor(() => expect(screen.getByTestId('file-inspector-panel')).toBeInTheDocument());
    const firstNode = screen.getByTestId('file-inspector-panel');
    expect(firstNode).toHaveAttribute('aria-label', 'Benchy');

    // Tag the live DOM node. A remount would build a fresh <aside> and the
    // marker would be gone — this is what proves the panel stayed mounted
    // rather than merely "a panel is on screen again".
    firstNode.setAttribute('data-mount-marker', 'first-mount');

    await user.click(cardFor('Bracket'));

    await waitFor(() =>
      expect(screen.getByTestId('file-inspector-panel')).toHaveAttribute('aria-label', 'Bracket'),
    );
    const secondNode = screen.getByTestId('file-inspector-panel');
    expect(secondNode).toBe(firstNode);
    expect(secondNode).toHaveAttribute('data-mount-marker', 'first-mount');

    // And back again — still the same node.
    await user.click(cardFor('Benchy'));
    await waitFor(() =>
      expect(screen.getByTestId('file-inspector-panel')).toHaveAttribute('aria-label', 'Benchy'),
    );
    expect(screen.getByTestId('file-inspector-panel')).toBe(firstNode);
  });

  it('inspects a nested sliced child in the same panel instance', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

    await user.click(cardFor('Benchy'));
    await waitFor(() => expect(screen.getByTestId('file-inspector-panel')).toBeInTheDocument());
    const panel = screen.getByTestId('file-inspector-panel');
    panel.setAttribute('data-mount-marker', 'first-mount');

    // Nested slices are collapsed under their parent card until expanded.
    await user.click(screen.getByRole('button', { name: 'Sliced outputs: 1' }));
    await waitFor(() => expect(screen.getByText('Benchy Plate 1')).toBeInTheDocument());

    await user.click(cardFor('Benchy Plate 1'));

    await waitFor(() =>
      expect(screen.getByTestId('file-inspector-panel')).toHaveAttribute(
        'aria-label',
        'Benchy Plate 1',
      ),
    );
    expect(screen.getByTestId('file-inspector-panel')).toBe(panel);
    expect(screen.getByTestId('file-inspector-panel')).toHaveAttribute(
      'data-mount-marker',
      'first-mount',
    );
  });

  it('closes when the inspected file leaves the listing', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());
    await user.click(cardFor('Bracket'));
    await waitFor(() => expect(screen.getByTestId('file-inspector-panel')).toBeInTheDocument());

    // Filtering the file out of the list must not leave a panel pointing at
    // something the user can no longer see.
    await user.type(screen.getByPlaceholderText('Search files...'), 'benchy');

    await waitFor(() =>
      expect(screen.queryByTestId('file-inspector-panel')).not.toBeInTheDocument(),
    );
  });
});
