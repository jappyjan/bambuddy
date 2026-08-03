/**
 * The rail's **Printer** group (#44) — Bambu Studio's layout: the printer and
 * the build plate as two cards side by side, and a Nozzle group beneath them.
 *
 * It replaces the single flat "Printer profile" dropdown, where model, nozzle
 * diameter and tier were all collapsed into one preset name the user had to
 * read. What it selects is unchanged: **one `PresetRef`**, the same value the
 * old dropdown produced, so `useSlicePresets`, `selectionFingerprint` and the
 * slice body see exactly what they saw before. `SliceModal` keeps the flat
 * dropdown and is untouched.
 *
 * ## Nozzle Flow is not here on purpose
 *
 * The reference's Nozzle group has Diameter *and* Flow. Flow is not modelled
 * in preset data — see the header of `utils/printerPresetAxes.ts` for what was
 * checked and what it would take. Rendering a Flow select that resolves to no
 * preset and changes no slice would be worse than not having one.
 *
 * ## An unmatched pair is stated, never substituted
 *
 * The two selects are the user's *intent*; `value` is what that intent
 * resolved to. Changing the model keeps the chosen diameter, so switching from
 * a printer that has a 0.8 nozzle profile to one that does not leaves a pair
 * no preset carries. That clears the selection and says so, which stops Slice
 * — deliberately, rather than quietly slicing a 0.4 profile while the rail
 * reads 0.8. The stale diameter stays in the list, marked, so the way out is
 * one click.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, Printer } from 'lucide-react';
import type { PresetRef, UnifiedPresetsResponse } from '../../api/client';
import {
  axesOfPrinterPreset,
  buildPrinterAxes,
  diametersForModel,
  normalizeDiameterKey,
  resolvePrinterPreset,
} from '../../utils/printerPresetAxes';
import { BedTypeDropdown } from './PresetControls';

export interface PrinterPickerProps {
  data: UnifiedPresetsResponse;
  /** The selected printer preset — the single value this group produces. */
  value: PresetRef | null;
  onChange: (ref: PresetRef | null) => void;
  /** Build-plate override (#1337); its card sits beside the printer's. */
  bedType: string | null;
  onBedTypeChange: (value: string | null) => void;
  disabled?: boolean;
}

const CARD_CLASS =
  'flex flex-col gap-1 rounded-md border border-bambu-dark-tertiary bg-bambu-dark/40 p-2';
const SELECT_CLASS =
  'w-full rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5 text-xs text-white focus:border-bambu-gray focus:outline-none disabled:opacity-50';

