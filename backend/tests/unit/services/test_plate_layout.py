"""Unit tests for applying a stored ``plate_layout`` to model bytes (step 7).

The assertions here are about *where the object ends up*, not about which
attribute got edited: each one composes the rewritten ``<build><item>``
transform with the object's ``<component>`` transform — the same composition
the slicer performs — and checks the object's anchor lands on the requested
bed coordinate. That is the property the feature promises, and it is the one
that survives a change in how the rewrite is implemented.

The transform convention these tests encode was measured, not derived:
``docs/superpowers/spikes/2026-08-02-stl-recentring/run_layout_check.sh``
drives this module over both real sidecars and compares first-layer G-code
extents against an analytically-computed bounding box, including a +30 vs -30
degree pair that would disagree if the rotation were mirrored.
"""

from __future__ import annotations

import io
import math
import re
import zipfile

import pytest

from backend.app.services.plate_layout import (
    PlateLayoutError,
    apply_plate_layout,
    ensure_project_3mf,
    is_project_3mf,
    layout_placements,
)
from backend.tests._fixtures.project_3mf import build_core_spec_3mf, build_project_3mf

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _layout(object_id="2", position=(128.0, 128.0, 10.0), rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0)):
    return {
        "version": 1,
        "plates": {
            "1": [
                {
                    "object_id": object_id,
                    "position": list(position),
                    "rotation": list(rotation),
                    "scale": list(scale),
                }
            ]
        },
    }


def _model_xml(model_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(model_bytes)) as zf:
        return zf.read("3D/3dmodel.model").decode("utf-8")


def _parse(attr: str) -> tuple[list[list[float]], list[float]]:
    v = [float(p) for p in attr.split()]
    return [[v[3 * j + i] for j in range(3)] for i in range(3)], v[9:12]


def _transforms(model_bytes: bytes, object_id: str = "2") -> tuple[str, str]:
    """(build item transform, component transform) for ``object_id``."""
    xml = _model_xml(model_bytes)
    item = re.search(rf'<item objectid="{object_id}"[^>]*?transform="([^"]*)"', xml)
    obj = re.search(rf'<object id="{object_id}".*?<component[^>]*?transform="([^"]*)"', xml, re.DOTALL)
    return (item.group(1) if item else ""), (obj.group(1) if obj else "")


def _world_anchor(model_bytes: bytes, object_id: str = "2") -> list[float]:
    """Where the object's anchor lands on the bed after item . component.

    The anchor is the component's translation in the object's frame, so its
    bed position is ``item_linear . component_translation + item_translation``
    — exactly the composition the slicer applies.
    """
    item_attr, component_attr = _transforms(model_bytes, object_id)
    item_linear, item_t = _parse(item_attr)
    _, component_t = _parse(component_attr)
    return [sum(item_linear[i][j] * component_t[j] for j in range(3)) + item_t[i] for i in range(3)]


def _geometry_counts(model_bytes: bytes) -> dict[str, tuple[int, int]]:
    counts = {}
    with zipfile.ZipFile(io.BytesIO(model_bytes)) as zf:
        for name in zf.namelist():
            if name.endswith(".model"):
                text = zf.read(name).decode("utf-8")
                counts[name] = (text.count("<vertex "), text.count("<triangle "))
    return counts


# ---------------------------------------------------------------------------
# layout_placements
# ---------------------------------------------------------------------------


