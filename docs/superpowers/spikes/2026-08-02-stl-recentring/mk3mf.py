"""Wrap an STL's triangles into a minimal core-spec 3MF with a build-item transform."""
import struct
import sys
import zipfile

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"""


def read_stl(path):
    with open(path, "rb") as f:
        f.read(80)
        n = struct.unpack("<I", f.read(4))[0]
        tris = []
        for _ in range(n):
            f.read(12)
            tri = [struct.unpack("<3f", f.read(12)) for _ in range(3)]
            f.read(2)
            tris.append(tri)
    return tris


def build_model(tris, transform):
    verts = {}
    order = []
    for tri in tris:
        for p in tri:
            k = (round(p[0], 5), round(p[1], 5), round(p[2], 5))
            if k not in verts:
                verts[k] = len(order)
                order.append(k)
    v_xml = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in order)
    t_xml = "".join(
        '<triangle v1="{}" v2="{}" v3="{}"/>'.format(
            *[verts[(round(p[0], 5), round(p[1], 5), round(p[2], 5))] for p in tri]
        )
        for tri in tris
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="millimeter" xml:lang="en-US" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        "<resources>"
        f'<object id="1" type="model"><mesh><vertices>{v_xml}</vertices>'
        f"<triangles>{t_xml}</triangles></mesh></object>"
        "</resources>"
        f'<build><item objectid="1" transform="{transform}"/></build>'
        "</model>"
    )


def translation(dx, dy, dz):
    return f"1 0 0 0 1 0 0 0 1 {dx} {dy} {dz}"


def write_3mf(path, tris, transform):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("3D/3dmodel.model", build_model(tris, transform))


if __name__ == "__main__":
    # Mesh authored at the origin: 20 mm cube spanning 0..20 on every axis.
    tris = read_stl(sys.argv[1] if len(sys.argv) > 1 else "models/origin_cube.stl")
    out = sys.argv[2] if len(sys.argv) > 2 else "models"
    write_3mf(f"{out}/w_center.3mf", tris, translation(118.0, 118.0, 0.0))
    write_3mf(f"{out}/w_offset.3mf", tris, translation(158.0, 143.0, 0.0))
    print("wrote w_center.3mf (item -> bbox centre 128,128) and w_offset.3mf (-> 168,153)")
