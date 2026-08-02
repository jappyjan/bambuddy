/**
 * File Manager header toolbar (#33 / #36).
 *
 * Page title and subtitle plus the row of page-level actions: view-mode
 * toggle, batch thumbnail generation, link-external-folder, new folder,
 * manage tags, purge, trash and upload.
 *
 * Pure move out of `FileManagerPage.tsx` — the JSX below is byte-identical to
 * the region it came from. State ownership stays in the page: every value is
 * passed in, mutation objects included, so nothing here needed rewriting.
 */

import { Link } from 'react-router-dom';
import {
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  Image,
  LayoutGrid,
  List,
  Loader2,
  Tag as TagIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import type { Permission } from '../../api/client';
import { Button } from '../Button';
import type { TFunction } from '../../pages/FileManagerPage';

interface FileManagerToolbarProps {
  viewMode: 'grid' | 'list';
  handleViewModeChange: (mode: 'grid' | 'list') => void;
  // Threaded down as the mutation object rather than as an onClick + flag pair
  // so the moved JSX stays byte-identical to the original (#36).
  batchThumbnailMutation: { mutate: (variables?: void) => void; isPending: boolean };
  trashCount: number | undefined;
  setShowExternalFolderModal: (show: boolean) => void;
  setShowNewFolderModal: (show: boolean) => void;
  setShowTagsModal: (show: boolean) => void;
  setShowPurgeModal: (show: boolean) => void;
  setShowUploadModal: (show: boolean) => void;
  hasPermission: (permission: Permission) => boolean;
  hasAnyPermission: (...permissions: Permission[]) => boolean;
  t: TFunction;
}

export function FileManagerToolbar({
  viewMode,
  handleViewModeChange,
  batchThumbnailMutation,
  trashCount,
  setShowExternalFolderModal,
  setShowNewFolderModal,
  setShowTagsModal,
  setShowPurgeModal,
  setShowUploadModal,
  hasPermission,
  hasAnyPermission,
  t,
}: FileManagerToolbarProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <FolderOpen className="w-7 h-7 text-bambu-green" />
          {t('fileManager.title')}
        </h1>
        <p className="text-bambu-gray mt-1">
          {t('fileManager.subtitle')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {/* View mode toggle */}
        <div className="flex items-center bg-bambu-dark rounded-lg p-1">
          <button
            onClick={() => handleViewModeChange('grid')}
            className={`p-1.5 rounded transition-colors ${
              viewMode === 'grid' ? 'bg-bambu-dark-secondary text-white' : 'text-bambu-gray hover:text-white'
            }`}
            title={t('fileManager.gridView')}
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleViewModeChange('list')}
            className={`p-1.5 rounded transition-colors ${
              viewMode === 'list' ? 'bg-bambu-dark-secondary text-white' : 'text-bambu-gray hover:text-white'
            }`}
            title={t('fileManager.listView')}
          >
            <List className="w-4 h-4" />
          </button>
        </div>
        <Button
          variant="secondary"
          onClick={() => batchThumbnailMutation.mutate()}
          disabled={batchThumbnailMutation.isPending || !hasAnyPermission('library:update_own', 'library:update_all')}
          title={!hasAnyPermission('library:update_own', 'library:update_all') ? t('fileManager.noPermissionGenerateThumbnail') : t('fileManager.generateThumbnailsForMissing')}
        >
          {batchThumbnailMutation.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Image className="w-4 h-4 mr-2" />
          )}
          {t('fileManager.generateThumbnails')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setShowExternalFolderModal(true)}
          disabled={!hasPermission('library:upload')}
          title={!hasPermission('library:upload') ? t('fileManager.noPermissionCreateFolder') : t('fileManager.linkExternalFolder')}
        >
          <FolderSymlink className="w-4 h-4 mr-2" />
          {t('fileManager.linkExternal')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setShowNewFolderModal(true)}
          disabled={!hasPermission('library:upload')}
          title={!hasPermission('library:upload') ? t('fileManager.noPermissionCreateFolder') : undefined}
        >
          <FolderPlus className="w-4 h-4 mr-2" />
          {t('fileManager.newFolder')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setShowTagsModal(true)}
          title={t('fileManager.tags.manageTitle')}
        >
          <TagIcon className="w-4 h-4 mr-2" />
          {t('fileManager.tags.manage')}
        </Button>
        {hasPermission('library:purge') && (
          <Button
            variant="secondary"
            onClick={() => setShowPurgeModal(true)}
            title={t('libraryPurge.headerTooltip')}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            {t('libraryPurge.headerButton')}
          </Button>
        )}
        {(hasAnyPermission('library:delete_own', 'library:delete_all')) && (
          <Link
            to="/files/trash"
            className="inline-flex items-center px-3 py-1.5 text-sm rounded bg-bambu-dark-secondary text-bambu-gray hover:text-white hover:bg-bambu-dark transition-colors"
            title={t('libraryTrash.headerTooltip')}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            {t('libraryTrash.headerButton')}
            {typeof trashCount === 'number' && trashCount > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-bambu-green/20 text-bambu-green">
                {trashCount}
              </span>
            )}
          </Link>
        )}
        <Button
          onClick={() => setShowUploadModal(true)}
          disabled={!hasPermission('library:upload')}
          title={!hasPermission('library:upload') ? t('fileManager.noPermissionUpload') : undefined}
        >
          <Upload className="w-4 h-4 mr-2" />
          {t('common.upload')}
        </Button>
      </div>
    </div>
  );
}
