"""Apply a stored ``plate_layout`` to model bytes before they reach the slicer.

The sidecar takes bytes, so placement is a byte-rewriting job: the stored
arrangement has to be *in* the file the CLI loads. Two things make that
harder than it sounds, both measured against real sidecars in the #22 spike
(``docs/superpowers/spikes/2026-08-02-stl-recentring/``):

1. **A bare mesh is re-centred, unconditionally.** Two identical cubes, one
   translated by (+40, +25), sliced to byte-identical first-layer extents on
   OrcaSlicer 2.3.2 *and* BambuStudio 02.07.01.57. ``--arrange 0 --orient 0``
   changes nothing, and orientation is not preserved either (a 60x20 bar
   comes out of BambuStudio rotated 90 degrees). So baking the matrix into
   STL vertices does not work, and neither does a hand-rolled minimal
   core-spec 3MF — that is *also* treated as raw mesh import and re-centred.
2. **A full project 3MF is honoured, exactly.** Rewriting the transform in a
   3MF the slicer itself exported (``exportType=3mf``) moved the sliced
   centre by exactly the requested delta on both slicers, to 0.01 mm.

Hence the design: anything that is not already a project 3MF is converted to
one *through the sidecar* (:func:`ensure_project_3mf`) and then goes down the
ordinary transform-rewriting path (:func:`apply_plate_layout`). There is no
STL branch in the transform logic — the conversion is the only special case,
and the container is written by the same tool that will consume it. A
hand-rolled wrapper was rejected deliberately: it needs a near-complete
~596-key ``project_settings.config`` that differs per slicer, and getting it
wrong SIGSEGVs the binary rather than erroring.

Placement contract
------------------
``position`` is the bed coordinate of the object's **anchor**, where the
anchor is the translation of the object's first ``<component>`` transform —
which is where a slicer-authored 3MF actually records placement. Real
exports put *identity* on ``<build><item>`` and the placement on the
component, so reading the build item to work out where an object sits gives
the wrong answer (it reads the origin). This module never reads placement
off the build item; it computes

    new item transform = T(position) . R(rotation) . S(scale) . T(-anchor)

and writes that onto ``<build><item>``. The composed effect (item then
component) puts the object's anchor exactly at ``position`` regardless of
where the placement was recorded before, which is what makes ``position``
mean bed millimetres rather than "delta from wherever this happened to be".
The component transform and the ``Metadata/model_settings.config`` part
matrix are left untouched, so they stay a truthful description of the
part-within-object geometry.

``rotation`` is degrees XYZ composed as ``Rx . Ry . Rz`` — three.js ``Euler``
order ``'XYZ'``, so the step-8 gizmo's numbers map straight through. Scale is
applied innermost, before rotation.

**For step 8:** the initial readout for an object is the translation of its
first ``<component>`` transform (plus the build item's translation if the
file has one), *not* ``buildItem.transform`` alone.
"""

from __future__ import annotations

import logging
import math
import re
import zipfile
from io import BytesIO
from typing import Any

logger = logging.getLogger(__name__)

_MODEL_PATH = "3D/3dmodel.model"
_PROJECT_SETTINGS_PATH = "Metadata/project_settings.config"

# A 3MF transform attribute is 12 numbers. Read with the column-vector
# convention used everywhere below, consecutive triples are the *columns* of
# the 3x3 linear part and the last triple is the translation:
#     p' = L . p + t,  L[i][j] = v[3 * j + i],  t = v[9:12]
# BambuStudio's own export writes ``1 0 0 0 1 0 0 0 1 128 128 10`` alongside a
# ``Metadata/model_settings.config`` matrix of ``1 0 0 128 0 1 0 128 0 0 1 10
# 0 0 0 1`` (row-major 4x4), which agrees.
_TRANSFORM_ATTR_RE = re.compile(r'\btransform="([^"]*)"')
_OBJECT_OR_COMPONENT_RE = re.compile(r"<(object|component)\b[^>]*?/?>", re.DOTALL)
_ID_ATTR_RE = re.compile(r'\bid="([^"]*)"')
_OBJECTID_ATTR_RE = re.compile(r'\bobjectid="([^"]*)"')
_BUILD_BLOCK_RE = re.compile(r"<build\b.*?</build>", re.DOTALL)
_ITEM_RE = re.compile(r"<item\b[^>]*?/?>", re.DOTALL)


class PlateLayoutError(ValueError):
    """The stored layout can't be applied to these bytes."""


# --------------------------------------------------------------------------
# Layout reading
# --------------------------------------------------------------------------


