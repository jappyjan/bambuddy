/**
 * The rail's Project-Filaments panel (#45, rail.2) — Bambu Studio's own slot
 * manager, as described from the owner's screenshot in ticket comment 153.
 *
 * Anatomy, and what each part is for:
 *
 * - A `Filament` header row carrying **`+`** (append a slot) and **`−`**
 *   (drop the last one).
 * - One row per slot: a **numbered square badge filled with that slot's
 *   colour** — the badge *is* the colour control, which is how Bambu Studio
 *   surfaces it and what #42 will paint the 3D view from — then the filament
 *   dropdown, then a **`⋯` menu** for the per-slot actions.
 *
 * ## Two deliberate departures from the reference
 *
 * 1. **One column, not two.** The reference panel is a wide dialog; this rail
 *    is 20rem. Two columns leave ~130px for a filament dropdown, which
 *    truncates every preset name to "Bambu PLA Basic @BB…" — the control the
 *    panel exists for would become the one you cannot read. The badge / `⋯` /
 *    `+` `−` anatomy is what carries the resemblance; the column count is what
 *    the available width decides.
 * 2. **No Purging volumes / Sync / gear buttons, and no "Add Mixed Filament".**
 *    Nothing behind them is modelled anywhere in Bambuddy — there is no purge
 *    volume in `SliceRequest` and no multi-material blend in the preset data.
 *    Rendering the buttons would be drawing a UI over an absence.
 *
 * ## Why some controls are disabled rather than absent
 *
 * Slot **position** is what the model's painted geometry refers to, so an edit
 * that would shift a painted slot is refused — see `filamentSlots.ts` for the
 * full reasoning. A refused action stays visible and disabled with the reason
 * on its `title`, because a control that vanishes reads as a missing feature
 * while a disabled one reads as a rule.
 *
 * Presentation only: every value and every mutation comes from `SlicerPage`,
 * which owns the selection because the action bar has to fingerprint it.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Minus, MoreHorizontal, Plus } from 'lucide-react';
import type { PresetRef, UnifiedPresetsResponse } from '../../api/client';
import type { PrinterCompatibilityIndex } from '../../utils/slicerPrinterMatch';
import type { FilamentTypeWarning } from '../../utils/slicePresetPicker';
import { PresetDropdown } from './PresetControls';
import {
  canInsertAfter,
  canRemoveLast,
  canRemoveSlotAt,
  resolveSlotColors,
  type FilamentSlotState,
} from './filamentSlots';

export interface FilamentSlotGridProps {
  presets: UnifiedPresetsResponse;
  slots: FilamentSlotState[];
  slotsLoading: boolean;
  filamentPresets: (PresetRef | null)[];
  /**
   * The material honesty guard (#47), one entry per slot, straight from
   * `useSlicePresets`. The same array `SliceModal` renders, so the two entry
   * points cannot disagree about whether a slot's material is trustworthy.
   */
  filamentTypeWarnings?: (FilamentTypeWarning | null)[];
  onFilamentPresetChange: (index: number, ref: PresetRef | null) => void;
  onAddSlot: () => void;
  onInsertSlotAfter: (index: number) => void;
  onRemoveSlot: (index: number) => void;
  /** `null` reverts the slot to the plate's as-designed colour. */
  onSlotColorChange: (index: number, color: string | null) => void;
  selectedPrinterName: string | null;
  compatIndex: PrinterCompatibilityIndex;
  disabled?: boolean;
  /**
   * Render the "Filament" heading above the add / remove buttons.
   *
   * Off when the rail wraps this grid in its own collapsible section (#46) —
   * that section's header already says "Filament", and repeating it inside
   * reads as two panels. The add / remove buttons stay either way: they are
   * the grid's controls, not the section's.
   */
  showHeading?: boolean;
}

