/**
 * The slicer page's left rail (#15, step-5.3; mockup screen 2, desktop layout).
 *
 * Top to bottom: the printer group (printer model + build-plate cards and the
 * nozzle diameter — `PrinterPicker`, #44), process, the filament slot grid,
 * then `ProcessSettingsEditor` filling whatever height is left. Presentation only —
 * every value and every setter comes from the page, which owns the selection
 * because the action bar has to fingerprint the same one (see
 * `sliceSelection.ts`). Splitting it out keeps the page about *wiring* and this
 * file about *layout*, and lets the mobile wizard (#11) reuse the field set
 * without inheriting the desktop arrangement.
 *
 * The process and filament controls are the same `PresetDropdown` the
 * `SliceModal` renders, and the build plate the same `BedTypeDropdown`, so the
 * two entry points cannot offer different presets. Two controls differ: the
 * rail splits the printer across model and nozzle diameter (#44) while the
 * modal keeps the flat dropdown, and the rail wraps the filament dropdowns in
 * `FilamentSlotGrid` (#45) so slots can be added, removed and coloured. Both
 * still select `PresetRef`s out of the same lists, so what reaches the
 * slicer — and the fingerprint — is the same shape either way.
 *
 * ## Sections (#24, step-6.1)
 *
 * The mobile wizard shows one group of these controls per screen. Rather than
 * copy the dropdowns into a phone component — where they would drift from the
 * desktop's the first time a slot rule changed — the rail renders a *subset* of
 * itself on request: `sections={['filaments']}` is the same JSX, the same
 * disabled rules, the same labels. Default is every section, which is the
 * desktop rail unchanged.
 *
 * ## Collapsing them (#46, rail.3)
 *
 * With `collapsible`, those same three groups become Bambu Studio's three
 * disclosure panels — *Printer & quality*, *Filament*, *Print settings* — and
 * each remembers whether it is open. Only the desktop page asks for it; the
 * wizard already puts one group on each screen, so a chevron there would be a
 * second, contradictory way to hide the step you are standing on.
 *
 * Three things are deliberate:
 *
 * 1. **Closed sections are hidden, not unmounted** (`keepMounted`). Nothing in
 *    a closed section stops reaching the slice request either way — the page
 *    owns every value the rail edits — but the *controls* own state of their
 *    own that nothing else records: `PrinterPicker`'s unmatched model/diameter
 *    pair (the only reason Slice is off, and the only record of what was
 *    asked for), the settings editor's search text and tier. Unmounting would
 *    throw those away on a chevron click.
 * 2. **All three start open**, and each remembers its own state from there.
 *    Both the default and where it is stored live in `railSections.ts`.
 * 3. **No section scrolls.** The settings editor's field list is still the
 *    rail's only scroll area — a closed section takes no height, and an open
 *    one grows the editor rather than nesting a second scroller inside it.
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Palette, Printer, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { PresetRef, UnifiedPresetsResponse } from '../../api/client';
import type { PrinterCompatibilityIndex } from '../../utils/slicerPrinterMatch';
import type { FilamentTypeWarning } from '../../utils/slicePresetPicker';
import { Collapsible } from '../Collapsible';
import { FilamentSlotGrid } from './FilamentSlotGrid';
import type { FilamentSlotState } from './filamentSlots';
import { PresetDropdown } from './PresetControls';
import { PrinterPicker } from './PrinterPicker';
import { ProcessSettingsEditor } from './ProcessSettingsEditor';
import type { ProcessField, ProcessOverrides, ResolvedProcess } from './processFields';
import {
  ALL_RAIL_SECTIONS,
  storeSectionOpen,
  storedSectionOpen,
  type SlicerRailSection,
} from './railSections';

export type { SlicerRailSection };

export interface SlicerRailProps {
  presets: UnifiedPresetsResponse | undefined;
  presetsLoading: boolean;
  presetsError: boolean;
  isRefreshing: boolean;
  onRefreshPresets: () => void;

  printerPreset: PresetRef | null;
  onPrinterPresetChange: (ref: PresetRef | null) => void;
  processPreset: PresetRef | null;
  onProcessPresetChange: (ref: PresetRef | null) => void;
  /** One entry per plate slot, in plate order. */
  filamentPresets: (PresetRef | null)[];
  /** The material honesty guard (#47), one entry per slot. Passed straight
   *  through to `FilamentSlotGrid` from `useSlicePresets`. */
  filamentTypeWarnings?: (FilamentTypeWarning | null)[];
  onFilamentPresetChange: (index: number, ref: PresetRef | null) => void;
  /**
   * The page's **owned** slot list (#45), seeded from the plate's requirements.
   * Drives the labels, the badge colours and the used/unused gating.
   */
  filamentSlots: FilamentSlotState[];
  filamentSlotsLoading: boolean;
  /** Slot-list edits (#45). Every one of them is refused by the page when it
   *  would move a slot the plate paints with — see `filamentSlots.ts`. */
  onAddFilamentSlot: () => void;
  onInsertFilamentSlotAfter: (index: number) => void;
  onRemoveFilamentSlot: (index: number) => void;
  onFilamentSlotColorChange: (index: number, color: string | null) => void;
  bedType: string | null;
  onBedTypeChange: (value: string | null) => void;

  /** "Slice as designed" (#2611); the toggle only renders when offered. */
  useEmbedded: boolean;
  onUseEmbeddedChange: (value: boolean) => void;
  canUseEmbedded: boolean;

  selectedPrinterName: string | null;
  compatIndex: PrinterCompatibilityIndex;

  /** `GET /slicer/process-fields` → `.fields`. */
  processFields: ProcessField[];
  /** `GET /slicer/resolved-process`; null while loading or for `standard`. */
  resolvedProcess: ResolvedProcess | null;
  processFieldsLoading: boolean;
  processFieldsError: string | null;
  overrides: ProcessOverrides;
  onOverridesChange: (overrides: ProcessOverrides) => void;

  /** Everything is read-only while a slice is in flight. */
  disabled?: boolean;
  /**
   * Which control groups to render, in the rail's own order. Defaults to all
   * three — the desktop rail. The mobile wizard (#24) asks for one at a time.
   */
  sections?: SlicerRailSection[];
  /**
   * Render each group as a collapsible section whose state is remembered
   * (#46). Desktop only — the mobile wizard shows one group per step and must
   * not offer a second way to hide it.
   */
  collapsible?: boolean;
  className?: string;
}