def layout_placements(layout: Any) -> dict[str, dict]:
    """Flatten a stored ``plate_layout`` into ``{object_id: placement}``.

    Placements from every plate are merged. 3MF object ids are unique across
    the whole document, so the plate key is UI bookkeeping rather than a
    namespace — merging keeps the applier independent of which plate the
    caller asked to slice (including ``plate=0``, "all plates").

    Returns an empty dict for ``None``, a non-dict, or a layout with no
    placements. Raises :class:`PlateLayoutError` for a ``version`` other than
    1: the field exists precisely so an unknown shape is detectable, and
    guessing at it would place objects wrongly instead of visibly failing.
    """
    if not layout:
        return {}
    if not isinstance(layout, dict):
        raise PlateLayoutError(f"plate_layout must be an object, got {type(layout).__name__}")
    version = layout.get("version")
    if version != 1:
        raise PlateLayoutError(f"unsupported plate_layout version {version!r} (expected 1)")

    placements: dict[str, dict] = {}
    plates = layout.get("plates") or {}
    if not isinstance(plates, dict):
        raise PlateLayoutError("plate_layout.plates must be an object")
    # Numeric plate order so a duplicated object id resolves deterministically
    # (lowest plate wins) rather than depending on dict insertion order.
    for plate_key in sorted(plates, key=lambda k: (not str(k).isdigit(), str(k).zfill(8))):
        entries = plates[plate_key] or []
        if not isinstance(entries, list):
            raise PlateLayoutError(f"plate {plate_key!r} must hold a list of placements")
        for entry in entries:
            if not isinstance(entry, dict):
                raise PlateLayoutError(f"plate {plate_key!r} holds a non-object placement")
            object_id = str(entry.get("object_id", "")).strip()
            if not object_id:
                raise PlateLayoutError(f"plate {plate_key!r} holds a placement with no object_id")
            placements.setdefault(object_id, entry)
    return placements


def is_project_3mf(model_bytes: bytes) -> bool:
    """True when these bytes are a *project* 3MF the slicer will honour.

    ``Metadata/project_settings.config`` is the marker. A core-spec 3MF —
    what Fusion, Blender and every non-slicer exporter writes — lacks it and
    is re-centred exactly like an STL, so it needs the same conversion. The
    #22 spike measured this: without the check, placement silently does
    nothing for user-uploaded 3MFs, and tests built on slicer-authored files
    never notice.
    """
    try:
        with zipfile.ZipFile(BytesIO(model_bytes), "r") as zf:
            return _PROJECT_SETTINGS_PATH in zf.namelist()
    except (zipfile.BadZipFile, OSError):
        return False


# --------------------------------------------------------------------------
# Matrix helpers (column-vector convention: p' = L . p + t)
# --------------------------------------------------------------------------


def _parse_transform(attr: str | None) -> tuple[list[list[float]], list[float]]:
    if not attr:
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], [0.0, 0.0, 0.0]
    parts = attr.split()
    if len(parts) < 12:
        raise PlateLayoutError(f"3MF transform needs 12 numbers, got {len(parts)}")
    try:
        v = [float(p) for p in parts[:12]]
    except ValueError as exc:
        raise PlateLayoutError(f"3MF transform has a non-numeric component: {attr!r}") from exc
    linear = [[v[3 * j + i] for j in range(3)] for i in range(3)]
    return linear, v[9:12]


def _format_component(value: float) -> str:
    # 12 significant digits, trailing zeros dropped: an exact 1 stays "1"
    # rather than "1.0000000000000002", while a rotated axis keeps enough
    # precision that composing it back with the component transform returns
    # the anchor to within a nanometre. Fixed decimals were tried first and
    # left a 5e-5 mm drift under rotation — invisible in print but enough to
    # make an exact round-trip assertion flaky.
    #
    # The exponent guard is not cosmetic: cos(90 deg) is 6.12e-17 in binary
    # floating point, and ``%g`` would write that as "6.12323399574e-17" into
    # an attribute whose consumers are two C++ 3MF parsers. A right-angle
    # rotation — the single most likely thing a user asks for — must not be
    # the case that hands the slicer an exotic number literal. Below the
    # printable threshold it is zero.
    if value == 0:
        return "0"
    text = f"{value:.12g}"
    if "e" in text or "E" in text:
        text = f"{value:.9f}".rstrip("0").rstrip(".")
        return "0" if text in ("", "-0", "-") else text
    return text


def _format_transform(linear: list[list[float]], translation: list[float]) -> str:
    v = [linear[i][j] for j in range(3) for i in range(3)] + list(translation)
    return " ".join(_format_component(c) for c in v)


def _matmul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def _apply(linear: list[list[float]], vec: list[float]) -> list[float]:
    return [sum(linear[i][j] * vec[j] for j in range(3)) for i in range(3)]


def _rotation_matrix(degrees: list[float]) -> list[list[float]]:
    """Rx . Ry . Rz for degrees XYZ — three.js ``Euler`` order ``'XYZ'``."""
    rx, ry, rz = (math.radians(d) for d in degrees)
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    mx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]]
    my = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
    mz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]
    return _matmul(_matmul(mx, my), mz)