export function FilamentSlotGrid({
  presets,
  slots,
  slotsLoading,
  filamentPresets,
  filamentTypeWarnings = [],
  onFilamentPresetChange,
  onAddSlot,
  onInsertSlotAfter,
  onRemoveSlot,
  onSlotColorChange,
  selectedPrinterName,
  compatIndex,
  disabled = false,
  showHeading = true,
}: FilamentSlotGridProps) {
  const { t } = useTranslation();
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  if (slotsLoading) {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-bambu-gray">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('slice.analyzingPlateFilaments')}
      </div>
    );
  }

  const canAdd = !disabled && canInsertAfter(slots, slots.length - 1);
  const canDrop = !disabled && canRemoveLast(slots);
  // The *same* call the 3D stage is painted from (#42) — one function, two
  // consumers, so a badge and the model it describes cannot show different
  // colours for the same slot.
  const slotColors = resolveSlotColors(slots, presets, filamentPresets);

  return (
    <div className="flex flex-col gap-2" data-testid="filament-slots">
      <div className="flex items-center justify-between gap-2">
        {showHeading && (
          <h3 className="text-xs font-semibold uppercase tracking-wider text-bambu-gray">
            {t('slicer.filamentHeading')}
          </h3>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onAddSlot}
            disabled={!canAdd}
            aria-label={t('slicer.addSlot')}
            title={canAdd ? t('slicer.addSlot') : t('slicer.slotOrderLocked')}
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-bambu-dark-tertiary text-bambu-gray transition-colors hover:border-bambu-gray hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onRemoveSlot(slots.length - 1)}
            disabled={!canDrop}
            aria-label={t('slicer.removeSlot')}
            title={canDrop ? t('slicer.removeSlot') : t('slicer.slotOrderLocked')}
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-bambu-dark-tertiary text-bambu-gray transition-colors hover:border-bambu-gray hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {slots.map((slot, index) => {
        // Slots the backend flagged as unused by this plate stay auto-picked
        // and read-only — the CLI still needs a profile per project slot, but
        // the user should not have to reason about slots their plate never
        // paints with. A slot they added themselves is theirs to set, even
        // though the plate does not use it either.
        const isUsed = slot.used_in_plate !== false;
        const editable = isUsed || slot.userAdded;
        const slotColor = slotColors[index];
        const label = slot.userAdded
          ? t('slicer.filamentSlotAdded', { index: index + 1 })
          : slot.type
            ? t('slice.filamentSlot', { index: index + 1, type: slot.type })
            : t('slicer.filamentSlotPlain', { index: index + 1 });
        const removable = !disabled && canRemoveSlotAt(slots, index);
        const insertable = !disabled && canInsertAfter(slots, index);

        return (
          <div
            key={slot.key}
            data-testid={`filament-slot-${index + 1}`}
            className="flex items-end gap-2"
          >
            {/* The numbered badge doubles as the colour control: its fill IS
                the slot's colour (comment 153), and clicking it opens the
                picker. The native colour input is laid over the badge rather
                than placed beside it so the badge stays the single thing that
                shows *and* sets the colour. */}
            <label
              className="relative mb-0.5 inline-flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded border border-bambu-dark-tertiary text-[11px] font-semibold"
              style={{ backgroundColor: slotColor }}
              title={t('slicer.slotColorTitle', { index: index + 1 })}
            >
              <span className="mix-blend-difference text-white" aria-hidden>
                {index + 1}
              </span>
              <input
                type="color"
                aria-label={t('slicer.slotColor', { index: index + 1 })}
                value={toColorInputValue(slotColor)}
                onChange={(event) => onSlotColorChange(index, event.target.value)}
                disabled={disabled}
                className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
              />
            </label>

            <div className="min-w-0 flex-1">
              <PresetDropdown
                label={isUsed || slot.userAdded ? label : `${label} ${t('slice.notUsedByPlate')}`}
                slot="filament"
                data={presets}
                value={filamentPresets[index] ?? null}
                onChange={(ref) => onFilamentPresetChange(index, ref)}
                disabled={disabled || !editable}
                selectedPrinterName={selectedPrinterName}
                compatIndex={compatIndex}
                // #57: a filament profile scoped to a printer the user did not
                // select is noise here, not a fallback — same call as the
                // rail's process picker.
                hideIncompatible
                // #58: manufacturer, then material — the owner asked for
                // Bambu Studio's grouping, and the source tier a preset came
                // from is an implementation detail, not a heading. Falls back
                // to the tier grouping on its own when the presets carry
                // neither vendor nor material.
                groupByVendor
                selectClassName="px-2 py-1.5 text-xs"
                // Same suppression as `SliceModal` (#47): a slot the plate does
                // not paint with is auto-picked and read-only, so a material
                // warning on it is noise the user cannot act on.
                typeWarning={isUsed ? (filamentTypeWarnings[index] ?? null) : null}
              />
            </div>

            <SlotMenu
              open={openMenu === slot.key}
              onOpenChange={(open) => setOpenMenu(open ? slot.key : null)}
              label={t('slicer.slotMenu', { index: index + 1 })}
              items={[
                {
                  key: 'insert',
                  label: t('slicer.insertSlotAfter'),
                  enabled: insertable,
                  hint: t('slicer.slotOrderLocked'),
                  onSelect: () => onInsertSlotAfter(index),
                },
                {
                  key: 'remove',
                  label: t('slicer.removeThisSlot'),
                  enabled: removable,
                  hint:
                    slots.length <= 1
                      ? t('slicer.slotLastRemaining')
                      : t('slicer.slotOrderLocked'),
                  onSelect: () => onRemoveSlot(index),
                },
                {
                  key: 'reset-color',
                  label: t('slicer.resetSlotColor'),
                  enabled: !disabled && slot.colorSet,
                  hint: t('slicer.slotColorNotSet'),
                  onSelect: () => onSlotColorChange(index, null),
                },
              ]}
            />
          </div>
        );
      })}

      <p className="text-[10px] leading-snug text-bambu-gray/70">
        {t('slicer.slotOrderHint')}
      </p>
    </div>
  );
}

interface SlotMenuItem {
  key: string;
  label: string;
  enabled: boolean;
  /** Shown on `title` when the item is disabled — the rule, not the action. */
  hint: string;
  onSelect: () => void;
}

/**
 * The per-slot `⋯`. Deliberately tiny: a popover with three items, closed on
 * outside click and on Escape. Not worth a shared abstraction until a second
 * caller exists, and a `<select>` would misread as another setting.
 */
function SlotMenu({
  open,
  onOpenChange,
  label,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  items: SlotMenuItem[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={containerRef} className="relative mb-0.5 flex-shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => onOpenChange(!open)}
        className="inline-flex h-7 w-7 items-center justify-center rounded border border-transparent text-bambu-gray transition-colors hover:border-bambu-dark-tertiary hover:text-white"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary py-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={!item.enabled}
              title={item.enabled ? undefined : item.hint}
              onClick={() => {
                onOpenChange(false);
                item.onSelect();
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * `<input type="color">` accepts exactly `#rrggbb`. Plate colours arrive as
 * `#RRGGBBAA` (the 3MF's own spelling) or occasionally without the `#`, and a
 * value the input rejects silently resets it to black — which would look like
 * the slot's colour had been cleared.
 */
function toColorInputValue(color: string): string {
  const hex = color.replace('#', '').slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : '#000000';
}
