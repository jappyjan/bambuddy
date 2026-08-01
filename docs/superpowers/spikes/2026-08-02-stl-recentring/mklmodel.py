"""Generate the asymmetric L-shaped STL used by ``run_layout_check.sh``.

A bar or a symmetric pair is centrosymmetric, so its axis-aligned bounding
box after a +30 degree rotation is identical to its bbox after -30 — which
means those models cannot tell a correct rotation from a mirrored one. Three
cubes in an L can: its rotated bbox differs by sign, so the extents printed
by ``extents.py`` pin down the transform convention rather than merely
showing that *something* rotated.
"""

import sys

from mkstl import cube_tris, stl_bbox, write_stl

# Cube centres relative to the shape's own origin, in mm. The L is 40x40
# overall with the top-right quadrant missing.
CUBES = [(-10.0, -10.0), (10.0, -10.0), (-10.0, 10.0)]
SIZE = 20.0
# Footprint corner points, used by applylayout.py's analytic expectation.
CORNERS = [
    (cx + dx, cy + dy) for cx, cy in CUBES for dx in (-SIZE / 2, SIZE / 2) for dy in (-SIZE / 2, SIZE / 2)
]


def l_shape(cx: float, cy: float) -> list:
    tris = []
    for dx, dy in CUBES:
        tris += cube_tris(cx + dx, cy + dy, 0.0, SIZE)
    return tris


if __name__ == "__main__":
    path = sys.argv[1]
    write_stl(path, l_shape(128.0, 128.0))
    mn, mx = stl_bbox(path)
    print(f"{path}  min={[round(v, 2) for v in mn]}  max={[round(v, 2) for v in mx]}")
