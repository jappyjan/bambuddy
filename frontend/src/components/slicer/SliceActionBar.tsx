/**
 * The bar under the stage: estimate, Reset layout, Save layout, Slice, Print
 * now (#15, step-5.3; mockup screen 2 — "Bottom bar: estimate, then Slice, then
 * Print now lights up once a slice exists"). Reset arrived with persistence
 * (#32).
 *
 * Presentational. It is handed `canPrintNow` rather than deciding it, because
 * the decision is the ticket's one correctness rule and belongs next to the
 * fingerprint that implements it (`sliceSelection.ts`), not in a layout
 * component. What this file *is* responsible for is that the disabled state is
 * legible: a greyed-out Print now with no explanation reads as a bug, so the
 * reason is spelled out in `title` and in the status line.
 */

import { useTranslation } from 'react-i18next';
import { Loader2, Play, Printer, RotateCcw, Save } from 'lucide-react';

export interface SliceEstimate {
  printTimeSeconds: number | null;
  filamentGrams: number | null;
}

export interface SliceActionBarProps {
  estimate: SliceEstimate | null;
  /** Second line under the estimate — printer + build plate, per the mockup. */
  contextLabel?: string | null;

  onSlice: () => void;
  canSlice: boolean;
  isSlicing: boolean;

  onPrintNow: () => void;
  /**
   * True only while the last completed slice still matches the selection on
   * screen. Never widen this without reading `sliceSelection.ts` first.
   */
  canPrintNow: boolean;
  /** A slice completed at some point — distinguishes "none yet" from "stale". */
  hasCompletedSlice: boolean;

  onSaveLayout?: () => void;
  /** True only when the plate differs from the stored arrangement (#32). */
  canSaveLayout?: boolean;
  saveLayoutHint?: string;

  /** Clear the stored arrangement and put every object back as designed. */
  onResetLayout?: () => void;
  canResetLayout?: boolean;
  resetLayoutHint?: string;

  /** A layout write is in flight; both layout buttons wait it out. */
  isSavingLayout?: boolean;

  /**
   * `bar` (default) is the desktop row under the stage. `stacked` is the same
   * bar on a phone (#24): the estimate on its own line and the four actions in
   * a 2×2 grid of full-width, thumb-sized buttons, because four buttons in a
   * row do not fit 375px and shrinking them until they do makes Slice and
   * Print now equally easy to hit by accident.
   */
  layout?: 'bar' | 'stacked';

  className?: string;
}

export function SliceActionBar({
  estimate,
  contextLabel,
  onSlice,
  canSlice,
  isSlicing,
  onPrintNow,
  canPrintNow,
  hasCompletedSlice,
  onSaveLayout,
  canSaveLayout = false,
  saveLayoutHint,
  onResetLayout,
  canResetLayout = false,
  resetLayoutHint,
  isSavingLayout = false,
  layout = 'bar',
  className = '',
}: SliceActionBarProps) {
  const { t } = useTranslation();
  const stacked = layout === 'stacked';
  // Applied to every button, so the four keep one shape in both layouts.
  const buttonLayout = stacked ? 'justify-center py-2.5 text-sm' : '';

  // Three distinct states, three distinct explanations. "Slice first" and
  // "your slice is out of date" are different problems with different fixes,
  // and collapsing them into one greyed button hides which one you have.
  const printNowTitle = canPrintNow
    ? t('slicer.printNowTitle')
    : hasCompletedSlice
      ? t('slicer.printNowStale')
      : t('slicer.printNowNeedsSlice');

  return (
    <div
      data-testid="slice-action-bar"
      className={`flex gap-3 px-3 py-2 ${stacked ? 'flex-col items-stretch' : 'flex-wrap items-center'} ${className}`}
    >
      <div className="min-w-0 text-xs leading-tight text-bambu-gray-light">
        <div data-testid="slice-estimate" className="tabular-nums">
          {estimate && (estimate.printTimeSeconds != null || estimate.filamentGrams != null)
            ? [
                estimate.printTimeSeconds != null ? formatDuration(estimate.printTimeSeconds) : null,
                estimate.filamentGrams != null ? `${estimate.filamentGrams.toFixed(1)} g` : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : t('slicer.noEstimate')}
        </div>
        {contextLabel && (
          <div className="truncate text-[10px] text-bambu-gray" title={contextLabel}>
            {contextLabel}
          </div>
        )}
      </div>

      <div className={stacked ? 'grid grid-cols-2 gap-2' : 'ml-auto flex items-center gap-2'}>
        <button
          type="button"
          onClick={onResetLayout}
          disabled={!canResetLayout || isSavingLayout}
          title={resetLayoutHint ?? t('slicer.resetLayout')}
          className={`inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary px-2.5 py-1.5 text-xs text-bambu-gray transition-colors hover:border-bambu-gray hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-bambu-dark-tertiary disabled:hover:text-bambu-gray ${buttonLayout}`}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('slicer.resetLayout')}
        </button>

        <button
          type="button"
          onClick={onSaveLayout}
          disabled={!canSaveLayout || isSavingLayout}
          title={saveLayoutHint ?? t('slicer.saveLayout')}
          className={`inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary px-2.5 py-1.5 text-xs text-bambu-gray transition-colors hover:border-bambu-gray hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-bambu-dark-tertiary disabled:hover:text-bambu-gray ${buttonLayout}`}
        >
          {isSavingLayout ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {t('slicer.saveLayout')}
        </button>

        <button
          type="button"
          onClick={onSlice}
          disabled={!canSlice || isSlicing}
          className={`inline-flex items-center gap-1.5 rounded-md bg-bambu-green px-3 py-1.5 text-xs font-medium text-bambu-dark transition-colors hover:bg-bambu-green/90 disabled:cursor-not-allowed disabled:opacity-50 ${buttonLayout}`}
        >
          {isSlicing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('slice.slicing')}
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" />
              {t('slice.action')}
            </>
          )}
        </button>

        <button
          type="button"
          onClick={onPrintNow}
          disabled={!canPrintNow}
          title={printNowTitle}
          className={`inline-flex items-center gap-1.5 rounded-md border border-bambu-green/50 bg-bambu-green/15 px-3 py-1.5 text-xs font-medium text-bambu-green transition-colors hover:bg-bambu-green/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-bambu-green/15 ${buttonLayout}`}
        >
          <Printer className="h-3.5 w-3.5" />
          {t('slicer.printNow')}
        </button>
      </div>

      {/* Said out loud as well as in the tooltip — a stale slice is the state
          most likely to be mistaken for a broken button. */}
      {hasCompletedSlice && !canPrintNow && !isSlicing && (
        <p data-testid="print-now-stale" role="status" className="w-full text-[10px] text-amber-400">
          {t('slicer.printNowStale')}
        </p>
      )}
    </div>
  );
}

/** "2h 14m" / "41m" — the mockup's estimate spelling. */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
