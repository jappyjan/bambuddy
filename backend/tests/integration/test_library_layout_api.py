"""Integration tests for the plate-layout endpoints (spec §4/§5).

Routes under test:
- GET /library/files/{id}/layout
- PUT /library/files/{id}/layout

The layout is stored metadata only — nothing here touches the file bytes.
Applying the stored transform at slice time is a separate concern.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient


def _layout(**overrides) -> dict:
    """A valid single-object layout, with per-test overrides applied."""
    payload = {
        "version": 1,
        "plates": {
            "1": [
                {
                    "object_id": "2",
                    "position": [128.0, 128.0, 0.0],
                    "rotation": [0.0, 0.0, 45.0],
                    "scale": [1.0, 1.0, 1.0],
                }
            ]
        },
    }
    payload.update(overrides)
    return payload


class TestLibraryFileLayoutAPI:
    """Integration tests for GET/PUT /library/files/{id}/layout."""

    @pytest.fixture
    async def file_factory(self, db_session):
        """Factory to create test files."""
        _counter = [0]

        async def _create_file(**kwargs):
            from backend.app.models.library import LibraryFile

            _counter[0] += 1
            counter = _counter[0]

            defaults = {
                "filename": f"layout_file_{counter}.3mf",
                "file_path": f"/test/path/layout_file_{counter}.3mf",
                "file_size": 1024,
                "file_type": "3mf",
            }
            defaults.update(kwargs)

            lib_file = LibraryFile(**defaults)
            db_session.add(lib_file)
            await db_session.commit()
            await db_session.refresh(lib_file)
            return lib_file

        return _create_file

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_layout_defaults_to_null(self, async_client: AsyncClient, file_factory):
        """A file with no stored arrangement reports null — "as designed"."""
        lib_file = await file_factory()

        response = await async_client.get(f"/api/v1/library/files/{lib_file.id}/layout")

        assert response.status_code == 200
        assert response.json() == {"file_id": lib_file.id, "layout": None}

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_layout_unknown_file_404(self, async_client: AsyncClient):
        """An unknown file id is a 404, not an empty layout."""
        response = await async_client.get("/api/v1/library/files/999999/layout")
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_put_layout_round_trips(self, async_client: AsyncClient, file_factory, db_session):
        """A valid layout survives PUT → response → GET → DB unchanged."""
        lib_file = await file_factory()
        payload = _layout()

        put = await async_client.put(f"/api/v1/library/files/{lib_file.id}/layout", json=payload)
        assert put.status_code == 200
        assert put.json() == {"file_id": lib_file.id, "layout": payload}

        get = await async_client.get(f"/api/v1/library/files/{lib_file.id}/layout")
        assert get.status_code == 200
        assert get.json()["layout"] == payload

        await db_session.refresh(lib_file)
        assert lib_file.plate_layout == payload

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_put_layout_accepts_multiple_plates_and_objects(self, async_client: AsyncClient, file_factory):
        """Plate keys are stringified 1-indexed plate numbers, many per file."""
        lib_file = await file_factory()
        payload = {
            "version": 1,
            "plates": {
                "1": [
                    {
                        "object_id": "2",
                        "position": [10.0, 20.0, 0.0],
                        "rotation": [0.0, 0.0, 0.0],
                        "scale": [1.0, 1.0, 1.0],
                    },
                    {
                        "object_id": "3",
                        "position": [30.0, 40.0, 0.0],
                        "rotation": [0.0, 0.0, 90.0],
                        "scale": [2.0, 2.0, 2.0],
                    },
                ],
                "2": [],
            },
        }

        put = await async_client.put(f"/api/v1/library/files/{lib_file.id}/layout", json=payload)

        assert put.status_code == 200
        assert put.json()["layout"] == payload

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_put_null_clears_layout(self, async_client: AsyncClient, file_factory, db_session):
        """Writing null resets the file to its original arrangement."""
        lib_file = await file_factory(plate_layout=_layout())

        put = await async_client.put(f"/api/v1/library/files/{lib_file.id}/layout", json=None)

        assert put.status_code == 200
        assert put.json() == {"file_id": lib_file.id, "layout": None}

        await db_session.refresh(lib_file)
        assert lib_file.plate_layout is None

        get = await async_client.get(f"/api/v1/library/files/{lib_file.id}/layout")
        assert get.json()["layout"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize("version", [0, 2, 99, "1", None])
    async def test_put_rejects_wrong_version(self, async_client: AsyncClient, file_factory, version):
        """The version field exists so a shape change is detectable — enforce it."""
        lib_file = await file_factory()

        response = await async_client.put(f"/api/v1/library/files/{lib_file.id}/layout", json=_layout(version=version))

        assert response.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_put_rejects_missing_version(self, async_client: AsyncClient, file_factory):
        """A body without a version is not a version-1 layout."""
        lib_file = await file_factory()
        payload = _layout()
        del payload["version"]

        response = await async_client.put(f"/api/v1/library/files/{lib_file.id}/layout", json=payload)

        assert response.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize(
        "placement",
        [
            # Too few / too many components.
            {"object_id": "2", "position": [1.0, 2.0], "rotation": [0.0] * 3, "scale": [1.0] * 3},
            {"object_id": "2", "position": [1.0] * 4, "rotation": [0.0] * 3, "scale": [1.0] * 3},
            {"object_id": "2", "position": [1.0] * 3, "rotation": [0.0, 0.0], "scale": [1.0] * 3},
            {"object_id": "2", "position": [1.0] * 3, "rotation": [0.0] * 3, "scale": [1.0, 1.0]},
            # Wrong types.
            {"object_id": "2", "position": "128,128,0", "rotation": [0.0] * 3, "scale": [1.0] * 3},
            {"object_id": "2", "position": [1.0] * 3, "rotation": [0.0] * 3, "scale": ["big"] * 3},
            {"object_id": 2, "position": [1.0] * 3, "rotation": [0.0] * 3, "scale": [1.0] * 3},
            # Degenerate scale — collapses or mirrors the object.
            {"object_id": "2", "position": [1.0] * 3, "rotation": [0.0] * 3, "scale": [0.0, 1.0, 1.0]},
            {"object_id": "2", "position": [1.0] * 3, "rotation": [0.0] * 3, "scale": [1.0, -1.0, 1.0]},
            # Missing / unknown keys.
            {"object_id": "2", "rotation": [0.0] * 3, "scale": [1.0] * 3},
            {"position": [1.0] * 3, "rotation": [0.0] * 3, "scale": [1.0] * 3},
            {
                "object_id": "2",
                "postion": [1.0] * 3,
                "position": [1.0] * 3,
                "rotation": [0.0] * 3,
                "scale": [1.0] * 3,
            },
            # Empty object id.
            {"object_id": "", "position": [1.0] * 3, "rotation": [0.0] * 3, "scale": [1.0] * 3},
        ],
    )
    async def test_put_rejects_malformed_transform(self, async_client: AsyncClient, file_factory, placement):
        """Malformed transforms are rejected rather than stored and applied."""
        lib_file = await file_factory()

        response = await async_client.put(
            f"/api/v1/library/files/{lib_file.id}/layout",
            json={"version": 1, "plates": {"1": [placement]}},
        )

        assert response.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize("plate_key", ["0", "-1", "front", "1.0", ""])
    async def test_put_rejects_bad_plate_key(self, async_client: AsyncClient, file_factory, plate_key):
        """Plate keys are stringified 1-indexed plate numbers."""
        lib_file = await file_factory()

        response = await async_client.put(
            f"/api/v1/library/files/{lib_file.id}/layout",
            json={"version": 1, "plates": {plate_key: []}},
        )

        assert response.status_code == 422

    @pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
    def test_schema_rejects_non_finite_components(self, bad):
        """Pydantic allows inf/NaN floats by default and Python's JSON decoder
        emits them for the ``NaN``/``Infinity`` literals — the schema must not,
        or the transform matrix silently corrupts the model at slice time.

        Asserted against the schema rather than over HTTP: FastAPI's validation
        handler echoes the offending input, and a NaN in that echo breaks the
        error response's own JSON encoding.
        """
        from pydantic import ValidationError

        from backend.app.schemas.library import PlateLayout

        with pytest.raises(ValidationError):
            PlateLayout.model_validate(
                {
                    "version": 1,
                    "plates": {
                        "1": [
                            {
                                "object_id": "2",
                                "position": [bad, 0.0, 0.0],
                                "rotation": [0.0, 0.0, 0.0],
                                "scale": [1.0, 1.0, 1.0],
                            }
                        ]
                    },
                }
            )

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_put_layout_unknown_file_404(self, async_client: AsyncClient):
        """A layout cannot be attached to a file that does not exist."""
        response = await async_client.put("/api/v1/library/files/999999/layout", json=_layout())
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejected_put_leaves_stored_layout_intact(self, async_client: AsyncClient, file_factory, db_session):
        """A 422 must not clobber the arrangement already on the file."""
        stored = _layout()
        lib_file = await file_factory(plate_layout=stored)

        response = await async_client.put(f"/api/v1/library/files/{lib_file.id}/layout", json=_layout(version=2))
        assert response.status_code == 422

        await db_session.refresh(lib_file)
        assert lib_file.plate_layout == stored