export function PrinterPicker({
  data,
  value,
  onChange,
  bedType,
  onBedTypeChange,
  disabled = false,
}: PrinterPickerProps) {
  const { t } = useTranslation();
  const axes = useMemo(() => buildPrinterAxes(data), [data]);

  // Where the selected preset sits on the two axes. This — not local state —
  // is what the controls normally show, so a pre-pick from the 3MF's embedded
  // printer, a pipeline or a preset refresh is on screen in the same render it
  // reaches `value`, with no effect to catch up.
  const resolvedAxes = useMemo(() => axesOfPrinterPreset(axes, value), [axes, value]);

  // The one thing `value` cannot express: a pair the user asked for that no
  // preset carries. `value` is null then, and this is the only record of what
  // was asked. Held here rather than in `useSlicePresets` so the hook's
  // contract — and therefore `SliceModal` — is untouched. A resolved selection
  // always wins over it, so it can never shadow a real pick.
  const [unresolvedPair, setUnresolvedPair] = useState<
    { modelKey: string; diameter: string | null } | null
  >(null);

  const shown = resolvedAxes
    ? { modelKey: resolvedAxes.modelKey, diameter: resolvedAxes.diameter }
    : unresolvedPair;
  const modelKey = shown?.modelKey ?? null;
  const diameter = shown?.diameter ?? null;
  const modelLabel =
    axes.models.find((m) => m.key === modelKey)?.label ?? resolvedAxes?.model ?? '';

  const diameters = useMemo(() => diametersForModel(axes, modelKey), [axes, modelKey]);
  // A diameter the user carried over from another model that this one has no
  // profile for. Kept in the list so the control still shows what was asked
  // for; flagged so it does not read as a working choice.
  const staleDiameter =
    diameter != null && !diameters.some((d) => normalizeDiameterKey(d) === normalizeDiameterKey(diameter))
      ? diameter
      : null;

  const unmatched = modelKey != null && value == null;

  const applyPair = (nextModelKey: string | null, nextDiameter: string | null) => {
    const ref = nextModelKey == null ? null : resolvePrinterPreset(axes, nextModelKey, nextDiameter);
    // Remembered only while it resolves to nothing — see `unresolvedPair`.
    setUnresolvedPair(
      ref == null && nextModelKey != null ? { modelKey: nextModelKey, diameter: nextDiameter } : null,
    );
    // null stops Slice, which is the point: the message below says why.
    onChange(ref);
  };

  const handleModelChange = (nextModelKey: string | null) => {
    // A diameter the user *chose* is carried over even when the new model has
    // no profile for it — that is the unmatched case, and it must be stated
    // rather than corrected. But when nothing is on the diameter axis at all
    // (the previous model's presets carried no nozzle segment, or no printer
    // was selected yet), there is no choice to preserve, and seeding the new
    // model's own default is not a substitution. 0.4 is Bambu's default and
    // the only size every model ships.
    let nextDiameter = diameter;
    if (nextModelKey != null && nextDiameter == null) {
      const available = diametersForModel(axes, nextModelKey);
      if (available.length > 0) {
        nextDiameter =
          available.find((d) => normalizeDiameterKey(d) === '0.4') ?? available[0];
      }
    }
    applyPair(nextModelKey, nextDiameter);
  };

  return (
    <div className="flex flex-col gap-2" data-testid="printer-picker">
      <div className="grid grid-cols-2 gap-2">
        <div className={CARD_CLASS}>
          <span className="flex items-center gap-1.5 text-xs text-bambu-gray">
            <Printer className="h-3.5 w-3.5" aria-hidden />
            {t('slicer.printerModel')}
          </span>
          <select
            aria-label={t('slicer.printerModel')}
            value={modelKey ?? ''}
            onChange={(event) => handleModelChange(event.target.value || null)}
            disabled={disabled || axes.models.length === 0}
            className={SELECT_CLASS}
          >
            <option value="">
              {axes.models.length === 0 ? t('slice.noPresetsForSlot') : t('slicer.printerModelSelect')}
            </option>
            {axes.models.map((model) => (
              <option key={model.key} value={model.key}>
                {model.label}
              </option>
            ))}
          </select>
        </div>

        <div className={CARD_CLASS}>
          <span className="flex items-center gap-1.5 text-xs text-bambu-gray">
            <Layers className="h-3.5 w-3.5" aria-hidden />
            {t('slice.bedType.label')}
          </span>
          {/* The same control the modal renders, so the two entry points cannot
              offer different plates. Its own label is redundant inside a card
              that already carries one, hence `hideLabel`. */}
          <BedTypeDropdown
            value={bedType}
            onChange={onBedTypeChange}
            disabled={disabled}
            hideLabel
            selectClassName={SELECT_CLASS}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-bambu-gray">{t('slicer.nozzleHeading')}</span>
        <label className="flex items-center gap-2">
          <span className="w-16 flex-shrink-0 text-xs text-bambu-gray">
            {t('slicer.nozzleDiameter')}
          </span>
          <select
            aria-label={t('slicer.nozzleDiameter')}
            value={diameter ?? ''}
            onChange={(event) => applyPair(modelKey, event.target.value || null)}
            disabled={disabled || modelKey == null || diameters.length === 0}
            className={SELECT_CLASS}
          >
            {/* An empty value is a real option only for a model whose preset
                carries no nozzle segment — an imported non-Bambu profile.
                Everything else lists the sizes that model actually has. */}
            <option value="">
              {modelKey == null
                ? t('slicer.nozzleDiameterNoPrinter')
                : diameters.length === 0
                  ? t('slicer.nozzleDiameterNone')
                  : t('slicer.nozzleDiameterSelect')}
            </option>
            {/* Bare sizes, as the reference's combo shows them — the unit is
                the control's business, not each option's. */}
            {diameters.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
            {staleDiameter != null && (
              <option value={staleDiameter}>
                {t('slicer.nozzleDiameterUnavailable', { diameter: staleDiameter })}
              </option>
            )}
          </select>
        </label>
      </div>

      {unmatched && (
        <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">
          {diameter != null
            ? t('slicer.printerNoMatch', { model: modelLabel, diameter })
            : t('slicer.printerNoMatchNoDiameter', { model: modelLabel })}
        </p>
      )}
    </div>
  );
}
