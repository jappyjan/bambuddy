/**
 * The phone slicer: Printer → Filaments → Settings → Review, one per screen
 * (#24, step-6.1; spec §6/§7 step 6, mockup "Phone: three strategies" option C).
 *
 * ## It owns nothing
 *
 * This component holds exactly two pieces of state — which step is showing and
 * whether the full viewport is open — and neither can affect a slice. Every
 * preset, every override, the plate arrangement, `canSlice`, `canPrintNow` and
 * the estimate are computed once in `SlicerPage` and handed down, because the
 * phone and the desktop must slice the same thing for the same selection. A
 * value re-derived here would be a second implementation of a rule that already
 * exists, and the two would drift silently.
 *
 * That is why the props are three pass-through bundles (`rail`, `stage`,
 * `actions`) rather than forty flattened fields: adding a control to the rail or
 * a button to the action bar reaches the phone with no edit here at all.
 *
 * ## Print now
 *
 * `actions.canPrintNow` is rendered, never recomputed. `SlicerPage` gates it on
 * `lastSlice.fingerprint === selectionFingerprint(selection)`; the tempting
 * phone shortcut — "a slice finished, so offer the print" — would offer to print
 * an arrangement or a profile the user has since changed. Read the module header
 * in `sliceSelection.ts` before touching anything in the Review step.
 *
 * ## Reuse
 *
 * The three editing steps are `SlicerRail` rendering one of its own sections
 * (`sections={['filaments']}` etc.), not phone copies of those controls, and
 * Review is the desktop `SliceActionBar` in its `stacked` layout. The full
 * viewport is the same `PlateStage` the desktop mounts, gizmos and all — with
 * `onTransformChange` passed through exactly as given, so the archive
 * read-only rule (#32: no layout endpoint, therefore no editable gizmo) holds
 * here without this file knowing what an archive is.
 *
 * ## Where the wizard starts
 *
 * At step 1 for everyone. **#31 (step-6.2) seeds `initialStep`** — a
 * previously-sliced file should open on Review — and that is the only place the
 * start index is decided; see {@link MobileSliceWizardProps.initialStep} and
 * `FIRST_STEP` in `wizardSteps.ts`. #31's editable chips go in the Review
 * branch of the step body, which is marked with its ticket number.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Box, Maximize2, X } from 'lucide-react';
import { PlateStage, type PlateStageProps } from './PlateStage';
import { SliceActionBar, type SliceActionBarProps } from './SliceActionBar';
import { SlicerRail, type SlicerRailProps } from './SlicerRail';
import {
  clampStep,
  FIRST_STEP,
  isStepComplete,
  WIZARD_STEPS,
  type WizardCompleteness,
  type WizardStep,
} from './wizardSteps';

export interface MobileSliceWizardProps {
  /** Shown in the header, and over the full-screen viewport. */
  filename: string;
  /** Leave the slicer entirely — the header's back arrow. */
  onBack: () => void;
  /** The page's error banner, rendered above the step content. */
  errorMessage?: string | null;

  /** `SlicerRail`'s props verbatim; the wizard only chooses the `sections`. */
  rail: Omit<SlicerRailProps, 'sections' | 'className'>;
  /** `PlateStage`'s props verbatim, for the full-screen viewport. */
  stage: Omit<PlateStageProps, 'actionBar' | 'className'>;
  /** `SliceActionBar`'s props verbatim, including the `canPrintNow` gate. */
  actions: Omit<SliceActionBarProps, 'layout' | 'className'>;

  /** Thumbnail for the persistent strip; `null` renders the placeholder. */
  thumbnailUrl?: string | null;

  /**
   * 1-based step to open on. Defaults to {@link FIRST_STEP}.
   *
   * The seam for #31 (step-6.2): a file that has been sliced before should open
   * on Review. Nothing else in this file decides the start index.
   */
  initialStep?: number;
}

