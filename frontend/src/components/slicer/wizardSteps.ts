/**
 * The mobile wizard's steps and its per-step validation (#24, step-6.1).
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

import type { PresetRef } from '../../api/client';
import type { PlateFilament } from '../../types/plates';

/** The four screens, in order. */
export const WIZARD_STEPS = ['printer', 'filaments', 'settings', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/**
 * Where the wizard opens when the caller passes no `initialStep`.
 *
 * **#31 (step-6.2) hooks in here**, through `MobileSliceWizard`'s `initialStep`
 * prop — a previously-sliced file should open on Review. This constant and that
 * prop are the only two places the start index is decided.
 */
export const FIRST_STEP = 1;

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
