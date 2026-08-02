import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  FolderOpen,
  Upload,
  HardDrive,
  File,
  AlertTriangle,
} from 'lucide-react';
import { api } from '../api/client';
import type {
  LibraryFolderTree,
  LibraryFileListItem,
  LibraryFolderCreate,
  LibraryFolderUpdate,
  ExternalFolderCreate,
  AppSettings,
} from '../api/client';
import { ConfirmModal } from '../components/ConfirmModal';
import { PrintModal } from '../components/PrintModal';
import { ModelViewerModal } from '../components/ModelViewerModal';
import { SliceModal } from '../components/SliceModal';
import { RunWithPipelineModal } from '../components/RunWithPipelineModal';
import { BulkTagsPickerModal } from '../components/BulkTagsPickerModal';
import { FileUploadModal } from '../components/FileUploadModal';
import { FolderReadmePanel } from '../components/FolderReadmePanel';
import { LibraryTagsModal } from '../components/LibraryTagsModal';
import { PurgeOldFilesModal } from '../components/PurgeOldFilesModal';
import { FileInspectorPanel } from '../components/FileInspectorPanel';
import { BottomSheet } from '../components/BottomSheet';
import { NewFolderModal } from '../components/fileManager/NewFolderModal';
import { ExternalFolderModal } from '../components/fileManager/ExternalFolderModal';
import { RenameModal } from '../components/fileManager/RenameModal';
import { MoveFilesModal } from '../components/fileManager/MoveFilesModal';
import { LinkFolderModal } from '../components/fileManager/LinkFolderModal';
import { FolderSidebar } from '../components/fileManager/FolderSidebar';
import { FileManagerToolbar } from '../components/fileManager/FileManagerToolbar';
import { FileGrid } from '../components/fileManager/FileGrid';
import { useToast } from '../contexts/ToastContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { usePageFileDrop } from '../hooks/usePageFileDrop';
import { useAuth } from '../contexts/AuthContext';
import { parseUTCDate } from '../utils/date';
import { formatFileSize, isSlicedFilename, isSliceableFilename } from '../utils/file';

export type SortField = 'name' | 'date' | 'size' | 'type' | 'prints';
export type SortDirection = 'asc' | 'desc';
export type TFunction = (key: string, options?: Record<string, unknown>) => string;

// `?group=nested` hands sliced outputs back inside their source's `children`.
// Selection and the list view work on individual rows, so they flatten first.
function flattenGrouped(items: LibraryFileListItem[]): LibraryFileListItem[] {
  return items.flatMap((f) => [f, ...(f.children ?? [])]);
}

