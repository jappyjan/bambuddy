/**
 * File Manager files column (#33 / #36).
 *
 * Everything between the folder sidebar and the inspector rail: the tag filter
 * chips, the external-folder info bar, the search / filter / sort toolbar, the
 * bulk-selection toolbar, and the grid or list body itself — including the
 * nested-children rendering from `?group=nested` (#6), the two empty states
 * and the loading state.
 *
 * What is deliberately NOT here: `FileInspectorPanel`. It is a sibling of this
 * component inside the same flex row in `FileManagerPage`, mounted once and
 * unkeyed, so clicking another file re-renders it in place instead of
 * remounting it (#27). Moving it inside this component would tie its lifetime
 * to the grid. The grid only *reads* the selection, via `inspectedFile`, to
 * drop its column count while the panel is docked.
 *
 * Pure move out of `FileManagerPage.tsx` — the JSX below is byte-identical to
 * the region it came from. State ownership stays in the page: every value is
 * passed in, mutation objects and `navigate` included, so nothing here needed
 * rewriting.
 */

import type { NavigateFunction } from 'react-router-dom';
import {
  Box,
  CalendarClock,
  CheckSquare,
  Cog,
  Download,
  FileBox,
  Filter,
  FolderSymlink,
  Image,
  Loader2,
  Lock,
  MoveRight,
  Pencil,
  Play,
  Plus,
  Printer,
  RefreshCw,
  Search,
  SortAsc,
  SortDesc,
  Square,
  Tag as TagIcon,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { api } from '../../api/client';
import type {
  AppSettings,
  LibraryFileListItem,
  LibraryFolderTree,
  LibraryTag,
  Permission,
  UserResponse,
} from '../../api/client';
import { Button } from '../Button';
import { FileCard } from '../FileCard';
import { formatDate } from '../../utils/date';
import { formatFileSize, isSlicedFilename, isSliceableFilename } from '../../utils/file';
import type { SortDirection, SortField, TFunction } from '../../pages/FileManagerPage';

interface FileGridProps {
  // Tag filter rail
  tagCatalog: LibraryTag[];
  selectedTagIds: number[];
  setSelectedTagIds: (ids: number[]) => void;
  toggleTagFilter: (tagId: number) => void;
  // External folder info bar
  selectedFolder: LibraryFolderTree | null;
  selectedFolderId: number | null;
  scanExternalFolderMutation: { mutate: (folderId: number) => void; isPending: boolean };
  // Search / filter / sort toolbar
  files: LibraryFileListItem[] | undefined;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchExpandsSubfolders: boolean;
  filterType: string;
  setFilterType: (type: string) => void;
  fileTypes: string[];
  filterUsername: string;
  setFilterUsername: (username: string) => void;
  users: UserResponse[] | undefined;
  sortField: SortField;
  setSortField: (field: SortField) => void;
  sortDirection: SortDirection;
  setSortDirection: React.Dispatch<React.SetStateAction<SortDirection>>;
  showModified: boolean;
  setShowModified: React.Dispatch<React.SetStateAction<boolean>>;
  filteredAndSortedFiles: LibraryFileListItem[];
  // Selection toolbar
  selectedFiles: number[];
  flatFiles: LibraryFileListItem[];
  selectedSlicedFiles: LibraryFileListItem[];
  handleSelectAll: () => void;
  handleDeselectAll: () => void;
  setShowMoveModal: (show: boolean) => void;
  setShowBulkTagsModal: (show: boolean) => void;
  // Grid / list body
  isLoading: boolean;
  topLevelView: 'internal' | 'external';
  setShowUploadModal: (show: boolean) => void;
  viewMode: 'grid' | 'list';
  // Read-only view of the inspector selection: the grid narrows its columns
  // while the panel is docked. The panel itself is mounted by the page.
  inspectedFile: LibraryFileListItem | null;
  isMobile: boolean;
  handleFileSelect: (id: number) => void;
  handleDownload: (id: number) => void;
  setPrintFile: (file: LibraryFileListItem) => void;
  setSliceFile: (file: LibraryFileListItem) => void;
  setRunPipelineFile: (file: LibraryFileListItem) => void;
  setViewerFile: (file: LibraryFileListItem) => void;
  setRenameItem: (item: { type: 'file' | 'folder'; id: number; name: string }) => void;
  setDeleteConfirm: (confirm: { type: 'file' | 'folder' | 'bulk'; id: number; count?: number }) => void;
  singleThumbnailMutation: { mutate: (fileId: number) => void; isPending: boolean };
  thumbnailVersions: Record<number, number>;
  settings: AppSettings | undefined;
  navigate: NavigateFunction;
  hasPermission: (permission: Permission) => boolean;
  hasAnyPermission: (...permissions: Permission[]) => boolean;
  canModify: (
    resource: 'queue' | 'archives' | 'library',
    action: 'update' | 'delete' | 'reprint',
    createdById: number | null | undefined,
  ) => boolean;
  authEnabled: boolean;
  // The list-view "run with pipeline" button uses i18next's `t(key, default)`
  // string-default overload, which the page-level `TFunction` alias does not
  // describe. Widened here rather than rewriting the call — #36 is a pure move.
  t: TFunction & ((key: string, defaultValue: string) => string);
}

export function FileGrid({
  tagCatalog,
  selectedTagIds,
  setSelectedTagIds,
  toggleTagFilter,
  selectedFolder,
  selectedFolderId,
  scanExternalFolderMutation,
  files,
  searchQuery,
  setSearchQuery,
  searchExpandsSubfolders,
  filterType,
  setFilterType,
  fileTypes,
  filterUsername,
  setFilterUsername,
  users,
  sortField,
  setSortField,
  sortDirection,
  setSortDirection,
  showModified,
  setShowModified,
  filteredAndSortedFiles,
  selectedFiles,
  flatFiles,
  selectedSlicedFiles,
  handleSelectAll,
  handleDeselectAll,
  setShowMoveModal,
  setShowBulkTagsModal,
  isLoading,
  topLevelView,
  setShowUploadModal,
  viewMode,
  inspectedFile,
  isMobile,
  handleFileSelect,
  handleDownload,
  setPrintFile,
  setSliceFile,
  setRunPipelineFile,
  setViewerFile,
  setRenameItem,
  setDeleteConfirm,
  singleThumbnailMutation,
  thumbnailVersions,
  settings,
  navigate,
  hasPermission,
  hasAnyPermission,
  canModify,
  authEnabled,
  t,
}: FileGridProps) {
  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Tag filter rail (#1268). Lists every catalog tag as a togglable
          chip — active chips are filled green and show an X, inactive
          chips are outlined and toggle ON when clicked. Clicking an active
          chip removes it from the filter. Hidden entirely when the
          catalog is empty so brand-new installs don't see a stray rail. */}
      {tagCatalog.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 p-2 sm:p-3 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary">
          <span className="text-xs text-bambu-gray font-medium shrink-0">
            {t('fileManager.tags.filterLabel')}
          </span>
          {tagCatalog.map((tg) => {
            const active = selectedTagIds.includes(tg.id);
            return (
              <button
                key={tg.id}
                type="button"
                onClick={() => toggleTagFilter(tg.id)}
                className={
                  active
                    ? 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-bambu-green/20 text-bambu-green border border-bambu-green/40 hover:bg-bambu-green/30 transition-colors'
                    : 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-bambu-dark text-bambu-gray border border-bambu-dark-tertiary hover:text-white hover:border-bambu-green/40 transition-colors'
                }
                title={tg.name}
              >
                <TagIcon className="w-3 h-3" />
                <span>{tg.name}</span>
                {active && <X className="w-3 h-3" />}
              </button>
            );
          })}
          {selectedTagIds.length > 0 && (
            <button
              type="button"
              onClick={() => setSelectedTagIds([])}
              className="ml-auto text-xs text-bambu-gray hover:text-white shrink-0"
            >
              {t('fileManager.tags.clearAll')}
            </button>
          )}
        </div>
      )}
      {/* External folder info bar */}
      {selectedFolder?.is_external && (
        <div className="flex items-center gap-3 mb-4 p-3 bg-purple-50 dark:bg-purple-500/10 border border-purple-300 dark:border-purple-500/30 rounded-lg">
          <FolderSymlink className="w-5 h-5 text-purple-600 dark:text-purple-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-purple-700 dark:text-purple-300">{t('fileManager.externalFolder')}</span>
              {selectedFolder.external_readonly && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 flex items-center gap-1">
                  <Lock className="w-3 h-3" />
                  {t('fileManager.readOnly')}
                </span>
              )}
            </div>
            <p className="text-xs text-bambu-gray truncate font-mono" title={selectedFolder.external_path || ''}>
              {selectedFolder.external_path}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => selectedFolderId && scanExternalFolderMutation.mutate(selectedFolderId)}
            disabled={scanExternalFolderMutation.isPending}
            title={t('fileManager.scanFolder')}
          >
            {scanExternalFolderMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            <span className="ml-1.5">{t('fileManager.scanFolder')}</span>
          </Button>
        </div>
      )}
      {/* Search, Filter, Sort toolbar - sticky on mobile for easier access */}
      {files && files.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4 p-2 sm:p-3 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary sticky top-0 z-10 lg:static">
          {/* Search */}
          <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray" />
            <input
              type="text"
              placeholder={t('fileManager.searchFiles')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded text-sm text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
            />
            {searchExpandsSubfolders && (
              <span
                className="absolute -bottom-4 left-0 text-[10px] text-bambu-gray whitespace-nowrap"
                title={t('fileManager.searchSubfoldersHint')}
              >
                {t('fileManager.searchSubfoldersHint')}
              </span>
            )}
          </div>

          {/* Type filter */}
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-bambu-gray hidden sm:block" />
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-bambu-green"
            >
              <option value="all">{t('fileManager.allTypes')}</option>
              {fileTypes.map((type) => (
                <option key={type} value={type}>
                  {type.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          {/* Username filter with autocomplete - only show when auth is enabled */}
          {authEnabled && (
            <div className="relative">
              <input
                type="text"
                placeholder={t('fileManager.filterByUser', { defaultValue: 'Filter by user' })}
                value={filterUsername}
                onChange={(e) => setFilterUsername(e.target.value)}
                list="usernames-list"
                className={`w-32 sm:w-40 px-2 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded text-sm text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green ${filterUsername ? 'pr-7' : ''}`}
                style={filterUsername ? { WebkitAppearance: 'none', MozAppearance: 'textfield' } : undefined}
              />
              {filterUsername && (
                <button
                  onClick={() => setFilterUsername('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-bambu-gray hover:text-white z-10"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
              <datalist id="usernames-list">
                {users?.map((user) => (
                  <option key={user.id} value={user.username} />
                ))}
              </datalist>
            </div>
          )}

          {/* Sort */}
          <div className="flex items-center gap-2">
            <select
              value={sortField}
              onChange={(e) => {
                const newField = e.target.value as SortField;
                setSortField(newField);
                localStorage.setItem('library-sort-field', newField);
              }}
              className="bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-bambu-green"
            >
              <option value="name">{t('common.name')}</option>
              <option value="date">{t('common.date')}</option>
              <option value="size">{t('fileManager.size')}</option>
              <option value="type">{t('common.type')}</option>
              <option value="prints">{t('fileManager.prints')}</option>
            </select>
            <button
              onClick={() => setSortDirection((d) => {
                const newDir = d === 'asc' ? 'desc' : 'asc';
                localStorage.setItem('library-sort-direction', newDir);
                return newDir;
              })}
              className="p-1.5 rounded bg-bambu-dark border border-bambu-dark-tertiary hover:border-bambu-green transition-colors"
              title={sortDirection === 'asc' ? t('fileManager.ascending') : t('fileManager.descending')}
            >
              {sortDirection === 'asc' ? (
                <SortAsc className="w-4 h-4 text-white" />
              ) : (
                <SortDesc className="w-4 h-4 text-white" />
              )}
            </button>
            <button
              onClick={() => setShowModified((v) => {
                const next = !v;
                localStorage.setItem('library-show-modified', String(next));
                return next;
              })}
              className={`p-1.5 rounded bg-bambu-dark border transition-colors ${
                showModified ? 'border-bambu-green text-bambu-green' : 'border-bambu-dark-tertiary text-white hover:border-bambu-green'
              }`}
              title={showModified ? t('fileManager.hideModified') : t('fileManager.showModified')}
              aria-pressed={showModified}
            >
              <CalendarClock className="w-4 h-4" />
            </button>
          </div>

          {/* Results count */}
          {(searchQuery || filterType !== 'all' || filterUsername) && (
            <span className="text-sm text-bambu-gray hidden sm:inline">
              {t('fileManager.resultsCount', { showing: filteredAndSortedFiles.length, total: files.length })}
            </span>
          )}
        </div>
      )}

      {/* Selection toolbar - sticky on mobile below search bar */}
      {filteredAndSortedFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4 p-2 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary sticky top-[52px] z-10 lg:static">
          {/* Select all / Deselect all */}
          {selectedFiles.length === flatFiles.length && selectedFiles.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleDeselectAll}
            >
              <Square className="w-4 h-4 sm:mr-1" />
              <span className="hidden sm:inline">{t('fileManager.deselectAll')}</span>
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSelectAll}
            >
              <CheckSquare className="w-4 h-4 sm:mr-1" />
              <span className="hidden sm:inline">{t('fileManager.selectAll')}</span>
            </Button>
          )}

          {selectedFiles.length > 0 && (
            <>
              <span className="text-sm text-bambu-gray ml-2">
                {t('fileManager.selected', { count: selectedFiles.length })}
              </span>
              <div className="hidden sm:block flex-1" />
              <div className="w-full sm:w-auto flex flex-wrap items-center gap-2 mt-2 sm:mt-0">
                {selectedSlicedFiles.length === 1 && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setPrintFile(selectedSlicedFiles[0])}
                    disabled={!hasPermission('queue:create')}
                    title={!hasPermission('queue:create') ? t('fileManager.noPermissionAddToQueue') : undefined}
                  >
                    <Printer className="w-4 h-4 sm:mr-1" />
                    <span className="hidden sm:inline">{t('common.print')}</span>
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowMoveModal(true)}
                  disabled={!hasAnyPermission('library:update_own', 'library:update_all')}
                  title={!hasAnyPermission('library:update_own', 'library:update_all') ? t('fileManager.noPermissionMoveFiles') : undefined}
                >
                  <MoveRight className="w-4 h-4 sm:mr-1" />
                  <span className="hidden sm:inline">{t('common.move')}</span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowBulkTagsModal(true)}
                  disabled={!hasAnyPermission('library:update_own', 'library:update_all')}
                  title={!hasAnyPermission('library:update_own', 'library:update_all') ? t('fileManager.tags.noPermission') : t('fileManager.tags.bulkTooltip')}
                >
                  <TagIcon className="w-4 h-4 sm:mr-1" />
                  <span className="hidden sm:inline">{t('fileManager.tags.tagAction')}</span>
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    if (selectedFiles.length === 1) {
                      setDeleteConfirm({ type: 'file', id: selectedFiles[0] });
                    } else {
                      setDeleteConfirm({ type: 'bulk', id: 0, count: selectedFiles.length });
                    }
                  }}
                  disabled={!hasAnyPermission('library:delete_own', 'library:delete_all')}
                  title={!hasAnyPermission('library:delete_own', 'library:delete_all') ? t('fileManager.noPermissionDeleteFiles') : undefined}
                >
                  <Trash2 className="w-4 h-4 sm:mr-1" />
                  <span className="hidden sm:inline">{t('common.delete')}</span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleDeselectAll}
                >
                  <X className="w-4 h-4 sm:mr-1" />
                  <span className="hidden sm:inline">{t('common.clear')}</span>
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* File grid/list */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-bambu-green" />
            <p className="text-sm text-bambu-gray">{t('fileManager.loadingFiles')}</p>
          </div>
        </div>
      ) : files?.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="p-4 bg-bambu-dark rounded-2xl mb-4">
            <FileBox className="w-12 h-12 text-bambu-gray/50" />
          </div>
          <h3 className="text-lg font-medium text-white mb-2">
            {selectedFolderId !== null
              ? t('fileManager.folderIsEmpty')
              : topLevelView === 'external'
                ? t('fileManager.externalIsEmpty')
                : t('fileManager.noFilesYet')}
          </h3>
          <p className="text-bambu-gray text-center max-w-md mb-6">
            {selectedFolderId !== null
              ? t('fileManager.folderEmptyDescription')
              : topLevelView === 'external'
                ? t('fileManager.externalEmptyDescription')
                : t('fileManager.noFilesDescription')}
          </p>
          <Button
            onClick={() => setShowUploadModal(true)}
            disabled={!hasPermission('library:upload')}
            title={!hasPermission('library:upload') ? t('fileManager.noPermissionUpload') : undefined}
          >
            <Plus className="w-4 h-4 mr-2" />
            {t('fileManager.uploadFiles')}
          </Button>
        </div>
      ) : filteredAndSortedFiles.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="p-4 bg-bambu-dark rounded-2xl mb-4">
            <Search className="w-12 h-12 text-bambu-gray/50" />
          </div>
          <h3 className="text-lg font-medium text-white mb-2">{t('fileManager.noMatchingFiles')}</h3>
          <p className="text-bambu-gray text-center max-w-md mb-6">
            {t('fileManager.noMatchingFilesDescription')}
          </p>
          <Button variant="secondary" onClick={() => { setSearchQuery(''); setFilterType('all'); }}>
            {t('fileManager.clearFilters')}
          </Button>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="flex-1 lg:overflow-y-auto">
          {/* Column count drops while the inspector is docked beside the
              grid so the cards keep a sane width instead of being squeezed
              (mockup screen 1 option A: 5 columns → 3). */}
          <div
            data-testid="file-grid"
            className={
              inspectedFile
                ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4'
                : 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4'
            }
          >
            {filteredAndSortedFiles.map((file) => (
              <FileCard
                key={file.id}
                file={file}
                selectedFiles={selectedFiles}
                isMobile={isMobile}
                t={t}
                onSelect={handleFileSelect}
                onDelete={(id) => setDeleteConfirm({ type: 'file', id })}
                onDownload={handleDownload}
                onPrint={setPrintFile}
                onSlice={setSliceFile}
                onRunPipeline={setRunPipelineFile}
                useSlicerApi={settings?.use_slicer_api ?? false}
                onPreview3d={(f) => {
                  // Sliced files (.gcode / .gcode.3mf) open the same
                  // full-page gcode viewer the archive card uses, so
                  // the two paths feel consistent. STL / source 3MF
                  // continue to use the in-app 3D model viewer modal.
                  if (isSlicedFilename(f.filename)) {
                    navigate(`/gcode-viewer?library_file=${f.id}`);
                  } else {
                    setViewerFile(f);
                  }
                }}
                onRename={(f) => setRenameItem({ type: 'file', id: f.id, name: f.filename })}
                onGenerateThumbnail={(f) => singleThumbnailMutation.mutate(f.id)}
                onTagClick={toggleTagFilter}
                thumbnailVersions={thumbnailVersions}
                hasPermission={hasPermission}
                canModify={canModify}
                authEnabled={authEnabled}
                showModified={showModified}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 lg:overflow-y-auto">
          {/* The wrapper has overflow-x-auto so a narrow viewport scrolls
              horizontally instead of clipping the actions column off the
              right edge. The previous `overflow-hidden` was there for the
              rounded corners but also swallowed any content the actions
              column couldn't fit (#1325 follow-up reported in chat). */}
          <div className="bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary overflow-x-auto">
            {/* List header - hidden on mobile, show simplified on small screens.
                Trailing actions column is fixed at 220px (sliced 3MF = 7 icons
                ~220px). It used to be `min-content`, but header + body are sibling
                grids that compute `min-content` independently — the header's empty
                trailing div resolved to 0px, leaving body columns shifted left of
                their headers. Fixed width keeps header and body in lockstep. */}
            <div className={`hidden sm:grid ${authEnabled ? 'grid-cols-[auto_1fr_120px_100px_100px_100px_minmax(0,200px)_220px]' : 'grid-cols-[auto_1fr_100px_100px_100px_minmax(0,200px)_220px]'} gap-4 px-4 py-2 bg-bambu-dark-secondary border-b border-bambu-dark-tertiary text-xs text-bambu-gray font-medium`}>
              <div className="w-6" />
              <div>{t('common.name')}</div>
              {authEnabled && <div>{t('fileManager.uploadedBy', { defaultValue: 'Uploaded By' })}</div>}
              <div>{t('common.type')}</div>
              <div>{t('fileManager.size')}</div>
              <div>{t('fileManager.prints')}</div>
              <div>{t('fileManager.tags.title')}</div>
              <div />
            </div>
            {/* List rows. Flat — nesting is a grid-only treatment, so a
                grouped slice still gets its own row here. */}
            {flatFiles.map((file) => (
              <div
                key={file.id}
                className={`grid ${authEnabled ? 'grid-cols-[auto_1fr_120px_100px_100px_100px_minmax(0,200px)_220px]' : 'grid-cols-[auto_1fr_100px_100px_100px_minmax(0,200px)_220px]'} gap-4 px-4 py-3 items-center border-b border-bambu-dark-tertiary last:border-b-0 cursor-pointer hover:bg-bambu-dark/50 transition-colors ${
                  selectedFiles.includes(file.id) ? 'bg-bambu-green/10' : ''
                }`}
                onClick={() => handleFileSelect(file.id)}
              >
                {/* Checkbox */}
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                  selectedFiles.includes(file.id)
                    ? 'bg-bambu-green border-bambu-green'
                    : 'border-bambu-gray/50'
                }`}>
                  {selectedFiles.includes(file.id) && <div className="w-2 h-2 bg-white rounded-sm" />}
                </div>
                {/* Name with thumbnail */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative group/thumb">
                    <div className="w-10 h-10 rounded bg-bambu-dark flex-shrink-0 overflow-hidden">
                      {file.thumbnail_path ? (
                        <img
                          src={`${api.getLibraryFileThumbnailUrl(file.id)}${thumbnailVersions[file.id] ? ((api.getLibraryFileThumbnailUrl(file.id).includes('?') ? '&' : '?') + `v=${thumbnailVersions[file.id]}`) : ''}`}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <FileBox className="w-5 h-5 text-bambu-gray/50" />
                        </div>
                      )}
                    </div>
                    {/* Hover preview */}
                    {file.thumbnail_path && (
                      <div className="absolute left-0 top-full mt-2 z-50 hidden group-hover/thumb:block">
                        <div className="w-48 h-48 rounded-lg bg-bambu-dark-secondary border border-bambu-dark-tertiary shadow-xl overflow-hidden">
                          <img
                            src={`${api.getLibraryFileThumbnailUrl(file.id)}${thumbnailVersions[file.id] ? ((api.getLibraryFileThumbnailUrl(file.id).includes('?') ? '&' : '?') + `v=${thumbnailVersions[file.id]}`) : ''}`}
                            alt={file.filename}
                            className="w-full h-full object-contain"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate">{file.print_name || file.filename}</div>
                    {/* #2680: last-modified date under the name, toggled from
                        the toolbar. Real on-disk mtime when known, else created_at. */}
                    {showModified && (
                      <div className="text-xs text-bambu-gray flex items-center gap-1 mt-0.5" title={t('fileManager.lastModified')}>
                        <CalendarClock className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{formatDate(file.fs_modified_at ?? file.created_at)}</span>
                      </div>
                    )}
                  </div>
                </div>
                {/* Uploaded By - only show when auth is enabled */}
                {authEnabled && (
                  <div className="text-sm text-bambu-gray flex items-center gap-1">
                    {file.created_by_username ? (
                      <>
                        <User className="w-3 h-3" />
                        <span className="truncate">{file.created_by_username}</span>
                      </>
                    ) : (
                      '-'
                    )}
                  </div>
                )}
                {/* Type */}
                <div>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    file.file_type === '3mf' ? 'bg-bambu-green/20 text-bambu-green'
                    : (file.file_type === 'gcode' || file.file_type === 'gcode.3mf') ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400'
                    : file.file_type === 'stl' ? 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400'
                    : 'bg-bambu-gray/20 text-bambu-gray'
                  }`}>
                    {file.file_type.toUpperCase()}
                  </span>
                </div>
                {/* Size */}
                <div className="text-sm text-bambu-gray">{formatFileSize(file.file_size)}</div>
                {/* Prints */}
                <div className="text-sm text-bambu-gray">{file.print_count > 0 ? `${file.print_count}x` : '-'}</div>
                {/* Tags (#1268) — clickable chips push into the active
                    filter; minmax(0,200px) on the column lets the cell
                    shrink/wrap on narrow viewports without pushing the
                    Actions cell off-screen. */}
                <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
                  {!file.tags || file.tags.length === 0 ? (
                    <span className="text-xs text-bambu-gray/50">-</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {file.tags.map((tg) => (
                        <button
                          key={tg.id}
                          type="button"
                          onClick={() => toggleTagFilter(tg.id)}
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
                {/* Actions */}
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  {isSlicedFilename(file.filename) && (
                    <>
                      <button
                        onClick={() => hasPermission('queue:create') && setPrintFile(file)}
                        className={`p-1.5 rounded transition-colors ${
                          hasPermission('queue:create')
                            ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
                            : 'text-bambu-gray/50 cursor-not-allowed'
                        }`}
                        title={hasPermission('queue:create') ? t('common.print') : t('fileManager.noPermissionAddToQueue')}
                        disabled={!hasPermission('queue:create')}
                      >
                        <Printer className="w-4 h-4" />
                      </button>
                    </>
                  )}
                  {(settings?.use_slicer_api ?? false) && isSliceableFilename(file.filename) && (
                    <button
                      onClick={() => hasPermission('library:upload') && setSliceFile(file)}
                      className={`p-1.5 rounded transition-colors ${
                        hasPermission('library:upload')
                          ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
                          : 'text-bambu-gray/50 cursor-not-allowed'
                      }`}
                      title={hasPermission('library:upload') ? t('slice.action') : t('fileManager.noPermissionSlice')}
                      disabled={!hasPermission('library:upload')}
                    >
                      <Cog className="w-4 h-4" />
                    </button>
                  )}
                  {(settings?.use_slicer_api ?? false) && isSliceableFilename(file.filename) && (
                    <button
                      onClick={() => hasPermission('pipelines:run') && setRunPipelineFile(file)}
                      className={`p-1.5 rounded transition-colors ${
                        hasPermission('pipelines:run')
                          ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
                          : 'text-bambu-gray/50 cursor-not-allowed'
                      }`}
                      title={hasPermission('pipelines:run') ? t('library.runWithPipeline.actionLabel', 'Run with pipeline') : t('library.runWithPipeline.noPermission', 'You do not have permission to run pipelines')}
                      disabled={!hasPermission('pipelines:run')}
                    >
                      <Play className="w-4 h-4" />
                    </button>
                  )}
                  {(file.file_type === '3mf' || file.file_type === 'gcode' || file.file_type === 'gcode.3mf' || file.file_type === 'stl') && (
                    <button
                      onClick={() => {
                        if (!hasPermission('library:read')) return;
                        if (isSlicedFilename(file.filename)) {
                          navigate(`/gcode-viewer?library_file=${file.id}`);
                        } else {
                          setViewerFile(file);
                        }
                      }}
                      className={`p-1.5 rounded transition-colors ${
                        hasPermission('library:read')
                          ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
                          : 'text-bambu-gray/50 cursor-not-allowed'
                      }`}
                      title={hasPermission('library:read') ? '3D Preview' : 'You do not have permission to preview files'}
                      disabled={!hasPermission('library:read')}
                    >
                      <Box className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => hasPermission('library:read') && handleDownload(file.id)}
                    className={`p-1.5 rounded transition-colors ${
                      hasPermission('library:read')
                        ? 'hover:bg-bambu-dark text-bambu-gray hover:text-white'
                        : 'text-bambu-gray/50 cursor-not-allowed'
                    }`}
                    title={hasPermission('library:read') ? t('common.download') : t('fileManager.noPermissionDownload')}
                    disabled={!hasPermission('library:read')}
                  >
                    <Download className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => canModify('library', 'update', file.created_by_id) && setRenameItem({ type: 'file', id: file.id, name: file.filename })}
                    className={`p-1.5 rounded transition-colors ${
                      canModify('library', 'update', file.created_by_id)
                        ? 'hover:bg-bambu-dark text-bambu-gray hover:text-white'
                        : 'text-bambu-gray/50 cursor-not-allowed'
                    }`}
                    title={canModify('library', 'update', file.created_by_id) ? t('common.rename') : t('fileManager.noPermissionRenameFile')}
                    disabled={!canModify('library', 'update', file.created_by_id)}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  {file.file_type === 'stl' && (
                    <button
                      onClick={() => canModify('library', 'update', file.created_by_id) && singleThumbnailMutation.mutate(file.id)}
                      className={`p-1.5 rounded transition-colors ${
                        canModify('library', 'update', file.created_by_id)
                          ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
                          : 'text-bambu-gray/50 cursor-not-allowed'
                      }`}
                      title={canModify('library', 'update', file.created_by_id) ? t('fileManager.generateThumbnail') : t('fileManager.noPermissionGenerateThumbnail')}
                      disabled={singleThumbnailMutation.isPending || !canModify('library', 'update', file.created_by_id)}
                    >
                      <Image className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => canModify('library', 'delete', file.created_by_id) && setDeleteConfirm({ type: 'file', id: file.id })}
                    className={`p-1.5 rounded transition-colors ${
                      canModify('library', 'delete', file.created_by_id)
                        ? 'hover:bg-bambu-dark text-bambu-gray hover:text-red-700 dark:hover:text-red-400'
                        : 'text-bambu-gray/50 cursor-not-allowed'
                    }`}
                    title={canModify('library', 'delete', file.created_by_id) ? t('common.delete') : t('fileManager.noPermissionDeleteFile')}
                    disabled={!canModify('library', 'delete', file.created_by_id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
