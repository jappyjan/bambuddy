/**
 * Tests for FileInspectorPanel (slicer UX redesign, spec §7 step 3).
 *
 * The panel is presentation-only: it renders the file it is handed, emits
 * actions, and shows only the actions the caller's permission callbacks allow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FileInspectorPanel } from '../../components/FileInspectorPanel';
import type { LibraryFileListItem, Permission } from '../../api/client';
import i18n from '../../i18n';

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

function makeFile(
  overrides: Partial<LibraryFileListItem> & { id: number; filename: string },
): LibraryFileListItem {
  return {
    folder_id: null,
    is_external: false,
    file_type: '3mf',
    file_size: 346112,
    thumbnail_path: null,
    print_count: 0,
    duplicate_count: 0,
    created_by_id: null,
    created_by_username: null,
    created_at: '2026-06-12T00:00:00Z',
    fs_modified_at: null,
    print_name: null,
    print_time_seconds: null,
    filament_used_grams: null,
    sliced_for_model: null,
    ...overrides,
  };
}

const handlers = {
  onClose: vi.fn(),
  onPrint: vi.fn(),
  onSlice: vi.fn(),
  onDownload: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onPreview3d: vi.fn(),
  onTagClick: vi.fn(),
};

const panelProps = {
  ...handlers,
  useSlicerApi: true,
  hasPermission: () => true,
  canModify: () => true,
  t,
};

beforeEach(() => {
  Object.values(handlers).forEach((fn) => fn.mockClear());
});

describe('FileInspectorPanel metadata', () => {
  const file = makeFile({
    id: 1,
    filename: 'Lighthouse.3mf',
    print_count: 3,
    print_time_seconds: 8040,
    tags: [{ id: 7, name: 'toys' }],
  });

  it('renders every metadata field it is given', () => {
    render(
      <FileInspectorPanel
        {...panelProps}
        file={file}
        dimensions={{ x: 31, y: 31, z: 74 }}
        plateCount={1}
      />,
    );

    expect(screen.getByText('Lighthouse.3mf')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-dimensions')).toHaveTextContent('31 × 31 × 74 mm');
    expect(screen.getByTestId('inspector-size')).toHaveTextContent('338.0 KB');
    expect(screen.getByTestId('inspector-plates')).toHaveTextContent(
      t('modelViewer.plateCount', { count: 1 }),
    );
    expect(screen.getByTestId('inspector-uploaded')).toHaveTextContent(/2026/);
    expect(screen.getByTestId('inspector-prints')).toHaveTextContent(
      t('fileManager.printedCount', { count: 3 }),
    );
    expect(screen.getByTestId('inspector-tags')).toHaveTextContent('toys');
  });

  it('omits dimensions and plate count when the caller has none', () => {
    render(<FileInspectorPanel {...panelProps} file={file} />);

    expect(screen.queryByTestId('inspector-dimensions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inspector-plates')).not.toBeInTheDocument();
    // The fields that come straight off the list item are still there.
    expect(screen.getByTestId('inspector-size')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-uploaded')).toBeInTheDocument();
  });

  it('renders a nested sliced child the same way as a parent file', () => {
    // With ?group=nested the selected file can be a sliced output; it carries
    // the same shape, so nothing about the panel changes except the badge.
    const child = makeFile({ id: 2, filename: 'Lighthouse.gcode.3mf', file_type: 'gcode.3mf' });
    render(<FileInspectorPanel {...panelProps} file={child} />);

    expect(screen.getByText('Lighthouse.gcode.3mf')).toBeInTheDocument();
    expect(screen.getByText(t('fileManager.slicedBadge'))).toBeInTheDocument();
    expect(screen.getByTestId('inspector-size')).toBeInTheDocument();
  });

  it('prefers the print name over the filename in the heading', () => {
    render(<FileInspectorPanel {...panelProps} file={{ ...file, print_name: 'Lighthouse v2' }} />);
    expect(screen.getByRole('heading', { name: 'Lighthouse v2' })).toBeInTheDocument();
  });
});

describe('FileInspectorPanel actions', () => {
  const sliceable = makeFile({ id: 1, filename: 'Lighthouse.3mf', created_by_id: 5 });
  const sliced = makeFile({ id: 2, filename: 'Lighthouse.gcode.3mf', file_type: 'gcode.3mf' });

  it('emits slice for the file it was handed', async () => {
    const user = userEvent.setup();
    render(<FileInspectorPanel {...panelProps} file={sliceable} />);

    await user.click(screen.getByRole('button', { name: t('fileManager.inspector.slicePrint') }));

    expect(handlers.onSlice).toHaveBeenCalledWith(sliceable);
    expect(handlers.onPrint).not.toHaveBeenCalled();
  });

  it('emits add-to-queue, download, rename, delete and close', async () => {
    const user = userEvent.setup();
    render(<FileInspectorPanel {...panelProps} file={sliced} />);

    await user.click(screen.getByRole('button', { name: t('fileManager.inspector.addToQueue') }));
    await user.click(screen.getByRole('button', { name: t('common.download') }));
    await user.click(screen.getByRole('button', { name: t('common.rename') }));
    await user.click(screen.getByRole('button', { name: t('common.delete') }));
    await user.click(screen.getByRole('button', { name: t('common.close') }));

    expect(handlers.onPrint).toHaveBeenCalledWith(sliced);
    expect(handlers.onDownload).toHaveBeenCalledWith(2);
    expect(handlers.onRename).toHaveBeenCalledWith(sliced);
    expect(handlers.onDelete).toHaveBeenCalledWith(2);
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('emits the tag id when a tag chip is clicked', async () => {
    const user = userEvent.setup();
    render(
      <FileInspectorPanel {...panelProps} file={{ ...sliceable, tags: [{ id: 7, name: 'toys' }] }} />,
    );

    await user.click(screen.getByRole('button', { name: /toys/ }));
    expect(handlers.onTagClick).toHaveBeenCalledWith(7);
  });

  it('offers slice only for sliceable files, and queue only for sliced ones', () => {
    const { unmount } = render(<FileInspectorPanel {...panelProps} file={sliceable} />);
    expect(screen.getByRole('button', { name: t('fileManager.inspector.slicePrint') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('fileManager.inspector.addToQueue') })).not.toBeInTheDocument();
    unmount();

    render(<FileInspectorPanel {...panelProps} file={sliced} />);
    expect(screen.queryByRole('button', { name: t('fileManager.inspector.slicePrint') })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('fileManager.inspector.addToQueue') })).toBeInTheDocument();
  });

  it('hides slice when the slicer sidecar is not configured', () => {
    render(<FileInspectorPanel {...panelProps} file={sliceable} useSlicerApi={false} />);
    expect(screen.queryByRole('button', { name: t('fileManager.inspector.slicePrint') })).not.toBeInTheDocument();
  });

  it('emits the 3D preview when the file type supports it', async () => {
    const user = userEvent.setup();
    render(<FileInspectorPanel {...panelProps} file={sliceable} />);

    await user.click(screen.getByRole('button', { name: t('fileManager.inspector.preview3d') }));
    expect(handlers.onPreview3d).toHaveBeenCalledWith(sliceable);
  });
});

describe('FileInspectorPanel permission gating', () => {
  const file = makeFile({ id: 1, filename: 'Lighthouse.3mf', created_by_id: 5 });
  const sliced = makeFile({ id: 2, filename: 'Lighthouse.gcode.3mf', file_type: 'gcode.3mf' });

  /** Grant everything except the listed permissions — mirrors FileCard's checks. */
  const allow = (...denied: Permission[]) => (p: Permission) => !denied.includes(p);

  it('hides Slice without library:upload', () => {
    render(<FileInspectorPanel {...panelProps} file={file} hasPermission={allow('library:upload')} />);
    expect(screen.queryByRole('button', { name: t('fileManager.inspector.slicePrint') })).not.toBeInTheDocument();
    // The other actions are untouched.
    expect(screen.getByRole('button', { name: t('common.download') })).toBeInTheDocument();
  });

  it('hides Add to queue without queue:create', () => {
    render(<FileInspectorPanel {...panelProps} file={sliced} hasPermission={allow('queue:create')} />);
    expect(screen.queryByRole('button', { name: t('fileManager.inspector.addToQueue') })).not.toBeInTheDocument();
  });

  it('hides Download and the 3D preview without library:read', () => {
    render(<FileInspectorPanel {...panelProps} file={file} hasPermission={allow('library:read')} />);
    expect(screen.queryByRole('button', { name: t('common.download') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('fileManager.inspector.preview3d') })).not.toBeInTheDocument();
  });

  it('hides Rename when canModify denies library:update for this owner', () => {
    const canModify = vi.fn((_r: string, action: string) => action !== 'update');
    render(<FileInspectorPanel {...panelProps} file={file} canModify={canModify} />);

    expect(screen.queryByRole('button', { name: t('common.rename') })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('common.delete') })).toBeInTheDocument();
    // The owner id is what FileCard passes, so the same rule applies here.
    expect(canModify).toHaveBeenCalledWith('library', 'update', 5);
  });

  it('hides Delete when canModify denies library:delete for this owner', () => {
    const canModify = vi.fn((_r: string, action: string) => action !== 'delete');
    render(<FileInspectorPanel {...panelProps} file={file} canModify={canModify} />);

    expect(screen.queryByRole('button', { name: t('common.delete') })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('common.rename') })).toBeInTheDocument();
    expect(canModify).toHaveBeenCalledWith('library', 'delete', 5);
  });

  it('leaves a read-only user with no destructive actions at all', async () => {
    const user = userEvent.setup();
    render(
      <FileInspectorPanel
        {...panelProps}
        file={file}
        hasPermission={(p) => p === 'library:read'}
        canModify={() => false}
      />,
    );

    expect(screen.queryByRole('button', { name: t('fileManager.inspector.slicePrint') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('fileManager.inspector.addToQueue') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('common.rename') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('common.delete') })).not.toBeInTheDocument();
    // Download stays: library:read is all it needs.
    await user.click(screen.getByRole('button', { name: t('common.download') }));
    expect(handlers.onDownload).toHaveBeenCalledWith(1);
  });
});
