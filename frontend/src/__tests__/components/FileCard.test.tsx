/**
 * Tests for FileCard's grouped-slice display (slicer UX redesign, spec §7 step 2).
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FileCard } from '../../components/FileCard';
import type { LibraryFileListItem } from '../../api/client';
import i18n from '../../i18n';

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

function makeFile(overrides: Partial<LibraryFileListItem> & { id: number; filename: string }): LibraryFileListItem {
  return {
    folder_id: null,
    is_external: false,
    file_type: '3mf',
    file_size: 1024,
    thumbnail_path: null,
    print_count: 0,
    duplicate_count: 0,
    created_by_id: null,
    created_by_username: null,
    created_at: '2026-01-01T00:00:00Z',
    fs_modified_at: null,
    print_name: null,
    print_time_seconds: null,
    filament_used_grams: null,
    sliced_for_model: null,
    ...overrides,
  };
}

const cardProps = {
  selectedFiles: [] as number[],
  isMobile: false,
  onSelect: vi.fn(),
  onDelete: vi.fn(),
  onDownload: vi.fn(),
  hasPermission: () => true,
  canModify: () => true,
  authEnabled: false,
  showModified: false,
  t,
};

/** Order of every rendered card, read from the DOM. */
const cardOrder = () =>
  Array.from(document.querySelectorAll('[data-testid^="file-card-"]')).map(
    (el) => el.getAttribute('data-testid'),
  );

describe('FileCard grouped slices', () => {
  const child = makeFile({ id: 2, filename: 'Lighthouse.gcode.3mf', file_type: 'gcode.3mf' });
  const parent = makeFile({ id: 1, filename: 'Lighthouse.3mf', slice_count: 1, children: [child] });

  it('renders a parent collapsed, with its slice-count badge but no children', () => {
    render(<FileCard {...cardProps} file={parent} />);

    expect(screen.getByText('Lighthouse.3mf')).toBeInTheDocument();
    expect(screen.queryByText('Lighthouse.gcode.3mf')).not.toBeInTheDocument();
    // Chevron is present and reports the collapsed state.
    const toggle = screen.getByRole('button', { name: t('fileManager.sliceCount', { count: 1 }) });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('reveals the indented child with a SLICED badge when expanded', async () => {
    const user = userEvent.setup();
    render(<FileCard {...cardProps} file={parent} />);

    await user.click(screen.getByRole('button', { name: t('fileManager.sliceCount', { count: 1 }) }));

    expect(screen.getByText('Lighthouse.gcode.3mf')).toBeInTheDocument();
    expect(screen.getByText(t('fileManager.slicedBadge'))).toBeInTheDocument();
    // The child card is indented rather than rendered inside the parent card.
    const childCard = screen.getByTestId('file-card-2');
    expect(childCard.className).toContain('ml-3');
    expect(screen.getByTestId('file-card-1')).not.toContainElement(childCard);
  });

  it('keeps the badge on slice_count when a child is filtered out of the view', () => {
    // slice_count 3, but only one child came back in this result set.
    render(<FileCard {...cardProps} file={{ ...parent, slice_count: 3 }} />);
    expect(screen.getByTitle(t('fileManager.sliceCount', { count: 3 }))).toHaveTextContent('3');
  });

  it('renders a parentless sliced file as a normal top-level card', () => {
    // The common case — pre-existing rows have no `sliced_from_file_id` and
    // are not an error (spec §3: no backfill).
    render(<FileCard {...cardProps} file={makeFile({ id: 9, filename: 'Old.gcode.3mf', file_type: 'gcode.3mf' })} />);

    expect(screen.getByText('Old.gcode.3mf')).toBeInTheDocument();
    expect(screen.queryByText(t('fileManager.slicedBadge'))).not.toBeInTheDocument();
    expect(screen.getByTestId('file-card-9').className).not.toContain('ml-3');
    expect(screen.queryByRole('button', { name: /Sliced outputs/ })).not.toBeInTheDocument();
  });

  it('does not reorder the top-level cards across expand and collapse', async () => {
    const user = userEvent.setup();
    const siblings = [
      parent,
      makeFile({ id: 3, filename: 'Benchy.3mf' }),
      makeFile({ id: 4, filename: 'Calicat.3mf' }),
    ];
    render(
      <>
        {siblings.map((f) => (
          <FileCard key={f.id} {...cardProps} file={f} />
        ))}
      </>,
    );

    const collapsed = cardOrder();
    expect(collapsed).toEqual(['file-card-1', 'file-card-3', 'file-card-4']);

    const toggle = screen.getByRole('button', { name: t('fileManager.sliceCount', { count: 1 }) });
    await user.click(toggle);
    // The child is inserted directly after its parent; nothing else moves.
    expect(cardOrder()).toEqual(['file-card-1', 'file-card-2', 'file-card-3', 'file-card-4']);

    await user.click(toggle);
    expect(cardOrder()).toEqual(collapsed);
  });
});
