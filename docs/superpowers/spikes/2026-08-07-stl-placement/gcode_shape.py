"""First-layer placement AND orientation from OrcaSlicer / BambuStudio G-code.

Extends ``../2026-08-02-stl-recentring/extents.py``, which reports only a
bounding box. A bounding box answers "where did it land" but not "which way
up" for anything whose silhouette is not a rectangle, so this adds a quadrant
occupancy signature: the fraction of first-layer extrusion length falling in
each quadrant of the part's own bounding box.

For the ``ell`` model one quadrant is empty by construction, so the signature
names the rotation directly:

    empty quadrant  +x+y  -> as authored (no rotation)
    empty quadrant  -x+y  -> rotated  90 deg CCW
    empty quadrant  -x-y  -> rotated 180 deg
    empty quadrant  +x-y  -> rotated  90 deg CW

Only extrusion between the first and second layer-change markers is counted,
and Custom / skirt / brim / prime-tower features are skipped so the machine
start G-code (the A1's purge line at X=-48) does not pollute the box.
"""

import json
import re
import sys

NUM = r"([-+]?\d*\.?\d+)"
LAYER_MARK = re.compile(r"^;\s*(CHANGE_LAYER|LAYER_CHANGE|LAYER:\s*\d+)\s*$", re.I)
FEAT_MARK = re.compile(r"^;\s*(FEATURE|TYPE)\s*:\s*(.+)$", re.I)
SKIP_FEATURES = {"custom", "skirt", "brim", "prime tower", "wipe tower"}


def first_layer_segments(path):
    """Return [(x0, y0, x1, y1)] of extruding first-layer moves."""
    x = y = None
    layer = 0
    feat = ""
    segs = []
    with open(path, "r", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if s.startswith(";"):
                if LAYER_MARK.match(s):
                    layer += 1
                    if layer > 1:
                        break
                    continue
                m = FEAT_MARK.match(s)
                if m:
                    feat = m.group(2).strip()
                continue
            if not (s[:2] in ("G0", "G1") and (len(s) == 2 or s[2] in " \t")):
                continue
            gx = re.search(r"[Xx]" + NUM, s)
            gy = re.search(r"[Yy]" + NUM, s)
            ge = re.search(r"[Ee]" + NUM, s)
            nx = float(gx.group(1)) if gx else x
            ny = float(gy.group(1)) if gy else y
            extruding = ge is not None and float(ge.group(1)) > 0
            keep = layer == 1 and feat.lower() not in SKIP_FEATURES
            if (
                extruding and keep
                and None not in (x, y, nx, ny)
            ):
                segs.append((x, y, nx, ny))
            x, y = nx, ny
    return segs


def analyse(path):
    segs = first_layer_segments(path)
    if not segs:
        return None
    xs = [c for s in segs for c in (s[0], s[2])]
    ys = [c for s in segs for c in (s[1], s[3])]
    mn = (min(xs), min(ys))
    mx = (max(xs), max(ys))
    ctr = ((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2)
    size = (mx[0] - mn[0], mx[1] - mn[1])

    # Extrusion length per quadrant, attributed by segment midpoint.
    quads = {"+x+y": 0.0, "-x+y": 0.0, "-x-y": 0.0, "+x-y": 0.0}
    total = 0.0
    for x0, y0, x1, y1 in segs:
        length = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        if length == 0:
            continue
        mx_, my_ = (x0 + x1) / 2, (y0 + y1) / 2
        key = ("+x" if mx_ >= ctr[0] else "-x") + ("+y" if my_ >= ctr[1] else "-y")
        quads[key] += length
        total += length
    frac = {k: (v / total if total else 0.0) for k, v in quads.items()}
    empty = min(frac, key=frac.get)

    return {
        "file": path.split("/")[-1],
        "min": [round(v, 3) for v in mn],
        "max": [round(v, 3) for v in mx],
        "centre": [round(v, 3) for v in ctr],
        "size": [round(v, 3) for v in size],
        "quadrant_fraction": {k: round(v, 4) for k, v in frac.items()},
        "emptiest_quadrant": empty,
        "segments": len(segs),
    }


def fmt(v):
    return "(" + ", ".join(f"{c:8.3f}" for c in v) + ")"


if __name__ == "__main__":
    as_json = "--json" in sys.argv
    paths = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = []
    for p in paths:
        r = analyse(p)
        if r is None:
            print(f"{p.split('/')[-1]:34s}  NO FIRST-LAYER EXTRUSION FOUND")
            continue
        out.append(r)
        if not as_json:
            q = r["quadrant_fraction"]
            print(
                f"{r['file']:34s} min={fmt(r['min'])} max={fmt(r['max'])} "
                f"centre={fmt(r['centre'])} size={fmt(r['size'])}"
            )
            print(
                f"{'':34s} quadrants +x+y={q['+x+y']:.3f} -x+y={q['-x+y']:.3f} "
                f"-x-y={q['-x-y']:.3f} +x-y={q['+x-y']:.3f}  "
                f"empty={r['emptiest_quadrant']}"
            )
    if as_json:
        print(json.dumps(out, indent=2))