export function MobileSliceWizard({
  filename,
  onBack,
  errorMessage,
  rail,
  stage,
  actions,
  thumbnailUrl,
  initialStep,
}: MobileSliceWizardProps) {
  const { t } = useTranslation();

  const [stepIndex, setStepIndex] = useState(() =>
    clampStep(initialStep ?? FIRST_STEP),
  );
  const [viewportOpen, setViewportOpen] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  // A different source is a different picture; without this a file with no
  // thumbnail would poison the placeholder for the next one.
  useEffect(() => setThumbnailFailed(false), [thumbnailUrl]);

  const step = WIZARD_STEPS[stepIndex - 1];

  const completeness = useMemo<WizardCompleteness>(
    () => ({
      printerPreset: rail.printerPreset,
      processPreset: rail.processPreset,
      filamentPresets: rail.filamentPresets,
      filamentSlots: rail.filamentSlots,
      filamentSlotsLoading: rail.filamentSlotsLoading,
    }),
    [
      rail.printerPreset,
      rail.processPreset,
      rail.filamentPresets,
      rail.filamentSlots,
      rail.filamentSlotsLoading,
    ],
  );

  const stepComplete = isStepComplete(step, completeness);
  // Named out loud rather than left as a greyed button: "Next does nothing" is
  // the single most common way a wizard reads as broken.
  const blockedReason = stepComplete
    ? null
    : step === 'printer'
      ? t('slicer.wizardNeedsPrinter')
      : t('slicer.wizardNeedsFilaments');

  const isReview = step === 'review';

  const railSection = (
    <SlicerRail
      {...rail}
      sections={[step === 'printer' ? 'presets' : step === 'filaments' ? 'filaments' : 'settings']}
      className="min-h-0 flex-1 overflow-y-auto"
    />
  );

  return (
    <div
      data-testid="mobile-slice-wizard"
      className="flex min-h-[calc(100vh-64px)] flex-col gap-2 p-3"
    >
      <header className="flex flex-shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          data-testid="wizard-exit"
          className="inline-flex items-center gap-1.5 text-sm text-bambu-gray transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('slicer.back')}
        </button>
        <span className="ml-auto text-xs text-bambu-gray" data-testid="wizard-step-counter">
          {t('slicer.wizardStepOf', { current: stepIndex, total: WIZARD_STEPS.length })}
        </span>
      </header>

      {/* Decorative: the counter above already says where you are, and four
          unlabelled dots would only repeat it to a screen reader. */}
      <div className="flex flex-shrink-0 justify-center gap-1.5" aria-hidden="true">
        {WIZARD_STEPS.map((name, index) => (
          <span
            key={name}
            className={`h-1.5 w-1.5 rounded-full ${
              index + 1 === stepIndex ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'
            }`}
          />
        ))}
      </div>

      <h1 className="flex-shrink-0 text-base font-medium text-white">
        {t(STEP_TITLE_KEYS[step])}
      </h1>
      <p className="flex-shrink-0 truncate text-xs text-bambu-gray" title={filename}>
        {filename || t('slicer.title')}
      </p>

      {/* The model comes along every step, and the full viewport is one tap
          from all of them — the mockup's whole argument for this layout. */}
      <button
        type="button"
        onClick={() => setViewportOpen(true)}
        aria-label={t('slicer.wizardOpenViewport')}
        data-testid="wizard-thumbnail"
        className="relative flex h-24 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary"
      >
        {thumbnailUrl && !thumbnailFailed ? (
          <img
            src={thumbnailUrl}
            alt={t('slicer.wizardModelPreview')}
            onError={() => setThumbnailFailed(true)}
            className="h-full w-full object-contain"
          />
        ) : (
          <Box className="h-8 w-8 text-bambu-gray" />
        )}
        <span className="absolute bottom-1 right-1 inline-flex items-center gap-1 rounded bg-bambu-dark/80 px-1.5 py-0.5 text-[10px] text-bambu-gray-light">
          <Maximize2 className="h-3 w-3" />
          {t('slicer.wizardOpenViewport')}
        </span>
      </button>

      {errorMessage && (
        <div
          role="alert"
          className="flex-shrink-0 rounded border border-red-900/40 bg-red-900/20 p-2 text-sm text-red-700 dark:text-red-400"
        >
          {errorMessage}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {isReview ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {/* #31 (step-6.2) adds the editable chips here — the summary of the
                choices behind you, each tappable back to its own step. Today
                this is read-only, and the estimate lives in the action bar. */}
            <p className="text-xs text-bambu-gray" data-testid="wizard-review-overrides">
              {Object.keys(rail.overrides).length > 0
                ? t('slice.settingsEditor.overrideCount', {
                    changed: Object.keys(rail.overrides).length,
                  })
                : t('slice.settingsEditor.noOverrides')}
            </p>
          </div>
        ) : (
          railSection
        )}
      </div>

      <footer className="flex flex-shrink-0 flex-col gap-2 border-t border-bambu-dark-tertiary pt-2">
        {isReview && (
          <SliceActionBar
            {...actions}
            layout="stacked"
            className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary"
          />
        )}

        {blockedReason && (
          <p role="status" className="text-xs text-amber-400">
            {blockedReason}
          </p>
        )}

        <div className="flex items-center gap-2">
          {stepIndex > 1 && (
            <button
              type="button"
              onClick={() => setStepIndex((current) => Math.max(1, current - 1))}
              data-testid="wizard-back"
              className="inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary px-4 py-2.5 text-sm text-bambu-gray transition-colors hover:border-bambu-gray hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('slicer.back')}
            </button>
          )}

          {!isReview && (
            <button
              type="button"
              onClick={() => setStepIndex((current) => clampStep(current + 1))}
              disabled={!stepComplete}
              title={blockedReason ?? undefined}
              data-testid="wizard-next"
              className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-bambu-green px-4 py-2.5 text-sm font-medium text-bambu-dark transition-colors hover:bg-bambu-green/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('slicer.wizardNext')}
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </footer>

      {viewportOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('slicer.wizardViewportLabel')}
          data-testid="wizard-viewport"
          className="fixed inset-0 z-50 flex flex-col bg-bambu-dark"
        >
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-bambu-dark-tertiary p-2">
            <span className="min-w-0 truncate text-sm text-white">{filename}</span>
            <button
              type="button"
              onClick={() => setViewportOpen(false)}
              aria-label={t('slicer.wizardCloseViewport')}
              className="ml-auto rounded-md p-2 text-bambu-gray transition-colors hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {/* Same stage the desktop mounts. `onTransformChange` is whatever the
              page gave us — absent for an archive, which is what keeps the
              gizmos off a source whose arrangement can never be saved. */}
          <PlateStage {...stage} className="min-h-0 flex-1" />
        </div>
      )}
    </div>
  );
}

const STEP_TITLE_KEYS: Record<WizardStep, string> = {
  printer: 'slicer.wizardPrinterTitle',
  filaments: 'slicer.wizardFilamentsTitle',
  settings: 'slicer.wizardSettingsTitle',
  review: 'slicer.wizardReviewTitle',
};
