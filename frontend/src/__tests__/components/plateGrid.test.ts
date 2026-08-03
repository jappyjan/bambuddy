/**
 * The multi-plate grid (#41).
 *
 * These numbers are not decoration: a 3MF written by Bambu Studio bakes each
 * plate's cell offset into its build-item transforms, so the beds this module
 * places have to land exactly where the geometry already is. Getting the stride
 * wrong does not look like a layout bug — it looks like the models are floating
 * between the plates, which is indistinguishable from the #40 defect this epic
 * started with.
 *
 * The grid-versus-real-geometry check lives in `parse3mf.test.ts`, against the
 * reference file. This file pins the arithmetic on its own.
 */

import { describe, it, expect } from 'vitest';
import {
  PLATE_GAP_RATIO,
  PLATE_GRID_COLUMNS,
  plateGridCell,
  plateGridOrigin,
  plateGridOrigins,
  plateNumberBadge,
} from '../../components/slicer/plateGrid';

/** The reference file's printer: a Bambu Lab H2S. */
const H2S = { x: 340, y: 320 };

describe('plateGridCell', () => {
  it('wraps three across, the way Studio does', () => {
    expect(PLATE_GRID_COLUMNS).toBe(3);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(plateGridCell)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
      { col: 0, row: 1 },
      { col: 1, row: 1 },
      { col: 2, row: 1 },
      { col: 0, row: 2 },
      { col: 1, row: 2 },
    ]);
  });

  it('treats a nonsense plate number as the first plate rather than throwing', () => {
    expect(plateGridCell(0)).toEqual({ col: 0, row: 0 });
    expect(plateGridCell(-4)).toEqual({ col: 0, row: 0 });
  });
});

describe('plateGridOrigin', () => {
  it('strides by the bed plus Studio\'s gap fraction, not a fixed millimetre gap', () => {
    // 340 x 1.2 = 408 and 320 x 1.2 = 384 — the offsets #40 measured off all 16
    // of the reference file's build items. Hard-coding those two numbers would
    // have reproduced this one printer and misplaced every bed for any other.
    expect(PLATE_GAP_RATIO).toBe(0.2);
    expect(plateGridOrigin(2, H2S)).toMatchObject({ x: 408, y: 0 });
    expect(plateGridOrigin(4, H2S)).toMatchObject({ x: 0, y: -384 });
    expect(plateGridOrigin(8, H2S)).toMatchObject({ x: 408, y: -768 });
  });

  it('puts the first plate at the origin, where a single-plate file already is', () => {
    expect(plateGridOrigin(1, H2S)).toMatchObject({ index: 1, col: 0, row: 0, x: 0, y: 0 });
  });

  it('scales with the bed, so a 256 mm printer gets a 256 mm grid', () => {
    expect(plateGridOrigin(5, { x: 256, y: 256 })).toMatchObject({
      x: 256 * 1.2,
      y: -256 * 1.2,
    });
  });

  it('runs rows towards negative y, the direction the file is written in', () => {
    // Positive would put plates 4-8 on the far side of plate 1 from where their
    // geometry actually is: beds and models in different postcodes.
    expect(plateGridOrigin(7, H2S).y).toBeLessThan(0);
  });

  it('maps a whole plate list in the order given', () => {
    expect(plateGridOrigins([3, 1], H2S).map((cell) => cell.index)).toEqual([3, 1]);
  });
});

describe('plateNumberBadge', () => {
  it('zero-pads to two digits and does not pad past them', () => {
    expect(plateNumberBadge(1)).toBe('01');
    expect(plateNumberBadge(9)).toBe('09');
    expect(plateNumberBadge(10)).toBe('10');
    expect(plateNumberBadge(0)).toBe('01');
  });
});