class TestLayoutPlacements:
    def test_none_and_empty_yield_nothing(self):
        assert layout_placements(None) == {}
        assert layout_placements({}) == {}
        assert layout_placements({"version": 1, "plates": {}}) == {}

    def test_flattens_every_plate(self):
        layout = {
            "version": 1,
            "plates": {
                "1": [{"object_id": "2", "position": [1, 2, 3]}],
                "2": [{"object_id": "5", "position": [4, 5, 6]}],
            },
        }
        assert set(layout_placements(layout)) == {"2", "5"}

    def test_unknown_version_is_rejected(self):
        # The version field exists so a future shape change is *detectable*.
        # Guessing at it would place objects wrongly instead of failing.
        with pytest.raises(PlateLayoutError, match="version"):
            layout_placements({"version": 2, "plates": {}})

    def test_missing_object_id_is_rejected(self):
        with pytest.raises(PlateLayoutError, match="object_id"):
            layout_placements({"version": 1, "plates": {"1": [{"position": [0, 0, 0]}]}})

    def test_duplicate_object_id_resolves_to_the_lowest_plate(self):
        layout = {
            "version": 1,
            "plates": {
                "10": [{"object_id": "2", "position": [9, 9, 9]}],
                "2": [{"object_id": "2", "position": [1, 1, 1]}],
            },
        }
        assert layout_placements(layout)["2"]["position"] == [1, 1, 1]


# ---------------------------------------------------------------------------
# is_project_3mf
# ---------------------------------------------------------------------------


class TestIsProject3mf:
    def test_slicer_authored_project_is_recognised(self):
        assert is_project_3mf(build_project_3mf()) is True

    def test_core_spec_3mf_is_not_a_project(self):
        # A Fusion / Blender export. Both slicers treat it as raw mesh input
        # and re-centre it, so it must not take the rewrite-only path (#22).
        assert is_project_3mf(build_core_spec_3mf()) is False

    def test_stl_bytes_are_not_a_project(self):
        assert is_project_3mf(b"solid cube\nendsolid cube\n") is False


# ---------------------------------------------------------------------------
# apply_plate_layout — placement
# ---------------------------------------------------------------------------


