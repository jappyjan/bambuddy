"""Unit tests for per-slice `process_overrides` (#20, step 4 of the slicer
UX redesign).

`SliceRequest.process_overrides` lets a user change individual print
settings for one slice without cloning a preset. The route patches them
onto the *resolved* process JSON before it is forwarded to the sidecar —
the same position in the pipeline, and now the same helper, as the #1337
`bed_type` patch.

The process profile used here is shaped like a real BambuStudio process
preset (string values, `from`/`inherits` bookkeeping keys), and every
setting key it uses is asserted to exist in the key set captured from the
real binary (`_fixtures/slicer_keys/`), so the tests cannot drift onto
keys the slicer does not actually have.

Note: these assert what reaches the process JSON. Whether the resulting
G-code really comes back at 25% infill needs a live sidecar and is not
runnable in this test environment.
"""

import json
from pathlib import Path

import pytest

from backend.app.api.routes.library import _patch_process_overrides
from backend.app.schemas.slicer import PresetRef, SliceRequest

_SLICER_KEYS_DIR = Path(__file__).resolve().parents[1] / "_fixtures" / "slicer_keys"


def _slicer_keys(slicer: str) -> set[str]:
    return set(json.loads((_SLICER_KEYS_DIR / f"{slicer}.json").read_text())["keys"])


# A trimmed-down but structurally faithful BambuStudio process preset: the
# bookkeeping keys a resolved preset carries, plus a handful of settings.
_PROCESS_PROFILE = {
    "name": "0.20mm Standard @BBL X1C",
    "from": "system",
    "inherits": "fdm_process_bbl_0.20_nozzle_0.4",
    "type": "process",
    "layer_height": "0.2",
    "sparse_infill_density": "15%",
    "wall_loops": "2",
    "curr_bed_type": "Cool Plate",
}


def _profile_json() -> str:
    return json.dumps(_PROCESS_PROFILE)


class TestProcessProfileFixtureIsReal:
    @pytest.mark.parametrize("slicer", ("bambu_studio", "orcaslicer"))
    def test_every_setting_key_exists_in_the_slicer(self, slicer):
        keys = _slicer_keys(slicer)
        bookkeeping = {"name", "from", "inherits", "type"}
        for key in set(_PROCESS_PROFILE) - bookkeeping:
            assert key in keys, f"{key} is not a real {slicer} setting"


class TestSliceRequestProcessOverridesField:
    def _request(self, **kwargs) -> SliceRequest:
        return SliceRequest(
            printer_preset=PresetRef(source="local", id="1"),
            process_preset=PresetRef(source="local", id="2"),
            filament_preset=PresetRef(source="local", id="3"),
            **kwargs,
        )

    def test_defaults_to_empty_dict(self):
        assert self._request().process_overrides == {}

    def test_accepts_mixed_value_types(self):
        # No validation here by design — key existence, type and range are
        # ticket #29's job, against the slicer schema + curated metadata.
        overrides = {"sparse_infill_density": 25, "layer_height": 0.28, "spiral_mode": True}
        assert self._request(process_overrides=overrides).process_overrides == overrides

    def test_coexists_with_bed_type(self):
        req = self._request(bed_type="Textured PEI Plate", process_overrides={"sparse_infill_density": 25})
        assert req.bed_type == "Textured PEI Plate"
        assert req.process_overrides == {"sparse_infill_density": 25}


class TestPatchProcessOverrides:
    def test_patches_a_single_key(self):
        result = json.loads(_patch_process_overrides(_profile_json(), {"sparse_infill_density": 25}))
        assert result["sparse_infill_density"] == 25

    def test_patches_multiple_keys_at_once(self):
        result = json.loads(
            _patch_process_overrides(
                _profile_json(),
                {"sparse_infill_density": 25, "wall_loops": 4, "layer_height": 0.28},
            )
        )
        assert result["sparse_infill_density"] == 25
        assert result["wall_loops"] == 4
        assert result["layer_height"] == 0.28

    def test_leaves_untouched_keys_alone(self):
        result = json.loads(_patch_process_overrides(_profile_json(), {"sparse_infill_density": 25}))
        assert result["name"] == _PROCESS_PROFILE["name"]
        assert result["inherits"] == _PROCESS_PROFILE["inherits"]
        assert result["curr_bed_type"] == "Cool Plate"
        assert result["wall_loops"] == "2"

    def test_adds_keys_the_profile_does_not_carry(self):
        # A preset only spells out what it overrides from its parent, so an
        # override commonly names a key that isn't in the resolved JSON yet.
        result = json.loads(_patch_process_overrides(_profile_json(), {"top_shell_layers": 5}))
        assert result["top_shell_layers"] == 5

    def test_empty_overrides_return_the_input_unchanged(self):
        original = _profile_json()
        assert _patch_process_overrides(original, {}) is original

    def test_returns_input_unchanged_when_json_is_invalid(self):
        bogus = "not a json document"
        assert _patch_process_overrides(bogus, {"sparse_infill_density": 25}) is bogus

    def test_returns_input_unchanged_when_json_is_not_a_dict(self):
        not_a_dict = json.dumps(["this", "is", "an", "array"])
        assert _patch_process_overrides(not_a_dict, {"sparse_infill_density": 25}) is not_a_dict
