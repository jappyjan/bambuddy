"""Generate binary STL cubes for the step-7.1 re-centring spike."""
import struct
import sys

def cube_tris(cx, cy, z0, size):
    h = size / 2.0
    x0, x1 = cx - h, cx + h
    y0, y1 = cy - h, cy + h
    z1 = z0 + size
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


if __name__ == "__main__":
    out = sys.argv[1]
    # A: single cube centred on the A1 bed (256x256), sitting on z=0
    write_stl(f"{out}/a_center.stl", cube_tris(128.0, 128.0, 0.0, 20.0))
    # B: same cube translated +40 X, +25 Y  (the "placement baked in" case)
    write_stl(f"{out}/b_translated.stl", cube_tris(168.0, 153.0, 0.0, 20.0))
    # C: two cubes, symmetric pair -> bbox centre stays at bed centre
    write_stl(f"{out}/c_pair.stl",
              cube_tris(108.0, 128.0, 0.0, 20.0) + cube_tris(148.0, 128.0, 0.0, 20.0))
    # D: same pair, but the two cubes pushed apart asymmetrically.
    #    bbox centre is DIFFERENT from C, and relative spacing differs too.
    write_stl(f"{out}/d_pair_moved.stl",
              cube_tris(108.0, 128.0, 0.0, 20.0) + cube_tris(188.0, 168.0, 0.0, 20.0))
    for name in ("a_center", "b_translated", "c_pair", "d_pair_moved"):
        mn, mx = stl_bbox(f"{out}/{name}.stl")
        print(f"{name}.stl  min={[round(v,2) for v in mn]}  max={[round(v,2) for v in mx]}")
