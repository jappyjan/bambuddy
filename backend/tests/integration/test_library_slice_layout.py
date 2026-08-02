"""Integration tests: a stored ``plate_layout`` reaches the slicer (step 7).

The unit tests in ``tests/unit/services/test_plate_layout.py`` cover the
transform maths. These cover the wiring — that slicing a file which has a
saved arrangement actually sends *rewritten* bytes to the sidecar, that a
file without one is untouched, and that a model which is not already a
project 3MF is converted first (by the same sidecar that will slice it,
because the embedded config is slicer-specific).

Every assertion reads the bytes the mock sidecar received, so it fails if the
layout is dropped anywhere between the DB row and the wire — which is the
failure mode this step exists to prevent, and the one that is invisible from
the API response.
"""

from __future__ import annotations

import io
import json
import re
import zipfile

import httpx
import pytest
from httpx import AsyncClient

from backend.app.core.config import settings as app_settings
from backend.app.models.library import LibraryFile
from backend.app.models.local_preset import LocalPreset
from backend.app.models.settings import Settings as SettingsModel
from backend.app.services import process_overrides as process_overrides_module, slicer_api as slicer_api_module
from backend.app.services.plate_layout import is_project_3mf
from backend.tests._fixtures.project_3mf import build_core_spec_3mf, build_project_3mf
from backend.tests.integration.test_library_slice_api import (
    _make_3mf_with_settings,
    _wait_for_job,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _layout(object_id="2", position=(168.0, 153.0, 10.0), version=1):
    return {
        "version": version,
        "plates": {
            "1": [
                {
                    "object_id": object_id,
                    "position": list(position),
                    "rotation": [0.0, 0.0, 0.0],
                    "scale": [1.0, 1.0, 1.0],
                }
            ]
        },
    }


def _uploaded_model(request: httpx.Request) -> bytes:
    """The bytes of the multipart ``file`` part the sidecar received."""
    content_type = request.headers.get("content-type", "")
    boundary = content_type.split("boundary=")[-1].strip().encode()
    for part in request.content.split(b"--" + boundary):
        head, _, body = part.partition(b"\r\n\r\n")
        if b'name="file"' in head:
            return body.rsplit(b"\r\n", 1)[0]
    raise AssertionError("no file part in the sidecar request")


def _anchor_on_bed(model_bytes: bytes, object_id: str = "2") -> list[float]:
    """Where object ``object_id`` sits, composing item . component."""
    with zipfile.ZipFile(io.BytesIO(model_bytes)) as zf:
        xml = zf.read("3D/3dmodel.model").decode("utf-8")

    def _parse(attr: str):
        v = [float(p) for p in attr.split()]
        return [[v[3 * j + i] for j in range(3)] for i in range(3)], v[9:12]

    item = re.search(rf'<item objectid="{object_id}"[^>]*?transform="([^"]*)"', xml)
    component = re.search(rf'<object id="{object_id}".*?<component[^>]*?transform="([^"]*)"', xml, re.DOTALL)
    item_linear, item_t = _parse(item.group(1))
    _, component_t = _parse(component.group(1))
    return [sum(item_linear[i][j] * component_t[j] for j in range(3)) + item_t[i] for i in range(3)]


class _RecordingSidecar:
    """Mock sidecar recording every uploaded model, converting on demand.

    ``slice_and_persist`` always asks for ``exportType=3mf``, so the
    conversion call and the real slice call look alike on the wire — they are
    told apart by order, which is also what a reviewer would check.
    """

    def __init__(self, converted: bytes | None = None):
        self.uploads: list[bytes] = []
        self._converted = converted if converted is not None else build_project_3mf()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/schema":
            return httpx.Response(404)
        uploaded = _uploaded_model(request)
        self.uploads.append(uploaded)
        # A non-project input can only be the conversion call — the real
        # slice always runs on a project 3MF. Hand back a project file the
        # way the sidecar's exportType=3mf does.
        converting = not is_project_3mf(uploaded)
        return httpx.Response(
            status_code=200,
            content=self._converted if converting else _make_3mf_with_settings(),
            headers={
                "x-print-time-seconds": "10",
                "x-filament-used-g": "0.1",
                "x-filament-used-mm": "1.0",
            },
        )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
async def layout_slice_setup(db_session, tmp_path):
    """Presets plus a factory for source files with an optional layout."""
    storage_dir = tmp_path / "library" / "files"
    storage_dir.mkdir(parents=True, exist_ok=True)

    original_base_dir = app_settings.base_dir
    app_settings.base_dir = tmp_path

    presets = {}
    for kind in ("printer", "process", "filament"):
        p = LocalPreset(
            name=f"Test {kind}",
            preset_type=kind,
            source="orcaslicer",
            setting=json.dumps({"name": f"Test {kind}", "type": kind}),
        )
        db_session.add(p)
        presets[kind] = p
    db_session.add(SettingsModel(key="preferred_slicer", value="orcaslicer"))
    await db_session.commit()
    process_overrides_module._schema_cache.clear()
    for p in presets.values():
        await db_session.refresh(p)

    async def make_file(name: str, payload: bytes, plate_layout: dict | None = None) -> int:
        path = storage_dir / name
        path.write_bytes(payload)
        row = LibraryFile(
            filename=name,
            file_path=str(path.relative_to(tmp_path)),
            file_type=name.rsplit(".", 1)[-1],
            file_size=len(payload),
            plate_layout=plate_layout,
        )
        db_session.add(row)
        await db_session.commit()
        await db_session.refresh(row)
        return row.id

    yield {
        "make_file": make_file,
        "printer_id": presets["printer"].id,
        "process_id": presets["process"].id,
        "filament_id": presets["filament"].id,
    }

    app_settings.base_dir = original_base_dir
    slicer_api_module.set_shared_http_client(None)


def _slice_body(setup) -> dict:
    return {
        "printer_preset_id": setup["printer_id"],
        "process_preset_id": setup["process_id"],
        "filament_preset_id": setup["filament_id"],
    }


async def _slice(async_client: AsyncClient, file_id: int, setup) -> dict:
    response = await async_client.post(f"/api/v1/library/files/{file_id}/slice", json=_slice_body(setup))
    assert response.status_code == 202, response.text
    return await _wait_for_job(async_client, response.json()["job_id"])


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.integration
class TestStoredLayoutReachesTheSlicer:
    async def test_stl_with_a_layout_is_converted_then_placed(
        self, async_client: AsyncClient, layout_slice_setup, monkeypatch
    ):
        """The STL path, end to end.

        #22 measured that a translated STL is re-centred by both slicers, so
        the only thing that carries placement is a project 3MF written by the
        slicer itself. Two sidecar calls are expected: convert, then slice
        the rewritten project file.
        """
        sidecar = _RecordingSidecar()
        slicer_api_module.set_shared_http_client(
            httpx.AsyncClient(transport=httpx.MockTransport(sidecar), timeout=10.0)
        )
        file_id = await layout_slice_setup["make_file"]("Cube.stl", b"solid Cube\nendsolid\n", plate_layout=_layout())

        job = await _slice(async_client, file_id, layout_slice_setup)
        assert job["status"] == "completed", job

        assert len(sidecar.uploads) == 2, "expected a conversion call and then the real slice"
        assert sidecar.uploads[0] == b"solid Cube\nendsolid\n"
        assert _anchor_on_bed(sidecar.uploads[1]) == pytest.approx([168.0, 153.0, 10.0], abs=1e-6)

    async def test_project_3mf_with_a_layout_is_placed_without_a_conversion(
        self, async_client: AsyncClient, layout_slice_setup
    ):
        sidecar = _RecordingSidecar()
        slicer_api_module.set_shared_http_client(
            httpx.AsyncClient(transport=httpx.MockTransport(sidecar), timeout=10.0)
        )
        file_id = await layout_slice_setup["make_file"]("Thing.3mf", build_project_3mf(), plate_layout=_layout())

        job = await _slice(async_client, file_id, layout_slice_setup)
        assert job["status"] == "completed", job

        assert len(sidecar.uploads) == 1, "a project 3MF needs no conversion round-trip"
        assert _anchor_on_bed(sidecar.uploads[0]) == pytest.approx([168.0, 153.0, 10.0], abs=1e-6)

    async def test_core_spec_3mf_with_a_layout_is_converted_too(self, async_client: AsyncClient, layout_slice_setup):
        """A Fusion / Blender 3MF is re-centred exactly like an STL (#22).

        Tests built on slicer-authored 3MFs never notice, which is why this
        one is written against a core-spec file specifically.
        """
        sidecar = _RecordingSidecar()
        slicer_api_module.set_shared_http_client(
            httpx.AsyncClient(transport=httpx.MockTransport(sidecar), timeout=10.0)
        )
        # The conversion response has to be told apart from the input, and
        # both are zips here, so hand the recorder an explicit marker object.
        sidecar._converted = build_project_3mf(object_id="4", component_transform="1 0 0 0 1 0 0 0 1 128 128 10")
        file_id = await layout_slice_setup["make_file"](
            "FromFusion.3mf", build_core_spec_3mf(), plate_layout=_layout(object_id="4")
        )

        job = await _slice(async_client, file_id, layout_slice_setup)
        assert job["status"] == "completed", job

        assert len(sidecar.uploads) == 2
        assert _anchor_on_bed(sidecar.uploads[1], "4") == pytest.approx([168.0, 153.0, 10.0], abs=1e-6)

    async def test_no_layout_forwards_the_source_bytes_unchanged(self, async_client: AsyncClient, layout_slice_setup):
        sidecar = _RecordingSidecar()
        slicer_api_module.set_shared_http_client(
            httpx.AsyncClient(transport=httpx.MockTransport(sidecar), timeout=10.0)
        )
        original = build_project_3mf()
        file_id = await layout_slice_setup["make_file"]("Thing.3mf", original, plate_layout=None)

        job = await _slice(async_client, file_id, layout_slice_setup)
        assert job["status"] == "completed", job
        assert len(sidecar.uploads) == 1
        assert _anchor_on_bed(sidecar.uploads[0]) == pytest.approx([128.0, 128.0, 10.0], abs=1e-6)

    async def test_layout_with_an_unknown_version_fails_the_job(self, async_client: AsyncClient, layout_slice_setup):
        """Refuse rather than slice an arrangement we can't read.

        A stored layout the applier doesn't understand would otherwise slice
        as-designed while the viewer shows the saved arrangement — the silent
        mismatch the ``version`` field exists to make detectable.
        """
        sidecar = _RecordingSidecar()
        slicer_api_module.set_shared_http_client(
            httpx.AsyncClient(transport=httpx.MockTransport(sidecar), timeout=10.0)
        )
        file_id = await layout_slice_setup["make_file"](
            "Thing.3mf", build_project_3mf(), plate_layout=_layout(version=2)
        )

        job = await _slice(async_client, file_id, layout_slice_setup)
        assert job["status"] == "failed", job
        assert "layout" in json.dumps(job).lower()
        assert sidecar.uploads == []


@pytest.mark.asyncio
@pytest.mark.integration
class TestObjectIdsSurviveTheWholeRoundTrip:
    """The ``object_id`` contract, on a **multi-object** project 3MF (#32).

    This is the path the step-8 tickets flag as the one that fails silently.
    The placement UI keys every saved transform on an object id it got from
    ``GET /library/files/{id}/plates``; the applier matches on the 3MF
    ``<object id>``. If those two are different strings the PUT succeeds, the
    GET echoes it back, the viewport looks right, and the slice comes out
    unarranged — nothing anywhere reports a problem.

    A single-object file cannot catch it: ``_rewrite_build`` deliberately
    remaps a lone placement onto a lone build item whatever it is called
    (an STL has no object ids to carry). Two objects is the smallest case
    where the ids have to actually be right.
    """

    @staticmethod
    def _multi_object_3mf() -> bytes:
        return build_project_3mf(
            object_id="2",
            component_transform="1 0 0 0 1 0 0 0 1 100 100 10",
            extra_objects=[("3", "1 0 0 0 1 0 0 0 1 160 100 10")],
        )

    async def test_plates_reports_ids_the_applier_matches_not_display_names(
        self, async_client: AsyncClient, layout_slice_setup
    ):
        """``objects`` is names, ``object_ids`` is ids, and they differ."""
        file_id = await layout_slice_setup["make_file"]("Two.3mf", self._multi_object_3mf())

        response = await async_client.get(f"/api/v1/library/files/{file_id}/plates")
        assert response.status_code == 200, response.text
        plate = response.json()["plates"][0]

        # The trap: `objects` is what the file grid shows, and it is names.
        assert plate["objects"] == ["part_0.stl", "part_1.stl"]
        # `object_ids` is what a layout must be keyed on.
        assert plate["object_ids"] == ["2", "3"]

        # And those ids really are the model's build-item ids — the exact
        # strings `services/plate_layout.py` matches a placement against.
        with zipfile.ZipFile(io.BytesIO(self._multi_object_3mf())) as zf:
            xml = zf.read("3D/3dmodel.model").decode()
        build = re.search(r"<build\b.*?</build>", xml, re.DOTALL).group(0)
        assert re.findall(r'<item objectid="([^"]*)"', build) == plate["object_ids"]

    async def test_every_object_of_a_multi_object_plate_is_placed(self, async_client: AsyncClient, layout_slice_setup):
        """/plates → PUT /layout → slice, with the numbers checked on the wire."""
        sidecar = _RecordingSidecar()
        slicer_api_module.set_shared_http_client(
            httpx.AsyncClient(transport=httpx.MockTransport(sidecar), timeout=10.0)
        )
        file_id = await layout_slice_setup["make_file"]("Two.3mf", self._multi_object_3mf())

        plates = (await async_client.get(f"/api/v1/library/files/{file_id}/plates")).json()["plates"]
        object_ids = plates[0]["object_ids"]

        # Exactly what the page saves: one entry per object, keyed on the ids
        # the same endpoint just handed the UI.
        put = await async_client.put(
            f"/api/v1/library/files/{file_id}/layout",
            json={
                "version": 1,
                "plates": {
                    "1": [
                        {
                            "object_id": object_ids[0],
                            "position": [60.0, 40.0, 10.0],
                            "rotation": [0.0, 0.0, 0.0],
                            "scale": [1.0, 1.0, 1.0],
                        },
                        {
                            "object_id": object_ids[1],
                            "position": [190.0, 210.0, 10.0],
                            "rotation": [0.0, 0.0, 0.0],
                            "scale": [1.0, 1.0, 1.0],
                        },
                    ]
                },
            },
        )
        assert put.status_code == 200, put.text

        job = await _slice(async_client, file_id, layout_slice_setup)
        assert job["status"] == "completed", job
        assert len(sidecar.uploads) == 1

        # Both, not just the first: a partial match is the shape of the bug.
        assert _anchor_on_bed(sidecar.uploads[0], object_ids[0]) == pytest.approx([60.0, 40.0, 10.0], abs=1e-6)
        assert _anchor_on_bed(sidecar.uploads[0], object_ids[1]) == pytest.approx([190.0, 210.0, 10.0], abs=1e-6)

    async def test_a_layout_keyed_on_display_names_places_nothing(self, async_client: AsyncClient, layout_slice_setup):
        """The failure this is all guarding against, made visible.

        Saving the names `objects` reports is accepted by the endpoint and
        applies to nothing. The slice still succeeds — which is exactly why
        the id has to be pinned by a test rather than noticed in a print.
        """
        sidecar = _RecordingSidecar()
        slicer_api_module.set_shared_http_client(
            httpx.AsyncClient(transport=httpx.MockTransport(sidecar), timeout=10.0)
        )
        file_id = await layout_slice_setup["make_file"](
            "Two.3mf",
            self._multi_object_3mf(),
            plate_layout={
                "version": 1,
                "plates": {
                    "1": [
                        {
                            "object_id": "part_0.stl",
                            "position": [60.0, 40.0, 10.0],
                            "rotation": [0.0, 0.0, 0.0],
                            "scale": [1.0, 1.0, 1.0],
                        },
                        {
                            "object_id": "part_1.stl",
                            "position": [190.0, 210.0, 10.0],
                            "rotation": [0.0, 0.0, 0.0],
                            "scale": [1.0, 1.0, 1.0],
                        },
                    ]
                },
            },
        )

        job = await _slice(async_client, file_id, layout_slice_setup)
        assert job["status"] == "completed", job
        # Untouched: still where the file itself put them.
        assert _anchor_on_bed(sidecar.uploads[0], "2") == pytest.approx([100.0, 100.0, 10.0], abs=1e-6)
        assert _anchor_on_bed(sidecar.uploads[0], "3") == pytest.approx([160.0, 100.0, 10.0], abs=1e-6)
