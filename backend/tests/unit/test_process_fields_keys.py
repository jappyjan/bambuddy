"""Guard: every key in process_fields.json exists in a real slicer.

The file used to declare 11 keys BambuStudio has never had and 4 neither
slicer has (step-4a). A dead key is silent: the user changes the setting,
the slice succeeds, nothing differs. These tests fail instead.

Ground truth is the committed key sets in ``tests/_fixtures/slicer_keys/``,
dumped with ``--export-settings`` from the two sidecar images.
"""

import json
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2]
FIELDS_PATH = _BACKEND / "app" / "data" / "process_fields.json"
FIXTURE_DIR = _BACKEND / "tests" / "_fixtures" / "slicer_keys"

SLICERS = ("bambu_studio", "orcaslicer")


@pytest.fixture(scope="module")
def fields() -> list[dict]:
    return json.loads(FIELDS_PATH.read_text())["fields"]


@pytest.fixture(scope="module")
def slicer_keys() -> dict[str, set[str]]:
    return {s: set(json.loads((FIXTURE_DIR / f"{s}.json").read_text())["keys"]) for s in SLICERS}


def test_every_key_resolves_on_at_least_one_slicer(fields, slicer_keys) -> None:
    known = set().union(*slicer_keys.values())
    dead = sorted(f["key"] for f in fields if f["key"] not in known)
    assert not dead, f"keys no slicer knows: {dead}"


def test_slicers_tag_matches_the_fixtures(fields, slicer_keys) -> None:
    """Present-and-correct where restricted, absent where universal."""
    wrong = {}
    for f in fields:
        actual = [s for s in SLICERS if f["key"] in slicer_keys[s]]
        declared = f.get("slicers", list(SLICERS))
        if declared != actual:
            wrong[f["key"]] = {"declared": declared, "actual": actual}
    assert not wrong, f"slicers tag out of sync with fixtures: {wrong}"


def test_regressed_keys_stay_fixed(fields) -> None:
    """The four keys neither slicer has — renamed or dropped in step-4a."""
    keys = {f["key"] for f in fields}
    assert not keys & {
        "fuzzy_skin_point_dist",
        "initial_layer_height",
        "prime_tower_enable",
        "overhang_speed_classic",
    }


@pytest.mark.parametrize("slicer,version,count", [("bambu_studio", "02.07.01.57", 545), ("orcaslicer", "2.3.2", 572)])
def test_fixtures_pin_the_spiked_key_counts(slicer, version, count) -> None:
    """Spec §3a's numbers. A mismatch means the sidecar images moved."""
    data = json.loads((FIXTURE_DIR / f"{slicer}.json").read_text())
    assert data["version"] == version
    assert len(data["keys"]) == count
    assert len(set(data["keys"])) == count
