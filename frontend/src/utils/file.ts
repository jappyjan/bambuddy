/**
 * Formats a byte count into a human-readable string (e.g. `1.5 MB`).
 *
 * @param bytes - The number of bytes to format.
 * @returns A formatted string with the appropriate unit (B, KB, MB, GB, or TB).
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  const size = bytes / Math.pow(k, i);

  // No decimals for bytes, 1 decimal for larger units
  return i === 0
    ? `${size} ${units[i]}`
    : `${size.toFixed(1)} ${units[i]}`;
}

// Helper to check if a file is sliced (printable)
export function isSlicedFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.gcode') || lower.endsWith('.gcode.3mf');
}

// Files that can be fed to the slicer sidecar (model geometry inputs).
// Excludes .gcode.* (already sliced) and any other non-model formats.
export function isSliceableFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gcode') || lower.endsWith('.gcode.3mf')) return false;
  return lower.endsWith('.stl') || lower.endsWith('.3mf') || lower.endsWith('.step') || lower.endsWith('.stp');
}
