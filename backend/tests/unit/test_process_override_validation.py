"""Unit tests for two-source `process_overrides` validation (#29, step 4 of
the slicer UX redesign).

Key existence comes from the target slicer's own `/schema`; label, type and
range come from the curated `process_fields.json`. Anything that fails
either is a 422 — never a value the slicer silently discards, which is the
failure the whole step exists to prevent.

The `/schema` payloads here are built from the key-set fixtures captured
from the real binaries (`_fixtures/slicer_keys/`), which were re-verified on
2026-08-01 against `ghcr.io/jappyjan/bambu-studio-api:latest`: the live
endpoint returned the same 545 keys, byte for byte.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from backend.app.services.process_overrides import (
    _schema_cache,
    curated_fields_for_slicer,
    validate_process_overrides,
)
from backend.app.services.slicer_api import SlicerApiUnavailableError

_SLICER_KEYS_DIR = Path(__file__).resolve().parents[1] / "_fixtures" / "slicer_keys"
URL = "http://slicer:3000"


def _schema_payload(slicer: str, *, version: str = "02.07.01.57") -> dict:
    fixture = json.loads((_SLICER_KEYS_DIR / f"{slicer}.json").read_text())
    return {"slicer": slicer, "version": version, "keys": fixture["keys"], "defaults": {}}


def _mock_schema(payload: dict | Exception):
    """Patch the sidecar `/schema` call with a canned answer."""
    side_effect = payload if isinstance(payload, Exception) else None
    return patch(
        "backend.app.services.slicer_api.SlicerApiService.schema",
        new=AsyncMock(return_value=None if side_effect else payload, side_effect=side_effect),
    )


@pytest.fixture(autouse=True)
def _clear_cache():
    _schema_cache.clear()
    yield
    _schema_cache.clear()


async def _validate(overrides, *, slicer="bambu_studio", schema=None):
    with _mock_schema(schema if schema is not None else _schema_payload(slicer)):
        return await validate_process_overrides(overrides, api_url=URL, slicer=slicer)


class TestAccepted:
    @pytest.mark.asyncio
    async def test_empty_overrides_never_touch_the_sidecar(self):
        with _mock_schema(_schema_payload("bambu_studio")) as mocked:
            assert await validate_process_overrides({}, api_url=URL, slicer="bambu_studio") == {}
            mocked.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_valid_number_passes(self):
        assert await _validate({"wall_loops": 4}) == {"wall_loops": "4"}

    @pytest.mark.asyncio
    async def test_valid_select_passes(self):
        assert await _validate({"sparse_infill_pattern": "gyroid"}) == {"sparse_infill_pattern": "gyroid"}

    @pytest.mark.asyncio
    async def test_valid_boolean_passes(self):
        assert await _validate({"enable_support": True}) == {"enable_support": "1"}

    @pytest.mark.asyncio
    async def test_multiple_keys_at_once(self):
        result = await _validate({"sparse_infill_density": 25, "layer_height": 0.28})
        assert result == {"sparse_infill_density": "25%", "layer_height": "0.28"}

    @pytest.mark.asyncio
    async def test_boundary_values_are_inclusive(self):
        assert await _validate({"sparse_infill_density": 0}) == {"sparse_infill_density": "0%"}
        assert await _validate({"sparse_infill_density": 100}) == {"sparse_infill_density": "100%"}

    @pytest.mark.asyncio
    async def test_field_without_a_curated_range_is_accepted(self):
        # Plenty of curated fields carry no min/max; type is still checked.
        assert await _validate({"line_width": 0.42}) == {"line_width": "0.42"}

    @pytest.mark.asyncio
    async def test_orcaslicer_only_key_passes_on_orcaslicer(self):
        assert await _validate({"infill_anchor": 2}, slicer="orcaslicer") == {"infill_anchor": "2"}


class TestCoercionToProfileSpelling:
    """Values reach the process JSON spelled the way a real profile spells
    them. Verified live on 2026-08-01: BambuStudio's `load_from_json` logs
    `invalid json type` for a raw JSON number and keeps the preset default,
    so an uncoerced override is silently discarded with an HTTP 200 slice."""

    @pytest.mark.asyncio
    async def test_numbers_become_strings(self):
        assert await _validate({"wall_loops": 4}) == {"wall_loops": "4"}

    @pytest.mark.asyncio
    async def test_percent_fields_keep_their_suffix(self):
        assert await _validate({"sparse_infill_density": 25}) == {"sparse_infill_density": "25%"}

    @pytest.mark.asyncio
    async def test_booleans_become_one_and_zero(self):
        assert await _validate({"enable_support": True}) == {"enable_support": "1"}
        assert await _validate({"enable_support": False}) == {"enable_support": "0"}

    @pytest.mark.asyncio
    async def test_integral_floats_lose_the_trailing_zero(self):
        # "4.0" is not how any profile spells an integer setting.
        assert await _validate({"wall_loops": 4.0}) == {"wall_loops": "4"}

    @pytest.mark.asyncio
    async def test_fractional_floats_keep_their_precision(self):
        assert await _validate({"layer_height": 0.28}) == {"layer_height": "0.28"}


class TestRejected:
    async def _detail(self, overrides, **kwargs) -> str:
        with pytest.raises(HTTPException) as exc:
            await _validate(overrides, **kwargs)
        assert exc.value.status_code == 422
        return exc.value.detail

    @pytest.mark.asyncio
    async def test_key_the_slicer_does_not_have(self):
        # `infill_anchor` is curated but OrcaSlicer-only — BambuStudio has no
        # such setting and would drop it without a word.
        detail = await self._detail({"infill_anchor": 2})
        assert "infill_anchor" in detail and "bambu_studio" in detail

    @pytest.mark.asyncio
    async def test_key_that_exists_nowhere(self):
        detail = await self._detail({"not_a_real_setting": 1})
        assert "not_a_real_setting" in detail

    @pytest.mark.asyncio
    async def test_key_in_the_slicer_but_with_no_curated_metadata(self):
        # A real BambuStudio setting, deliberately not in process_fields.json:
        # without a curated range there is nothing to validate against, so it
        # is not offered and not accepted.
        assert "bed_custom_texture" in set(_schema_payload("bambu_studio")["keys"])
        assert "bed_custom_texture" not in {f["key"] for f in curated_fields_for_slicer("bambu_studio")}
        detail = await self._detail({"bed_custom_texture": "x"})
        assert "curated metadata" in detail

    @pytest.mark.asyncio
    async def test_numeric_below_the_curated_minimum(self):
        detail = await self._detail({"sparse_infill_density": -1})
        assert "at least 0" in detail

    @pytest.mark.asyncio
    async def test_numeric_above_the_curated_maximum(self):
        detail = await self._detail({"sparse_infill_density": 150})
        assert "at most 100" in detail

    @pytest.mark.asyncio
    async def test_select_value_not_among_the_options(self):
        detail = await self._detail({"sparse_infill_pattern": "spirograph"})
        assert "gyroid" in detail  # the message lists what is allowed

    @pytest.mark.asyncio
    async def test_type_mismatch_string_for_a_number(self):
        detail = await self._detail({"layer_height": "thick"})
        assert "expects a number" in detail

    @pytest.mark.asyncio
    async def test_type_mismatch_number_for_a_boolean(self):
        detail = await self._detail({"enable_support": 1})
        assert "expects true or false" in detail

    @pytest.mark.asyncio
    async def test_type_mismatch_boolean_for_a_number(self):
        # bool is an int subclass in Python — the check must not let it slip
        # through as "a number".
        detail = await self._detail({"wall_loops": True})
        assert "expects a number" in detail

    @pytest.mark.asyncio
    async def test_every_problem_is_reported_at_once(self):
        detail = await self._detail({"wall_loops": "many", "sparse_infill_density": 150, "nope": 1})
        assert "wall_loops" in detail and "sparse_infill_density" in detail and "nope" in detail

    @pytest.mark.asyncio
    async def test_nothing_is_patched_when_one_key_is_bad(self):
        # All-or-nothing: a request that half-applies is worse than a reject.
        with pytest.raises(HTTPException):
            await _validate({"wall_loops": 4, "not_a_real_setting": 1})


class TestFallbackWhenSchemaIsUnreachable:
    """An old sidecar (no `/schema` route) or one that is down must degrade,
    never hard-fail: overrides keep working against the curated key list."""

    @pytest.mark.asyncio
    async def test_valid_override_still_works(self):
        result = await _validate(
            {"sparse_infill_density": 25},
            schema=SlicerApiUnavailableError("Slicer sidecar /schema returned 404"),
        )
        assert result == {"sparse_infill_density": "25%"}

    @pytest.mark.asyncio
    async def test_range_is_still_enforced(self):
        with pytest.raises(HTTPException) as exc:
            await _validate({"sparse_infill_density": 150}, schema=SlicerApiUnavailableError("down"))
        assert exc.value.status_code == 422

    @pytest.mark.asyncio
    async def test_unknown_key_is_still_rejected(self):
        with pytest.raises(HTTPException) as exc:
            await _validate({"not_a_real_setting": 1}, schema=SlicerApiUnavailableError("down"))
        assert exc.value.status_code == 422

    @pytest.mark.asyncio
    async def test_the_curated_slicer_tag_still_applies(self):
        # Without /schema the curated file's own per-slicer tagging is the
        # key list, so an OrcaSlicer-only key is still refused on BambuStudio.
        with pytest.raises(HTTPException) as exc:
            await _validate({"infill_anchor": 2}, schema=SlicerApiUnavailableError("down"))
        assert exc.value.status_code == 422

    @pytest.mark.asyncio
    async def test_a_malformed_schema_payload_falls_back_too(self):
        result = await _validate({"wall_loops": 4}, schema={"unexpected": "shape"})
        assert result == {"wall_loops": "4"}

    @pytest.mark.asyncio
    async def test_failure_is_not_cached(self):
        # A sidecar that comes back up must be picked up on the next slice.
        with _mock_schema(SlicerApiUnavailableError("down")):
            await validate_process_overrides({"wall_loops": 4}, api_url=URL, slicer="bambu_studio")
        assert _schema_cache == {}


class TestSchemaCache:
    @pytest.mark.asyncio
    async def test_schema_is_fetched_once_per_sidecar(self):
        with _mock_schema(_schema_payload("bambu_studio")) as mocked:
            for _ in range(3):
                await validate_process_overrides({"wall_loops": 4}, api_url=URL, slicer="bambu_studio")
            assert mocked.await_count == 1

    @pytest.mark.asyncio
    async def test_two_sidecars_cache_independently(self):
        with _mock_schema(_schema_payload("bambu_studio")):
            await validate_process_overrides({"wall_loops": 4}, api_url=URL, slicer="bambu_studio")
        with _mock_schema(_schema_payload("orcaslicer", version="2.3.2")):
            await validate_process_overrides({"wall_loops": 4}, api_url="http://other:3000", slicer="orcaslicer")
        assert {v[1] for v in _schema_cache.values()} == {"02.07.01.57", "2.3.2"}

    @pytest.mark.asyncio
    async def test_a_sidecar_upgrade_replaces_the_cached_key_set(self):
        """The cache identity is (URL, version): re-reading after an image
        upgrade must yield the new slicer's keys, not the old ones."""
        old = _schema_payload("bambu_studio", version="02.07.01.57")
        old["keys"] = [k for k in old["keys"] if k != "wall_loops"]
        with _mock_schema(old), pytest.raises(HTTPException):
            await validate_process_overrides({"wall_loops": 4}, api_url=URL, slicer="bambu_studio")
        assert _schema_cache[URL][1] == "02.07.01.57"

        # TTL elapses (the sidecar image was swapped underneath us).
        expires_at, version, keys = _schema_cache[URL]
        _schema_cache[URL] = (0.0, version, keys)

        with _mock_schema(_schema_payload("bambu_studio", version="02.08.00.00")):
            result = await validate_process_overrides({"wall_loops": 4}, api_url=URL, slicer="bambu_studio")
        assert result == {"wall_loops": "4"}
        assert _schema_cache[URL][1] == "02.08.00.00"
