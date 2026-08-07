/**
 * Tests for which bed the viewport draws (#69).
 *
 * This is where the ticket's risk actually lives. `ModelViewer.tsx` stands up a
 * real WebGL context, has no test file of its own and is mocked by every
 * consumer — so the rule that decides on-screen bed size was moved out into a
 * pure module rather than left where nothing could check it.
 *
 * Two things are pinned here, and they pull in opposite directions:
 *
 * 1. **The printer must reach the bed.** That is the owner's request.
 * 2. **A 3MF's own bed must outrank the printer.** Studio bakes plate-grid
 *    offsets into build-item transforms computed against the *file's* bed
 *    (`plateGrid.ts`); redrawing those plates on the rail's printer slides every
 *    one of them off its own geometry, which is the defect #39/#40/#41 existed
 *    to fix. The `multi-plate` case below is the regression that matters most.
 *
 * Numbers are real: 350 x 320 is the H2D's, 340 x 320 the H2S's (the shape
 * `plateBeds.test.ts` and `parse3mf.test.ts` already use), 180 x 180 the A1
 * mini's — the last two measured off real slices in #70's spike.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BUILD_VOLUME,
  printableAreaBed,
  printerBuildVolume,
  resolveBuildVolume,
} from '../../components/slicer/buildVolume';

/** An H2D, verbatim from its resolved printer profile. */
const H2D_AREA = ['0x0', '350x0', '350x320', '0x320'];

describe('printableAreaBed', () => {
  it('reduces the ordinary four-corner rectangle', () => {
    expect(printableAreaBed(['0x0', '256x0', '256x256', '0x256'])).toEqual({ x: 256, y: 256 });
  });

  it('keeps a non-square bed non-square', () => {
    // The whole point of the ticket: an H2D is 350 wide and 320 deep, and a bed
    // that reduces to a square renders as a square.
    expect(printableAreaBed(H2D_AREA)).toEqual({ x: 350, y: 320 });
  });

  it('keeps a fractional coordinate', () => {
    // The backend's equivalent reduction (`archives.py`) parses with `int()`,
    // which raises on "162.5" and drops the coordinate inside a bare `except`.
    // Rounding a bed down by half a millimetre is silent and permanent.
    expect(printableAreaBed(['0x0', '162.5x0', '162.5x180.5', '0x180.5'])).toEqual({
      x: 162.5,
      y: 180.5,
    });
  });

  it('keeps the offset of an origin-offset bed out of the size', () => {
    // Also unlike the backend, which takes `max` with no `min`: a bed running
    // from 20 to 270 is 250 across, not 270.
    expect(printableAreaBed(['20x20', '270x20', '270x300', '20x300'])).toEqual({ x: 250, y: 280 });
  });

  it('accepts the polygon written as one comma-joined string', () => {
    // How OrcaSlicer's `Creality Ender-5 Max` declares it.
    expect(printableAreaBed('0x0,400x0,400x400,0x400')).toEqual({ x: 400, y: 400 });
  });

  it('accepts a comma-joined string arriving inside a single-element list', () => {
    expect(printableAreaBed(['0x0,220x0,220x220,0x220'])).toEqual({ x: 220, y: 220 });
  });

  it('tolerates whitespace inside a point', () => {
    // BambuStudio's `Bambu Lab X2D 0.4 nozzle` writes its corners spaced out.
    // Belt and braces: `parseFloat` already skips leading whitespace, so this
    // pins the behaviour rather than exercising the trim.
    expect(printableAreaBed([' 0x0 ', '350 x 0', ' 350x320', '0x320 '])).toEqual({
      x: 350,
      y: 320,
    });
  });

  it('survives a trailing separator', () => {
    // What the trim and the empty-point filter are actually for: an empty final
    // point has no `x` at all, and unfiltered it rejects the whole bed.
    expect(printableAreaBed('0x0,350x0,350x320,0x320,')).toEqual({ x: 350, y: 320 });
    expect(printableAreaBed(['0x0', '350x0', '350x320', '0x320', ' '])).toEqual({
      x: 350,
      y: 320,
    });
  });

  it('reduces a round delta bed to its bounding box rather than rejecting it', () => {
    // Eight OrcaSlicer profiles declare a 72-point circle. A circumscribing
    // rectangle is a better drawing than no bed at all, and refusing the polygon
    // would drop those printers back to a 256 plate they do not have.
    const radius = 100;
    const circle = Array.from({ length: 72 }, (_, i) => {
      const angle = (i / 72) * Math.PI * 2;
      return `${(radius + radius * Math.cos(angle)).toFixed(3)}x${(radius + radius * Math.sin(angle)).toFixed(3)}`;
    });
    const bed = printableAreaBed(circle);
    expect(bed!.x).toBeCloseTo(200, 1);
    expect(bed!.y).toBeCloseTo(200, 1);
  });

  it('rejects anything that is not a polygon', () => {
    // `null` is the normal state on a deployment whose sidecar predates #68, and
    // it must stay distinguishable from a bed of size zero.
    expect(printableAreaBed(null)).toBeNull();
    expect(printableAreaBed(undefined)).toBeNull();
    expect(printableAreaBed([])).toBeNull();
    expect(printableAreaBed({ x: 350, y: 320 })).toBeNull();
    // Two points are a line, not a bed.
    expect(printableAreaBed(['0x0', '350x320'])).toBeNull();
    expect(printableAreaBed([0, 350, 320])).toBeNull();
    expect(printableAreaBed(['0x0', 'wide x deep', '350x320'])).toBeNull();
    expect(printableAreaBed(['0x0x0', '350x0x0', '350x320x0'])).toBeNull();
  });

  it('rejects a degenerate outline instead of returning a zero bed', () => {
    expect(printableAreaBed(['0x0', '0x0', '0x0'])).toBeNull();
    expect(printableAreaBed(['0x0', '0x100', '0x200'])).toBeNull();
  });
});

