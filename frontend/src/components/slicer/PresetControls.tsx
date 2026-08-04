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
import { AlertTriangle } from 'lucide-react';
import type { PresetRef, UnifiedPreset, UnifiedPresetsBySlot, UnifiedPresetsResponse } from '../../api/client';
import {
  presetCompatibility,
  EMPTY_COMPATIBILITY_INDEX,
  type PrinterCompatibilityIndex,
} from '../../utils/slicerPrinterMatch';
import { type FilamentTypeWarning, type Slot } from '../../utils/slicePresetPicker';

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
 * Material tokens used to recover a filament preset's TYPE from its name when
 * the field is null — which is every bundled ("standard") preset on today's
 * sidecar, because the sidecar only learned to resolve `filament_type` through
 * the `inherits:` chain in the fork images (#51 is the sidecar-side fix).
 *
 * Display only. This never writes back onto the preset and is never consulted
 * by `pickFilamentForSlot` or by the material-honesty guard (#47) — those must
 * keep seeing the real metadata, because a *guessed* type that silences a
 * "we are not sure about this material" warning is exactly the failure #47
 * exists to prevent. It decides an `<optgroup>` heading and nothing else.
 *
 * Same token list as `LocalProfilesView`, which has parsed names this way
 * since long before this file did.
 */
const MATERIAL_TYPES = ['PLA', 'PETG', 'PCTG', 'ABS', 'ASA', 'TPU', 'PC', 'PA', 'PVA', 'HIPS', 'PP', 'PET', 'NYLON'];

function materialFromName(name: string): string | null {
  const upper = name.toUpperCase();
  for (const mat of MATERIAL_TYPES) {
    if (new RegExp(`\\b${mat}\\b`).test(upper)) return mat;
  }
  return null;
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

/**
 * One synthesised `<optgroup>`: a manufacturer, a material, and the presets
 * that are both. `vendor: null` is the single trailing catch-all — everything
 * with no resolvable manufacturer lands there together rather than being
 * scattered under one-preset headings.
 */
interface VendorGroup {
  vendor: string | null;
  type: string | null;
  entries: UnifiedPreset[];
}

/**
 * Regroup filament presets the way Bambu Studio does: manufacturer first,
 * material second.
 *
 * Returns `null` when the data cannot support it — not one entry resolves a
 * vendor OR a material — which is the caller's signal to keep the tier
 * grouping. That is the un-upgraded-sidecar case, and it matters: without the
 * gate, an install whose presets carry neither field would render every single
 * preset under one "Other" heading, which is a downgrade from headings that at
 * least say where a preset came from.
 *
 * Order: vendors alphabetically, materials alphabetically inside each vendor,
 * presets by name inside each group. Every unknown sorts last at its own
 * level — an "Other" bucket is where you look when the specific headings did
 * not have your preset, so it belongs at the bottom.
 */
function groupByVendorAndType(entries: UnifiedPreset[]): VendorGroup[] | null {
  let anyKey = false;
  // Vendors are keyed case-insensitively (an import spelling "eSUN" and a
  // name-parsed "ESUN" are one manufacturer), but labelled with the first
  // spelling seen so the heading reads the way the preset author wrote it.
  const byVendor = new Map<string, { label: string; byType: Map<string, UnifiedPreset[]> }>();
  const vendorless: UnifiedPreset[] = [];

  for (const p of entries) {
    const vendor = p.filament_vendor?.trim() || null;
    // Real metadata first; the name is only consulted where the field is null.
    const type = p.filament_type?.trim() || materialFromName(p.name);
    if (vendor || type) anyKey = true;
    if (!vendor) {
      vendorless.push(p);
      continue;
    }
    const vendorKey = vendor.toLowerCase();
    let bucket = byVendor.get(vendorKey);
    if (!bucket) {
      bucket = { label: vendor, byType: new Map() };
      byVendor.set(vendorKey, bucket);
    }
    const typeKey = type ?? '';
    const list = bucket.byType.get(typeKey);
    if (list) list.push(p);
    else bucket.byType.set(typeKey, [p]);
  }

  if (!anyKey) return null;

  const byName = (a: UnifiedPreset, b: UnifiedPreset) =>
    a.name.localeCompare(b.name) || a.source.localeCompare(b.source);

  const groups: VendorGroup[] = [];
  for (const key of [...byVendor.keys()].sort((a, b) => a.localeCompare(b))) {
    const bucket = byVendor.get(key)!;
    const typeKeys = [...bucket.byType.keys()].sort((a, b) => {
      // '' is "material unknown" — last within its vendor.
      if (a === '') return 1;
      if (b === '') return -1;
      return a.localeCompare(b);
    });
    for (const typeKey of typeKeys) {
      groups.push({
        vendor: bucket.label,
        type: typeKey || null,
        entries: [...bucket.byType.get(typeKey)!].sort(byName),
      });
    }
  }
  if (vendorless.length > 0) {
    groups.push({ vendor: null, type: null, entries: [...vendorless].sort(byName) });
  }
  return groups;
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
  /**
   * Drop other printers' presets instead of demoting them (#57).
   *
   * The owner overruled the demote-don't-hide call the "Other printers" group
   * was built on: on the `/slicer` rail a profile for a printer you did not
   * select is noise, not a fallback. `SliceModal` keeps the old grouping —
   * it is the legacy path and nobody asked for it to change.
   *
   * Two presets are deliberately NOT hidden even when this is set:
   *   - anything the matcher calls 'unknown' (custom / untagged imports),
   *     because hiding those loses profiles no rule can vouch for either way;
   *   - the preset currently selected, because a `<select>` whose value is
   *     absent from its options renders blank — the user would see an empty
   *     control and a slice request carrying a preset they cannot see.
   */
  hideIncompatible?: boolean;
  /**
   * Group filament presets by manufacturer, then material, instead of by
   * source tier (#58) — "Bambu Lab – PLA" rather than "Imported" / "Standard".
   *
   * The tier a preset came from is an implementation detail; Bambu Studio
   * groups by vendor and then by type, and that is what the owner asked for.
   * A native `<select>` is flat two-level, so the two keys are synthesised
   * into one `<optgroup>` label rather than nested — a real tree would mean a
   * custom listbox and re-implementing mobile, keyboard and screen-reader
   * behaviour that the native control gives for free.
   *
   * Opt-in rather than "always, for the filament slot", because `SliceModal`
   * is the legacy slice path and renders the same component: #57 deliberately
   * left its grouping alone and nothing in #58 asks for that to change.
   * Ignored for the process / printer slots, which have no vendor.
   *
   * **Degrades on its own.** If not one visible preset resolves a vendor OR a
   * material, this falls back to the tier grouping. That is the un-upgraded
   * sidecar case, and one giant "Other" bucket is strictly worse than the
   * headings we have today.
   */
  groupByVendor?: boolean;
  /** Extra classes on the `<select>` — the rail runs tighter than the modal. */
  selectClassName?: string;
  /**
   * The material honesty guard (#47) for a filament slot, from
   * `useSlicePresets().filamentTypeWarnings`.
   *
   * Rendered here rather than by each caller so the modal, the rail and the
   * mobile wizard cannot word it differently — and so the warning sits on the
   * control it is about. The selection is deliberately *kept*: an empty
   * dropdown blocks slicing outright (`SliceModal` refuses to enqueue while
   * any slot is null), which would turn "we are not sure about this material"
   * into "you cannot slice at all". A user who knows better must still be able
   * to slice on purpose.
   */
  typeWarning?: FilamentTypeWarning | null;
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
  hideIncompatible = false,
  groupByVendor = false,
  selectClassName = 'px-3 py-2 text-sm',
  typeWarning = null,
}: PresetDropdownProps) {
  const { t } = useTranslation();

  const selectedValue = toRefValue(value);

  // Tier sections (imported → cloud → standard), plus — for a process /
  // filament slot with a selected printer — a trailing group of presets that
  // resolve to a different printer (#1325), or nothing at all when
  // `hideIncompatible` is set (#57). Compatibility-unknown presets
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
        const mismatch =
          presetCompatibility(
            p,
            // filterByPrinter is true here, so slot is never 'printer'.
            slot as 'process' | 'filament',
            selectedPrinterName ?? null,
            compatIndex ?? EMPTY_COMPATIBILITY_INDEX,
          ) === 'mismatch';
        if (!mismatch) {
          compatible.push(p);
        } else if (!hideIncompatible) {
          other.push(p);
        } else if (`${p.source}:${p.id}` === selectedValue) {
          // Hidden everywhere except where it is already in force — see the
          // note on `hideIncompatible`.
          compatible.push(p);
        }
      }
      if (compatible.length > 0) {
        compatSections.push({ tierLabel: t(lk, fallback), entries: compatible });
      }
    }

    // Vendor → material regrouping (#58). Built from exactly the entries the
    // tier pass decided are visible, which is what keeps it honest alongside
    // #57: a preset hidden as another printer's never reaches this, so it
    // cannot leave an empty vendor group behind — the groups are derived from
    // the survivors rather than filtered after the fact.
    if (groupByVendor && slot === 'filament') {
      const groups = groupByVendorAndType(compatSections.flatMap((s) => s.entries));
      // Gate: no vendor and no material anywhere means an un-upgraded
      // sidecar, and one giant "Other" heading is worse than the tiers.
      if (groups) {
        return {
          sections: groups.map((g) => ({
            tierLabel:
              g.vendor === null
                ? t('slice.presetGroupOther')
                : t('slice.presetGroup', {
                    vendor: g.vendor,
                    type: g.type ?? t('slice.presetGroupOther'),
                  }),
            entries: g.entries,
          })),
          otherEntries: other,
        };
      }
    }

    return { sections: compatSections, otherEntries: other };
  }, [data, slot, t, selectedPrinterName, compatIndex, hideIncompatible, groupByVendor, selectedValue]);

  const totalEntries =
    sections.reduce((sum, s) => sum + s.entries.length, 0) + otherEntries.length;

  // An empty dropdown used to mean "this install has no presets of this kind".
  // With #57 it can also mean "it has plenty, they all belong to other
  // printers" — a very different thing to tell the user, and the only thing
  // standing between them and a disabled control with no explanation.
  const emptyLabel =
    hideIncompatible && selectedPrinterName
      ? t('slice.noPresetsForPrinter')
      : t('slice.noPresetsForSlot');

  const warningText = typeWarning
    ? typeWarning.kind === 'mismatch'
      ? t('slice.filamentTypeMismatch', {
          required: typeWarning.required,
          selected: typeWarning.selectedName ?? '',
          selectedType: typeWarning.selectedType ?? '',
        })
      : t('slice.filamentTypeUnavailable', { required: typeWarning.required })
    : null;

  const control = (
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
        className={`w-full rounded-md bg-bambu-dark border text-white focus:outline-none disabled:opacity-50 ${
          warningText
            ? 'border-amber-500 focus:border-amber-400'
            : 'border-bambu-dark-tertiary focus:border-bambu-gray'
        } ${selectClassName}`}
      >
        <option value="">
          {totalEntries === 0 ? emptyLabel : t('slice.selectPreset')}
        </option>
        {sections.map((section, index) => (
          // Index-keyed: tier labels are unique, but a synthesised vendor
          // label is only as unique as the vendor strings behind it.
          <optgroup key={`${index}:${section.tierLabel}`} label={section.tierLabel}>
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

  if (!warningText) return control;
  return (
    <div className="block">
      {control}
      {/* Outside the <label> on purpose: inside, the warning text would be
          folded into the select's accessible name and read out on every
          option change. `role="alert"` announces it once, when it appears. */}
      <p
        role="alert"
        data-testid="filament-type-warning"
        className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-amber-400"
      >
        <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden />
        <span>{warningText}</span>
      </p>
    </div>
  );
}
