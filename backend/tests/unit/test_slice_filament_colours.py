"""Per-slot filament colour overrides on slice requests (#45, rail.2).

The `/slicer` rail lets a user give each filament slot a colour, the way Bambu
Studio's Project Filaments panel does. Colour lives on the *filament* profile
(``filament_colour``), not the process one, so it cannot ride along in
``process_overrides`` — hence a request field and a patcher of its own.

Two properties matter beyond "the value lands":

- **Alignment.** ``filament_colours[i]`` colours ``filament_presets[i]``. The
  route applies the patch immediately after resolution and before
  ``substitute_unused_plate_filaments`` rewrites entries by index, because that
  is the last moment the two lists are still the same list.
- **Silence is silence.** A request without colours must be byte-identical to
  one from before the field existed, or every existing client's slice changes.
"""

import json

import pytest
from pydantic import ValidationError

from backend.app.api.routes.library import _patch_filament_colour
from backend.app.schemas.slicer import PresetRef, SliceRequest


def _req(**kwargs) -> SliceRequest:
    return SliceRequest(
        printer_preset=PresetRef(source="local", id="1"),
        process_preset=PresetRef(source="local", id="2"),
        filament_presets=[
            PresetRef(source="local", id="3"),
            PresetRef(source="local", id="4"),
        ],
        **kwargs,
    )


def _filament_json(**extra) -> str:
    return json.dumps(
        {
            "name": "Bambu PLA Basic",
            "filament_type": ["PLA"],
            "filament_colour": ["#00AE42"],
            **extra,
        }
    )


class TestSchema:
    def test_absent_by_default(self):
        assert _req().filament_colours == []

    def test_accepts_six_and_eight_digit_hex_and_nulls(self):
        req = _req(filament_colours=["#FF6A13", None, "#00AE42FF"])
        assert req.filament_colours == ["#FF6A13", None, "#00AE42FF"]

    def test_trims_surrounding_whitespace(self):
        assert _req(filament_colours=[" #FF6A13 "]).filament_colours == ["#FF6A13"]

    @pytest.mark.parametrize(
        "bad",
        ["red", "FF6A13", "#FFF", "#GGGGGG", "#FF6A1", "", "#FF6A13FFFF"],
    )
    def test_rejects_anything_that_is_not_a_hex_colour(self, bad):
        # A value the slicer cannot parse either does nothing (the user's pick
        # silently ignored) or trips the CLI's own validator with a message
        # that names a profile rather than a slot. 422 here says which slot.
        with pytest.raises(ValidationError) as exc:
            _req(filament_colours=[bad])
        assert "filament_colours[0]" in str(exc.value)

    def test_error_names_the_offending_slot(self):
        with pytest.raises(ValidationError) as exc:
            _req(filament_colours=["#FF6A13", "nope"])
        assert "filament_colours[1]" in str(exc.value)

    def test_does_not_disturb_the_existing_preset_normalisation(self):
        # The legacy singular-field promotion is what every old client relies
        # on; adding a field must not move it.
        req = SliceRequest(
            printer_preset=PresetRef(source="local", id="1"),
            process_preset=PresetRef(source="local", id="2"),
            filament_preset_id=9,
            filament_colours=["#FF6A13"],
        )
        assert req.filament_presets == [PresetRef(source="local", id="9")]


class TestPatch:
    def test_sets_both_colour_keys(self):
        # The two slicers disagree about which they read, and a profile that
        # only had `default_filament_colour` set would keep its old colour.
        out = json.loads(_patch_filament_colour(_filament_json(), "#FF6A13"))
        assert out["filament_colour"] == ["#FF6A13"]
        assert out["default_filament_colour"] == ["#FF6A13"]

    def test_writes_arrays_not_scalars(self):
        # Filament profiles store these per-extruder; a bare string where the
        # profile had a list is the shape the CLI silently drops.
        out = json.loads(_patch_filament_colour(_filament_json(), "#FF6A13"))
        assert isinstance(out["filament_colour"], list)

    def test_leaves_every_other_key_alone(self):
        out = json.loads(_patch_filament_colour(_filament_json(nozzle_temperature=[220]), "#FF6A13"))
        assert out["filament_type"] == ["PLA"]
        assert out["nozzle_temperature"] == [220]
        assert out["name"] == "Bambu PLA Basic"

    @pytest.mark.parametrize("junk", ["not json", "[1, 2, 3]", '"a string"'])
    def test_unparseable_profile_is_returned_untouched(self, junk):
        # Matching the process patcher: a slice with the profile's own colour
        # is a far better failure than no slice at all.
        assert _patch_filament_colour(junk, "#FF6A13") == junk


class TestRouteAlignment:
    """The loop the slice route runs, reproduced against a stand-in list.

    Kept as a direct exercise of the indexing rule rather than a route test:
    what can break is the pairing of `filament_colours[i]` with
    `filament_jsons[i]`, and that is visible without a sidecar.
    """

    @staticmethod
    def _apply(filament_jsons: list[str], colours: list[str | None]) -> list[str]:
        out = list(filament_jsons)
        for index, colour in enumerate(colours):
            if colour is None or index >= len(out):
                continue
            out[index] = _patch_filament_colour(out[index], colour)
        return out

    def test_colours_only_the_slots_that_asked(self):
        jsons = [_filament_json(name=f"slot{i}") for i in range(3)]
        out = self._apply(jsons, [None, "#FF6A13", None])
        assert json.loads(out[0])["filament_colour"] == ["#00AE42"]
        assert json.loads(out[1])["filament_colour"] == ["#FF6A13"]
        assert json.loads(out[2])["filament_colour"] == ["#00AE42"]
        # Untouched entries are the same objects, not re-serialised copies.
        assert out[0] == jsons[0]
        assert out[2] == jsons[2]

    def test_a_longer_colour_list_than_slot_list_is_ignored_not_an_error(self):
        jsons = [_filament_json()]
        out = self._apply(jsons, ["#FF6A13", "#00AE42", "#123456"])
        assert len(out) == 1
        assert json.loads(out[0])["filament_colour"] == ["#FF6A13"]

    def test_an_empty_colour_list_changes_nothing(self):
        jsons = [_filament_json(), _filament_json()]
        assert self._apply(jsons, []) == jsons
