/**
 * Grid card for a library file.
 *
 * Extracted out of `FileManagerPage.tsx` (2,776 lines) so the grouped-slice
 * display of the slicer UX redesign (spec §7 step 2) has somewhere to live
 * without growing that page further.
 *
 * Grouping: with `?group=nested` the listing hands back sliced outputs inside
 * their source file's `children` instead of beside it. A card whose source has
 * children gets an expand chevron; the children render as siblings in the same
 * grid, indented, immediately after the parent. Expand/collapse is local state
 * only — the server order of the top-level cards never changes.
 */

import { useState } from 'react';
import {
  Box,
  CalendarClock,
  ChevronRight,
  Clock,
  Cog,
  Download,
  FileBox,
  Image,
  Layers,
  MoreVertical,
  Pencil,
  Play,
  Printer,
  Tag as TagIcon,
  Trash2,
  User,
} from 'lucide-react';
import { api } from '../api/client';
import type { LibraryFileListItem, Permission } from '../api/client';
import { formatDuration, formatDate } from '../utils/date';
import { formatFileSize, isSlicedFilename, isSliceableFilename } from '../utils/file';

type TFunction = (key: string, options?: Record<string, unknown>) => string;

export interface FileCardProps {
  file: LibraryFileListItem;
  /** Ids of every currently selected file — children need their own lookup. */
  selectedFiles: number[];
  isMobile: boolean;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
  onDownload: (id: number) => void;
  onPrint?: (file: LibraryFileListItem) => void;
  onSlice?: (file: LibraryFileListItem) => void;
  onRunPipeline?: (file: LibraryFileListItem) => void;
  useSlicerApi?: boolean;
  onPreview3d?: (file: LibraryFileListItem) => void;
  onRename?: (file: LibraryFileListItem) => void;
  onGenerateThumbnail?: (file: LibraryFileListItem) => void;
  onTagClick?: (tagId: number) => void;
  thumbnailVersions?: Record<number, number>;
  hasPermission: (permission: Permission) => boolean;
  canModify: (resource: 'queue' | 'archives' | 'library', action: 'update' | 'delete' | 'reprint', createdById: number | null | undefined) => boolean;
  authEnabled: boolean;
  showModified: boolean;
  t: TFunction;
  /** Set on the nested slice rows the parent renders. One level only. */
  isChild?: boolean;
}

