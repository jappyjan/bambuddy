/**
 * The mobile wizard's steps, its per-step validation (#24, step-6.1) and the
 * Review summary its chips render (#31, step-6.2).
 *
 * Pure, and in its own module so the gating can be tested without a DOM — and
 * so `MobileSliceWizard.tsx` stays a component file.
 *
 * **The gate is derived, never tracked.** Each step asks the same values
 * `isSelectionComplete` asks, split by which screen is responsible for them, so
 * a wizard that lets you reach Review always has a complete selection there.
 * The failure this avoids is a Next that opens the Review screen onto a Slice
 * button which is disabled for a reason the user was never shown.
 */

import type { PresetRef, UnifiedPresetsResponse } from '../../api/client';
import type { PlateFilament } from '../../types/plates';
import { findPreset } from '../../utils/slicePresetPicker';

/** The four screens, in order. */
export const WIZARD_STEPS = ['printer', 'filaments', 'settings', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/**
 * Where the wizard opens when the caller passes no `initialStep`.
 *
 * **#31 (step-6.2) hooks in here**, through `MobileSliceWizard`'s `initialStep`
 * prop — a previously-sliced file should open on Review. This constant,
 * {@link initialStepForSource} and that prop are the only places the start
 * index is decided.
 */
export const FIRST_STEP = 1;

/** Review — the last screen, and where a previously-sliced file opens. */
export const REVIEW_STEP = WIZARD_STEPS.length;

/**
 * Which step a source opens on, from its slice history (#31, step-6.2).
 *
 * A file with a sliced child has been through these four screens before, and
 * `useSlicePresets` re-picks the same printer / process / filaments from the
 * source 3MF and the compatibility scoring every time it is opened — so the
 * choices behind Review are already the ones the last slice used. Walking the
 * user back through four screens to re-confirm a deterministic pre-pick is the
 * cost this removes. **Nothing is restored from the previous slice**: there is
 * no stored settings blob anywhere in this codebase, and this function must not
 * grow into the place that pretends otherwise.
 *
 * `slice_count` is a COUNT of non-trashed sliced children, so a file whose
 * slices were all trashed correctly opens at step 1 again.
 *
 * **This says nothing about Print now.** Whether the sliced output may be
 * printed is `lastSlice.fingerprint === selectionFingerprint(selection)`,
 * computed in `SlicerPage` for a slice made *in this session*; a previous
 * slice's output is not in `lastSlice` and never enables that button. See the
 * module header in `sliceSelection.ts`.
 *
 * Archives have no `slice_count` — pass `undefined` and they start at step 1.
 */
export function initialStepForSource(sliceCount: number | null | undefined): number {
  return (sliceCount ?? 0) > 0 ? REVIEW_STEP : FIRST_STEP;
}

/** Everything a step needs to decide whether it has been answered. */
export interface WizardCompleteness {
  printerPreset: PresetRef | null;
  processPreset: PresetRef | null;
  filamentPresets: (PresetRef | null)[];
  filamentSlots: PlateFilament[];
  filamentSlotsLoading: boolean;
}

/**
 * Whether a step has been answered — the gate on Next.
 *
 * Settings is always satisfiable: overrides are optional by definition, and
 * Review is gated by `canSlice`, which the page computes.
 *
 * Filaments is *incomplete while the requirements are still loading*, because
 * the slot list is not known yet: the rail is showing one placeholder slot, and
 * a plate that turns out to need three would otherwise sail past unanswered.
 */
export function isStepComplete(step: WizardStep, values: WizardCompleteness): boolean {
  switch (step) {
    case 'printer':
      // The rail pairs the two, and the slicer requires both.
      return values.printerPreset != null && values.processPreset != null;
    case 'filaments':
      return (
        !values.filamentSlotsLoading &&
        values.filamentSlots.length > 0 &&
        values.filamentSlots.every((_, index) => values.filamentPresets[index] != null)
      );
    case 'settings':
    case 'review':
      return true;
  }
}

/** Keeps a seeded or advanced index inside the four steps. */
export function clampStep(step: number): number {
  if (!Number.isFinite(step)) return FIRST_STEP;
  return Math.min(WIZARD_STEPS.length, Math.max(1, Math.trunc(step)));
}

/** The three editable steps — Review summarises these, never itself. */
export type WizardChipStep = Exclude<WizardStep, 'review'>;

/**
 * One Review chip: which step it opens, and what that step is currently holding.
 *
 * Deliberately *values*, not sentences. Wording and pluralisation are the
 * component's job (it has `t`); what belongs here is the reading of the
 * selection, so it can be tested without a DOM and cannot quietly disagree with
 * what the step itself shows.
 */
export interface WizardChip {
  step: WizardChipStep;
  /** 1-based index to jump to. */
  index: number;
  /**
   * The preset name to show verbatim, when a single name says it all — the
   * printer, or a lone filament slot. `null` means "use the counts instead".
   */
  name: string | null;
  /** Filament slots answered / overrides changed. */
  count: number;
  /** Filament slots in total; 0 for the steps where a total is meaningless. */
  total: number;
}

/** Everything the Review chips read. All of it already exists on the rail. */
export interface WizardChipInput {
  presets: UnifiedPresetsResponse | undefined;
  printerPreset: PresetRef | null;
  filamentPresets: (PresetRef | null)[];
  filamentSlots: PlateFilament[];
  /** `Object.keys(overrides).length` — the editor's diff size. */
  overrideCount: number;
}

/**
 * What each editable step currently holds, for Review's chips (#31, step-6.2).
 *
 * Names come from `findPreset` — the same resolver `useSlicePresets` uses for
 * `selectedPrinterName` and the one `PresetDropdown` renders its options from.
 * A second lookup here would be a second answer to "which preset is picked",
 * and the way that fails is a chip confidently naming a profile the slice does
 * not use.
 */
export function wizardChips({
  presets,
  printerPreset,
  filamentPresets,
  filamentSlots,
  overrideCount,
}: WizardChipInput): WizardChip[] {
  const nameOf = (ref: PresetRef | null, slot: 'printer' | 'filament') =>
    presets ? (findPreset(presets, ref, slot)?.name ?? null) : null;

  const answered = filamentSlots.filter((_, index) => filamentPresets[index] != null).length;

  return [
    {
      step: 'printer',
      index: WIZARD_STEPS.indexOf('printer') + 1,
      name: nameOf(printerPreset, 'printer'),
      count: printerPreset != null ? 1 : 0,
      total: 0,
    },
    {
      step: 'filaments',
      index: WIZARD_STEPS.indexOf('filaments') + 1,
      // One slot is the common case and its profile name is the useful thing
      // to see; past that a name per slot would not fit a phone chip, so the
      // count carries it and the step itself has the detail.
      name: filamentSlots.length === 1 ? nameOf(filamentPresets[0] ?? null, 'filament') : null,
      count: answered,
      total: filamentSlots.length,
    },
    {
      step: 'settings',
      index: WIZARD_STEPS.indexOf('settings') + 1,
      name: null,
      count: overrideCount,
      total: 0,
    },
  ];
}
