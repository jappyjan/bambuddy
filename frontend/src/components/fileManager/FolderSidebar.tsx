import {
  FileBox,
  FolderSymlink,
  SortAsc,
  SortDesc,
} from 'lucide-react';
import type { LibraryFolderTree, Permission } from '../../api/client';
import type { TFunction } from '../../pages/FileManagerPage';
import { FolderTreeItem } from './FolderTreeItem';

// Folder sidebar: the desktop resizable folder tree plus the mobile
// (`lg:hidden`) folder <select> that stands in for it on narrow screens. Both
// render the same selection, so they live together.
//
// State ownership stays in FileManagerPage (#33/#35): every value below is
// passed in, including the resize state. The resize `useEffect` also stays in
// the page because it drives `isResizing` and document.body styles, not just
// `sidebarWidth` — `sidebarRef` is threaded down so it can keep measuring the
// container.
interface FolderSidebarProps {
  folders: LibraryFolderTree[] | undefined;
  sortedFolders: LibraryFolderTree[] | undefined;
  selectedFolderId: number | null;
  setSelectedFolderId: (id: number | null) => void;
  topLevelView: 'internal' | 'external';
  setTopLevelView: (view: 'internal' | 'external') => void;
  sidebarRef: React.RefObject<HTMLDivElement | null>;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  isResizing: boolean;
  setIsResizing: (resizing: boolean) => void;
  folderSortField: 'name' | 'activity';
  setFolderSortField: (field: 'name' | 'activity') => void;
  folderSortDirection: 'asc' | 'desc';
  setFolderSortDirection: (direction: 'asc' | 'desc') => void;
  collapseFoldersByDefault: boolean;
  setCollapseFoldersByDefault: (value: boolean) => void;
  wrapFolderNames: boolean;
  setWrapFolderNames: (value: boolean) => void;
  onDeleteFolder: (id: number) => void;
  onLinkFolder: (folder: LibraryFolderTree) => void;
  onRenameFolder: (folder: LibraryFolderTree) => void;
  hasPermission: (permission: Permission) => boolean;
  t: TFunction;
}

