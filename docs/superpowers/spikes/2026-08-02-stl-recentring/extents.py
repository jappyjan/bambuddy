"""First-layer extrusion extents from OrcaSlicer / BambuStudio G-code.

Measures only between the first and second layer-change marker, and skips
Custom / skirt / brim features so machine start G-code (the A1's purge line
at X=-48) does not pollute the bounding box.
"""
import re
import sys

NUM = r"([-+]?\d*\.?\d+)"
LAYER_MARK = re.compile(r"^;\s*(CHANGE_LAYER|LAYER_CHANGE|LAYER:\s*\d+)\s*$", re.I)
FEAT_MARK = re.compile(r"^;\s*(FEATURE|TYPE)\s*:\s*(.+)$", re.I)
SKIP_FEATURES = {"custom", "skirt", "brim", "prime tower", "wipe tower"}


def first_layer_extents(path):
    x = y = None
    layer = 0
    feat = ""
    mn = [1e18, 1e18]
    mx = [-1e18, -1e18]
    n = 0
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
            if extruding and keep and nx is not None and ny is not None:
                for px, py in ((x, y), (nx, ny)):
                    if px is None or py is None:
                        continue
                    n += 1
                    mn[0] = min(mn[0], px); mn[1] = min(mn[1], py)
                    mx[0] = max(mx[0], px); mx[1] = max(mx[1], py)
            x, y = nx, ny
    if not n:
        return None
    return mn, mx


def fmt(v):
    return "(" + ", ".join(f"{c:7.2f}" for c in v) + ")"


if __name__ == "__main__":
    for p in sys.argv[1:]:
        r = first_layer_extents(p)
        name = p.split("/")[-1]
        if not r:
            print(f"{name:26s}  NO FIRST-LAYER EXTRUSION FOUND")
            continue
        mn, mx = r
        ctr = [(mn[i] + mx[i]) / 2 for i in range(2)]
        size = [mx[i] - mn[i] for i in range(2)]
        print(f"{name:26s} min={fmt(mn)} max={fmt(mx)} centre={fmt(ctr)} size={fmt(size)}")
