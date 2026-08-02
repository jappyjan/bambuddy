import { useState } from 'react';
import {
  ChevronRight,
  FolderOpen,
  FolderSymlink,
  Link2,
  Archive as ArchiveIcon,
  Briefcase,
  Lock,
  MoreVertical,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { LibraryFolderTree, Permission } from '../../api/client';
import type { TFunction } from '../../pages/FileManagerPage';

// Folder Tree Item
interface FolderTreeItemProps {
  folder: LibraryFolderTree;
  selectedFolderId: number | null;
  onSelect: (id: number | null) => void;
  onDelete: (id: number) => void;
  onLink: (folder: LibraryFolderTree) => void;
  onRename: (folder: LibraryFolderTree) => void;
  depth?: number;
  wrapNames?: boolean;
  defaultExpanded?: boolean;
  hasPermission: (permission: Permission) => boolean;
  t: TFunction;
}

export function FolderTreeItem({ folder, selectedFolderId, onSelect, onDelete, onLink, onRename, depth = 0, wrapNames = false, defaultExpanded = true, hasPermission, t }: FolderTreeItemProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showActions, setShowActions] = useState(false);
  const hasChildren = folder.children.length > 0;
  const isLinked = folder.project_id || folder.archive_id;
  const isExternal = folder.is_external;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer transition-colors ${
          selectedFolderId === folder.id
            ? 'bg-bambu-green/20 text-bambu-green'
            : 'hover:bg-bambu-dark text-white'
        }`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => onSelect(folder.id)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="p-0.5 hover:bg-bambu-dark-tertiary rounded"
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <div className="w-4.5" />
        )}
        {isExternal ? (
          <FolderSymlink className="w-4 h-4 text-purple-600 dark:text-purple-400 flex-shrink-0" />
        ) : (
          <FolderOpen className="w-4 h-4 text-bambu-green flex-shrink-0" />
        )}
        <span className={`text-sm flex-1 min-w-0 ${wrapNames ? 'break-all' : 'truncate'}`} title={folder.name}>{folder.name}</span>
        {/* Link indicator - clickable to change link */}
        {isLinked && (
          <button
            onClick={(e) => { e.stopPropagation(); onLink(folder); }}
            className="flex-shrink-0 flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-500/30 transition-colors"
            title={`${folder.project_name ? `Project: ${folder.project_name}` : `Archive: ${folder.archive_name}`} (click to change)`}
          >
            <Link2 className="w-3 h-3" />
            {folder.project_name ? (
              <Briefcase className="w-3 h-3" />
            ) : (
              <ArchiveIcon className="w-3 h-3" />
            )}
          </button>
        )}
        {/* Read-only indicator for external folders */}
        {isExternal && folder.external_readonly && (
          <span title={t('fileManager.readOnly')}>
            <Lock className="w-3 h-3 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          </span>
        )}
        {folder.file_count > 0 && (
          <span className="flex-shrink-0 text-xs text-bambu-gray">{folder.file_count}</span>
        )}
        {/* Quick link button - always visible for unlinked folders */}
        {!isLinked && !isExternal && (
          <button
            onClick={(e) => { e.stopPropagation(); onLink(folder); }}
            className="flex-shrink-0 p-1 rounded hover:bg-bambu-dark-tertiary"
            title={t('fileManager.linkToProjectOrArchive')}
          >
            <Link2 className="w-3.5 h-3.5 text-bambu-gray hover:text-bambu-green" />
          </button>
        )}
        <div className={`flex-shrink-0 flex items-center gap-0.5 transition-opacity ${wrapNames ? '' : 'opacity-0 group-hover:opacity-100'}`} onClick={(e) => e.stopPropagation()}>
          <div className="relative">
            <button
              onClick={() => setShowActions(!showActions)}
              className="p-1 rounded hover:bg-bambu-dark-tertiary"
            >
              <MoreVertical className="w-3.5 h-3.5 text-bambu-gray" />
            </button>
            {showActions && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowActions(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl py-1 min-w-[120px]">
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    hasPermission('library:update_all') ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (hasPermission('library:update_all')) { onRename(folder); setShowActions(false); } }}
                  disabled={!hasPermission('library:update_all')}
                  title={!hasPermission('library:update_all') ? t('fileManager.noPermissionRenameFolder') : undefined}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  {t('common.rename')}
                </button>
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    hasPermission('library:update_all') ? 'text-white hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (hasPermission('library:update_all')) { onLink(folder); setShowActions(false); } }}
                  disabled={!hasPermission('library:update_all')}
                  title={!hasPermission('library:update_all') ? t('fileManager.noPermissionLinkFolder') : undefined}
                >
                  <Link2 className="w-3.5 h-3.5" />
                  {isLinked ? t('fileManager.changeLink') : t('fileManager.linkTo')}
                </button>
                <button
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 ${
                    hasPermission('library:delete_all') ? 'text-red-700 dark:text-red-400 hover:bg-bambu-dark' : 'text-bambu-gray cursor-not-allowed'
                  }`}
                  onClick={() => { if (hasPermission('library:delete_all')) { onDelete(folder.id); setShowActions(false); } }}
                  disabled={!hasPermission('library:delete_all')}
                  title={!hasPermission('library:delete_all') ? t('fileManager.noPermissionDeleteFolder') : undefined}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('common.delete')}
                </button>
              </div>
              </>
            )}
          </div>
        </div>
      </div>
      {hasChildren && expanded && (
        <div>
          {folder.children.map((child) => (
            <FolderTreeItem
              key={child.id}
              folder={child}
              selectedFolderId={selectedFolderId}
              onSelect={onSelect}
              onDelete={onDelete}
              onLink={onLink}
              onRename={onRename}
              depth={depth + 1}
              wrapNames={wrapNames}
              defaultExpanded={defaultExpanded}
              hasPermission={hasPermission}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}
