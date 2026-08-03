/**
 * The slicer page's **owned** filament-slot list (#45, rail.2).
 *
 * ## Why this file exists
 *
 * Until this ticket `filamentSlots` was *derived*: it was `filamentReqsQuery`'s
 * answer, mapped straight into the rail. The user could pick a profile per
 * existing slot and nothing else. Bambu Studio's Project Filaments panel lets
 * you add and remove slots and give each one a colour, so the list has to
 * become state the page owns and merely *seeds* from the plate.
 *
 * Everything about editing that list is pure and lives here, because the one
 * way to get it wrong is invisible:
 *
 * > `filament_presets` reaches the backend as a **positional** list — index 0 is
 * > slot 1, and the slicer matches it index-by-index against the plate's own
 * > filament slots. Insert or remove anywhere but the end and every later slot
 * > shifts under the model's painted geometry. The slice still succeeds. It
 * > just comes out with the materials swapped, which reads as a plausible
 * > print rather than an error.
 *
 * ## The rule: a plate-used prefix is immutable
 *
 * The plate's geometry names its extruders **by number** — "this part prints
 * with extruder 2" is baked into the 3MF. Bambuddy forwards a positional list;
 * it has no way to re-index painted geometry. So any edit that would move a
 * slot the plate actually paints with is refused rather than remapped or
 * warned about:
 *
 * - **remove at `i`** is allowed only when `i > lastPlateUsedIndex` — removing
 *   `i` shifts everything after it, so both `i` itself and every later slot
 *   must be unpainted.
 * - **insert after `i`** is allowed only when `i >= lastPlateUsedIndex` — the
 *   new slot lands at `i + 1`, so nothing painted may sit at or after that.
 *
 * Both collapse to the same sentence for a user: *the slots your plate paints
 * with keep their positions; the ones after them are yours.* On the common
 * plate — where every slot is used, or where `used_in_plate` is absent and so
 * conservatively read as used — that is "append, and remove what you appended",
 * which is exactly as much freedom as can be offered without lying about what
 * reaches the slicer.
 *
 * The alternative, letting the user remove slot 2 of a plate that paints with
 * slot 2, has no honest implementation here: "remap" would require rewriting
 * the model, and "warn" trades a blocked click for a wrong print.
 *
 * ## Colour
 *
 * Bambu Studio carries a slot's colour on its numbered badge rather than in a
 * separate control, and #42 paints the 3D view from the same value, so a slot's
 * colour is one field with a defined precedence: the user's pick if there is
 * one, else the plate's as-designed colour. `plateColor` is kept alongside so
 * "reset to as designed" is possible after an override.
 */

import type { PlateFilament } from '../../types/plates';

/**
 * One editable slot. Extends `PlateFilament` — rather than replacing it —
 * because `SlicerRail`, `MobileSliceWizard` and `wizardSteps` already read that
 * shape, and `color` staying the *effective* colour means every existing
 * consumer keeps showing the right swatch with no change.
 */
export interface FilamentSlotState extends PlateFilament {
  /**
   * Identity that survives inserts and removals, so React keys (and the focus
   * inside a row) follow the slot rather than the index. Indices are the one
   * thing that shifts here; keying on them would move a slot's open menu onto
   * its neighbour.
   */
  key: string;
  /** The plate's as-designed colour. `''` for a slot the user added. */
  plateColor: string;
  /** True once the user has chosen this slot's colour themselves. */
  colorSet: boolean;
  /** True for a slot with no counterpart in the plate's requirements. */
  userAdded: boolean;
}

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `slot-${keyCounter}`;
}

/**
 * Renumber `slot_id` to match position, so "index 0 = slot 1" holds after
 * every edit. The backend reads the list positionally; a `slot_id` that
 * disagreed with the position would be a second, quieter source of truth.
 */
function renumber(slots: FilamentSlotState[]): FilamentSlotState[] {
  return slots.map((slot, index) =>
    slot.slot_id === index + 1 ? slot : { ...slot, slot_id: index + 1 },
  );
}

/**
 * Seed the owned list from the plate's filament requirements.
 *
 * An empty requirement list (an STL, or metadata that failed to load) seeds one
 * synthetic slot, matching what the rail and `SliceModal` have always shown for
 * those sources: a single filament dropdown.
 */
