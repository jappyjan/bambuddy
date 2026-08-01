"""Tests for the two read endpoints the per-slice override editor needs.

``GET /slicer/process-fields`` — curated field metadata filtered to the
slicer this install actually slices with. The filter is the point: the two
supported slicers do not share a key set, and a field the active slicer
lacks must be hidden rather than shown-and-broken.

``GET /slicer/resolved-process`` — the resolved process JSON for one
preset, so the editor prefills real current values instead of curated
defaults. Resolution reuses the slice route's ``resolve_preset_ref``, so
these tests pin that each source tier arrives at the endpoint intact.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.api.routes.slicer_presets import _load_process_fields
from backend.app.models.local_preset import LocalPreset
from backend.app.models.settings import Settings

FIELDS_URL = "/api/v1/slicer/process-fields"
RESOLVED_URL = "/api/v1/slicer/resolved-process"


async def _set_slicer(db_session, slicer: str) -> None:
    db_session.add(Settings(key="preferred_slicer", value=slicer))
    await db_session.commit()


def _restricted_keys(slicer: str) -> set[str]:
    """Curated keys tagged as NOT available on `slicer`."""
    return {f["key"] for f in _load_process_fields() if slicer not in f.get("slicers", [slicer])}


class TestProcessFields:
    @pytest.mark.asyncio
    async def test_defaults_to_bambu_studio(self, async_client, db_session):
        """No setting stored — same default the slice route uses."""
        resp = await async_client.get(FIELDS_URL)
        assert resp.status_code == 200
        assert resp.json()["slicer"] == "bambu_studio"

    @pytest.mark.asyncio
    async def test_bambu_studio_hides_orca_only_fields(self, async_client, db_session):
        await _set_slicer(db_session, "bambu_studio")

        resp = await async_client.get(FIELDS_URL)
        assert resp.status_code == 200
        keys = {f["key"] for f in resp.json()["fields"]}

        # Universal fields are always offered.
        assert "layer_height" in keys
        assert "sparse_infill_density" in keys
        # Orca-only fields are not — BambuStudio has no `infill_anchor`,
        # so an editor control for it would silently do nothing.
        assert "infill_anchor" not in keys
        assert not (keys & _restricted_keys("bambu_studio"))

    @pytest.mark.asyncio
    async def test_orcaslicer_offers_its_extra_fields(self, async_client, db_session):
        await _set_slicer(db_session, "orcaslicer")

        resp = await async_client.get(FIELDS_URL)
        assert resp.status_code == 200
        body = resp.json()
        assert body["slicer"] == "orcaslicer"
        keys = {f["key"] for f in body["fields"]}

        assert "layer_height" in keys
        assert "infill_anchor" in keys
        assert _restricted_keys("bambu_studio") <= keys

    @pytest.mark.asyncio
    async def test_field_set_differs_between_the_two_slicers(self, async_client, db_session):
        """The whole reason the endpoint filters at all."""
        await _set_slicer(db_session, "bambu_studio")
        bambu = {f["key"] for f in (await async_client.get(FIELDS_URL)).json()["fields"]}

        await db_session.execute(Settings.__table__.delete())
        await _set_slicer(db_session, "orcaslicer")
        orca = {f["key"] for f in (await async_client.get(FIELDS_URL)).json()["fields"]}

        assert orca - bambu == _restricted_keys("bambu_studio")
        assert bambu - orca == _restricted_keys("orcaslicer")

    @pytest.mark.asyncio
    async def test_carries_the_metadata_the_editor_renders_with(self, async_client, db_session):
        """Label / type / range come from the curated file and nowhere else —
        the slicer CLI emits none of them."""
        resp = await async_client.get(FIELDS_URL)
        layer_height = next(f for f in resp.json()["fields"] if f["key"] == "layer_height")
        assert layer_height["label"] == "Layer Height"
        assert layer_height["type"] == "number"
        assert layer_height["min"] < layer_height["max"]
        assert layer_height["category"]


class TestResolvedProcess:
    @pytest.mark.asyncio
    async def test_local_preset_returns_its_stored_values(self, async_client, db_session):
        preset = LocalPreset(
            name="0.28mm Draft",
            preset_type="process",
            setting=json.dumps({"layer_height": "0.28", "sparse_infill_density": "10%"}),
        )
        db_session.add(preset)
        await db_session.commit()

        resp = await async_client.get(RESOLVED_URL, params={"source": "local", "id": str(preset.id)})
        assert resp.status_code == 200
        assert resp.json() == {"layer_height": "0.28", "sparse_infill_density": "10%"}

    @pytest.mark.asyncio
    async def test_cloud_preset_returns_its_real_values(self, async_client, db_session):
        cloud = MagicMock()
        cloud.set_token = MagicMock()
        cloud.close = AsyncMock()
        cloud.get_setting_detail = AsyncMock(
            return_value={"setting": {"name": "Cloudy", "layer_height": "0.16", "wall_loops": "4"}}
        )

        with (
            patch(
                "backend.app.services.preset_resolver.get_stored_token",
                AsyncMock(return_value=("token", "user@example.com", "global")),
            ),
            patch("backend.app.services.preset_resolver.BambuCloudService", MagicMock(return_value=cloud)),
        ):
            resp = await async_client.get(RESOLVED_URL, params={"source": "cloud", "id": "77"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["layer_height"] == "0.16"
        assert body["wall_loops"] == "4"
        cloud.get_setting_detail.assert_awaited_once_with("77")

    @pytest.mark.asyncio
    async def test_orca_cloud_preset_returns_its_real_values(self, async_client, db_session):
        svc = MagicMock()
        svc.close = AsyncMock()
        svc.get_profile = AsyncMock(
            return_value={"content": {"name": "Orca Fine", "layer_height": "0.12", "top_shell_layers": "5"}}
        )

        with patch("backend.app.services.preset_resolver._build_orca_service", AsyncMock(return_value=svc)):
            resp = await async_client.get(RESOLVED_URL, params={"source": "orca_cloud", "id": "abc-123"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["layer_height"] == "0.12"
        assert body["top_shell_layers"] == "5"

    @pytest.mark.asyncio
    async def test_standard_preset_returns_the_inherits_stub(self, async_client, db_session):
        """Bundled presets resolve inside the sidecar, so the honest answer
        here is the same stub the slice route hands it — not invented values."""
        resp = await async_client.get(RESOLVED_URL, params={"source": "standard", "id": "0.20mm Standard @BBL X1C"})
        assert resp.status_code == 200
        assert resp.json() == {
            "name": "0.20mm Standard @BBL X1C",
            "inherits": "0.20mm Standard @BBL X1C",
            "from": "system",
            "type": "process",
        }

    @pytest.mark.asyncio
    async def test_unknown_source_is_rejected(self, async_client, db_session):
        resp = await async_client.get(RESOLVED_URL, params={"source": "dropbox", "id": "1"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_wrong_slot_preset_id_is_rejected(self, async_client, db_session):
        """A filament preset id must not resolve as a process preset."""
        preset = LocalPreset(name="PLA", preset_type="filament", setting=json.dumps({"filament_type": "PLA"}))
        db_session.add(preset)
        await db_session.commit()

        resp = await async_client.get(RESOLVED_URL, params={"source": "local", "id": str(preset.id)})
        assert resp.status_code == 400
