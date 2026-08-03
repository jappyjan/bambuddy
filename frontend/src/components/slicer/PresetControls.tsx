/**
 * The preset pickers shared by every slice entry point.
 *
 * Moved verbatim out of `SliceModal.tsx` (#15, step-5.3) for the same reason
 * `useSlicePresets` was moved out in #5: the modal and the `/slicer` rail must
 * offer the *same* presets, grouped the same way, with the same
 * printer-compatibility filter. Two copies of the tier/compatibility grouping
 * would drift, and the way it would drift is that one surface quietly hides a
 * preset the other offers — which looks like a missing profile, not a bug.
 *
 * Behaviour is unchanged; `SliceModal` imports these back and renders exactly
 * what it rendered before. The mobile wizard (#11) mounts the same controls.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PresetRef, UnifiedPreset, UnifiedPresetsBySlot, UnifiedPresetsResponse } from '../../api/client';
import {
  presetCompatibility,
  EMPTY_COMPATIBILITY_INDEX,
  type PrinterCompatibilityIndex,
} from '../../utils/slicerPrinterMatch';
import { type Slot } from '../../utils/slicePresetPicker';

function toRefValue(ref: PresetRef | null): string {
  // The HTML `<select>` value space is flat strings; encode source + id so
  // the same preset name can live in multiple tiers without collision.
  return ref ? `${ref.source}:${ref.id}` : '';
}

function fromRefValue(raw: string): PresetRef | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  const source = raw.slice(0, idx) as PresetRef['source'];
  const id = raw.slice(idx + 1);
  if (source !== 'orca_cloud' && source !== 'cloud' && source !== 'local' && source !== 'standard') return null;
  return { source, id };
}

/**
 * Build-plate options. Values are the canonical strings the slicer's
 * StaticPrintConfig validator accepts as `curr_bed_type` — BambuStudio is the
 * default sidecar, so this matches its enum; OrcaSlicer accepts the same set
 * with a Supertack alias that users can target via the same dropdown if they
 * re-import their presets.
 */
const BED_TYPE_OPTIONS: { value: string; labelKey: string; fallback: string }[] = [
  { value: 'Cool Plate', labelKey: 'slice.bedType.coolPlate', fallback: 'Cool Plate' },
  {
    value: 'Cool Plate (SuperTack)',
    labelKey: 'slice.bedType.coolPlateSuperTack',
    fallback: 'Cool Plate SuperTack',
  },
  { value: 'Engineering Plate', labelKey: 'slice.bedType.engineering', fallback: 'Engineering Plate' },
  { value: 'High Temp Plate', labelKey: 'slice.bedType.highTemp', fallback: 'High Temp Plate' },
  { value: 'Textured PEI Plate', labelKey: 'slice.bedType.texturedPEI', fallback: 'Textured PEI Plate' },
  { value: 'Smooth PEI Plate', labelKey: 'slice.bedType.smoothPEI', fallback: 'Smooth PEI Plate' },
];

export function BedTypeDropdown({
  value,
  onChange,
  disabled,
  // Both default to the modal's original rendering — this control is shared,
  // and the rail's build-plate card (#44) is the only caller that overrides
  // them: it draws its own heading, so a second visible label inside the card
  // would just repeat it, and the rail's selects run tighter than the modal's.
  hideLabel = false,
  selectClassName = 'w-full px-3 py-2 rounded-md bg-bambu-dark border border-bambu-dark-tertiary text-white text-sm focus:outline-none focus:border-bambu-gray disabled:opacity-50',
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  hideLabel?: boolean;
  selectClassName?: string;
}) {
  const { t } = useTranslation();
  const select = (
    <select
      // Without a visible label the select still has to be reachable by name —
      // for a screen reader as much as for a test.
      aria-label={hideLabel ? t('slice.bedType.label') : undefined}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      disabled={disabled}
      className={selectClassName}
    >
      <option value="">{t('slice.bedType.auto')}</option>
      {BED_TYPE_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {t(opt.labelKey, opt.fallback)}
        </option>
      ))}
    </select>
  );
  if (hideLabel) return select;
  return (
    <label className="block">
      <span className="block text-xs text-bambu-gray mb-1">
        {t('slice.bedType.label')}
      </span>
      {select}
    </label>
  );
}

