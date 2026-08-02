import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../Button';
import type { TFunction } from '../../pages/FileManagerPage';

// FAT32/exFAT-illegal chars rejected by Bambu Studio (#1540). Mirrors the
// backend validator in backend/app/utils/filename.py — keep in sync.
const INVALID_FILENAME_CHARS = '<>:"/\\|?*';

function findInvalidFilenameChar(name: string): string | null {
  for (const ch of name) {
    if (INVALID_FILENAME_CHARS.includes(ch)) return ch;
    if (ch.charCodeAt(0) < 0x20) return ch;
  }
  return null;
}

// Rename Modal
interface RenameModalProps {
  type: 'file' | 'folder';
  currentName: string;
  onClose: () => void;
  onSave: (newName: string) => void;
  isLoading: boolean;
  t: TFunction;
}

export function RenameModal({ type, currentName, onClose, onSave, isLoading, t }: RenameModalProps) {
  // For files, separate the extension so users can only edit the base name
  // Handle compound extensions like .gcode.3mf
  const fileExtension = type === 'file' ? (currentName.match(/(\.gcode\.3mf|\.3mf|\.gcode)$/i)?.[1] ?? '') : '';
  const baseName = type === 'file' && fileExtension ? currentName.slice(0, -fileExtension.length) : currentName;
  const [name, setName] = useState(baseName);

  const invalidChar = type === 'file' ? findInvalidFilenameChar(name) : null;
  const filenameError = invalidChar
    ? t('fileManager.invalidFilenameChar', { char: invalidChar })
    : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (filenameError) return;
    const fullName = type === 'file' ? name.trim() + fileExtension : name.trim();
    if (name.trim() && fullName !== currentName) {
      onSave(fullName);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-sm border border-bambu-dark-tertiary">
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white">{type === 'file' ? t('fileManager.renameFile') : t('fileManager.renameFolder')}</h2>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('common.name')}
            </label>
            <div className={`flex items-center bg-bambu-dark border rounded focus-within:border-bambu-green ${filenameError ? 'border-red-500' : 'border-bambu-dark-tertiary'}`}>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 bg-transparent px-3 py-2 text-white placeholder-bambu-gray focus:outline-none min-w-0"
                autoFocus
                required
              />
              {fileExtension && (
                <span className="pr-3 text-bambu-gray text-sm select-none whitespace-nowrap">{fileExtension}</span>
              )}
            </div>
            {filenameError && (
              <p className="mt-1 text-xs text-red-700 dark:text-red-400">{filenameError}</p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || name.trim() === baseName || !!filenameError || isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.rename')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