export function SlicerRail({
  presets,
  presetsLoading,
  presetsError,
  isRefreshing,
  onRefreshPresets,
  printerPreset,
  onPrinterPresetChange,
  processPreset,
  onProcessPresetChange,
  filamentPresets,
  filamentTypeWarnings,
  onFilamentPresetChange,
  filamentSlots,
  filamentSlotsLoading,
  onAddFilamentSlot,
  onInsertFilamentSlotAfter,
  onRemoveFilamentSlot,
  onFilamentSlotColorChange,
  bedType,
  onBedTypeChange,
  useEmbedded,
  onUseEmbeddedChange,
  canUseEmbedded,
  selectedPrinterName,
  compatIndex,
  processFields,
  resolvedProcess,
  processFieldsLoading,
  processFieldsError,
  overrides,
  onOverridesChange,
  disabled = false,
  sections = ALL_RAIL_SECTIONS,
  collapsible = false,
  className = '',
}: SlicerRailProps) {
  const { t } = useTranslation();

  const showPresetPickers = sections.includes('presets');
  const showFilaments = sections.includes('filaments');
  const showSettings = sections.includes('settings');
  // The heading and its Refresh belong to the preset *lists*, which both the
  // picker group and the filament grid read — so they follow either of those,
  // and a settings-only rail is just the editor.
  const showPresetHeader = showPresetPickers || showFilaments;

  const [openSections, setOpenSections] = useState<Record<SlicerRailSection, boolean>>(() => ({
    presets: storedSectionOpen('presets'),
    filaments: storedSectionOpen('filaments'),
    settings: storedSectionOpen('settings'),
  }));

  // Written before the state update, not in an effect: the preference is the
  // click, and an effect would also fire on the initial read-back, writing the
  // default over a value the user had not touched.
  const toggleSection = useCallback((section: SlicerRailSection, open: boolean) => {
    storeSectionOpen(section, open);
    setOpenSections((current) => ({ ...current, [section]: open }));
  }, []);

  /**
   * A group, wrapped in its disclosure panel when the caller asked for one and
   * handed back untouched when it did not — which is what keeps the wizard's
   * steps and the flat rail literally the same JSX.
   *
   * `grow` marks the one section that takes the rail's leftover height (the
   * settings editor). It only grows while open; a closed section that kept
   * `flex-1` would hold a column of empty space under its own header.
   */
  const asSection = (
    id: SlicerRailSection,
    icon: ReactNode,
    title: string,
    collapsedSummary: ReactNode,
    body: ReactNode,
    grow = false,
  ): ReactNode => {
    if (!collapsible) return body;
    const open = openSections[id];
    const growing = grow && open;
    return (
      <Collapsible
        open={open}
        onToggle={(next) => toggleSection(id, next)}
        // See the module header: hidden, never unmounted.
        keepMounted
        className={`border-t border-bambu-dark-tertiary pt-2 ${growing ? 'flex min-h-0 flex-1 flex-col' : ''}`}
        summaryClassName="py-0.5"
        contentClassName={growing ? 'mt-2 flex min-h-0 flex-1 flex-col' : 'mt-2'}
        summary={
          <div className="flex items-center gap-2" data-testid={`rail-section-${id}`}>
            {icon}
            <h2 className="text-xs font-semibold uppercase tracking-wider text-bambu-gray">
              {title}
            </h2>
            {/* What the section is holding while it is shut. Rendered only
                when closed, so nothing is said twice on an open rail. */}
            {!open && collapsedSummary != null && (
              <span
                data-testid={`rail-section-${id}-summary`}
                className="ml-auto min-w-0 truncate text-[10px] text-bambu-gray/80"
              >
                {collapsedSummary}
              </span>
            )}
          </div>
        }
      >
        {body}
      </Collapsible>
    );
  };

  const filamentsChosen = filamentPresets
    .slice(0, filamentSlots.length)
    .filter((ref) => ref != null).length;
  const overrideCount = Object.keys(overrides).length;

  // The three groups, built once and then either wrapped in a disclosure
  // panel or dropped straight into the rail — one definition, so a collapsible
  // rail and a wizard step cannot drift apart. `presets` gates them because
  // every control in them reads a preset list.
  const printerGroup = presets ? (
    <div className="flex flex-col gap-2">
      {/* Printer model + build plate as cards, nozzle diameter below
          them (#44). Produces the same single `PresetRef` the flat
          dropdown did — see `PrinterPicker`, including why there is no
          Flow control. Locked in embedded mode for the same reason the
          modal locks its dropdown (#2611): the pick is unused on that
          path, and changing it away from the design's target would drop
          canUseEmbedded and yank the toggle out from under the user. */}
      <PrinterPicker
        data={presets}
        value={printerPreset}
        onChange={onPrinterPresetChange}
        bedType={bedType}
        onBedTypeChange={onBedTypeChange}
        disabled={disabled || useEmbedded}
      />

      {canUseEmbedded && (
        <label className="flex cursor-pointer select-none items-start gap-2 text-xs text-bambu-gray">
          <input
            type="checkbox"
            checked={useEmbedded}
            onChange={(event) => onUseEmbeddedChange(event.target.checked)}
            disabled={disabled}
            className="mt-0.5 cursor-pointer"
          />
          <span>
            {t('slice.useEmbedded')}
            <span className="block text-[10px] text-bambu-gray/70">
              {t('slice.useEmbeddedHint')}
            </span>
          </span>
        </label>
      )}

      <PresetDropdown
        label={t('slice.process')}
        slot="process"
        data={presets}
        value={processPreset}
        onChange={onProcessPresetChange}
        disabled={disabled || useEmbedded}
        selectedPrinterName={selectedPrinterName}
        compatIndex={compatIndex}
        selectClassName="px-2 py-1.5 text-xs"
      />
    </div>
  ) : null;

  // Bambu Studio's Project Filaments panel (#45): numbered colour-carrying
  // badges, add / remove, per-slot `⋯`. Disabled wholesale in embedded mode
  // for the same reason the other pickers are — that path slices the design's
  // own profiles, so a slot edit there would change nothing about the output.
  const filamentGroup = presets ? (
    <FilamentSlotGrid
      presets={presets}
      slots={filamentSlots}
      slotsLoading={filamentSlotsLoading}
      filamentPresets={filamentPresets}
      filamentTypeWarnings={filamentTypeWarnings}
      onFilamentPresetChange={onFilamentPresetChange}
      onAddSlot={onAddFilamentSlot}
      onInsertSlotAfter={onInsertFilamentSlotAfter}
      onRemoveSlot={onRemoveFilamentSlot}
      onSlotColorChange={onFilamentSlotColorChange}
      selectedPrinterName={selectedPrinterName}
      compatIndex={compatIndex}
      disabled={disabled || useEmbedded}
      // The section header already says "Filament".
      showHeading={!collapsible}
    />
  ) : null;

  // The editor takes the remaining height and scrolls internally, so the
  // preset triplet above it never leaves the viewport. Disabled wholesale in
  // embedded mode: overrides patch the resolved process JSON, which that path
  // does not send, so an override there would do nothing.
  const settingsGroup = (
    <ProcessSettingsEditor
      className={
        collapsible ? 'flex-1' : 'mt-1 flex-1 border-t border-bambu-dark-tertiary pt-2'
      }
      fields={processFields}
      resolvedProcess={resolvedProcess}
      overrides={overrides}
      onOverridesChange={onOverridesChange}
      disabled={disabled || useEmbedded}
      isLoading={processFieldsLoading}
      error={processFieldsError}
      // The section header already says "Print settings", with the same icon.
      showHeading={!collapsible}
    />
  );

  return (
    <aside
      data-testid="slicer-rail"
      aria-label={t('slicer.railLabel')}
      className={`flex flex-col min-h-0 gap-2 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 ${className}`}
    >
      {showPresetHeader && (
        <div className="flex items-center justify-between gap-2">
          {/* Dropped when the groups below have headers of their own: a
              fourth uppercase heading with no chevron reads as a section
              that refuses to collapse. The Refresh stays — it reloads the
              preset *lists* both sections read, so it belongs to neither. */}
          {!collapsible && (
            <h2 className="text-xs font-semibold uppercase tracking-wider text-bambu-gray">
              {t('slicer.presetsHeading')}
            </h2>
          )}
          <button
            type="button"
            onClick={onRefreshPresets}
            disabled={isRefreshing || disabled}
            title={t('slice.refreshPresetsTitle')}
            aria-label={t('slice.refreshPresets')}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            {t('slice.refreshPresets')}
          </button>
        </div>
      )}

      {showPresetHeader && presetsLoading && (
        <div className="flex items-center gap-2 text-sm text-bambu-gray">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('slice.loadingPresets')}
        </div>
      )}

      {showPresetHeader && presetsError && (
        <div className="text-sm text-red-700 dark:text-red-400" role="alert">
          {t('slice.presetsLoadFailed')}
        </div>
      )}

      {showPresetPickers &&
        printerGroup &&
        asSection(
          'presets',
          <Printer className="h-3.5 w-3.5 shrink-0 text-bambu-green" aria-hidden="true" />,
          t('slicer.sectionPrinterQuality'),
          selectedPrinterName,
          printerGroup,
        )}

      {showFilaments &&
        filamentGroup &&
        asSection(
          'filaments',
          <Palette className="h-3.5 w-3.5 shrink-0 text-bambu-green" aria-hidden="true" />,
          t('slicer.filamentHeading'),
          t('slicer.wizardChipFilamentSlots', {
            chosen: filamentsChosen,
            total: filamentSlots.length,
          }),
          filamentGroup,
        )}

      {showSettings &&
        asSection(
          'settings',
          <SlidersHorizontal
            className="h-3.5 w-3.5 shrink-0 text-bambu-green"
            aria-hidden="true"
          />,
          t('slice.settingsEditor.title'),
          overrideCount > 0
            ? t('slice.settingsEditor.overrideCount', { changed: overrideCount })
            : t('slice.settingsEditor.noOverrides'),
          settingsGroup,
          true,
        )}
    </aside>
  );
}
