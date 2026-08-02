/**
 * Cross-folder selection visibility (#37).
 *
 * The selection deliberately survives a folder / search / tag-filter change, so
 * these tests exist to prove the UI never lets that be a surprise: the count
 * says how much of the selection is off-screen, and the delete confirmation —
 * the irreversible one — names every file it is about to destroy and marks the
 * ones the user cannot see.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FileManagerPage } from '../../pages/FileManagerPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockFolders = [
  { id: 1, name: 'Folder A', parent_id: null, file_count: 1, project_id: null, archive_id: null, project_name: null, archive_name: null, children: [] },
  { id: 2, name: 'Folder B', parent_id: null, file_count: 1, project_id: null, archive_id: null, project_name: null, archive_name: null, children: [] },
];

function file(id: number, filename: string, folderId: number, tagIds: number[] = []) {
  return {
    id,
    filename,
    file_path: `/library/${filename}`,
    file_size: 1024,
    file_type: 'stl',
    folder_id: folderId,
    thumbnail_path: null,
    print_name: null,
    print_time_seconds: null,
    print_count: 0,
    duplicate_count: 0,
    created_at: '2024-01-01T00:00:00Z',
    tags: tagIds.map((tid) => ({ id: tid, name: tid === 7 ? 'toys' : `tag${tid}` })),
  };
}

// alpha lives in Folder A and carries the "toys" tag; beta lives in Folder B.
// Any view change that narrows to one of them leaves the other selected but
// off-screen — which is the whole point of this file.
const ALPHA = file(1, 'alpha.stl', 1, [7]);
const BETA = file(2, 'beta.stl', 2);

let bulkDeleteBody: { file_ids: number[]; folder_ids: number[] } | null = null;

describe('FileManagerPage — cross-folder selection (#37)', () => {
  beforeEach(() => {
    localStorage.clear();
    bulkDeleteBody = null;

    server.use(
      http.get('/api/v1/library/folders', () => HttpResponse.json(mockFolders)),
      http.get('/api/v1/library/files', ({ request }) => {
        const params = new URL(request.url).searchParams;
        const folderId = params.get('folder_id');
        const tagIds = params.getAll('tag_ids');
        // Tag filter bypasses folder scoping server-side, same as the backend.
        if (tagIds.length > 0) {
          return HttpResponse.json([ALPHA, BETA].filter((f) => tagIds.includes('7') && f.id === ALPHA.id));
        }
        if (folderId === '1') return HttpResponse.json([ALPHA]);
        if (folderId === '2') return HttpResponse.json([BETA]);
        return HttpResponse.json([ALPHA, BETA]);
      }),
      http.get('/api/v1/library/tags', () => HttpResponse.json([{ id: 7, name: 'toys', file_count: 1 }])),
      http.post('/api/v1/library/bulk-delete', async ({ request }) => {
        bulkDeleteBody = (await request.json()) as { file_ids: number[]; folder_ids: number[] };
        return HttpResponse.json({ deleted_files: bulkDeleteBody.file_ids.length, deleted_folders: 0 });
      }),
    );
  });

  /** Select every file in the root listing (both alpha and beta). */
  async function selectBoth(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => expect(screen.getByText('alpha.stl')).toBeInTheDocument());
    await user.click(screen.getByText('Select All'));
    await waitFor(() => expect(screen.getByText('2 selected')).toBeInTheDocument());
  }

  it('shows no off-screen notice while the whole selection is visible', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await selectBoth(user);

    expect(screen.queryByText(/not in this view/)).not.toBeInTheDocument();
  });

  it('reports the off-screen part of the selection after a folder change', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await selectBoth(user);
    await user.click(screen.getByText('Folder B'));

    await waitFor(() => expect(screen.queryByText('alpha.stl')).not.toBeInTheDocument());
    // Still 2 selected, but one of them is no longer on screen — and the count
    // says so without hovering or opening anything.
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByText('1 not in this view')).toBeInTheDocument();
  });

  it('reports the off-screen part of the selection after a search change', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await selectBoth(user);
    await user.type(screen.getByPlaceholderText(/search/i), 'beta');

    await waitFor(() => expect(screen.getByText('1 not in this view')).toBeInTheDocument());
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('reports the off-screen part of the selection after a tag-filter change', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await selectBoth(user);
    // The filter chip in the tag bar above the listing (the file card renders
    // its own chip for the same tag further down).
    await user.click(screen.getAllByRole('button', { name: /toys/ })[0]);

    // The tag filter narrows the listing to alpha, leaving beta selected but
    // invisible.
    await waitFor(() => expect(screen.queryByText('beta.stl')).not.toBeInTheDocument());
    expect(screen.getByText('1 not in this view')).toBeInTheDocument();
  });

  it('names every file in the delete confirmation and marks the off-screen ones', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await selectBoth(user);
    await user.click(screen.getByText('Folder B'));
    await waitFor(() => expect(screen.getByText('1 not in this view')).toBeInTheDocument());

    await user.click(screen.getByText('Delete'));

    const dialog = await screen.findByText('These files will be deleted:');
    const list = dialog.parentElement!.querySelector('ul')!;
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    // alpha is the one the user cannot see, so it — and only it — is flagged.
    const alphaRow = rows.find((r) => r.textContent?.includes('alpha.stl'))!;
    const betaRow = rows.find((r) => r.textContent?.includes('beta.stl'))!;
    expect(alphaRow.textContent).toContain('not in this view');
    expect(betaRow.textContent).not.toContain('not in this view');
  });

  it('deletes exactly the selected files, on-screen and off', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await selectBoth(user);
    await user.click(screen.getByText('Folder B'));
    await waitFor(() => expect(screen.getByText('1 not in this view')).toBeInTheDocument());

    await user.click(screen.getByText('Delete'));
    await screen.findByText('These files will be deleted:');
    // The confirm button inside the dialog, not the toolbar's Delete.
    const buttons = screen.getAllByRole('button', { name: 'Delete' });
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(bulkDeleteBody).not.toBeNull());
    expect(bulkDeleteBody!.file_ids.slice().sort()).toEqual([1, 2]);
  });

  it('select-all adds the current view to a wider selection instead of replacing it', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    // Start from Folder A, select alpha, then move to Folder B and select all.
    await waitFor(() => expect(screen.getByText('Folder A')).toBeInTheDocument());
    await user.click(screen.getByText('Folder A'));
    await waitFor(() => expect(screen.queryByText('beta.stl')).not.toBeInTheDocument());
    await user.click(screen.getByText('Select All'));
    await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument());

    await user.click(screen.getByText('Folder B'));
    await waitFor(() => expect(screen.getByText('1 not in this view')).toBeInTheDocument());
    // The label admits its scope while a wider selection is live.
    expect(screen.getByText('Select All in View')).toBeInTheDocument();

    await user.click(screen.getByText('Select All in View'));
    await waitFor(() => expect(screen.getByText('2 selected')).toBeInTheDocument());
    expect(screen.getByText('1 not in this view')).toBeInTheDocument();
  });

  it('offers a clear that names the whole selection, not just the visible part', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await selectBoth(user);
    await user.click(screen.getByText('Folder B'));
    await waitFor(() => expect(screen.getByText('1 not in this view')).toBeInTheDocument());

    await user.click(screen.getAllByText('Clear all 2')[0]);

    await waitFor(() => expect(screen.queryByText(/selected/)).not.toBeInTheDocument());
    expect(screen.queryByText(/not in this view/)).not.toBeInTheDocument();
  });

  it('keeps the selection visible when the current view has no files at all', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await selectBoth(user);
    await user.type(screen.getByPlaceholderText(/search/i), 'nothing-matches-this');

    await waitFor(() => expect(screen.getByText('2 selected')).toBeInTheDocument());
    expect(screen.getByText('2 not in this view')).toBeInTheDocument();
  });

  it('shows the off-screen count in the move dialog too', async () => {
    const user = userEvent.setup();
    render(<FileManagerPage />);

    await selectBoth(user);
    await user.click(screen.getByText('Folder B'));
    await waitFor(() => expect(screen.getByText('1 not in this view')).toBeInTheDocument());

    await user.click(screen.getByText('Move'));

    await waitFor(() => expect(screen.getByText('Move 2 File(s)')).toBeInTheDocument());
    expect(screen.getAllByText('1 not in this view').length).toBeGreaterThan(1);
  });
});
