"""Drive the shipped placement code over a project 3MF.

Deliberately imports ``backend.app.services.plate_layout`` rather than
re-implementing the rewrite: the point of ``run_layout_check.sh`` is to prove
the code Bambuddy actually ships puts objects where the layout says, on both
sidecars — a private copy of the maths would prove nothing.

    applylayout.py <in.3mf> <out.3mf> move|rot+30|rot-30
    applylayout.py --expect        # analytic bbox for each case
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..")))

from mklmodel import CORNERS  # noqa: E402

from backend.app.services.plate_layout import (  # noqa: E402
    _object_anchors,
    apply_plate_layout,
)

CASES = {
    "move": {"offset": (40.0, 25.0, 0.0), "rotation": [0.0, 0.0, 0.0]},
    "rot+30": {"offset": (0.0, 0.0, 0.0), "rotation": [0.0, 0.0, 30.0]},
    "rot-30": {"offset": (0.0, 0.0, 0.0), "rotation": [0.0, 0.0, -30.0]},
}


def read_anchor(path):
    import zipfile

    with zipfile.ZipFile(path) as zf:
        xml = zf.read("3D/3dmodel.model").decode("utf-8")
    anchors = _object_anchors(xml)
    # The build item's object is the last one declared in a slicer export.
    return list(anchors.values())[-1]


def build_layout(anchor, case):
    spec = CASES[case]
    return {
        "version": 1,
        "plates": {
            "1": [
                {
                    "object_id": "1",
                    "position": [anchor[i] + spec["offset"][i] for i in range(3)],
                    "rotation": list(spec["rotation"]),
                    "scale": [1.0, 1.0, 1.0],
                }
            ]
        },
    }


def expected_bbox(case, centre=(128.0, 128.0)):
    spec = CASES[case]
    theta = math.radians(spec["rotation"][2])
    c, s = math.cos(theta), math.sin(theta)
    xs, ys = [], []
    for x, y in CORNERS:
        xs.append(centre[0] + spec["offset"][0] + c * x - s * y)
        ys.append(centre[1] + spec["offset"][1] + s * x + c * y)
    return min(xs), min(ys), max(xs), max(ys)


if __name__ == "__main__":
    if sys.argv[1] == "--expect":
        print("  model outline; sliced extents sit ~0.33 mm inside each edge (half a line width)")
        for case in ("none", *CASES):
            if case == "none":
                mnx, mny, mxx, mxy = expected_bbox("move", centre=(128.0 - 40.0, 128.0 - 25.0))
            else:
                mnx, mny, mxx, mxy = expected_bbox(case)
            print(
                f"  {case:8s} min=({mnx:7.2f}, {mny:7.2f}) max=({mxx:7.2f}, {mxy:7.2f}) "
                f"centre=({(mnx + mxx) / 2:7.2f}, {(mny + mxy) / 2:7.2f}) "
                f"size=({mxx - mnx:7.2f}, {mxy - mny:7.2f})"
            )
        raise SystemExit(0)

    src, dst, case = sys.argv[1], sys.argv[2], sys.argv[3]
    anchor = read_anchor(src)
    layout = build_layout(anchor, case)
    with open(src, "rb") as f:
        out = apply_plate_layout(f.read(), layout)
    with open(dst, "wb") as f:
        f.write(out)
    print(f"  {case}: anchor={[round(a, 2) for a in anchor]} -> position={layout['plates']['1'][0]['position']}")
