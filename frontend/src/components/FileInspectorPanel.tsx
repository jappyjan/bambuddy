/**
 * Inspector for a single library file (slicer UX redesign, spec §7 step 3 —
 * mockup screen 1, option A: the right-hand panel).
 *
 * Presentation only. It renders whatever file it is handed and emits actions;
 * it owns no file state, fetches nothing, and knows nothing about where it is
 * mounted. That is what lets the desktop panel and the mobile bottom sheet
 * mount the *same* component — the only thing they vary is `className`.
 *
 * Because the caller re-renders it with a different `file` rather than
 * remounting it, clicking through the grid updates the panel in place.
 * A nested sliced child is just another `LibraryFileListItem`, so it renders
 * exactly like a parent does.
 *
 * Metadata the list endpoint does not carry (`dimensions`, `plateCount`) comes
 * in as optional props; each row is simply omitted when the caller has nothing
 * to give it.
 *
 * Action gating is copied from `FileCard.tsx` — same permissions, same
 * `canModify` calls, same eligibility predicates. The one presentational
 * difference: the card disables an unavailable action and explains it in a
 * tooltip, whereas a full-width action stack reads better with unavailable
 * actions left out, so this panel omits them.
 */

import {
  Box,
  CalendarClock,
  Clock,
  Cog,
  Download,
  FileBox,
  Layers,
  Pencil,
  Printer,
  Ruler,
  Tag as TagIcon,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import type { LibraryFileListItem, Permission } from '../api/client';
import { formatDuration, formatDate } from '../utils/date';
import { formatFileSize, isSlicedFilename, isSliceableFilename } from '../utils/file';

type TFunction = (key: string, options?: Record<string, unknown>) => string;

/** Model bounding box in millimetres. */
export interface FileDimensions {
  x: number;
  y: number;
  z: number;
}

export interface FileInspectorPanelProps {
  /** The file to inspect. May be a top-level file or a nested sliced child. */
  file: LibraryFileListItem;
  /** Bounding box in mm, when the caller knows it. Row hidden when absent. */
  dimensions?: FileDimensions | null;
  /** Plates in the file. Row hidden when absent. */
  plateCount?: number | null;
  onClose: () => void;
  /** "Add to queue". Same eligibility as FileCard's Print action. */
  onPrint?: (file: LibraryFileListItem) => void;
  /** "Slice & Print". Consumer opens SliceModal (later: the slicer page). */
  onSlice?: (file: LibraryFileListItem) => void;
  /** Slicer sidecar configured — gates the slice action, as in FileCard. */
  useSlicerApi?: boolean;
  onDownload: (id: number) => void;
  onRename?: (file: LibraryFileListItem) => void;
  onDelete: (id: number) => void;
  onPreview3d?: (file: LibraryFileListItem) => void;
  onTagClick?: (tagId: number) => void;
  /** Cache-busting counters keyed by file id, as passed to FileCard. */
  thumbnailVersions?: Record<number, number>;
  hasPermission: (permission: Permission) => boolean;
  canModify: (
    resource: 'queue' | 'archives' | 'library',
    action: 'update' | 'delete' | 'reprint',
    createdById: number | null | undefined,
  ) => boolean;
  t: TFunction;
  /** Layout hook for the mount point (desktop rail vs mobile bottom sheet). */
  className?: string;
}

const PREVIEWABLE_TYPES = ['3mf', 'gcode', 'stl', 'gcode.3mf'];

export function FileInspectorPanel({
  file,
  dimensions,
  plateCount,
  onClose,
  onPrint,
  onSlice,
  useSlicerApi,
  onDownload,
  onRename,
  onDelete,
  onPreview3d,
  onTagClick,
  thumbnailVersions,
  hasPermission,
  canModify,
  t,
  className = '',
}: FileInspectorPanelProps) {
  const thumbnailVersion = thumbnailVersions?.[file.id];
  const thumbnailUrl = file.thumbnail_path
    ? `${api.getLibraryFileThumbnailUrl(file.id)}${
        thumbnailVersion
          ? (api.getLibraryFileThumbnailUrl(file.id).includes('?') ? '&' : '?') + `v=${thumbnailVersion}`
          : ''
      }`
    : null;

  // Gating, mirrored from FileCard.tsx.
  const canSlice = Boolean(onSlice) && Boolean(useSlicerApi)
    && isSliceableFilename(file.filename) && hasPermission('library:upload');
  const canQueue = Boolean(onPrint) && isSlicedFilename(file.filename) && hasPermission('queue:create');
  const canDownload = hasPermission('library:read');
  const canRename = Boolean(onRename) && canModify('library', 'update', file.created_by_id);
  const canDelete = canModify('library', 'delete', file.created_by_id);
  const canPreview3d = Boolean(onPreview3d)
    && PREVIEWABLE_TYPES.includes(file.file_type) && hasPermission('library:read');

  const tags = file.tags ?? [];

  return (
    <aside
      data-testid="file-inspector-panel"
      aria-label={file.print_name || file.filename}
      className={`bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg flex flex-col overflow-y-auto ${className}`}
    >
      <div className="flex items-start gap-2 p-3 border-b border-bambu-dark-tertiary">
        <h2 className="flex-1 min-w-0 text-sm font-medium text-white truncate" title={file.print_name || file.filename}>
          {file.print_name || file.filename}
        </h2>
        {isSlicedFilename(file.filename) && (
          <span className="flex-shrink-0 text-[10px] px-1 rounded bg-bambu-green/20 text-bambu-green font-medium">
            {t('fileManager.slicedBadge')}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="flex-shrink-0 p-1 rounded text-bambu-gray hover:text-white hover:bg-bambu-dark"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Preview: the 3D preview where the file supports it, else the thumbnail. */}
      <div className="relative aspect-square bg-bambu-dark flex items-center justify-center overflow-hidden">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt={file.filename} className="w-full h-full object-cover" />
        ) : (
          <FileBox className="w-16 h-16 text-bambu-gray/30" />
        )}
        {canPreview3d && (
          <button
            type="button"
            onClick={() => onPreview3d!(file)}
            className="absolute bottom-2 right-2 inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-bambu-dark-secondary/90 text-white hover:bg-bambu-dark-tertiary"
          >
            <Box className="w-3.5 h-3.5" />
            {t('fileManager.inspector.preview3d')}
          </button>
        )}
      </div>

      {/* Metadata */}
      <dl className="p-3 space-y-1.5 text-xs text-bambu-gray">
        {dimensions && (
          <div data-testid="inspector-dimensions" className="flex items-center gap-1.5">
            <Ruler className="w-3.5 h-3.5 flex-shrink-0" />
            <dt className="sr-only">{t('fileManager.inspector.dimensions')}</dt>
            <dd>{`${dimensions.x} × ${dimensions.y} × ${dimensions.z} mm`}</dd>
          </div>
        )}
        <div data-testid="inspector-size" className="flex items-center gap-1.5">
          <FileBox className="w-3.5 h-3.5 flex-shrink-0" />
          <dt className="sr-only">{t('fileManager.size')}</dt>
          <dd>{formatFileSize(file.file_size)}</dd>
        </div>
        {typeof plateCount === 'number' && (
          <div data-testid="inspector-plates" className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 flex-shrink-0" />
            <dt className="sr-only">{t('modelViewer.plates')}</dt>
            <dd>{t('modelViewer.plateCount', { count: plateCount })}</dd>
          </div>
        )}
        <div data-testid="inspector-uploaded" className="flex items-center gap-1.5">
          <CalendarClock className="w-3.5 h-3.5 flex-shrink-0" />
          <dt className="sr-only">{t('common.date')}</dt>
          <dd>{t('fileManager.inspector.uploaded', { date: formatDate(file.created_at) })}</dd>
        </div>
        <div data-testid="inspector-prints" className="flex items-center gap-1.5">
          <Printer className="w-3.5 h-3.5 flex-shrink-0" />
          <dt className="sr-only">{t('common.prints')}</dt>
          <dd className={file.print_count > 0 ? 'text-bambu-green' : undefined}>
            {t('fileManager.printedCount', { count: file.print_count })}
          </dd>
        </div>
        {file.print_time_seconds != null && (
          <div data-testid="inspector-print-time" className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 flex-shrink-0" />
            <dt className="sr-only">{t('common.time')}</dt>
            <dd>{formatDuration(file.print_time_seconds)}</dd>
          </div>
        )}
        <div data-testid="inspector-tags" className="flex items-start gap-1.5">
          <TagIcon className="w-3.5 h-3.5 flex-shrink-0" />
          <dt className="sr-only">{t('fileManager.tags.title')}</dt>
          <dd className="flex flex-wrap gap-1">
            {tags.length === 0 ? (
              <span>{t('common.none')}</span>
            ) : (
              tags.map((tg) => (
                <button
                  key={tg.id}
                  type="button"
                  onClick={() => onTagClick?.(tg.id)}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-bambu-green/10 text-bambu-green hover:bg-bambu-green/20 transition-colors max-w-full"
                  title={tg.name}
                >
                  <TagIcon className="w-2.5 h-2.5 flex-shrink-0" />
                  <span className="truncate">{tg.name}</span>
                </button>
              ))
            )}
          </dd>
        </div>
      </dl>

      {/* Action stack */}
      <div className="mt-auto p-3 pt-0 flex flex-col gap-1.5">
        {canSlice && (
          <button
            type="button"
            onClick={() => onSlice!(file)}
            className="w-full px-3 py-2 rounded text-sm font-medium flex items-center justify-center gap-2 bg-bambu-green text-white hover:bg-bambu-green/80"
          >
            <Cog className="w-4 h-4" />
            {t('fileManager.inspector.slicePrint')}
          </button>
        )}
        {canQueue && (
          <button
            type="button"
            onClick={() => onPrint!(file)}
            className="w-full px-3 py-2 rounded text-sm flex items-center justify-center gap-2 bg-bambu-dark text-white hover:bg-bambu-dark-tertiary"
          >
            <Printer className="w-4 h-4" />
            {t('fileManager.inspector.addToQueue')}
          </button>
        )}
        {canDownload && (
          <button
            type="button"
            onClick={() => onDownload(file.id)}
            className="w-full px-3 py-2 rounded text-sm flex items-center justify-center gap-2 bg-bambu-dark text-white hover:bg-bambu-dark-tertiary"
          >
            <Download className="w-4 h-4" />
            {t('common.download')}
          </button>
        )}
        {canRename && (
          <button
            type="button"
            onClick={() => onRename!(file)}
            className="w-full px-3 py-2 rounded text-sm flex items-center justify-center gap-2 bg-bambu-dark text-white hover:bg-bambu-dark-tertiary"
          >
            <Pencil className="w-4 h-4" />
            {t('common.rename')}
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={() => onDelete(file.id)}
            className="w-full px-3 py-2 rounded text-sm flex items-center justify-center gap-2 bg-bambu-dark text-red-700 dark:text-red-400 hover:bg-bambu-dark-tertiary"
          >
            <Trash2 className="w-4 h-4" />
            {t('common.delete')}
          </button>
        )}
      </div>
    </aside>
  );
}