class TestApplyPlateLayout:
    def test_no_layout_is_a_passthrough(self):
        original = build_project_3mf()
        assert apply_plate_layout(original, None) is original
        assert apply_plate_layout(original, {"version": 1, "plates": {}}) is original

    def test_translation_lands_the_object_on_the_requested_coordinate(self):
        original = build_project_3mf()
        moved = apply_plate_layout(original, _layout(position=(168.0, 153.0, 10.0)))
        assert _world_anchor(moved) == pytest.approx([168.0, 153.0, 10.0], abs=1e-6)

    def test_placement_is_absolute_not_a_delta_from_the_build_item(self):
        """The headline trap from the #22 spike.

        A real export puts identity on ``<build><item>`` and the placement on
        the component, so a naive implementation that writes ``position``
        straight onto the build item ships the object to ``position + 128``.
        Asking for the coordinate the object *already* occupies must be a
        no-op, and asking for a different one must land exactly there —
        whatever the file happened to record before.
        """
        original = build_project_3mf(component_transform="1 0 0 0 1 0 0 0 1 128 128 10")
        unchanged = apply_plate_layout(original, _layout(position=(128.0, 128.0, 10.0)))
        assert _world_anchor(unchanged) == pytest.approx([128.0, 128.0, 10.0], abs=1e-6)

        # Same request against a file that records its placement the other
        # way round — on the build item, component at the origin.
        other = build_project_3mf(
            component_transform="1 0 0 0 1 0 0 0 1 0 0 0",
            item_transform="1 0 0 0 1 0 0 0 1 128 128 10",
        )
        assert _world_anchor(apply_plate_layout(other, _layout(position=(168.0, 153.0, 10.0)))) == pytest.approx(
            [168.0, 153.0, 10.0], abs=1e-6
        )

    def test_rotation_is_about_the_object_anchor_and_keeps_it_in_place(self):
        original = build_project_3mf()
        rotated = apply_plate_layout(original, _layout(rotation=(0.0, 0.0, 45.0)))
        # The anchor is the centre of rotation, so it must not drift.
        assert _world_anchor(rotated) == pytest.approx([128.0, 128.0, 10.0], abs=1e-6)
        linear, _ = _parse(_transforms(rotated)[0])
        c = math.cos(math.radians(45.0))
        s = math.sin(math.radians(45.0))
        assert linear[0] == pytest.approx([c, -s, 0.0], abs=1e-6)
        assert linear[1] == pytest.approx([s, c, 0.0], abs=1e-6)

    def test_rotation_sign_is_not_mirrored(self):
        """+30 and -30 must produce transposed linear parts, not the same one.

        Verified against both sidecars: the L-shaped test model slices to
        53.75 x 43.75 mm at +30 and 43.75 x 53.75 mm at -30. A mirrored
        convention swaps those and no symmetric test model would notice.
        """
        plus, _ = _parse(_transforms(apply_plate_layout(build_project_3mf(), _layout(rotation=(0, 0, 30))))[0])
        minus, _ = _parse(_transforms(apply_plate_layout(build_project_3mf(), _layout(rotation=(0, 0, -30))))[0])
        assert plus[1][0] == pytest.approx(-minus[1][0], abs=1e-6)
        assert plus[1][0] > 0  # +30 about Z maps +X toward +Y

    def test_scale_multiplies_the_linear_part_and_holds_the_anchor(self):
        scaled = apply_plate_layout(build_project_3mf(), _layout(scale=(2.0, 2.0, 2.0)))
        linear, _ = _parse(_transforms(scaled)[0])
        assert [linear[i][i] for i in range(3)] == pytest.approx([2.0, 2.0, 2.0], abs=1e-6)
        assert _world_anchor(scaled) == pytest.approx([128.0, 128.0, 10.0], abs=1e-6)

    def test_absent_objects_keep_their_original_transform(self):
        # Spec §4: "objects absent from the array keep their original
        # transform" — absent *objects*, so a second object must not move.
        original = build_project_3mf(extra_objects=[("3", "1 0 0 0 1 0 0 0 1 60 60 10")])
        moved = apply_plate_layout(original, _layout(object_id="2", position=(168.0, 153.0, 10.0)))
        assert _world_anchor(moved, "2") == pytest.approx([168.0, 153.0, 10.0], abs=1e-6)
        assert _world_anchor(moved, "3") == pytest.approx([60.0, 60.0, 10.0], abs=1e-6)

    def test_item_with_no_transform_attribute_gets_one(self):
        original = build_project_3mf(item_transform=None)
        moved = apply_plate_layout(original, _layout(position=(168.0, 153.0, 10.0)))
        assert _world_anchor(moved) == pytest.approx([168.0, 153.0, 10.0], abs=1e-6)

    def test_unmatched_object_id_leaves_a_multi_object_model_alone(self):
        # With more than one object there is nothing to guess at, so an id
        # that matches nothing is dropped (and logged) rather than applied to
        # an arbitrary object.
        original = build_project_3mf(extra_objects=[("3", "1 0 0 0 1 0 0 0 1 60 60 10")])
        result = apply_plate_layout(original, _layout(object_id="99", position=(168.0, 153.0, 10.0)))
        assert result is original

    def test_single_object_model_accepts_a_mismatched_id(self, caplog):
        # An STL carries no object ids at all and conversion mints fresh
        # ones, so requiring a match would make placement a no-op for exactly
        # the case the sidecar conversion exists to serve.
        original = build_project_3mf(object_id="7")
        moved = apply_plate_layout(original, _layout(object_id="2", position=(168.0, 153.0, 10.0)))
        assert _world_anchor(moved, "7") == pytest.approx([168.0, 153.0, 10.0], abs=1e-6)

    def test_bad_bytes_are_reported_not_silently_ignored(self):
        with pytest.raises(PlateLayoutError):
            apply_plate_layout(b"not a zip", _layout())

    def test_zero_scale_is_rejected(self):
        with pytest.raises(PlateLayoutError, match="scale"):
            apply_plate_layout(build_project_3mf(), _layout(scale=(1.0, 0.0, 1.0)))


# ---------------------------------------------------------------------------
# apply_plate_layout — the rest of the container survives
# ---------------------------------------------------------------------------