def _placement_transform(placement: dict, anchor: list[float]) -> tuple[list[list[float]], list[float]]:
    """Build-item transform putting ``anchor`` at ``placement['position']``.

    ``T(position) . R . S . T(-anchor)`` — see the module docstring. The
    anchor compensation is what makes ``position`` an absolute bed coordinate
    instead of a delta from wherever the placement happened to be recorded.
    """
    position = _vec3(placement, "position", default=[0.0, 0.0, 0.0])
    rotation = _vec3(placement, "rotation", default=[0.0, 0.0, 0.0])
    scale = _vec3(placement, "scale", default=[1.0, 1.0, 1.0])
    if any(s == 0 for s in scale):
        raise PlateLayoutError("scale components must be non-zero")

    linear = _matmul(_rotation_matrix(rotation), [[scale[0], 0, 0], [0, scale[1], 0], [0, 0, scale[2]]])
    shifted = _apply(linear, [-anchor[0], -anchor[1], -anchor[2]])
    translation = [position[i] + shifted[i] for i in range(3)]
    return linear, translation


def _vec3(placement: dict, key: str, *, default: list[float]) -> list[float]:
    raw = placement.get(key)
    if raw is None:
        return list(default)
    if not isinstance(raw, (list, tuple)) or len(raw) != 3:
        raise PlateLayoutError(f"placement {key!r} must be three numbers")
    try:
        out = [float(c) for c in raw]
    except (TypeError, ValueError) as exc:
        raise PlateLayoutError(f"placement {key!r} must be three numbers") from exc
    if any(not math.isfinite(c) for c in out):
        raise PlateLayoutError(f"placement {key!r} must be finite")
    return out


# --------------------------------------------------------------------------
# Rewriting
# --------------------------------------------------------------------------


def _object_anchors(model_xml: str) -> dict[str, list[float]]:
    """``{object id: translation of its first component transform}``.

    An object holding a direct mesh (no components) anchors at its own
    origin. Only the *first* component is consulted: a multi-part object
    records each part's offset on its own component, and there is no
    object-level transform to read, so the first part's origin is the
    object's reference point. Rotation and scale on the component belong to
    the part's geometry and are deliberately not folded into the anchor.
    """
    anchors: dict[str, list[float]] = {}
    anchored: set[str] = set()
    current: str | None = None
    for match in _OBJECT_OR_COMPONENT_RE.finditer(model_xml):
        tag = match.group(0)
        if match.group(1) == "object":
            id_match = _ID_ATTR_RE.search(tag)
            current = id_match.group(1) if id_match else None
            if current is not None:
                anchors.setdefault(current, [0.0, 0.0, 0.0])
            continue
        if current is None or current in anchored:
            continue
        anchored.add(current)
        transform_match = _TRANSFORM_ATTR_RE.search(tag)
        if transform_match:
            _, translation = _parse_transform(transform_match.group(1))
            anchors[current] = translation
    return anchors


def _rewrite_build(model_xml: str, placements: dict[str, dict]) -> tuple[str, int]:
    """Rewrite ``<build><item>`` transforms; returns (xml, items changed)."""
    build_match = _BUILD_BLOCK_RE.search(model_xml)
    if not build_match:
        raise PlateLayoutError("3MF has no <build> section — nothing to place")

    anchors = _object_anchors(model_xml)
    build_xml = build_match.group(0)
    item_object_ids = [
        m.group(1) for tag in _ITEM_RE.findall(build_xml) if (m := _OBJECTID_ATTR_RE.search(tag)) is not None
    ]

    # Single object, single placement: apply it whichever id the layout
    # carries. An STL has no object ids at all, and conversion to a project
    # 3MF mints fresh ones, so an id-only match would make placement a no-op
    # for the single-model case that motivated the conversion in the first
    # place. Logged, because it is a real mismatch everywhere else.
    remapped: dict[str, dict] = {}
    if len(item_object_ids) == 1 and len(placements) == 1:
        only_id = item_object_ids[0]
        layout_id, placement = next(iter(placements.items()))
        if layout_id != only_id:
            logger.info(
                "Plate layout: object id %r not in the model, but it holds exactly one object (%r) "
                "and the layout exactly one placement — applying it to that object",
                layout_id,
                only_id,
            )
        remapped = {only_id: placement}
    else:
        remapped = placements
        for layout_id in placements:
            if layout_id not in item_object_ids:
                logger.warning(
                    "Plate layout: no build item for object id %r — that placement is not applied (model has %s)",
                    layout_id,
                    item_object_ids or "no build items",
                )

    changed = 0

    def _rewrite_item(match: re.Match[str]) -> str:
        nonlocal changed
        tag = match.group(0)
        id_match = _OBJECTID_ATTR_RE.search(tag)
        if id_match is None:
            return tag
        placement = remapped.get(id_match.group(1))
        if placement is None:
            return tag
        anchor = anchors.get(id_match.group(1), [0.0, 0.0, 0.0])
        linear, translation = _placement_transform(placement, anchor)
        attr = _format_transform(linear, translation)
        changed += 1
        if _TRANSFORM_ATTR_RE.search(tag):
            return _TRANSFORM_ATTR_RE.sub(lambda _: f'transform="{attr}"', tag, count=1)
        # No transform attribute yet — insert one before the tag's close.
        close = "/>" if tag.endswith("/>") else ">"
        return f'{tag[: -len(close)]} transform="{attr}"{close}'

    new_build = _ITEM_RE.sub(_rewrite_item, build_xml)
    return model_xml[: build_match.start()] + new_build + model_xml[build_match.end() :], changed


