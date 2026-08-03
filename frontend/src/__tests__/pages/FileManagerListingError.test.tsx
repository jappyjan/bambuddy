/**
 * Listing-query failure surfaces as an error, not a filter hint (#38).
 *
 * The empty-state chain in `FileGrid` used to test `files?.length === 0` and
 * then fall through to "no matching files — clear filters". On an errored
 * query `files` is `undefined` and not loading, so the user was told their
 * filters were too narrow when in fact the request had failed — and the
 * offered remedy (clearing the filters) did nothing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FileManagerPage } from '../../pages/FileManagerPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockFolders = [
  {
    id: 1,
    name: 'Folder A',
    parent_id: null,
    file_count: 1,
    project_id: null,
    archive_id: null,
    project_name: null,
    archive_name: null,
    children: [],
  },
];

const mockFile = {
  id: 1,
  filename: 'alpha.stl',
  file_path: '/library/alpha.stl',
  file_size: 1024,
  file_type: 'stl',
  folder_id: null,
  thumbnail_path: null,
  print_name: null,
  print_time_seconds: null,
  print_count: 0,
  duplicate_count: 0,
  created_at: '2024-01-01T00:00:00Z',
  tags: [],
};

describe('FileManagerPage — listing query errors (#38)', () => {
  beforeEach(() => {
    localStorage.clear();
    server.use(
      http.get('/api/v1/library/folders', () => HttpResponse.json(mockFolders)),
      http.get('/api/v1/library/tags', () => HttpResponse.json([])),
    );
  });

  it('shows an error state, not the "clear filters" hint, when the listing fails', async () => {
    server.use(
      http.get('/api/v1/library/files', () => new HttpResponse(null, { status: 500 })),
    );

    render(<FileManagerPage />);

    await waitFor(() => expect(screen.getByTestId('file-list-error')).toBeInTheDocument());
    expect(screen.getByText('Could not load files')).toBeInTheDocument();

    // The misleading state this ticket exists to remove.
    expect(screen.queryByText('No matching files')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('still shows the filter hint when the query succeeds but nothing matches', async () => {
    server.use(
      http.get('/api/v1/library/files', () => HttpResponse.json([mockFile])),
    );

    const user = userEvent.setup();
    render(<FileManagerPage />);

    await waitFor(() => expect(screen.getByText('alpha.stl')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/search/i), 'no-such-file');

    await waitFor(() => expect(screen.getByText('No matching files')).toBeInTheDocument());
    expect(screen.queryByTestId('file-list-error')).not.toBeInTheDocument();
  });

  it('recovers when the retry button refetches successfully', async () => {
    let shouldFail = true;
    server.use(
      http.get('/api/v1/library/files', () =>
        shouldFail ? new HttpResponse(null, { status: 500 }) : HttpResponse.json([mockFile]),
      ),
    );

    const user = userEvent.setup();
    render(<FileManagerPage />);

    await waitFor(() => expect(screen.getByTestId('file-list-error')).toBeInTheDocument());

    shouldFail = false;
    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByText('alpha.stl')).toBeInTheDocument());
    expect(screen.queryByTestId('file-list-error')).not.toBeInTheDocument();
  });
});
