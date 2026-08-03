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
  resolveSlotColors,
  seedSlots,
  setSlotColorAt,
  slotColorPayload,
  UNSET_SLOT_COLOR,
} from '../../../components/slicer/filamentSlots';
import type { PlateFilament } from '../../../types/plates';
import type { UnifiedPresetsResponse } from '../../../api/client';

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

/**
 * `resolveSlotColors` (#42) — the list the 3D stage is painted from *and* the
 * list the rail's numbered badges are filled from. One function, so the two
 * cannot disagree; these cases pin what it resolves to.
 */
describe('resolveSlotColors', () => {
  const filament = (id: string, colour?: string) => ({
    id,
    name: id,
    source: 'local' as const,
    filament_type: 'PLA',
    ...(colour === undefined ? {} : { filament_colour: colour }),
  });

  const PRESETS = {
    orca_cloud: { printer: [], process: [], filament: [] },
    cloud: { printer: [], process: [], filament: [] },
    local: {
      printer: [],
      process: [],
      filament: [filament('blue', '#0000FF'), filament('colourless')],
    },
    standard: { printer: [], process: [], filament: [] },
    cloud_status: 'ok',
    orca_cloud_status: 'ok',
  } as unknown as UnifiedPresetsResponse;

  const ref = (id: string) => ({ source: 'local' as const, id });

  it('is one entry per slot, in slot order, with index 0 = slot 1', () => {
    const two = seedSlots([req(1, true, '#FF0000'), req(2, true, '#00FF00')]);
    expect(resolveSlotColors(two, PRESETS, [null, null])).toEqual(['#FF0000', '#00FF00']);
  });

  it('lets the picked profile beat the plate\'s as-designed colour', () => {
    // **#49 reversed #45 here.** This case used to expect `['#FF0000', …]` —
    // the file's embedded red surviving a blue profile — because #45 resolved
    // `slot.color || presetColor`. A slice preview exists to show what *this
    // slice* will produce, so a profile the user has loaded into the slot now
    // outranks the colour the file was authored with. Both slots below render
    // the picked blue: slot 1 in spite of its embedded red, slot 2 for want of
    // any colour of its own.
    const two = seedSlots([req(1, true, '#FF0000'), req(2, true, '')]);
    expect(resolveSlotColors(two, PRESETS, [ref('blue'), ref('blue')])).toEqual([
      '#0000FF',
      '#0000FF',
    ]);
  });

  it('still falls back to the plate colour when the picked profile carries none', () => {
    // The profile only *outranks* the file — it does not erase it. A profile
    // with no `filament_colour` (plenty of real ones have none) must leave the
    // as-designed colour showing rather than drop the slot to the neutral.
    const two = seedSlots([req(1, true, '#FF0000'), req(2, true, '#00FF00')]);
    expect(resolveSlotColors(two, PRESETS, [ref('colourless'), null])).toEqual([
      '#FF0000',
      '#00FF00',
    ]);
  });

  it('prefers a colour the user chose over everything else', () => {
    // **The trap in #49's "one-line swap".** `slot.color` is the *effective*
    // colour — it holds both the user's hand-picked value and the plate's
    // as-designed one, and only `colorSet` distinguishes them. Writing the new
    // rule as `presetColor || slot.color || …` would therefore demote a colour
    // the user set by hand below the profile's, and this case is what catches
    // it: slot 1 must stay `#123456` even though its profile is blue.
    const two = setSlotColorAt(seedSlots([req(1, true, '#FF0000'), req(2, true, '')]), 0, '#123456');
    expect(resolveSlotColors(two, PRESETS, [ref('blue'), ref('blue')])).toEqual([
      '#123456',
      '#0000FF',
    ]);
  });

  it('puts the neutral at an unset slot\'s own index rather than leaving a hole', () => {
    // Slot 2 has no plate colour and its profile carries none either. It must
    // resolve to the neutral *in place* — an entry that fell through would
    // slide slot 3's colour up onto slot 2's geometry.
    const three = seedSlots([req(1, true, '#FF0000'), req(2, true, ''), req(3, true, '#00FF00')]);
    expect(resolveSlotColors(three, PRESETS, [null, ref('colourless'), null])).toEqual([
      '#FF0000',
      UNSET_SLOT_COLOR,
      '#00FF00',
    ]);
  });

  it('resolves every slot to the neutral before the presets have loaded', () => {
    const two = seedSlots([req(1, true, ''), req(2, true, '')]);
    expect(resolveSlotColors(two, undefined, [ref('blue'), ref('blue')])).toEqual([
      UNSET_SLOT_COLOR,
      UNSET_SLOT_COLOR,
    ]);
  });
});