def apply_plate_layout(model_bytes: bytes, layout: Any) -> bytes:
    """Return ``model_bytes`` with the stored arrangement written into it.

    ``model_bytes`` must already be a project 3MF — call :func:`is_project_3mf`
    and convert with :func:`ensure_project_3mf` first, otherwise the slicer
    re-centres the model and the placement is silently discarded (#22).

    A layout with no placements is a passthrough. Every other zip entry is
    copied byte-for-byte; only ``3D/3dmodel.model``'s ``<build>`` section
    changes, so geometry, thumbnails and the embedded settings survive
    untouched.
    """
    placements = layout_placements(layout)
    if not placements:
        return model_bytes

    try:
        with zipfile.ZipFile(BytesIO(model_bytes), "r") as zf:
            if _MODEL_PATH not in zf.namelist():
                raise PlateLayoutError(f"3MF has no {_MODEL_PATH}")
            entries = [(info, zf.read(info.filename)) for info in zf.infolist()]
    except (zipfile.BadZipFile, OSError) as exc:
        raise PlateLayoutError(f"model is not a readable 3MF: {exc}") from exc

    out = BytesIO()
    changed = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for info, data in entries:
            if info.filename == _MODEL_PATH:
                xml = data.decode("utf-8")
                xml, changed = _rewrite_build(xml, placements)
                data = xml.encode("utf-8")
            zout.writestr(info, data)

    if changed == 0:
        # Every placement missed. Returning the original bytes keeps the
        # slice working; the warnings above say which ids were dropped.
        logger.warning("Plate layout: none of the %d placement(s) matched a build item", len(placements))
        return model_bytes

    logger.info("Plate layout: applied %d placement(s) to the build items", changed)
    return out.getvalue()


async def ensure_project_3mf(
    service: Any,
    *,
    model_bytes: bytes,
    model_filename: str,
    printer_profile_json: str,
    process_profile_json: str,
    filament_profile_jsons: list[str],
) -> tuple[bytes, str]:
    """Convert a model to a project 3MF via the sidecar; return (bytes, name).

    A passthrough when the input already is one. Otherwise the model is sent
    to ``service`` with ``exportType=3mf`` and the slicer's own project file
    comes back — the only writer that produces a ``project_settings.config``
    the same binary will accept. ``service`` **must be the sidecar that will
    do the real slice**: the embedded config is slicer-specific, and a
    BambuStudio-exported 3MF fails on OrcaSlicer with exit 238
    (``raft_first_layer_expansion: -1 not in range``) whether or not its
    transforms were rewritten (#22 finding 6).

    Costs one extra sidecar round-trip, and it is a full slice — the CLI has
    no export-only mode. Only paid when a file with a stored layout is not
    already a project 3MF. Caching the converted bytes per (file, slicer) is
    a worthwhile follow-up; it needs somewhere to persist them, which is a
    storage decision rather than a placement one.

    The passed ``--load-settings`` triplet still wins over the config this
    embeds, so converting does not pin the user to the presets used for the
    conversion (measured: re-sliced at 0.28 mm after converting at 0.20 mm,
    got ``; layer_height = 0.28`` with the placement intact).
    """
    if is_project_3mf(model_bytes):
        return model_bytes, model_filename

    logger.info(
        "Plate layout: %s is not a project 3MF — converting via the sidecar so the placement is not re-centred away",
        model_filename,
    )
    result = await service.slice_with_profiles(
        model_bytes=model_bytes,
        model_filename=model_filename,
        printer_profile_json=printer_profile_json,
        process_profile_json=process_profile_json,
        filament_profile_jsons=filament_profile_jsons,
        export_3mf=True,
    )
    converted = result.content
    if not is_project_3mf(converted):
        raise PlateLayoutError("sidecar's exportType=3mf did not return a project 3MF")
    base = model_filename.rsplit(".", 1)[0] or "model"
    return converted, f"{base}.3mf"