class TestRewrittenFileIntegrity:
    def test_geometry_counts_are_unchanged(self):
        original = build_project_3mf()
        moved = apply_plate_layout(original, _layout(position=(168.0, 153.0, 10.0), rotation=(0, 0, 45)))
        assert _geometry_counts(moved) == _geometry_counts(original)

    def test_every_other_entry_is_copied_byte_for_byte(self):
        original = build_project_3mf()
        moved = apply_plate_layout(original, _layout(position=(168.0, 153.0, 10.0)))
        with zipfile.ZipFile(io.BytesIO(original)) as a, zipfile.ZipFile(io.BytesIO(moved)) as b:
            assert a.namelist() == b.namelist()
            for name in a.namelist():
                if name == "3D/3dmodel.model":
                    continue
                assert a.read(name) == b.read(name), name

    def test_model_settings_part_matrix_is_left_truthful(self):
        # The part matrix describes part-within-object geometry, which the
        # placement does not change. Rewriting it would make it disagree with
        # the component transform it mirrors.
        original = build_project_3mf()
        moved = apply_plate_layout(original, _layout(position=(168.0, 153.0, 10.0)))
        with zipfile.ZipFile(io.BytesIO(moved)) as zf:
            assert "Metadata/model_settings.config" in zf.namelist()
        assert _transforms(moved)[1] == _transforms(original)[1]

    def test_threemf_parser_still_parses_the_rewritten_file(self, tmp_path):
        from backend.app.services.archive import ThreeMFParser

        original = build_project_3mf()
        moved = apply_plate_layout(original, _layout(position=(168.0, 153.0, 10.0), rotation=(0, 0, 45)))

        before_path = tmp_path / "before.3mf"
        after_path = tmp_path / "after.3mf"
        before_path.write_bytes(original)
        after_path.write_bytes(moved)

        before = ThreeMFParser(str(before_path)).parse()
        after = ThreeMFParser(str(after_path)).parse()
        assert after == before
        assert _geometry_counts(moved) == _geometry_counts(original)


# ---------------------------------------------------------------------------
# ensure_project_3mf
# ---------------------------------------------------------------------------


class _FakeSlicer:
    """Stand-in sidecar that returns a project 3MF for ``exportType=3mf``."""

    def __init__(self, response: bytes):
        self._response = response
        self.calls: list[dict] = []

    async def slice_with_profiles(self, **kwargs):
        self.calls.append(kwargs)

        class _Result:
            content = self._response

        return _Result()


class TestEnsureProject3mf:
    @pytest.mark.asyncio
    async def test_project_3mf_is_a_passthrough_with_no_sidecar_call(self):
        original = build_project_3mf()
        service = _FakeSlicer(b"")
        out, name = await ensure_project_3mf(
            service,
            model_bytes=original,
            model_filename="thing.3mf",
            printer_profile_json="{}",
            process_profile_json="{}",
            filament_profile_jsons=["{}"],
        )
        assert out is original
        assert name == "thing.3mf"
        assert service.calls == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("payload", "filename"),
        [(b"solid cube\nendsolid cube\n", "thing.stl"), (None, "fusion.3mf")],
        ids=["stl", "core-spec-3mf"],
    )
    async def test_non_project_input_is_converted_via_the_sidecar(self, payload, filename):
        source = build_core_spec_3mf() if payload is None else payload
        converted = build_project_3mf()
        service = _FakeSlicer(converted)
        out, name = await ensure_project_3mf(
            service,
            model_bytes=source,
            model_filename=filename,
            printer_profile_json='{"printer": 1}',
            process_profile_json='{"process": 1}',
            filament_profile_jsons=['{"filament": 1}'],
        )
        assert out == converted
        assert name.endswith(".3mf")
        assert len(service.calls) == 1
        # The conversion must carry the same profile triplet the real slice
        # will use, and must ask for the project container.
        assert service.calls[0]["export_3mf"] is True
        assert service.calls[0]["printer_profile_json"] == '{"printer": 1}'

    @pytest.mark.asyncio
    async def test_a_sidecar_that_returns_a_non_project_file_is_an_error(self):
        service = _FakeSlicer(build_core_spec_3mf())
        with pytest.raises(PlateLayoutError):
            await ensure_project_3mf(
                service,
                model_bytes=b"solid cube\nendsolid cube\n",
                model_filename="thing.stl",
                printer_profile_json="{}",
                process_profile_json="{}",
                filament_profile_jsons=["{}"],
            )
