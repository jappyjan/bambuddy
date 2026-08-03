/**
 * Where each plate's bed sits in the shared multi-plate scene (#41).
 *
 * Bambu Studio does not show one plate at a time. It lays every plate out on a
 * **3-wide grid** on one virtual floor — wrapping to further rows — and you
 * orbit across them. Crucially it does that by *baking the cell offset into the
 * build-item transforms*: a build item on plate 5 is already written 408 mm to
 * the right and 384 mm forward of the same part on plate 1. So the geometry
 * needs no rearranging at all (`buildModelGroup(parsed, null)` already returns
 * every object at its true place); what has to be reconstructed is where each
 * plate's **bed** goes underneath it.
 *
 * ## The rule, and why it is not two constants
 *
 * Studio's `PartPlateList` strides one plate by its own size plus a fixed
 * *fraction* of it — `LOGICAL_PART_PLATE_GAP`, 0.2 — so the stride is
 * `bed x 1.2` on each axis, not a fixed millimetre gap. The reference file
 * `Attractap - V3 with Logo.3mf` prints on an H2S, whose `printable_area` is
 * 340 x 320, giving 408 x 384 — which is exactly the stride #40 measured off
 * all 16 of its build items. Hard-coding 408/384 would have reproduced that one
 * file and silently misplaced every bed for a 256 mm printer.
 *
 * Hence {@link plateGridOrigin} takes the bed size, and the bed size comes from
 * the *file* (`Parsed3MFData.bedSize`, read from `printable_area` in
 * `Metadata/project_settings.config`) rather than from the printer selected in
 * the rail. The file's own bed is what Studio used when it wrote those
 * transforms; a different printer chosen afterwards does not move the geometry,
 * so it must not move the beds either.
 *
 * ## Do not reach for `plateOffsets`
 *
 * `Parsed3MFData.plateOffsets` looks like it should hold this and does not:
 * #40 established that real Studio exports carry no `pos_x` / `pos_y` in
 * `model_settings.config` at all — the map is empty for the reference file —
 * and they ship only the *sliced* plate's `plate_N.json`, so `plateBounds` is
 * nearly empty too. The grid below is the only thing that reconstructs all of
 * them.
 */

/** Bambu Studio wraps to a new row after this many plates. */
export const PLATE_GRID_COLUMNS = 3;

/**
 * Studio's `LOGICAL_PART_PLATE_GAP`: the gap between two plates is this
 * fraction of the bed, so the stride is `bed x (1 + gap)`.
 */
export const PLATE_GAP_RATIO = 0.2;

/** A bed footprint in millimetres. Depth is `y` here, matching 3MF's Z-up axes. */
export interface BedSize {
  x: number;
  y: number;
}

/**
 * One plate's cell, in the 3MF's own (Z-up) bed coordinates.
 *
 * `x` / `y` are the cell's **minimum corner** — plate 1's is the origin, which
 * is where a single-plate file already puts its geometry — so the plate covers
 * `[x, x + bed.x] x [y, y + bed.y]`. Rows run towards **negative y**, which is
 * the direction Studio wraps in and the direction the reference file's plates
 * 4-8 are actually written at.
 */
export interface PlateCell {
  index: number;
  col: number;
  row: number;
  x: number;
  y: number;
}

/** The 1-indexed plate number as a grid cell, clamped against nonsense input. */
export function plateGridCell(plateIndex: number): { col: number; row: number } {
  const zeroBased = Math.max(0, Math.floor(plateIndex) - 1);
  return {
    col: zeroBased % PLATE_GRID_COLUMNS,
    row: Math.floor(zeroBased / PLATE_GRID_COLUMNS),
  };
}

/** Where plate `plateIndex`'s bed sits for a printer with this bed size. */
export function plateGridOrigin(plateIndex: number, bed: BedSize): PlateCell {
  const { col, row } = plateGridCell(plateIndex);
  const stride = 1 + PLATE_GAP_RATIO;
  return {
    index: plateIndex,
    col,
    row,
    x: col * bed.x * stride,
    // Written as a subtraction so the top row is +0 rather than -0: the value
    // travels into scene positions and test comparisons, and -0 is its own
    // small class of surprise in both.
    y: 0 - row * bed.y * stride,
  };
}

/** {@link plateGridOrigin} for a whole plate list, in the order given. */
export function plateGridOrigins(plateIndexes: number[], bed: BedSize): PlateCell[] {
  return plateIndexes.map((index) => plateGridOrigin(index, bed));
}

/**
 * The corner badge Studio prints on every plate: `01`, `02`, … `10`.
 *
 * Zero-padded to two digits and deliberately *not* translated — it is a number
 * on a picture of a printer bed, and the plate's name button next to it is what
 * carries the localised text.
 */
export function plateNumberBadge(plateIndex: number): string {
  return String(Math.max(1, Math.floor(plateIndex))).padStart(2, '0');
}
