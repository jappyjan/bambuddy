/**
 * The slot-edit rules (#45, rail.2).
 *
 * The interesting content of this module is not the splicing — it is *which
 * edits are refused*. Slot position is what the model's painted geometry
 * refers to, so an edit that would move a painted slot has no honest
 * implementation and is blocked. These cases pin that boundary from both
 * sides; the request-level consequences are pinned in
 * `pages/SlicerPageFilamentSlots.test.tsx`.
 */

import { describe, it, expect } from 'vitest';
import {
  canInsertAfter,
  canRemoveLast,
  canRemoveSlotAt,
  insertSlotAfter,
  lastPlateUsedIndex,
  removeSlotAt,
  seedSlots,
  setSlotColorAt,
  slotColorPayload,
} from '../../../components/slicer/filamentSlots';
import type { PlateFilament } from '../../../types/plates';

const req = (slot: number, used: boolean | undefined, color = ''): PlateFilament => ({
  slot_id: slot,
  type: 'PLA',
  color,
  used_grams: 0,
  used_meters: 0,
  ...(used === undefined ? {} : { used_in_plate: used }),
});

describe('seedSlots', () => {
  it('gives an STL / no-metadata source the single synthetic slot the rail has always shown', () => {
    expect(seedSlots(undefined)).toHaveLength(1);
    expect(seedSlots([])).toHaveLength(1);
    expect(seedSlots([])[0].type).toBe('');
  });

  it('keeps the plate colour separately from the effective one, so a colour can be undone', () => {
    const [slot] = seedSlots([req(1, true, '#FF0000')]);
    expect(slot.color).toBe('#FF0000');
    expect(slot.plateColor).toBe('#FF0000');
    expect(slot.colorSet).toBe(false);
  });
});

describe('lastPlateUsedIndex', () => {
  it('reads a MISSING used_in_plate as used', () => {
    // Sliced 3MFs and older backends report only used filaments and omit the
    // flag. Reading "no information" as "unused" would unlock exactly the
    // slots whose position is load-bearing.
    expect(lastPlateUsedIndex(seedSlots([req(1, undefined), req(2, undefined)]))).toBe(1);
  });

  it('ignores trailing unused slots', () => {
    expect(lastPlateUsedIndex(seedSlots([req(1, true), req(2, true), req(3, false)]))).toBe(1);
  });

  it('is -1 when the plate paints with nothing', () => {
    expect(lastPlateUsedIndex(seedSlots([req(1, false), req(2, false)]))).toBe(-1);
  });
});

describe('the painted prefix is immutable', () => {
  const slots = seedSlots([req(1, true), req(2, true), req(3, false), req(4, false)]);

  it('refuses to remove a painted slot', () => {
    expect(canRemoveSlotAt(slots, 0)).toBe(false);
    expect(canRemoveSlotAt(slots, 1)).toBe(false);
  });

  it('refuses to remove an unpainted slot that sits BEFORE a painted one', () => {
    // The hazard is the shift, not the slot itself: removing index 0 here
    // would slide the painted slot at index 1 into position 1.
    const leading = seedSlots([req(1, false), req(2, true)]);
    expect(canRemoveSlotAt(leading, 0)).toBe(false);
  });

  it('allows removing an unpainted slot after the last painted one', () => {
    expect(canRemoveSlotAt(slots, 2)).toBe(true);
    expect(canRemoveSlotAt(slots, 3)).toBe(true);
    expect(canRemoveLast(slots)).toBe(true);
  });

  it('never removes the last remaining slot — a slice needs one', () => {
    expect(canRemoveSlotAt(seedSlots([req(1, false)]), 0)).toBe(false);
  });

  it('refuses an insert that would shift a painted slot, and allows one after them', () => {
    expect(canInsertAfter(slots, 0)).toBe(false);
    expect(canInsertAfter(slots, 1)).toBe(true);
    expect(canInsertAfter(slots, 3)).toBe(true);
  });

  it('locks everything but appending when every slot is painted', () => {
    const allUsed = seedSlots([req(1, true), req(2, true)]);
    expect(canInsertAfter(allUsed, allUsed.length - 1)).toBe(true);
    expect(canRemoveLast(allUsed)).toBe(false);
  });
});

describe('editing', () => {
  it('renumbers slot_id to match position after an insert and a removal', () => {
    // `slot_id` disagreeing with the position would be a second, quieter
    // source of truth about a list the backend reads positionally.
    const inserted = insertSlotAfter(seedSlots([req(1, true), req(2, false)]), 1);
    expect(inserted.map((s) => s.slot_id)).toEqual([1, 2, 3]);
    expect(removeSlotAt(inserted, 1).map((s) => s.slot_id)).toEqual([1, 2]);
  });

  it('gives an added slot no required type, because the plate does not ask for one', () => {
    const added = insertSlotAfter(seedSlots([req(1, true, '#FF0000')]), 0)[1];
    expect(added.type).toBe('');
    expect(added.userAdded).toBe(true);
    expect(added.used_in_plate).toBe(false);
  });

  it('keys survive an insert, so a row does not adopt its neighbour', () => {
    const before = seedSlots([req(1, false), req(2, false)]);
    const after = insertSlotAfter(before, 0);
    expect(after[0].key).toBe(before[0].key);
    expect(after[2].key).toBe(before[1].key);
  });
});

describe('colour', () => {
  const slots = seedSlots([req(1, true, '#FF0000'), req(2, true, '#00FF00')]);

  it('sends only the colours the user actually chose', () => {
    expect(slotColorPayload(slots)).toEqual([null, null]);
    expect(slotColorPayload(setSlotColorAt(slots, 1, '#123456'))).toEqual([null, '#123456']);
  });

  it('reverts to the plate colour, which stops it travelling again', () => {
    const set = setSlotColorAt(slots, 0, '#123456');
    const undone = setSlotColorAt(set, 0, null);
    expect(undone[0].color).toBe('#FF0000');
    expect(slotColorPayload(undone)).toEqual([null, null]);
  });
});
