"""Build a realistic slicer-authored *project* 3MF in memory.

Modelled byte-for-structure on what the sidecar's ``exportType=3mf`` actually
writes (OrcaSlicer 2.3.2 / BambuStudio 02.07.01.57 — captured while verifying
ticket #30 against both binaries). The two details that matter for placement
are easy to get wrong when hand-writing a fixture, and a fixture that got
them wrong would let a broken implementation pass:

- the placement lives on the ``<component transform>`` **inside** the object,
  and ``<build><item>`` carries *identity*;
- ``Metadata/project_settings.config`` is present, which is what distinguishes
  a project 3MF (honoured) from a core-spec one (silently re-centred).

The mesh lives in an external ``3D/Objects/*.model`` part referenced by
``p:path``, again matching the real export, so geometry-count assertions
exercise the same file layout production code will see.
"""

from __future__ import annotations

import io
import json
import zipfile

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
    "</Types>"
)

RELS = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Target="/3D/3dmodel.model" Id="rel-1" '
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
    "</Relationships>"
)


def _cube_mesh(size: float = 20.0) -> str:
    """A cube centred on its own origin, sitting from -size/2 to +size/2."""
    h = size / 2.0
    corners = [
        (-h, -h, -h),
        (h, -h, -h),
        (h, h, -h),
        (-h, h, -h),
        (-h, -h, h),
        (h, -h, h),
        (h, h, h),
        (-h, h, h),
    ]
    faces = [
        (0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7),
    ]  # fmt: skip
    vertices = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in corners)
    triangles = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in faces)
    return f"<mesh><vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh>"


def build_project_3mf(
    *,
    component_transform: str = "1 0 0 0 1 0 0 0 1 128 128 10",
    item_transform: str | None = "1 0 0 0 1 0 0 0 1 0 0 0",
    object_id: str = "2",
    extra_objects: list[tuple[str, str]] | None = None,
) -> bytes:
    """Return the bytes of a project 3MF with one (or more) placed objects.

    ``extra_objects`` adds ``(object_id, component_transform)`` pairs, each
    with its own build item, for multi-object placement tests.
    ``item_transform=None`` omits the attribute entirely — some writers do.
    """
    objects = [(object_id, component_transform)] + list(extra_objects or [])

    resources = []
    build_items = []
    mesh_parts = {}
    for index, (oid, transform) in enumerate(objects):
        mesh_id = str(1000 + index)
        path = f"/3D/Objects/part_{index}.model"
        mesh_parts[path.lstrip("/")] = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
            f'<resources><object id="{mesh_id}" type="model">{_cube_mesh()}</object></resources>'
            "<build/></model>"
        )
        resources.append(
            f'<object id="{oid}" type="model"><components>'
            f'<component p:path="{path}" objectid="{mesh_id}" transform="{transform}"/>'
            "</components></object>"
        )
        item_attr = f' transform="{item_transform}"' if item_transform is not None else ""
        build_items.append(f'<item objectid="{oid}"{item_attr} printable="1"/>')

    model_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
        'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" '
        'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">'
        '<metadata name="Application">BambuStudio-2.3.2</metadata>'
        f"<resources>{''.join(resources)}</resources>"
        f"<build>{''.join(build_items)}</build>"
        "</model>"
    )

    model_settings = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<config>'
        + "".join(
            f'<object id="{oid}"><metadata key="name" value="part_{i}.stl"/>'
            f'<metadata key="extruder" value="1"/></object>'
            for i, (oid, _) in enumerate(objects)
        )
        + '<plate><metadata key="plater_id" value="1"/>'
        + "".join(f'<model_instance><metadata key="object_id" value="{oid}"/></model_instance>' for oid, _ in objects)
        + "</plate></config>"
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", CONTENT_TYPES)
        zf.writestr("_rels/.rels", RELS)
        zf.writestr("3D/3dmodel.model", model_xml)
        for path, payload in mesh_parts.items():
            zf.writestr(path, payload)
        zf.writestr("Metadata/model_settings.config", model_settings)
        zf.writestr(
            "Metadata/project_settings.config",
            json.dumps({"printer_model": "Bambu Lab A1", "layer_height": "0.2", "version": "2.3.2"}),
        )
        zf.writestr(
            "Metadata/slice_info.config",
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<config><plate><metadata key="index" value="1"/>'
            '<metadata key="printer_model_id" value="N1"/></plate></config>',
        )
    return buf.getvalue()


def build_core_spec_3mf() -> bytes:
    """A core-spec 3MF: what Fusion / Blender export. No project settings.

    Behaves exactly like an STL as far as both slicers are concerned — it is
    re-centred and the placement is discarded — so it has to go down the
    conversion path, not the rewrite path.
    """
    model_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        f'<resources><object id="1" type="model">{_cube_mesh()}</object></resources>'
        '<build><item objectid="1"/></build></model>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", CONTENT_TYPES)
        zf.writestr("_rels/.rels", RELS)
        zf.writestr("3D/3dmodel.model", model_xml)
    return buf.getvalue()
