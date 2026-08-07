/**
 * Which bed the viewport draws (#69), and the one reducer that turns a
 * `printable_area` polygon into a footprint.
 *
 * ## The rule is conditional, and that is the whole point
 *
 * The owner's ask was "changing the printer should change plate size
 * accordingly, just like BambuStudio". Feeding the rail's printer straight into
 * the bed would do that — and would re-open the defect #39/#40/#41 existed to
 * fix. A multi-plate 3MF has its plate-grid offsets **baked into its build-item
 * transforms**, computed by the authoring slicer against *its* bed
 * (`plateGrid.ts` explains the stride). Draw those plates on a different bed and
 * every one of them slides out from under its own geometry.
 *
 * So {@link resolveBuildVolume} is a three-branch rule, in order:
 *
 * 1. **The file declares a bed** → use it. A 3MF's `printable_area` wins over
 *    the rail, always, single-plate or multi.
 * 2. **The file declares none** (an STL, or a 3MF with no
 *    `Metadata/project_settings.config`) → use the selected printer's bed.
 * 3. **Neither** → {@link DEFAULT_BUILD_VOLUME}. This is not a rare corner: the
 *    printer's `printable_area` arrives from a rebuilt sidecar image only, so it
 *    is `null` across the whole standard tier on every deployment that has not
 *    been rebuilt yet. Branch 3 is the live production path and has to be the
 *    dull one.
 *
 * ## Why a module rather than a few lines in the component
 *
 * `ModelViewer.tsx` stands up a real WebGL context, has no test file of its own
 * and is mocked by every consumer. Bed selection decided inside it would be
 * decided where nothing can check it. Everything here is pure, so the rule is
 * testable and both `ModelViewer` (which draws the bed) and `PlateStage` (which
 * arranges objects onto it) can reach the *same* answer instead of two answers
 * that drift.
 *
 * ## The z axis, deliberately not chased
 *
 * `printable_height` is not read. Nothing in the frontend consumes
 * `buildVolume.z` — the bed is drawn from `.x`/`.y`, and `autoArrangeTransforms`
 * takes `{x, y}` — so a "real" z would be a field carried for no reader. It
 * stays 256 for shape compatibility with the callers that already spell a
 * `BuildVolume` with three axes.
 */

import type { BedSize } from './plateGrid';

/** The bed the viewport draws, in millimetres. `z` is carried, not used. */
export interface BuildVolume {
  x: number;
  y: number;
  z: number;
}

/**
 * The bed drawn when nothing better is known.
 *
 * **One declaration.** It used to be spelled separately in `ModelViewer.tsx` and
 * `PlateStage.tsx` with a comment on each asking the other to stay in step —
 * which matters because the stage arranges objects onto the bed the viewer
 * draws, and two constants that disagree put the model beside the plate.
 *
 * Module-level, so the default is **referentially stable**. As a default
 * parameter it was a fresh object every render, and it sits in `ModelViewer`'s
 * scene-setup dependency list: every render of a caller that omitted
 * `buildVolume` tore the WebGL context down and rebuilt it, which no gizmo
 * survives. Keep it a constant.
 */
export const DEFAULT_BUILD_VOLUME: BuildVolume = { x: 256, y: 256, z: 256 };

/**
 * The footprint of a `printable_area` polygon, or `null`.
 *
 * The value is a bed **outline**, as `"<x>x<y>"` corner points — a 3MF's
 * `Metadata/project_settings.config` and a printer preset's resolved profile
 * both spell it this way (`["0x0","350x0","350x320","0x320"]` for an H2D). It is
 * not a width/height pair, and the last corner is not the size.
 *
 * Reduced to the polygon's **extent**, which is deliberately more careful than
 * the equivalent backend reduction at `archives.py`:
 *
 * - **Fractional coordinates survive.** `parseFloat`, not `int` — the backend's
 *   `int("162.5")` raises and the coordinate is silently dropped.
 * - **An origin offset survives.** The extent is `max - min`, not `max`; a bed
 *   declared `20x20 … 270x270` is 250 wide, not 270.
 * - **A polygon given as one comma-joined string** is accepted as well as an
 *   array: OrcaSlicer's `Creality Ender-5 Max` writes it that way.
 * - **Whitespace inside a point** is tolerated (BambuStudio's
 *   `Bambu Lab X2D 0.4 nozzle`).
 * - **Non-rectangular beds** reduce to their bounding box rather than being
 *   rejected: eight OrcaSlicer profiles declare 72-point round delta beds, and a
 *   circumscribing rectangle is a better drawing than no bed at all.
 *
 * Fewer than three points is not a polygon, and anything unparseable, degenerate
 * or non-finite yields `null` so the caller falls through to the next branch of
 * {@link resolveBuildVolume}. `null` must never collapse into a bed of size zero.
 */
export function printableAreaBed(raw: unknown): BedSize | null {
  const points = normalisePolygon(raw);
  if (points === null || points.length < 3) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const parts = point.split('x');
    if (parts.length !== 2) return null;
    const x = Number.parseFloat(parts[0]);
    const y = Number.parseFloat(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const x = maxX - minX;
  const y = maxY - minY;
  return x > 0 && y > 0 ? { x, y } : null;
}

/** The corner points of a polygon written either as a list or as one string. */
function normalisePolygon(raw: unknown): string[] | null {
  if (typeof raw === 'string') {
    // `Creality Ender-5 Max` declares the whole outline in a single value.
    return raw.split(',').map((point) => point.trim()).filter((point) => point.length > 0);
  }
  if (!Array.isArray(raw)) return null;
  const points: string[] = [];
  for (const entry of raw) {
    // A single-element array holding the comma-joined form is the same file
    // shape arriving one layer deeper; anything else non-string is not a bed.
    if (typeof entry !== 'string') return null;
    for (const point of entry.split(',')) {
      const trimmed = point.trim();
      if (trimmed.length > 0) points.push(trimmed);
    }
  }
  return points;
}

/**
 * A printer preset's `printable_area` as a build volume, or `null` when the
 * preset does not carry one.
 *
 * `null` is the normal state, not an error: only a rebuilt sidecar image
 * resolves the field, so every deployment running an older image reports it for
 * no printer at all.
 */
export function printerBuildVolume(printableArea: string[] | string | null | undefined): BuildVolume | null {
  const bed = printableAreaBed(printableArea);
  return bed === null ? null : { x: bed.x, y: bed.y, z: DEFAULT_BUILD_VOLUME.z };
}

/**
 * The bed to draw, and to arrange onto: the file's if it declares one, else the
 * selected printer's, else {@link DEFAULT_BUILD_VOLUME}.
 *
 * See the module header for why the file wins. The short version: a 3MF's
 * geometry is already placed against the bed the file names, so changing the
 * printer must not move the bed out from under it.
 */
export function resolveBuildVolume(
  fileBedSize: BedSize | null | undefined,
  printerVolume: BuildVolume | null | undefined,
): BuildVolume {
  const z = printerVolume?.z ?? DEFAULT_BUILD_VOLUME.z;
  if (fileBedSize && fileBedSize.x > 0 && fileBedSize.y > 0) {
    return { x: fileBedSize.x, y: fileBedSize.y, z };
  }
  if (printerVolume && printerVolume.x > 0 && printerVolume.y > 0) {
    return { x: printerVolume.x, y: printerVolume.y, z };
  }
  return DEFAULT_BUILD_VOLUME;
}
