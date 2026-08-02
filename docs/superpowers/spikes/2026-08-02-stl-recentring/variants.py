"""Isolate which part of a Bambu/Orca 3MF makes placement stick."""
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mk3mf import read_stl  # noqa: E402

NS = ('xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
      'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" '
      'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" '
      'requiredextensions="p"')

CT = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
<Default Extension="config" ContentType="text/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"""

MODEL_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"""


def mesh_xml(tris):
    verts, order = {}, []
    for tri in tris:
        for p in tri:
            k = tuple(round(c, 5) for c in p)
            if k not in verts:
                verts[k] = len(order)
                order.append(k)
    v = "".join(f'<vertex x="{a}" y="{b}" z="{c}"/>' for a, b, c in order)
    t = "".join('<triangle v1="{}" v2="{}" v3="{}"/>'.format(
        *[verts[tuple(round(c, 5) for c in p)] for p in tri]) for tri in tris)
    return f"<mesh><vertices>{v}</vertices><triangles>{t}</triangles></mesh>"


def model_settings(obj_id, mat):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="{obj_id}">
    <metadata key="name" value="wrapped.stl"/>
    <metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="wrapped.stl"/>
      <metadata key="matrix" value="{mat}"/>
      <metadata key="source_file" value="wrapped.stl"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <model_instance>
      <metadata key="object_id" value="{obj_id}"/>
      <metadata key="instance_id" value="0"/>
    </model_instance>
  </plate>
  <assemble/>
</config>"""


def build(path, tris, x, y, z, *, components, settings):
    """components: mesh in a sub-model, placement on the <component> transform
    (what the slicer itself emits).  settings: include model_settings.config."""
    tr = f"1 0 0 0 1 0 0 0 1 {x} {y} {z}"
    mat = f"1 0 0 {x} 0 1 0 {y} 0 0 1 {z} 0 0 0 1"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", CT)
        zf.writestr("_rels/.rels", ROOT_RELS)
        if components:
            zf.writestr("3D/Objects/object_1.model",
                        f'<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" {NS}>'
                        f'<metadata name="BambuStudio:3mfVersion">1</metadata><resources>'
                        f'<object id="1" p:UUID="00010000-0000-4000-8000-000000000001" type="model">'
                        f"{mesh_xml(tris)}</object></resources><build/></model>")
            zf.writestr("3D/_rels/3dmodel.model.rels", MODEL_RELS)
            root = (f'<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" {NS}>'
                    f'<metadata name="Application">BambuStudio-2.3.2</metadata>'
                    f'<metadata name="BambuStudio:3mfVersion">1</metadata><resources>'
                    f'<object id="2" p:UUID="00000001-0000-4000-8000-000000000002" type="model"><components>'
                    f'<component p:path="/3D/Objects/object_1.model" objectid="1" '
                    f'p:UUID="00010000-0000-4000-8000-000000000003" transform="{tr}"/>'
                    f'</components></object></resources>'
                    f'<build p:UUID="00000000-0000-4000-8000-000000000004">'
                    f'<item objectid="2" p:UUID="00000002-0000-4000-8000-000000000005" '
                    f'transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/></build></model>')
            obj_id = 2
        else:
            root = (f'<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" {NS}>'
                    f'<metadata name="Application">BambuStudio-2.3.2</metadata>'
                    f'<metadata name="BambuStudio:3mfVersion">1</metadata><resources>'
                    f'<object id="1" p:UUID="00000001-0000-4000-8000-000000000002" type="model">'
                    f"{mesh_xml(tris)}</object></resources>"
                    f'<build p:UUID="00000000-0000-4000-8000-000000000004">'
                    f'<item objectid="1" p:UUID="00000002-0000-4000-8000-000000000005" '
                    f'transform="{tr}" printable="1"/></build></model>')
            obj_id = 1
        zf.writestr("3D/3dmodel.model", root)
        if settings:
            zf.writestr("Metadata/model_settings.config", model_settings(obj_id, mat))


if __name__ == "__main__":
    # 20 mm cube authored centred on the origin, like the slicer's own export.
    tris = read_stl("models/centred_cube.stl")
    for tag, comp, sett in (("flat_nosett", False, False), ("flat_sett", False, True),
                            ("comp_nosett", True, False), ("comp_sett", True, True)):
        build(f"models/v_{tag}_a.3mf", tris, 128.0, 128.0, 10.0, components=comp, settings=sett)
        build(f"models/v_{tag}_b.3mf", tris, 168.0, 153.0, 10.0, components=comp, settings=sett)
    print("built 4 variants x 2 positions")