export function FileCard(props: FileCardProps) {
  const {
    file, selectedFiles, isMobile, onSelect, onDelete, onDownload, onPrint, onSlice,
    onRunPipeline, useSlicerApi, onPreview3d, onRename, onGenerateThumbnail, onTagClick,
    thumbnailVersions, hasPermission, canModify, authEnabled, showModified, t, isChild = false,
  } = props;
  const [showActions, setShowActions] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const isSelected = selectedFiles.includes(file.id);
  const thumbnailVersion = thumbnailVersions?.[file.id];
  // Badge count comes from `slice_count`, not `children.length`: a slice can be
  // filtered out of the current view while still existing (contract rule 6).
  const sliceCount = file.slice_count ?? 0;
  // Nesting is one level deep, so a child never expands further.
  const children = isChild ? [] : (file.children ?? []);

  return (
    <>
    <div
      data-testid={`file-card-${file.id}`}
      className={`group relative bg-bambu-dark-secondary rounded-lg border transition-all cursor-pointer overflow-hidden ${
        isSelected
          ? 'border-bambu-green ring-1 ring-bambu-green'
          : 'border-bambu-dark-tertiary hover:border-bambu-green/50'
      } ${isChild ? 'ml-3 border-l-2 border-l-blue-400' : ''}`}
      onClick={() => onSelect(file.id)}
    >
      {/* Thumbnail */}
      <div className="aspect-square bg-bambu-dark flex items-center justify-center overflow-hidden">
        {file.thumbnail_path ? (
          <img
            src={`${api.getLibraryFileThumbnailUrl(file.id)}${thumbnailVersion ? ((api.getLibraryFileThumbnailUrl(file.id).includes('?') ? '&' : '?') + `v=${thumbnailVersion}`) : ''}`}
            alt={file.filename}
            className="w-full h-full object-cover"
          />
        ) : (
          <FileBox className="w-12 h-12 text-bambu-gray/30" />
        )}
        {/* File type badge */}
        <div className={`absolute top-2 right-2 text-xs px-1.5 py-0.5 rounded font-medium ${
          file.file_type === '3mf' ? 'bg-bambu-green/90 text-white'
          // Sliced output — share the gcode blue so users see at a glance
          // that the file is already sliced and ready to print (#1543).
          : file.file_type === 'gcode' || file.file_type === 'gcode.3mf' ? 'bg-blue-500/90 text-white'
          : file.file_type === 'stl' ? 'bg-purple-500/90 text-white'
          : 'bg-bambu-gray/90 text-white'
        }`}>
          {file.file_type.toUpperCase()}
        </div>
      </div>

      {/* Info */}
      <div className="p-3">
        <div className="flex items-center gap-1 min-w-0">
          {children.length > 0 && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={t('fileManager.sliceCount', { count: sliceCount })}
              onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
              className="flex-shrink-0 -ml-1 p-0.5 rounded text-bambu-gray hover:text-white"
            >
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
            </button>
          )}
          <h3 className="text-sm font-medium text-white truncate" title={file.print_name || file.filename}>
            {file.print_name || file.filename}
          </h3>
          {isChild && (
            <span className="flex-shrink-0 text-[10px] px-1 rounded bg-bambu-green/20 text-bambu-green font-medium">
              {t('fileManager.slicedBadge')}
            </span>
          )}
          {!isChild && sliceCount > 0 && (
            <span
              className="flex-shrink-0 inline-flex items-center gap-0.5 text-[10px] px-1 rounded bg-bambu-green/10 text-bambu-green"
              title={t('fileManager.sliceCount', { count: sliceCount })}
            >
              <Layers className="w-2.5 h-2.5" />
              {sliceCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-bambu-gray">
          <span>{formatFileSize(file.file_size)}</span>
          {file.print_time_seconds && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDuration(file.print_time_seconds)}
            </span>
          )}
        </div>
        {file.sliced_for_model && (
          <div className="mt-1 text-xs text-bambu-gray flex items-center gap-1">
            <Printer className="w-3 h-3" />
            {file.sliced_for_model}
          </div>
        )}
        {file.print_count > 0 && (
          <div className="mt-1 text-xs text-bambu-green">
            {t('fileManager.printedCount', { count: file.print_count })}
          </div>
        )}
        {authEnabled && file.created_by_username && (
          <div className="mt-1 text-xs text-bambu-gray flex items-center gap-1">
            <User className="w-3 h-3" />
            {file.created_by_username}
          </div>
        )}
        {/* #2680: last-modified date, toggled from the toolbar. Uses the real
            on-disk mtime when known, else the DB created_at. */}
        {showModified && (
          <div className="mt-1 text-xs text-bambu-gray flex items-center gap-1" title={t('fileManager.lastModified')}>
            <CalendarClock className="w-3 h-3" />
            {formatDate(file.fs_modified_at ?? file.created_at)}
          </div>
        )}
        {(file.tags?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
            {file.tags!.map((tg) => (
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
            ))}
          </div>
        )}
      </div>

      {/* Actions - always visible on mobile, hover on desktop */}
      <div className={`absolute bottom-2 right-2 transition-opacity ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => setShowActions(!showActions)}
          className="p-1.5 rounded bg-bambu-dark-secondary/90 hover:bg-bambu-dark-tertiary"
        >
          <MoreVertical className="w-4 h-4 text-bambu-gray" />
        </button>
        {showActions && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowActions(false)} />
            <div className="absolute right-0 bottom-8 z-20 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl py-1 min-w-[140px]">
              {onPrint && isSlicedFilename(file.filename) && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    hasPermission('queue:create') ? 'text-bambu-green hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (hasPermission('queue:create')) { onPrint(file); setShowActions(false); } }}
                  disabled={!hasPermission('queue:create')}
                  title={!hasPermission('queue:create') ? t('fileManager.noPermissionAddToQueue') : undefined}
                >
                  <Printer className="w-3.5 h-3.5" />
                  {t('common.print')}
                </button>
              )}
              {onSlice && useSlicerApi && isSliceableFilename(file.filename) && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    hasPermission('library:upload') ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (hasPermission('library:upload')) { onSlice(file); setShowActions(false); } }}
                  disabled={!hasPermission('library:upload')}
                  title={!hasPermission('library:upload') ? t('fileManager.noPermissionSlice') : undefined}
                >
                  <Cog className="w-3.5 h-3.5" />
                  {t('slice.action')}
                </button>
              )}
              {onRunPipeline && useSlicerApi && isSliceableFilename(file.filename) && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    hasPermission('pipelines:run') ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (hasPermission('pipelines:run')) { onRunPipeline(file); setShowActions(false); } }}
                  disabled={!hasPermission('pipelines:run')}
                  title={!hasPermission('pipelines:run') ? t('library.runWithPipeline.noPermission') : undefined}
                >
                  <Play className="w-3.5 h-3.5" />
                  {t('library.runWithPipeline.actionLabel')}
                </button>
              )}
              {onPreview3d && (file.file_type === '3mf' || file.file_type === 'gcode' || file.file_type === 'stl' || file.file_type === 'gcode.3mf') && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    hasPermission('library:read') ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (hasPermission('library:read')) { onPreview3d(file); setShowActions(false); } }}
                  disabled={!hasPermission('library:read')}
                  title={!hasPermission('library:read') ? 'You do not have permission to preview files' : undefined}
                >
                  <Box className="w-3.5 h-3.5" />
                  3D Preview
                </button>
              )}
              <button
                className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                  hasPermission('library:read') ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                }`}
                onClick={() => { if (hasPermission('library:read')) { onDownload(file.id); setShowActions(false); } }}
                disabled={!hasPermission('library:read')}
                title={!hasPermission('library:read') ? t('fileManager.noPermissionDownload') : undefined}
              >
                <Download className="w-3.5 h-3.5" />
                {t('common.download')}
              </button>
              {onRename && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    canModify('library', 'update', file.created_by_id) ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (canModify('library', 'update', file.created_by_id)) { onRename(file); setShowActions(false); } }}
                  disabled={!canModify('library', 'update', file.created_by_id)}
                  title={!canModify('library', 'update', file.created_by_id) ? t('fileManager.noPermissionRenameFile') : undefined}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  {t('common.rename')}
                </button>
              )}
              {onGenerateThumbnail && file.file_type === 'stl' && (
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    canModify('library', 'update', file.created_by_id) ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (canModify('library', 'update', file.created_by_id)) { onGenerateThumbnail(file); setShowActions(false); } }}
                  disabled={!canModify('library', 'update', file.created_by_id)}
                  title={!canModify('library', 'update', file.created_by_id) ? t('fileManager.noPermissionGenerateThumbnail') : undefined}
                >
                  <Image className="w-3.5 h-3.5" />
                  {t('fileManager.generateThumbnail')}
                </button>
              )}
              <button
                className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                  canModify('library', 'delete', file.created_by_id) ? 'text-red-700 dark:text-red-400 hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                }`}
                onClick={() => { if (canModify('library', 'delete', file.created_by_id)) { onDelete(file.id); setShowActions(false); } }}
                disabled={!canModify('library', 'delete', file.created_by_id)}
                title={!canModify('library', 'delete', file.created_by_id) ? t('fileManager.noPermissionDeleteFile') : undefined}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {t('common.delete')}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Selection checkbox - always visible on mobile, hover on desktop */}
      <div className={`absolute top-2 left-2 w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
        isSelected
          ? 'bg-bambu-green border-bambu-green'
          : `border-white/30 bg-black/30 ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`
      }`}>
        {isSelected && <div className="w-2 h-2 bg-white rounded-sm" />}
      </div>
    </div>
    {/* Children are siblings in the same grid, so the parent's own tile keeps
        its size and the top-level cards keep their order when this expands. */}
    {expanded && children.map((child) => (
      <FileCard key={child.id} {...props} file={child} isChild />
    ))}
    </>
  );
}
