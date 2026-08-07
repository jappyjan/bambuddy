"""Generate deliberately asymmetric binary STLs for the #70 placement spike.

The #22 spike (``../2026-08-02-stl-recentring/``) used cubes, which cannot
reveal a rotation. This one uses:

* ``bar`` — a 60 x 20 x 10 bar. A 90 degree rotation shows up directly in the
  first-layer bounding box (60x20 becomes 20x60). This is the exact shape the
  #22 docstring claims BambuStudio rotates.
* ``bar_offset`` — the same bar translated by (+40, +25) in STL coordinates.
  If the slicer honours baked-in placement, its sliced extents differ from
  ``bar`` by exactly that delta; if it re-centres, they are identical.
* ``ell`` — an L, bbox 60 x 50 x 10, with one bbox quadrant empty. The empty
  quadrant survives translation and scaling, so it identifies rotation *and*
  mirroring, which a bounding box alone cannot.
* ``pair`` — two bars 150 mm apart in Y. A single centred object cannot tell
  "``--arrange`` ran and was a no-op" apart from "``--arrange`` was ignored";
  a gap that arranging would close can.
* ``far_pair`` — two bars 300 mm apart, bbox 60 x 320. Does not fit a 256 mm
  bed *unless* something repacks it, so it fails without arranging and would
  succeed with it. This is the decisive ``--arrange`` probe.

All parts sit on z = 0 with their bbox minimum at the STL origin unless the
name says otherwise, so "where did it land" is a question about the slicer,
not about the mesh.
"""

import struct
import sys


def box_tris(x0, y0, z0, x1, y1, z1):
    """Twelve triangles for an axis-aligned box."""
    v = [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]
    faces = [
        (0, 2, 1), (0, 3, 2),   # bottom
        (4, 5, 6), (4, 6, 7),   # top
        (0, 1, 5), (0, 5, 4),   # -y
        (1, 2, 6), (1, 6, 5),   # +x
        (2, 3, 7), (2, 7, 6),   # +y
        (3, 0, 4), (3, 4, 7),   # -x
    ]
    return [(v[a], v[b], v[c]) for a, b, c in faces]


def translate(tris, dx, dy, dz=0.0):
    return [
        tuple((p[0] + dx, p[1] + dy, p[2] + dz) for p in tri)
        for tri in tris
    ]


def write_stl(path, tris):
    with open(path, "wb") as f:
        f.write(b"\0" * 80)
        f.write(struct.pack("<I", len(tris)))
        for a, b, c in tris:
            f.write(struct.pack("<3f", 0.0, 0.0, 0.0))
            for p in (a, b, c):
                f.write(struct.pack("<3f", *p))
            f.write(struct.pack("<H", 0))


def stl_bbox(path):
    with open(path, "rb") as f:
        f.read(80)
        n = struct.unpack("<I", f.read(4))[0]
        mn = [1e18] * 3
        mx = [-1e18] * 3
        for _ in range(n):
            f.read(12)
            for _ in range(3):
                p = struct.unpack("<3f", f.read(12))
                for i in range(3):
                    mn[i] = min(mn[i], p[i])
                    mx[i] = max(mx[i], p[i])
            f.read(2)
    return mn, mx


# The L: long arm along +X, short arm along +Y, sharing the origin corner.
# Bbox 60 x 50; the (+x, +y) quadrant relative to the bbox centre is empty.
ELL = box_tris(0, 0, 0, 60, 20, 10) + box_tris(0, 20, 0, 20, 50, 10)
BAR = box_tris(0, 0, 0, 60, 20, 10)


if __name__ == "__main__":
    out = sys.argv[1]
    write_stl(f"{out}/bar.stl", BAR)
    write_stl(f"{out}/bar_offset.stl", translate(BAR, 40.0, 25.0))
    write_stl(f"{out}/ell.stl", ELL)
    write_stl(f"{out}/pair.stl", BAR + translate(BAR, 0.0, 150.0))
    write_stl(f"{out}/far_pair.stl", BAR + translate(BAR, 0.0, 300.0))
    write_stl(f"{out}/cube.stl", box_tris(0, 0, 0, 20, 20, 20))
    for name in ("bar", "bar_offset", "ell", "pair", "far_pair", "cube"):
        mn, mx = stl_bbox(f"{out}/{name}.stl")
        size = [round(mx[i] - mn[i], 2) for i in range(3)]
        print(
            f"{name}.stl  min={[round(v, 2) for v in mn]}  "
            f"max={[round(v, 2) for v in mx]}  size={size}"
        )
