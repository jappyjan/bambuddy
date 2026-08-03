/**
 * The slicer page's left rail (#15, step-5.3; mockup screen 2, desktop layout).
 *
 * Top to bottom: printer, process, build plate, the filament slot grid, then
 * `ProcessSettingsEditor` filling whatever height is left. Presentation only —
 * every value and every setter comes from the page, which owns the selection
 * because the action bar has to fingerprint the same one (see
 * `sliceSelection.ts`). Splitting it out keeps the page about *wiring* and this
 * file about *layout*, and lets the mobile wizard (#11) reuse the field set
 * without inheriting the desktop arrangement.
 *
 * The preset controls are the same `PresetDropdown` / `BedTypeDropdown` the
 * `SliceModal` renders, so the two entry points cannot offer different presets.
 *
 * ## Sections (#24, step-6.1)
 *
 * The mobile wizard shows one group of these controls per screen. Rather than
 * copy the dropdowns into a phone component — where they would drift from the
 * desktop's the first time a slot rule changed — the rail renders a *subset* of
 * itself on request: `sections={['filaments']}` is the same JSX, the same
 * disabled rules, the same labels. Default is every section, which is the
 * desktop rail unchanged.
 */

import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import type { PresetRef, UnifiedPresetsResponse } from '../../api/client';
import type { PrinterCompatibilityIndex } from '../../utils/slicerPrinterMatch';
import type { PlateFilament } from '../../types/plates';
import { BedTypeDropdown, PresetDropdown } from './PresetControls';
import { ProcessSettingsEditor } from './ProcessSettingsEditor';
import type { ProcessField, ProcessOverrides, ResolvedProcess } from './processFields';

/**
 * A group of controls the rail can render on its own.
 *
 * - `presets` — printer, "slice as designed", process, build plate
 * - `filaments` — the per-slot filament grid
 * - `settings` — `ProcessSettingsEditor`
 */
export type SlicerRailSection = 'presets' | 'filaments' | 'settings';

const ALL_SECTIONS: SlicerRailSection[] = ['presets', 'filaments', 'settings'];

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
  onFilamentPresetChange: (index: number, ref: PresetRef | null) => void;
  /** Plate slot metadata — drives the labels, swatches and used/unused gating. */
  filamentSlots: PlateFilament[];
  filamentSlotsLoading: boolean;
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
  onFilamentPresetChange,
  filamentSlots,
  filamentSlotsLoading,
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
  sections = ALL_SECTIONS,
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

  return (
    <aside
      data-testid="slicer-rail"
      aria-label={t('slicer.railLabel')}
      className={`flex flex-col min-h-0 gap-2 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 ${className}`}
    >
      {showPresetHeader && (
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-bambu-gray">
            {t('slicer.presetsHeading')}
          </h2>
          <button
            type="button"
            onClick={onRefreshPresets}
            disabled={isRefreshing || disabled}
            title={t('slice.refreshPresetsTitle')}
            aria-label={t('slice.refreshPresets')}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
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

      {presets && showPresetHeader && (
        <div className="flex flex-col gap-2">
          {showPresetPickers && (
            <>
              <PresetDropdown
                label={t('slice.printer')}
                slot="printer"
                data={presets}
                value={printerPreset}
                onChange={onPrinterPresetChange}
                // Locked in embedded mode for the same reason the modal locks
                // it (#2611): the pick is unused on that path, and changing it
                // away from the design's target would drop canUseEmbedded and
                // yank the toggle out from under the user.
                disabled={disabled || useEmbedded}
                selectClassName="px-2 py-1.5 text-xs"
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

              {/* Bed type patches curr_bed_type onto the resolved process JSON,
                  which the embedded-settings path never sends — so it has no
                  effect there and is disabled rather than implying it does. */}
              <BedTypeDropdown
                value={bedType}
                onChange={onBedTypeChange}
                disabled={disabled || useEmbedded}
              />
            </>
          )}

          {showFilaments &&
            (filamentSlotsLoading ? (
              <div className="flex items-center gap-2 py-1 text-xs text-bambu-gray">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('slice.analyzingPlateFilaments')}
              </div>
            ) : (
              <div className="flex flex-col gap-2" data-testid="filament-slots">
                {filamentSlots.map((slot, index) => {
                  // Slots the backend flagged as unused by this plate are
                  // auto-picked and disabled — the CLI still needs a profile
                  // per project slot, but the user shouldn't have to think
                  // about slots their plate doesn't paint with.
                  const isUsed = slot.used_in_plate !== false;
                  const baseLabel =
                    filamentSlots.length > 1
                      ? t('slice.filamentSlot', { index: index + 1, type: slot.type })
                      : t('slice.filament');
                  return (
                    <PresetDropdown
                      key={`filament-${index}`}
                      label={isUsed ? baseLabel : `${baseLabel} ${t('slice.notUsedByPlate')}`}
                      slot="filament"
                      data={presets}
                      value={filamentPresets[index] ?? null}
                      onChange={(ref) => onFilamentPresetChange(index, ref)}
                      disabled={disabled || !isUsed || useEmbedded}
                      swatchColor={filamentSlots.length > 1 ? slot.color : undefined}
                      selectedPrinterName={selectedPrinterName}
                      compatIndex={compatIndex}
                      selectClassName="px-2 py-1.5 text-xs"
                    />
                  );
                })}
              </div>
            ))}
        </div>
      )}

      {/* The editor takes the remaining height and scrolls internally, so the
          preset triplet above it never leaves the viewport. Disabled wholesale
          in embedded mode: overrides patch the resolved process JSON, which
          that path does not send, so an override there would do nothing. */}
      {showSettings && (
        <ProcessSettingsEditor
          className="mt-1 flex-1 border-t border-bambu-dark-tertiary pt-2"
          fields={processFields}
          resolvedProcess={resolvedProcess}
          overrides={overrides}
          onOverridesChange={onOverridesChange}
          disabled={disabled || useEmbedded}
          isLoading={processFieldsLoading}
          error={processFieldsError}
        />
      )}
    </aside>
  );
}
