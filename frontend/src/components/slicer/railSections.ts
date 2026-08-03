/**
 * The slicer rail's three sections, and how their open/closed state is
 * remembered (#46, rail.3).
 *
 * Its own module rather than constants beside the component, for two reasons:
 * the persistence rule is testable without a DOM, and `SlicerRail.tsx` is a
 * component file — exporting values from it costs Fast Refresh.
 */

/**
 * A group of controls the rail can render on its own.
 *
 * - `presets` — printer model / nozzle / build plate, "slice as designed", process
 * - `filaments` — the per-slot filament grid
 * - `settings` — `ProcessSettingsEditor`
 */
export type SlicerRailSection = 'presets' | 'filaments' | 'settings';

export const ALL_RAIL_SECTIONS: SlicerRailSection[] = ['presets', 'filaments', 'settings'];

/**
 * Where each section's state is kept.
 *
 * Plain `localStorage` string flags read in a `useState` initialiser and
 * written at the toggle — the same shape the file manager uses for its own
 * view preferences (`library-view-mode`, `library-collapse-folders`, …), so
 * there is one way to persist a UI preference in this app rather than two.
 */
export const RAIL_SECTION_STORAGE_KEYS: Record<SlicerRailSection, string> = {
  presets: 'slicer-rail-printer-open',
  filaments: 'slicer-rail-filament-open',
  settings: 'slicer-rail-settings-open',
};

/**
 * **Every section starts open**, and the reasoning is worth keeping.
 *
 * The tempting default is to close *Print settings*, since it is the long one
 * and its values are already right without being touched. But the two groups
 * above it are the ones a slice cannot proceed without, and that third one is
 * where a returning user's overrides live — closing any of them on a first
 * visit makes the rail claim the page has fewer controls than it has, and a
 * user who never notices the chevrons never gets them back. Starting open is
 * also exactly what the rail looked like before this change, and what Bambu
 * Studio's own panels do, so nobody's first render after the upgrade moves.
 *
 * What the feature is actually for is the *second* visit: whichever sections
 * you closed stay closed, per section, until you open them again. Someone
 * re-slicing a known file closes Printer and Filament and keeps a full-height
 * settings editor; someone setting up a new print does the opposite. That is a
 * choice about their own workflow, and not one this default should make for
 * them on the strength of a guess about which of the two they are.
 */
export const RAIL_SECTION_DEFAULT_OPEN: Record<SlicerRailSection, boolean> = {
  presets: true,
  filaments: true,
  settings: true,
};

/** The stored preference for one section, or its default when never set. */
export function storedSectionOpen(section: SlicerRailSection): boolean {
  const saved = localStorage.getItem(RAIL_SECTION_STORAGE_KEYS[section]);
  // Absent means "never chosen", which is the default — not "closed". The
  // `=== 'true'` test the file manager uses for its default-false flags would,
  // on its own, close every section on a first visit.
  return saved == null ? RAIL_SECTION_DEFAULT_OPEN[section] : saved === 'true';
}

/** Records the user's choice for one section. */
export function storeSectionOpen(section: SlicerRailSection, open: boolean): void {
  localStorage.setItem(RAIL_SECTION_STORAGE_KEYS[section], String(open));
}