export function FolderSidebar({
  folders,
  sortedFolders,
  selectedFolderId,
  setSelectedFolderId,
  topLevelView,
  setTopLevelView,
  sidebarRef,
  sidebarWidth,
  setSidebarWidth,
  isResizing,
  setIsResizing,
  folderSortField,
  setFolderSortField,
  folderSortDirection,
  setFolderSortDirection,
  collapseFoldersByDefault,
  setCollapseFoldersByDefault,
  wrapFolderNames,
  setWrapFolderNames,
  onDeleteFolder,
  onLinkFolder,
  onRenameFolder,
  hasPermission,
  t,
}: FolderSidebarProps) {
  return (
    <>
      {/* Mobile folder selector */}
      <div className="lg:hidden">
        <select
          value={selectedFolderId !== null ? String(selectedFolderId) : `__top:${topLevelView}`}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('__top:')) {
              setSelectedFolderId(null);
              setTopLevelView(v.slice('__top:'.length) as 'internal' | 'external');
            } else {
              setSelectedFolderId(parseInt(v, 10));
            }
          }}
          className="w-full bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-bambu-green"
        >
          <option value="__top:internal">📁 {t('fileManager.allFiles')}</option>
          {folders?.some((f) => f.is_external) && (
            <option value="__top:external">🔗 {t('fileManager.allExternal')}</option>
          )}
          {sortedFolders && (() => {
            // Flatten folder tree for mobile selector
            const flattenFolders = (items: LibraryFolderTree[], depth = 0): { id: number; name: string; fileCount: number; depth: number }[] => {
              const result: { id: number; name: string; fileCount: number; depth: number }[] = [];
              for (const item of items) {
                result.push({ id: item.id, name: item.name, fileCount: item.file_count, depth });
                if (item.children.length > 0) {
                  result.push(...flattenFolders(item.children, depth + 1));
                }
              }
              return result;
            };
            return flattenFolders(sortedFolders).map((folder) => (
              <option key={folder.id} value={folder.id}>
                {'│ '.repeat(folder.depth)}📂 {folder.name} {folder.fileCount > 0 ? `(${folder.fileCount})` : ''}
              </option>
            ));
          })()}
        </select>
      </div>

      {/* Folder sidebar - resizable, hidden on mobile */}
      <div
        ref={sidebarRef}
        className="hidden lg:flex flex-shrink-0 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary overflow-hidden flex-col relative"
        style={{ width: `${sidebarWidth}px` }}
      >
        {/* Resize handle - drag to resize, double-click to reset */}
        <div
          className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 group/resize flex items-center justify-center transition-colors ${
            isResizing ? 'bg-bambu-green' : 'hover:bg-bambu-green/50'
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            setIsResizing(true);
          }}
          onDoubleClick={() => {
            setSidebarWidth(256); // Reset to default w-64
            localStorage.setItem('library-sidebar-width', '256');
          }}
          title={t('fileManager.dragToResizeTooltip')}
        >
          {/* Grip dots */}
          <div className={`flex flex-col gap-1 opacity-0 group-hover/resize:opacity-100 transition-opacity ${isResizing ? 'opacity-100' : ''}`}>
            <div className="w-0.5 h-0.5 rounded-full bg-white/70" />
            <div className="w-0.5 h-0.5 rounded-full bg-white/70" />
            <div className="w-0.5 h-0.5 rounded-full bg-white/70" />
          </div>
        </div>
        <div className="p-3 border-b border-bambu-dark-tertiary flex items-center justify-between">
          <h2 className="text-sm font-medium text-white">{t('fileManager.folders')}</h2>
          <div className="flex items-center gap-1">
            {/* Folder tree sort (#1770). Dropdown drives the comparator;
                direction button flips asc/desc. Both persist to localStorage
                on change so the choice survives reloads. */}
            <select
              value={folderSortField}
              onChange={(e) => {
                const v = e.target.value === 'activity' ? 'activity' : 'name';
                setFolderSortField(v);
                localStorage.setItem('library-folder-sort-field', v);
              }}
              className="text-xs px-1 py-0.5 rounded bg-bambu-dark border border-bambu-dark-tertiary text-bambu-gray focus:outline-none focus:border-bambu-green"
              title={t('fileManager.folderSort')}
              aria-label={t('fileManager.folderSort')}
            >
              <option value="name">{t('fileManager.folderSortByName')}</option>
              <option value="activity">{t('fileManager.folderSortByActivity')}</option>
            </select>
            <button
              onClick={() => {
                const newValue = folderSortDirection === 'asc' ? 'desc' : 'asc';
                setFolderSortDirection(newValue);
                localStorage.setItem('library-folder-sort-direction', newValue);
              }}
              className="text-bambu-gray hover:text-white hover:bg-bambu-dark p-1 rounded transition-colors"
              title={folderSortDirection === 'asc' ? t('fileManager.ascending') : t('fileManager.descending')}
              aria-label={folderSortDirection === 'asc' ? t('fileManager.ascending') : t('fileManager.descending')}
            >
              {folderSortDirection === 'asc' ? <SortAsc className="w-3.5 h-3.5" /> : <SortDesc className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => {
                const newValue = !collapseFoldersByDefault;
                setCollapseFoldersByDefault(newValue);
                localStorage.setItem('library-collapse-folders', String(newValue));
              }}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                collapseFoldersByDefault
                  ? 'bg-bambu-green/20 text-bambu-green'
                  : 'text-bambu-gray hover:text-white hover:bg-bambu-dark'
              }`}
              title={collapseFoldersByDefault ? t('fileManager.expandFoldersByDefault') : t('fileManager.collapseFoldersByDefault')}
            >
              {t('fileManager.collapse')}
            </button>
            <button
              onClick={() => {
                const newValue = !wrapFolderNames;
                setWrapFolderNames(newValue);
                localStorage.setItem('library-wrap-folders', String(newValue));
              }}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                wrapFolderNames
                  ? 'bg-bambu-green/20 text-bambu-green'
                  : 'text-bambu-gray hover:text-white hover:bg-bambu-dark'
              }`}
              title={wrapFolderNames ? t('fileManager.disableTextWrapping') : t('fileManager.enableTextWrapping')}
            >
              {t('fileManager.wrap')}
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {/* All Files = the user's own uploaded / managed-storage files
              only. External folders are surfaced separately below to keep
              a linked NAS from drowning the user's own uploads (#1621). */}
          <div
            className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
              selectedFolderId === null && topLevelView === 'internal'
                ? 'bg-bambu-green/20 text-bambu-green'
                : 'hover:bg-bambu-dark text-white'
            }`}
            onClick={() => {
              setSelectedFolderId(null);
              setTopLevelView('internal');
            }}
          >
            <FileBox className="w-4 h-4" />
            <span className="text-sm">{t('fileManager.allFiles')}</span>
          </div>

          {/* External (combined) — only shown when at least one external
              folder is linked. Single folder users don't need a combined
              view; clicking the individual folder is just as fast. */}
          {folders?.some((f) => f.is_external) && (
            <div
              className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                selectedFolderId === null && topLevelView === 'external'
                  ? 'bg-bambu-green/20 text-bambu-green'
                  : 'hover:bg-bambu-dark text-white'
              }`}
              onClick={() => {
                setSelectedFolderId(null);
                setTopLevelView('external');
              }}
            >
              <FolderSymlink className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              <span className="text-sm">{t('fileManager.allExternal')}</span>
            </div>
          )}

          {/* Folder tree — re-key on the collapse toggle so flipping it
              remounts every FolderTreeItem, which re-reads defaultExpanded
              and makes the preference take effect immediately. */}
          {sortedFolders?.map((folder) => (
            <FolderTreeItem
              key={`${folder.id}-${collapseFoldersByDefault ? 'c' : 'e'}`}
              folder={folder}
              selectedFolderId={selectedFolderId}
              onSelect={setSelectedFolderId}
              onDelete={onDeleteFolder}
              onLink={onLinkFolder}
              onRename={onRenameFolder}
              wrapNames={wrapFolderNames}
              defaultExpanded={!collapseFoldersByDefault}
              hasPermission={hasPermission}
              t={t}
            />
          ))}
        </div>
      </div>
    </>
  );
}