export function seedSlots(reqs: PlateFilament[] | undefined): FilamentSlotState[] {
  const source =
    reqs && reqs.length > 0
      ? reqs
      : [{ slot_id: 1, type: '', color: '', used_grams: 0, used_meters: 0 }];
  return source.map((req, index) => ({
    ...req,
    slot_id: index + 1,
    key: nextKey(),
    plateColor: req.color ?? '',
    colorSet: false,
    userAdded: false,
  }));
}

/**
 * Index of the last slot the picked plate paints with, or `-1` when it paints
 * with none.
 *
 * `used_in_plate === undefined` counts as **used**: sliced 3MFs and older
 * backends report only used filaments and omit the flag entirely, and reading
 * "no information" as "unused" would unlock exactly the slots whose position is
 * load-bearing. Same fail-closed reading the rail already uses for disabling a
 * slot's dropdown (`slot.used_in_plate !== false`).
 */
export function lastPlateUsedIndex(slots: FilamentSlotState[]): number {
  for (let i = slots.length - 1; i >= 0; i--) {
    if (!slots[i].userAdded && slots[i].used_in_plate !== false) return i;
  }
  return -1;
}

/** Removing `index` would not move any slot the plate paints with. */
export function canRemoveSlotAt(slots: FilamentSlotState[], index: number): boolean {
  if (slots.length <= 1) return false;
  if (index < 0 || index >= slots.length) return false;
  return index > lastPlateUsedIndex(slots);
}

/** Inserting after `index` would not move any slot the plate paints with. */
export function canInsertAfter(slots: FilamentSlotState[], index: number): boolean {
  if (index < -1 || index >= slots.length) return false;
  return index >= lastPlateUsedIndex(slots);
}

/** The last slot, which is what the header's `−` removes. */
export function canRemoveLast(slots: FilamentSlotState[]): boolean {
  return canRemoveSlotAt(slots, slots.length - 1);
}

/**
 * Insert a fresh slot after `index` (`slots.length - 1` appends).
 *
 * The new slot carries no required type and no colour: the plate does not ask
 * for it, and pretending it does would make the pre-pick score against a
 * requirement that doesn't exist.
 */
export function insertSlotAfter(
  slots: FilamentSlotState[],
  index: number,
): FilamentSlotState[] {
  const at = Math.min(Math.max(index + 1, 0), slots.length);
  const next = [...slots];
  next.splice(at, 0, {
    slot_id: at + 1,
    type: '',
    color: '',
    used_grams: 0,
    used_meters: 0,
    used_in_plate: false,
    key: nextKey(),
    plateColor: '',
    colorSet: false,
    userAdded: true,
  });
  return renumber(next);
}

/** Remove the slot at `index`. */
export function removeSlotAt(
  slots: FilamentSlotState[],
  index: number,
): FilamentSlotState[] {
  return renumber(slots.filter((_, i) => i !== index));
}

/** Set a slot's colour. `null` reverts to the plate's as-designed colour. */
export function setSlotColorAt(
  slots: FilamentSlotState[],
  index: number,
  color: string | null,
): FilamentSlotState[] {
  return slots.map((slot, i) => {
    if (i !== index) return slot;
    return color == null
      ? { ...slot, color: slot.plateColor, colorSet: false }
      : { ...slot, color, colorSet: true };
  });
}

/**
 * The per-slot colours as they travel in the slice request: the user's pick, or
 * `null` where the slot still has whatever the plate was designed with.
 *
 * Only overrides travel. An untouched selection therefore produces an all-null
 * list, which `buildSliceBody` omits — so a plain slice from this page stays
 * byte-identical to the one `SliceModal` sends, which is the parity the page's
 * tests pin.
 */
export function slotColorPayload(slots: FilamentSlotState[]): (string | null)[] {
  return slots.map((slot) => (slot.colorSet ? slot.color : null));
}

/** A neutral fill for a badge whose slot has no colour from anywhere. */
export const UNSET_SLOT_COLOR = '#6b7280';

/**
 * What a slot's numbered badge is filled with: the effective slot colour when
 * there is one, else the colour of the filament profile picked for it, else a
 * neutral grey. The badge is the only place colour is surfaced (comment 153),
 * so it has to fall back rather than render nothing.
 */
export function badgeColor(
  slot: FilamentSlotState,
  presetColor: string | null | undefined,
): string {
  return slot.color || presetColor || UNSET_SLOT_COLOR;
}