describe('printerBuildVolume', () => {
  it('carries the printer bed with the default height', () => {
    // z is deliberately not resolved: nothing in the frontend reads it — the bed
    // is drawn from x/y and `autoArrangeTransforms` takes {x, y} — so a resolved
    // height would be a field with no reader.
    expect(printerBuildVolume(H2D_AREA)).toEqual({ x: 350, y: 320, z: 256 });
  });

  it('is null when the preset carries no printable_area', () => {
    // The live state of every deployment until its sidecar image is rebuilt.
    expect(printerBuildVolume(null)).toBeNull();
    expect(printerBuildVolume(undefined)).toBeNull();
  });
});

describe('resolveBuildVolume', () => {
  const H2D = { x: 350, y: 320, z: 256 };

  it('rule 1 — the file wins when it declares a bed', () => {
    // The H2S multi-plate reference file (#41) with an H2D picked in the rail:
    // the drawn bed stays the file's. This is the regression that matters most —
    // the plate grid was strode by 340 x 320, and 350 x 320 beds would sit
    // beside their own geometry.
    expect(resolveBuildVolume({ x: 340, y: 320 }, H2D)).toEqual({ x: 340, y: 320, z: 256 });
  });

  it('rule 1 — and the printer selection cannot move it', () => {
    const fileBed = { x: 340, y: 320 };
    const onA1Mini = resolveBuildVolume(fileBed, { x: 180, y: 180, z: 256 });
    const onH2D = resolveBuildVolume(fileBed, H2D);
    expect(onA1Mini).toEqual(onH2D);
  });

  it('rule 2 — the printer wins when the file declares none', () => {
    // An STL, or a 3MF with no `Metadata/project_settings.config`.
    expect(resolveBuildVolume(null, H2D)).toEqual({ x: 350, y: 320, z: 256 });
    expect(resolveBuildVolume(null, { x: 180, y: 180, z: 256 })).toEqual({
      x: 180,
      y: 180,
      z: 256,
    });
  });

  it('rule 3 — the default when neither is available', () => {
    // Old sidecar, or no printer picked yet. The live production path today.
    expect(resolveBuildVolume(null, null)).toEqual(DEFAULT_BUILD_VOLUME);
    expect(resolveBuildVolume(undefined, undefined)).toEqual(DEFAULT_BUILD_VOLUME);
    expect(resolveBuildVolume(null, null)).toEqual({ x: 256, y: 256, z: 256 });
  });

  it('treats a zero-sized bed as no bed, on either side', () => {
    // A degenerate value must not produce an empty viewport.
    expect(resolveBuildVolume({ x: 0, y: 0 }, H2D)).toEqual({ x: 350, y: 320, z: 256 });
    expect(resolveBuildVolume(null, { x: 0, y: 0, z: 256 })).toEqual(DEFAULT_BUILD_VOLUME);
  });
});