export interface PresetDropdownProps {
  label: string;
  slot: Slot;
  data: UnifiedPresetsResponse;
  value: PresetRef | null;
  onChange: (ref: PresetRef | null) => void;
  disabled?: boolean;
  // Optional colour swatch shown next to the label — used for multi-color
  // filament slots so the user can see at a glance which slot they're
  // configuring against the source 3MF's per-slot colour.
  swatchColor?: string;
  // Selected printer context (#1325). When provided for a process / filament
  // slot, presets that resolve to a different printer (per compatIndex) move
  // into a trailing "Other printers" group instead of the main tier list.
  selectedPrinterName?: string | null;
  compatIndex?: PrinterCompatibilityIndex;
  /** Extra classes on the `<select>` — the rail runs tighter than the modal. */
  selectClassName?: string;
}

export function PresetDropdown({
  label,
  slot,
  data,
  value,
  onChange,
  disabled,
  swatchColor,
  selectedPrinterName,
  compatIndex,
  selectClassName = 'px-3 py-2 text-sm',
}: PresetDropdownProps) {
  const { t } = useTranslation();

  // Tier sections (imported → cloud → standard), plus — for a process /
  // filament slot with a selected printer — a trailing group of presets that
  // resolve to a different printer (#1325). Compatibility-unknown presets
  // stay in their tier, so a custom / untagged preset is never hidden, and
  // empty sections collapse out.
  const { sections, otherEntries } = useMemo(() => {
    const tiers: { key: keyof UnifiedPresetsResponse; label: string; fallback: string }[] = [
      { key: 'local', label: 'slice.tier.local', fallback: 'Imported' },
      { key: 'orca_cloud', label: 'slice.tier.orcaCloud', fallback: 'Orca Cloud' },
      { key: 'cloud', label: 'slice.tier.cloud', fallback: 'Bambu Cloud' },
      { key: 'standard', label: 'slice.tier.standard', fallback: 'Standard' },
    ];
    const filterByPrinter = slot !== 'printer';
    const compatSections: { tierLabel: string; entries: UnifiedPreset[] }[] = [];
    const other: UnifiedPreset[] = [];
    for (const { key, label: lk, fallback } of tiers) {
      const entries = (data[key] as UnifiedPresetsBySlot)[slot];
      if (!filterByPrinter) {
        if (entries.length > 0) compatSections.push({ tierLabel: t(lk, fallback), entries });
        continue;
      }
      const compatible: UnifiedPreset[] = [];
      for (const p of entries) {
        if (
          presetCompatibility(
            p,
            // filterByPrinter is true here, so slot is never 'printer'.
            slot as 'process' | 'filament',
            selectedPrinterName ?? null,
            compatIndex ?? EMPTY_COMPATIBILITY_INDEX,
          ) === 'mismatch'
        ) {
          other.push(p);
        } else {
          compatible.push(p);
        }
      }
      if (compatible.length > 0) {
        compatSections.push({ tierLabel: t(lk, fallback), entries: compatible });
      }
    }
    return { sections: compatSections, otherEntries: other };
  }, [data, slot, t, selectedPrinterName, compatIndex]);

  const totalEntries =
    sections.reduce((sum, s) => sum + s.entries.length, 0) + otherEntries.length;

  return (
    <label className="block">
      <span className="flex items-center gap-2 text-xs text-bambu-gray mb-1">
        {swatchColor && (
          <span
            className="inline-block w-3 h-3 rounded-full border border-bambu-dark-tertiary"
            style={{ backgroundColor: swatchColor || 'transparent' }}
            aria-hidden
          />
        )}
        <span>{label}</span>
      </span>
      <select
        value={toRefValue(value)}
        onChange={(e) => onChange(fromRefValue(e.target.value))}
        disabled={disabled || totalEntries === 0}
        className={`w-full rounded-md bg-bambu-dark border border-bambu-dark-tertiary text-white focus:outline-none focus:border-bambu-gray disabled:opacity-50 ${selectClassName}`}
      >
        <option value="">
          {totalEntries === 0
            ? t('slice.noPresetsForSlot')
            : t('slice.selectPreset')}
        </option>
        {sections.map((section) => (
          <optgroup key={section.tierLabel} label={section.tierLabel}>
            {section.entries.map((p) => (
              <option key={`${p.source}:${p.id}`} value={`${p.source}:${p.id}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        ))}
        {otherEntries.length > 0 && (
          <optgroup label={t('slice.otherPrinters')}>
            {otherEntries.map((p) => (
              <option key={`${p.source}:${p.id}`} value={`${p.source}:${p.id}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}