export function FileManagerPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission, hasAnyPermission, canModify, authEnabled } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Read folder ID from URL query parameter
  const folderIdFromUrl = searchParams.get('folder');
  const initialFolderId = folderIdFromUrl ? parseInt(folderIdFromUrl, 10) : null;

  // State
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(initialFolderId);
  // Which top-level pseudo-view the sidebar shows when no specific folder is
  // selected: "internal" = files in Bambuddy's managed storage, "external" =
  // combined view across every linked external folder (#1621). Per-folder
  // selection bypasses this (selectedFolderId !== null disables the filter).
  const [topLevelView, setTopLevelView] = useState<'internal' | 'external'>('internal');
  // Selection deliberately survives a folder / search / tag change (#37), so
  // part of it can sit off-screen. `selectedNames` remembers the filename of
  // every id at the moment it was picked — the listing no longer contains it
  // once the view moves on, and the delete confirmation has to be able to name
  // what it is about to destroy.
  const [selectedFiles, setSelectedFiles] = useState<number[]>([]);
  const [selectedNames, setSelectedNames] = useState<Record<number, string>>({});
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [showExternalFolderModal, setShowExternalFolderModal] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [showPurgeModal, setShowPurgeModal] = useState(false);
  // Tag UI state (#1268). selectedTagIds is the AND-style filter applied to
  // the listing; setting it bypasses folder scoping on the server so
  // "every toy" works regardless of which folder is currently selected.
  const [showTagsModal, setShowTagsModal] = useState(false);
  const [showBulkTagsModal, setShowBulkTagsModal] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [linkFolder, setLinkFolder] = useState<LibraryFolderTree | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'file' | 'folder' | 'bulk'; id: number; count?: number } | null>(null);
  const [printFile, setPrintFile] = useState<LibraryFileListItem | null>(null);
  const [sliceFile, setSliceFile] = useState<LibraryFileListItem | null>(null);
  // Slicer Pipelines (#1425 PR B) — file gets "Run with pipeline" action.
  const [runPipelineFile, setRunPipelineFile] = useState<LibraryFileListItem | null>(null);
  const [renameItem, setRenameItem] = useState<{ type: 'file' | 'folder'; id: number; name: string } | null>(null);
  const [thumbnailVersions, setThumbnailVersions] = useState<Record<number, number>>({});
  const [viewerFile, setViewerFile] = useState<LibraryFileListItem | null>(null);
  // Inspector panel (spec §7 step 3). Only the *id* is held: the panel is fed
  // from the live list, so a rename or a thumbnail refresh flows straight into
  // it, and a file that disappears from the listing closes it on its own.
  // Keeping this as a plain id also lets the mobile bottom sheet (#28) present
  // the same selection without a second source of truth.
  const [inspectedFileId, setInspectedFileId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    return (localStorage.getItem('library-view-mode') as 'grid' | 'list') || 'grid';
  });
  const [wrapFolderNames, setWrapFolderNames] = useState(() => {
    return localStorage.getItem('library-wrap-folders') === 'true';
  });
  const [collapseFoldersByDefault, setCollapseFoldersByDefault] = useState(() => {
    return localStorage.getItem('library-collapse-folders') === 'true';
  });
  // Folder tree sort (#1770). 'name' = alphabetical (the prior behaviour);
  // 'activity' = most recent file activity inside the folder first. Persisted
  // independently from the file-side sort so each can be tuned to taste.
  const [folderSortField, setFolderSortField] = useState<'name' | 'activity'>(() => {
    const saved = localStorage.getItem('library-folder-sort-field');
    return saved === 'activity' ? 'activity' : 'name';
  });
  const [folderSortDirection, setFolderSortDirection] = useState<'asc' | 'desc'>(() => {
    const saved = localStorage.getItem('library-folder-sort-direction');
    return saved === 'desc' ? 'desc' : 'asc';
  });

  // Resizable sidebar state
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('library-sidebar-width');
    return saved ? parseInt(saved, 10) : 256; // Default w-64 = 256px
  });
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Handle sidebar resize
  useEffect(() => {
    if (!isResizing) return;

    // Prevent text selection during resize
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return;
      const containerRect = sidebarRef.current.parentElement?.getBoundingClientRect();
      if (!containerRect) return;
      // Calculate new width based on mouse position relative to container
      const newWidth = e.clientX - containerRect.left;
      // Clamp between 200px and 500px
      const clampedWidth = Math.min(500, Math.max(200, newWidth));
      setSidebarWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // Save to localStorage
      localStorage.setItem('library-sidebar-width', String(sidebarWidth));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, sidebarWidth]);

  // Filter and sort state (persist sort preferences to localStorage)
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [filterUsername, setFilterUsername] = useState('');
  const [sortField, setSortField] = useState<SortField>(() => {
    const saved = localStorage.getItem('library-sort-field');
    return (saved as SortField) || 'name';
  });
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    const saved = localStorage.getItem('library-sort-direction');
    return (saved as SortDirection) || 'asc';
  });
  // Show/hide the last-modified date on each file card (#2680). Persisted.
  const [showModified, setShowModified] = useState<boolean>(
    () => localStorage.getItem('library-show-modified') === 'true'
  );

  // Mobile detection for touch-friendly UI
  const isMobile = useIsMobile();

  // Update selectedFolderId when URL parameter changes (e.g., navigating from Project or Archive page)
  useEffect(() => {
    const folderParam = searchParams.get('folder');
    if (folderParam) {
      const newFolderId = parseInt(folderParam, 10);
      setSelectedFolderId(newFolderId);
    }
  }, [searchParams]);

  // Queries
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings() as Promise<AppSettings>,
  });
  const { data: folders, isLoading: foldersLoading } = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => api.getLibraryFolders(),
  });

  // Recursive folder tree sort (#1770). Applies the same comparator to the
  // top-level list AND to each level of `children`, so sort order is uniform
  // at every depth of nesting. When sorting by activity, the comparator falls
  // back to a created-at fallback for folders with no files (`latest_activity_at`
  // is null) so they stay grouped at the end / start of the bucket instead of
  // randomly interspersed.
  const sortedFolders = useMemo(() => {
    if (!folders) return folders;
    const sortLevel = (items: LibraryFolderTree[]): LibraryFolderTree[] => {
      const sorted = [...items].sort((a, b) => {
        let comparison = 0;
        if (folderSortField === 'name') {
          comparison = a.name.localeCompare(b.name);
        } else {
          // activity: newest first on 'desc', oldest first on 'asc'.
          // Folders with no activity timestamp sort to the end regardless
          // of direction so an empty folder doesn't elbow a recently-used one.
          const aTs = a.latest_activity_at ? new Date(a.latest_activity_at).getTime() : null;
          const bTs = b.latest_activity_at ? new Date(b.latest_activity_at).getTime() : null;
          if (aTs === null && bTs === null) {
            comparison = a.name.localeCompare(b.name);
          } else if (aTs === null) {
            return 1;
          } else if (bTs === null) {
            return -1;
          } else {
            comparison = aTs - bTs;
          }
        }
        return folderSortDirection === 'asc' ? comparison : -comparison;
      });
      return sorted.map((f) => ({ ...f, children: sortLevel(f.children) }));
    };
    return sortLevel(folders);
  }, [folders, folderSortField, folderSortDirection]);

  // Trash count for the header badge (#1008). Empty/error are silently treated
  // as zero so a broken trash endpoint doesn't break the File Manager.
  const { data: trashCount } = useQuery({
    queryKey: ['library-trash-count'],
    queryFn: async () => {
      try {
        const res = await api.listLibraryTrash(1, 0);
        return res.total;
      } catch {
        return 0;
      }
    },
    staleTime: 30_000,
  });

  // #1268: when a folder is selected and the user has typed a search query,
  // ask the server to expand the result to every descendant folder so the
  // client-side filter can match files in subfolders too. Without this the
  // listing is just the immediate children and "robot.3mf" two levels deep
  // is invisible from the parent. Only kicks in for folder-scoped views —
  // root and the internal/external pseudo-nodes already return the union.
  const searchExpandsSubfolders = selectedFolderId !== null && searchQuery.trim().length > 0;
  // The tag filter overrides folder scoping server-side (#1268 design call),
  // so the FE query key includes it as a peer of folder/topLevelView. Sorted
  // so the cache hits regardless of the order tags were toggled.
  const tagFilterKey = useMemo(() => [...selectedTagIds].sort((a, b) => a - b), [selectedTagIds]);
  // Tag catalog — needed to resolve names for the active-filter chip bar.
  // Cheap query, shared with LibraryTagsModal / BulkTagsPickerModal via the
  // same queryKey so they all invalidate together on tag CRUD.
  const { data: tagCatalog = [] } = useQuery({
    queryKey: ['library-tags'],
    queryFn: api.getLibraryTags,
  });
  const tagsById = useMemo(() => {
    const map = new Map<number, string>();
    for (const t of tagCatalog) map.set(t.id, t.name);
    return map;
  }, [tagCatalog]);
  // Prune the active filter when a tag is removed from the catalog so the
  // listing never stalls on a phantom id. Skipped while the catalog query is
  // still settling (empty array on first paint) — otherwise the user's filter
  // gets cleared the moment the page mounts.
  useEffect(() => {
    if (tagCatalog.length === 0) return;
    setSelectedTagIds((prev) => {
      const next = prev.filter((id) => tagsById.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [tagCatalog.length, tagsById]);

  const toggleTagFilter = useCallback((tagId: number) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }, []);

  const { data: files, isLoading: filesLoading } = useQuery({
    queryKey: ['library-files', selectedFolderId, topLevelView, searchExpandsSubfolders, tagFilterKey],
    // When a specific folder is selected we list its contents directly; when
    // no folder is selected the topLevelView pseudo-node decides whether the
    // server scopes the result to internal-managed-storage files or to the
    // union of every external folder (#1621). include_root stays false so the
    // listing still descends into subfolders (regression guard from #1499).
    queryFn: () =>
      api.getLibraryFiles(
        selectedFolderId,
        false,
        undefined,
        selectedFolderId === null ? topLevelView : undefined,
        searchExpandsSubfolders,
        tagFilterKey,
        // Sliced outputs come back nested under the file they were sliced
        // from instead of sitting beside it (spec §7 step 2).
        'nested',
      ),
  });

  const { data: stats } = useQuery({
    queryKey: ['library-stats'],
    queryFn: () => api.getLibraryStats(),
  });

  // Get users for the username filter autocomplete
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.getUsers(),
  });

  // Get unique file types for filter dropdown
  const fileTypes = useMemo(() => {
    if (!files) return [];
    const types = new Set(files.map((f) => f.file_type));
    return Array.from(types).sort();
  }, [files]);

  // Filter and sort files
  const filteredAndSortedFiles = useMemo(() => {
    if (!files) return [];

    let result = [...files];

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (f) =>
          f.filename.toLowerCase().includes(query) ||
          (f.print_name && f.print_name.toLowerCase().includes(query))
      );
    }

    // Apply type filter
    if (filterType !== 'all') {
      result = result.filter((f) => f.file_type === filterType);
    }

    // Apply username filter
    if (filterUsername.trim()) {
      const query = filterUsername.toLowerCase();
      result = result.filter(
        (f) => f.created_by_username && f.created_by_username.toLowerCase().includes(query)
      );
    }

    // Apply sorting
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = (a.print_name || a.filename).localeCompare(b.print_name || b.filename);
          break;
        case 'date':
          // #2680: sort by real on-disk mtime (matches `ls -t`), falling back to
          // the DB created_at for managed uploads that have no filesystem mtime.
          comparison =
            (parseUTCDate(a.fs_modified_at ?? a.created_at)?.getTime() ?? 0) -
            (parseUTCDate(b.fs_modified_at ?? b.created_at)?.getTime() ?? 0);
          break;
        case 'size':
          comparison = a.file_size - b.file_size;
          break;
        case 'type':
          comparison = a.file_type.localeCompare(b.file_type);
          break;
        case 'prints':
          comparison = a.print_count - b.print_count;
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [files, searchQuery, filterType, filterUsername, sortField, sortDirection]);

  // Every visible row, nested slices included. The grid nests them inside the
  // FileCard; the list view and select-all need them flat.
  const flatFiles = useMemo(() => flattenGrouped(filteredAndSortedFiles), [filteredAndSortedFiles]);

  // Resolved against the flat list so a nested sliced child inspects exactly
  // like a top-level file does. Null (panel closed) once the id stops matching
  // anything visible — a delete or a filter change therefore closes the panel.
  const inspectedFile = useMemo(
    () => flatFiles.find((f) => f.id === inspectedFileId) ?? null,
    [flatFiles, inspectedFileId],
  );

  // Plate count for the inspector. The list endpoint doesn't carry it, and it
  // is the one extra metadata row that is cheap to fetch. `dimensions` has no
  // source at all today, so the panel's dimensions row stays hidden.
  // `plates.length || null` at the call site: an empty or failed read is
  // "unknown", not "zero plates", so the row is hidden rather than misleading.
  const { data: inspectedPlates } = useQuery({
    queryKey: ['library-file-plates', inspectedFileId],
    queryFn: () => api.getLibraryFilePlates(inspectedFileId!),
    enabled: inspectedFileId !== null,
    retry: false,
  });

  // Check if disk space is low
  const isDiskSpaceLow = useMemo(() => {
    if (!stats || !settings) return false;
    const thresholdBytes = (settings.library_disk_warning_gb || 5) * 1024 * 1024 * 1024;
    return stats.disk_free_bytes < thresholdBytes;
  }, [stats, settings]);

  // Mutations
  const createFolderMutation = useMutation({
    mutationFn: (data: LibraryFolderCreate) => api.createLibraryFolder(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      setShowNewFolderModal(false);
      showToast(t('fileManager.toast.folderCreated'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const createExternalFolderMutation = useMutation({
    mutationFn: async (data: ExternalFolderCreate) => {
      const folder = await api.createExternalFolder(data);
      // Auto-scan after creation
      await api.scanExternalFolder(folder.id);
      return folder;
    },
    onSuccess: (folder) => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      setShowExternalFolderModal(false);
      setSelectedFolderId(folder.id);
      showToast(t('fileManager.toast.externalFolderLinked'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const scanExternalFolderMutation = useMutation({
    mutationFn: (folderId: number) => api.scanExternalFolder(folderId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      showToast(t('fileManager.toast.folderScanned', { added: result.added, removed: result.removed }), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const deleteFolderMutation = useMutation({
    mutationFn: (id: number) => api.deleteLibraryFolder(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      if (selectedFolderId === deleteConfirm?.id) {
        setSelectedFolderId(null);
      }
      setDeleteConfirm(null);
      showToast(t('fileManager.toast.folderDeleted'), 'success');
    },
    onError: (error: Error) => {
      setDeleteConfirm(null);
      showToast(error.message, 'error');
    },
  });

  const deleteFileMutation = useMutation({
    mutationFn: (id: number) => api.deleteLibraryFile(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
      setSelectedFiles((prev) => prev.filter((id) => id !== deleteConfirm?.id));
      setDeleteConfirm(null);
      showToast(t('fileManager.toast.fileDeleted'), 'success');
    },
    onError: (error: Error) => {
      setDeleteConfirm(null);
      showToast(error.message, 'error');
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (fileIds: number[]) => api.bulkDeleteLibrary(fileIds, []),
    onSuccess: (_, fileIds) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
      showToast(t('fileManager.toast.filesDeleted', { count: fileIds.length }), 'success');
      setSelectedFiles([]);
      setDeleteConfirm(null);
    },
    onError: (error: Error) => {
      setDeleteConfirm(null);
      showToast(error.message, 'error');
    },
  });

  const moveFilesMutation = useMutation({
    mutationFn: ({ fileIds, folderId }: { fileIds: number[]; folderId: number | null }) =>
      api.moveLibraryFiles(fileIds, folderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      setSelectedFiles([]);
      setShowMoveModal(false);
      showToast(t('fileManager.toast.filesMoved'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const updateFolderMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: LibraryFolderUpdate }) =>
      api.updateLibraryFolder(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      // Invalidate project/archive folder queries so other pages see the update
      queryClient.invalidateQueries({ queryKey: ['project-folders'] });
      queryClient.invalidateQueries({ queryKey: ['archive-folders'] });
      setLinkFolder(null);
      const isUnlink = variables.data.project_id === 0 && variables.data.archive_id === 0;
      showToast(isUnlink ? t('fileManager.toast.folderUnlinked') : t('fileManager.toast.folderLinked'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const renameFileMutation = useMutation({
    mutationFn: ({ id, filename }: { id: number; filename: string }) =>
      api.updateLibraryFile(id, { filename }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      setRenameItem(null);
      showToast(t('fileManager.toast.fileRenamed'), 'success');
    },
    onError: (error: Error) => {
      setRenameItem(null);
      showToast(error.message, 'error');
    },
  });

  const renameFolderMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.updateLibraryFolder(id, { name }),
    onSuccess: () => {
      // Invalidate both folders and files - files may display folder info
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      setRenameItem(null);
      showToast(t('fileManager.toast.folderRenamed'), 'success');
    },
    onError: (error: Error) => {
      setRenameItem(null);
      showToast(error.message, 'error');
    },
  });

  const batchThumbnailMutation = useMutation({
    mutationFn: () => api.batchGenerateStlThumbnails({ all_missing: true }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      // Update thumbnail versions for cache busting
      if (result.succeeded > 0) {
        const now = Date.now();
        const newVersions: Record<number, number> = {};
        result.results.forEach((r) => {
          if (r.success) {
            newVersions[r.file_id] = now;
          }
        });
        setThumbnailVersions((prev) => ({ ...prev, ...newVersions }));
      }
      if (result.succeeded > 0 && result.failed === 0) {
        showToast(t('fileManager.toast.thumbnailsGenerated', { count: result.succeeded }), 'success');
      } else if (result.succeeded > 0 && result.failed > 0) {
        showToast(t('fileManager.toast.thumbnailsGeneratedPartial', { succeeded: result.succeeded, failed: result.failed }), 'success');
      } else if (result.processed === 0) {
        showToast(t('fileManager.toast.noStlMissingThumbnails'), 'info');
      } else {
        showToast(t('fileManager.toast.failedToGenerateThumbnails', { error: result.results[0]?.error || 'Unknown error' }), 'error');
      }
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const singleThumbnailMutation = useMutation({
    mutationFn: (fileId: number) => api.batchGenerateStlThumbnails({ file_ids: [fileId] }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      // Update thumbnail version for cache busting
      if (result.succeeded > 0) {
        const fileId = result.results[0]?.file_id;
        if (fileId) {
          setThumbnailVersions((prev) => ({ ...prev, [fileId]: Date.now() }));
        }
        showToast(t('fileManager.toast.thumbnailGenerated'), 'success');
      } else {
        showToast(t('fileManager.toast.failedToGenerateThumbnail', { error: result.results[0]?.error || 'Unknown error' }), 'error');
      }
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  // Helper to check if a file is sliced (printable)
  const isSlicedFile = useCallback((filename: string) => {
    const lower = filename.toLowerCase();
    return lower.endsWith('.gcode') || lower.includes('.gcode.');
  }, []);

  // Get sliced files from selection
  const selectedSlicedFiles = useMemo(() => {
    if (!files) return [];
    return flattenGrouped(files).filter(f => selectedFiles.includes(f.id) && isSlicedFile(f.filename));
  }, [files, selectedFiles, isSlicedFile]);

  // Which part of the selection the user can actually see. Computed off the
  // loaded listing only — while `files` is in flight everything would look
  // off-screen, and flashing "7 not in this view" on every refetch is exactly
  // the kind of lie this ticket is about.
  const offscreenSelected = useMemo(() => {
    if (!files) return [];
    const visible = new Set(flatFiles.map((f) => f.id));
    return selectedFiles.filter((id) => !visible.has(id));
  }, [files, flatFiles, selectedFiles]);

  // Every selected file by name, off-screen ones flagged. Names come from the
  // live listing when the file is visible (so a rename is reflected) and from
  // the capture-at-select-time record when it is not.
  const selectedFileEntries = useMemo(() => {
    const offscreen = new Set(offscreenSelected);
    return selectedFiles.map((id) => ({
      id,
      name: flatFiles.find((f) => f.id === id)?.filename ?? selectedNames[id] ?? `#${id}`,
      offscreen: offscreen.has(id),
    }));
  }, [selectedFiles, flatFiles, selectedNames, offscreenSelected]);

  // Handlers
  const handleFileSelect = useCallback((id: number) => {
    // Always toggle selection (multi-select by default)
    setSelectedFiles((prev) => {
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
    setSelectedNames((prev) => {
      const filename = flatFiles.find((f) => f.id === id)?.filename;
      return filename ? { ...prev, [id]: filename } : prev;
    });
    // ...and point the inspector at the clicked file (spec §7 step 3). Set
    // rather than toggled: clicking through a folder must update the panel in
    // place, never flicker it shut and open again. Closing is the X's job.
    setInspectedFileId(id);
  }, [flatFiles]);

  const handleCloseInspector = useCallback(() => setInspectedFileId(null), []);

  // Adds the visible listing to the selection instead of replacing it: silently
  // dropping an off-screen selection would be the same lie in the other
  // direction. The button says "in view" whenever that distinction is live.
  const handleSelectAll = useCallback(() => {
    if (flatFiles.length > 0) {
      setSelectedFiles((prev) => [...new Set([...prev, ...flatFiles.map((f) => f.id)])]);
      setSelectedNames((prev) => ({
        ...prev,
        ...Object.fromEntries(flatFiles.map((f) => [f.id, f.filename])),
      }));
    }
  }, [flatFiles]);

  // Clears the whole selection, off-screen included — never just the visible part.
  const handleDeselectAll = useCallback(() => {
    setSelectedFiles([]);
  }, []);

  const handleUploadComplete = () => {
    queryClient.invalidateQueries({ queryKey: ['library-files'] });
    queryClient.invalidateQueries({ queryKey: ['library-folders'] });
    queryClient.invalidateQueries({ queryKey: ['library-stats'] });
  };

  // Page-wide drag-and-drop upload (#1510). Disabled when the user lacks
  // library:upload so a non-uploader can't accidentally show the overlay,
  // and also disabled while the upload modal itself is open so drags into
  // the modal's own drop zone don't bubble up and flash the page overlay
  // behind it.
  const canUpload = hasPermission('library:upload');
  const { isDraggingOver, dragHandlers } = usePageFileDrop({
    disabled: !canUpload || showUploadModal,
    onFiles: (files) => {
      setDroppedFiles(files);
      setShowUploadModal(true);
    },
  });

  const handleDownload = (id: number) => {
    api.downloadLibraryFile(id).catch((err) => {
      console.error('Library file download failed:', err);
    });
  };

  const handleDeleteConfirm = () => {
    if (!deleteConfirm) return;
    if (deleteConfirm.type === 'file') {
      deleteFileMutation.mutate(deleteConfirm.id);
    } else if (deleteConfirm.type === 'folder') {
      deleteFolderMutation.mutate(deleteConfirm.id);
    } else if (deleteConfirm.type === 'bulk') {
      bulkDeleteMutation.mutate(selectedFiles);
    }
  };

  const isDeleting = deleteFolderMutation.isPending || deleteFileMutation.isPending || bulkDeleteMutation.isPending;

  // What the delete confirmation lists by name. A single-file delete fired from
  // a file card is already on screen and keeps its plain message; one fired
  // from the selection can point at a file the user cannot see, so it gets the
  // same named list as a bulk delete.
  const deleteEntries = useMemo(() => {
    if (!deleteConfirm || deleteConfirm.type === 'folder') return [];
    if (deleteConfirm.type === 'bulk') return selectedFileEntries;
    return selectedFileEntries.filter((e) => e.id === deleteConfirm.id && e.offscreen);
  }, [deleteConfirm, selectedFileEntries]);

  const handleViewModeChange = (mode: 'grid' | 'list') => {
    setViewMode(mode);
    localStorage.setItem('library-view-mode', mode);
  };

  const isLoading = foldersLoading || filesLoading;

  // Find the selected folder in the tree to check external status
  const selectedFolder = useMemo(() => {
    if (!selectedFolderId || !folders) return null;
    const findFolder = (items: LibraryFolderTree[]): LibraryFolderTree | null => {
      for (const item of items) {
        if (item.id === selectedFolderId) return item;
        const found = findFolder(item.children);
        if (found) return found;
      }
      return null;
    };
    return findFolder(folders);
  }, [selectedFolderId, folders]);

  // One inspector, two presentations: a rail beside the grid on a desktop, a
  // drag-to-resize bottom sheet on a phone (spec §7 step 3, mockup screen 1
  // option A). The element is built once here and mounted in exactly one of the
  // two places below, so there is no second panel and no second selection state
  // to keep in sync — only `className` differs.
  const inspectorPanel = inspectedFile ? (
    <FileInspectorPanel
      file={inspectedFile}
      plateCount={inspectedPlates?.plates.length || null}
      onClose={handleCloseInspector}
      onPrint={setPrintFile}
      onSlice={setSliceFile}
      useSlicerApi={settings?.use_slicer_api ?? false}
      onDownload={handleDownload}
      onRename={(f) => setRenameItem({ type: 'file', id: f.id, name: f.filename })}
      onDelete={(id) => setDeleteConfirm({ type: 'file', id })}
      onPreview3d={(f) => {
        if (isSlicedFilename(f.filename)) {
          navigate(`/gcode-viewer?library_file=${f.id}`);
        } else {
          setViewerFile(f);
        }
      }}
      onTagClick={toggleTagFilter}
      thumbnailVersions={thumbnailVersions}
      hasPermission={hasPermission}
      canModify={canModify}
      t={t}
      className={
        isMobile ? 'w-full h-full min-h-0' : 'w-full lg:w-80 lg:flex-shrink-0 lg:max-h-full'
      }
    />
  ) : null;

  return (
    <div
      className="p-4 md:p-8 min-h-[calc(100vh-64px)] lg:h-[calc(100vh-64px)] flex flex-col relative"
      {...dragHandlers}
    >
      {/* Drag & Drop Overlay — page-wide file upload (#1510) */}
      {isDraggingOver && (
        <div className="fixed inset-0 z-50 bg-bambu-dark/90 flex items-center justify-center pointer-events-none">
          <div className="border-4 border-dashed border-bambu-green rounded-xl p-12 text-center">
            <Upload className="w-16 h-16 mx-auto mb-4 text-bambu-green" />
            <p className="text-2xl font-semibold text-white mb-2">{t('fileManager.dropFilesHere')}</p>
            <p className="text-bambu-gray">{t('fileManager.releaseToUpload')}</p>
          </div>
        </div>
      )}

      {/* Header */}
      <FileManagerToolbar
        viewMode={viewMode}
        handleViewModeChange={handleViewModeChange}
        batchThumbnailMutation={batchThumbnailMutation}
        trashCount={trashCount}
        setShowExternalFolderModal={setShowExternalFolderModal}
        setShowNewFolderModal={setShowNewFolderModal}
        setShowTagsModal={setShowTagsModal}
        setShowPurgeModal={setShowPurgeModal}
        setShowUploadModal={setShowUploadModal}
        hasPermission={hasPermission}
        hasAnyPermission={hasAnyPermission}
        t={t}
      />

      {/* Disk space warning */}
      {isDiskSpaceLow && stats && settings && (
        <div className="flex items-center gap-3 mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-amber-500 font-medium">{t('fileManager.lowDiskSpaceWarning')}</p>
            <p className="text-xs text-amber-500/80">
              {t('fileManager.lowDiskSpaceDetails', { free: formatFileSize(stats.disk_free_bytes), total: formatFileSize(stats.disk_total_bytes), threshold: settings.library_disk_warning_gb })}
            </p>
          </div>
        </div>
      )}

      {/* Stats bar */}
      {stats && (
        <div className="flex flex-wrap items-center gap-3 sm:gap-6 mb-6 p-3 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary">
          <div className="flex items-center gap-2 text-sm">
            <File className="w-4 h-4 text-bambu-green" />
            <span className="text-bambu-gray">{t('fileManager.files')}:</span>
            <span className="text-white font-medium">{stats.total_files}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <FolderOpen className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span className="text-bambu-gray">{t('fileManager.folders')}:</span>
            <span className="text-white font-medium">{stats.total_folders}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <HardDrive className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            <span className="text-bambu-gray">{t('fileManager.size')}:</span>
            <span className="text-white font-medium">{formatFileSize(stats.total_size_bytes)}</span>
          </div>
          <div className="flex items-center gap-2 text-sm sm:ml-auto">
            <span className="text-bambu-gray">{t('fileManager.free')}:</span>
            <span className={`font-medium ${isDiskSpaceLow ? 'text-amber-500' : 'text-white'}`}>
              {formatFileSize(stats.disk_free_bytes)}
            </span>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col lg:flex-row gap-4 lg:gap-6 min-h-0">
        <FolderSidebar
          folders={folders}
          sortedFolders={sortedFolders}
          selectedFolderId={selectedFolderId}
          setSelectedFolderId={setSelectedFolderId}
          topLevelView={topLevelView}
          setTopLevelView={setTopLevelView}
          sidebarRef={sidebarRef}
          sidebarWidth={sidebarWidth}
          setSidebarWidth={setSidebarWidth}
          isResizing={isResizing}
          setIsResizing={setIsResizing}
          folderSortField={folderSortField}
          setFolderSortField={setFolderSortField}
          folderSortDirection={folderSortDirection}
          setFolderSortDirection={setFolderSortDirection}
          collapseFoldersByDefault={collapseFoldersByDefault}
          setCollapseFoldersByDefault={setCollapseFoldersByDefault}
          wrapFolderNames={wrapFolderNames}
          setWrapFolderNames={setWrapFolderNames}
          onDeleteFolder={(id) => setDeleteConfirm({ type: 'folder', id })}
          onLinkFolder={setLinkFolder}
          onRenameFolder={(f) => setRenameItem({ type: 'folder', id: f.id, name: f.name })}
          hasPermission={hasPermission}
          t={t}
        />

        {/* Files area + README rail (#2520 item 2). On wide screens the
            README docks as a collapsible right-hand column (rendered after
            the files column, below) so it no longer steals vertical space
            from the file list; on narrow screens it stacks above the list
            via `order-first` and the page itself scrolls. */}
        <div className="flex-1 flex flex-col lg:flex-row min-w-0 min-h-0 gap-4 lg:gap-6">
          <FileGrid
            tagCatalog={tagCatalog}
            selectedTagIds={selectedTagIds}
            setSelectedTagIds={setSelectedTagIds}
            toggleTagFilter={toggleTagFilter}
            selectedFolder={selectedFolder}
            selectedFolderId={selectedFolderId}
            scanExternalFolderMutation={scanExternalFolderMutation}
            files={files}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            searchExpandsSubfolders={searchExpandsSubfolders}
            filterType={filterType}
            setFilterType={setFilterType}
            fileTypes={fileTypes}
            filterUsername={filterUsername}
            setFilterUsername={setFilterUsername}
            users={users}
            sortField={sortField}
            setSortField={setSortField}
            sortDirection={sortDirection}
            setSortDirection={setSortDirection}
            showModified={showModified}
            setShowModified={setShowModified}
            filteredAndSortedFiles={filteredAndSortedFiles}
            selectedFiles={selectedFiles}
            offscreenSelectedCount={offscreenSelected.length}
            flatFiles={flatFiles}
            selectedSlicedFiles={selectedSlicedFiles}
            handleSelectAll={handleSelectAll}
            handleDeselectAll={handleDeselectAll}
            setShowMoveModal={setShowMoveModal}
            setShowBulkTagsModal={setShowBulkTagsModal}
            isLoading={isLoading}
            topLevelView={topLevelView}
            setShowUploadModal={setShowUploadModal}
            viewMode={viewMode}
            inspectedFile={inspectedFile}
            isMobile={isMobile}
            handleFileSelect={handleFileSelect}
            handleDownload={handleDownload}
            setPrintFile={setPrintFile}
            setSliceFile={setSliceFile}
            setRunPipelineFile={setRunPipelineFile}
            setViewerFile={setViewerFile}
            setRenameItem={setRenameItem}
            setDeleteConfirm={setDeleteConfirm}
            singleThumbnailMutation={singleThumbnailMutation}
            thumbnailVersions={thumbnailVersions}
            settings={settings}
            navigate={navigate}
            hasPermission={hasPermission}
            hasAnyPermission={hasAnyPermission}
            canModify={canModify}
            authEnabled={authEnabled}
            t={t}
          />
          {/* File inspector — a sibling of the grid inside the same lg:flex-row
              row, not a route. Rendered from `inspectedFile` with no `key`, so
              clicking another file re-renders this same instance with a new
              `file` prop; React never unmounts it and the panel updates in
              place. That is the whole reason for this layout (spec §3).
              On a phone the same element goes into the bottom sheet below
              instead, where it would only be squeezed into this row. */}
          {!isMobile && inspectorPanel}
          {/* README rail — collapsible right column on lg+, stacks on top
              on mobile. See the files-area wrapper comment above (#2520). */}
          {selectedFolderId !== null && <FolderReadmePanel folderId={selectedFolderId} />}
        </div>
      </div>

      {/* Phone presentation of the inspector: the same element as the desktop
          rail, in a sheet you drag up to full height and down to dismiss
          (mockup screen 1 option A, phone column). Mounted out here rather than
          in the files row because it is fixed to the viewport, not laid out. */}
      {isMobile && inspectorPanel && (
        <BottomSheet onDismiss={handleCloseInspector} closeLabel={t('common.close')}>
          {inspectorPanel}
        </BottomSheet>
      )}

      {/* Modals */}
      {showNewFolderModal && (
        <NewFolderModal
          parentId={selectedFolderId}
          onClose={() => setShowNewFolderModal(false)}
          onSave={(data) => createFolderMutation.mutate(data)}
          isLoading={createFolderMutation.isPending}
          t={t}
        />
      )}

      {showExternalFolderModal && (
        <ExternalFolderModal
          onClose={() => setShowExternalFolderModal(false)}
          onSave={(data) => createExternalFolderMutation.mutate(data)}
          isLoading={createExternalFolderMutation.isPending}
          t={t}
        />
      )}

      {showMoveModal && folders && (
        <MoveFilesModal
          folders={folders}
          selectedFiles={selectedFiles}
          offscreenSelectedCount={offscreenSelected.length}
          currentFolderId={selectedFolderId}
          onClose={() => setShowMoveModal(false)}
          onMove={(folderId) => moveFilesMutation.mutate({ fileIds: selectedFiles, folderId })}
          isLoading={moveFilesMutation.isPending}
          t={t}
        />
      )}

      {showUploadModal && (
        <FileUploadModal
          folderId={selectedFolderId}
          onClose={() => {
            setShowUploadModal(false);
            setDroppedFiles([]);
          }}
          onUploadComplete={handleUploadComplete}
          initialFiles={droppedFiles.length > 0 ? droppedFiles : undefined}
        />
      )}

      {showPurgeModal && (
        <PurgeOldFilesModal onClose={() => setShowPurgeModal(false)} />
      )}

      <LibraryTagsModal
        open={showTagsModal}
        onClose={() => setShowTagsModal(false)}
        onPickTag={(tagId) => {
          if (!selectedTagIds.includes(tagId)) {
            setSelectedTagIds((prev) => [...prev, tagId]);
          }
        }}
      />

      <BulkTagsPickerModal
        open={showBulkTagsModal}
        fileIds={selectedFiles}
        offscreenCount={offscreenSelected.length}
        onClose={() => setShowBulkTagsModal(false)}
      />

      {linkFolder && (
        <LinkFolderModal
          folder={linkFolder}
          onClose={() => setLinkFolder(null)}
          onLink={(data) => updateFolderMutation.mutate({ id: linkFolder.id, data })}
          isLoading={updateFolderMutation.isPending}
          t={t}
        />
      )}

      {deleteConfirm && (
        <ConfirmModal
          title={
            deleteConfirm.type === 'folder'
              ? t('fileManager.deleteFolder')
              : deleteConfirm.type === 'bulk'
              ? t('fileManager.deleteFilesCount', { count: deleteConfirm.count })
              : t('fileManager.deleteFile')
          }
          message={
            deleteConfirm.type === 'folder'
              ? t('fileManager.deleteFolderConfirm')
              : deleteConfirm.type === 'bulk'
              ? t('fileManager.deleteFilesConfirm', { count: deleteConfirm.count })
              : t('fileManager.deleteFileConfirm')
          }
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={isDeleting}
          loadingText={t('fileManager.deleting')}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteConfirm(null)}
        >
          {/* Delete is irreversible and the selection may reach outside the
              current view, so this is the last place the user can catch it:
              name every file, and mark the ones they cannot see (#37). */}
          {deleteEntries.length > 0 && (
            <div className="mb-4">
              <p className="text-sm text-bambu-gray mb-2">{t('fileManager.filesToDelete')}</p>
              <ul className="max-h-40 overflow-y-auto text-sm bg-bambu-dark rounded-lg border border-bambu-dark-tertiary divide-y divide-bambu-dark-tertiary">
                {deleteEntries.map((entry) => (
                  <li key={entry.id} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="text-white truncate">{entry.name}</span>
                    {entry.offscreen && (
                      <span className="ml-auto flex-shrink-0 text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500">
                        {t('fileManager.notInThisView')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </ConfirmModal>
      )}

      {printFile && (
        <PrintModal
          mode="create"
          libraryFileId={printFile.id}
          archiveName={printFile.print_name || printFile.filename}
          onClose={() => setPrintFile(null)}
          onSuccess={() => {
            setPrintFile(null);
            setSelectedFiles([]);
            queryClient.invalidateQueries({ queryKey: ['library-files'] });
            queryClient.invalidateQueries({ queryKey: ['queue'] });
            queryClient.invalidateQueries({ queryKey: ['archives'] });
          }}
        />
      )}

      {sliceFile && (
        <SliceModal
          source={{ kind: 'libraryFile', id: sliceFile.id, filename: sliceFile.filename }}
          onClose={() => setSliceFile(null)}
        />
      )}

      {runPipelineFile && (
        <RunWithPipelineModal
          source={{ kind: 'libraryFile', id: runPipelineFile.id, filename: runPipelineFile.filename }}
          onClose={() => setRunPipelineFile(null)}
        />
      )}

      {viewerFile && (
        <ModelViewerModal
          libraryFileId={viewerFile.id}
          title={viewerFile.print_name || viewerFile.filename}
          fileType={viewerFile.file_type}
          onClose={() => setViewerFile(null)}
          onSliceWithBambuddy={
            // Only offer in-app slicing on files the SliceModal can actually
            // handle (matches the file-row Cog visibility check at :2127).
            isSliceableFilename(viewerFile.filename) && hasPermission('library:upload')
              ? () => {
                  const f = viewerFile;
                  setViewerFile(null);
                  setSliceFile(f);
                }
              : undefined
          }
        />
      )}

      {renameItem && (
        <RenameModal
          type={renameItem.type}
          currentName={renameItem.name}
          onClose={() => setRenameItem(null)}
          onSave={(newName) => {
            if (renameItem.type === 'file') {
              renameFileMutation.mutate({ id: renameItem.id, filename: newName });
            } else {
              renameFolderMutation.mutate({ id: renameItem.id, name: newName });
            }
          }}
          isLoading={renameFileMutation.isPending || renameFolderMutation.isPending}
          t={t}
        />
      )}
    </div>
  );
}
