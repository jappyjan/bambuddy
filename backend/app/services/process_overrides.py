"""Validation for per-slice `process_overrides` (#29, step 4 of the slicer
UX redesign).

Two sources, each authoritative for a different thing:

- **the target slicer's key set**, from the sidecar's `GET /schema` — says
  whether a key *exists*. The two supported slicers share only 394 of their
  ~550 keys, and neither CLI complains about one it does not know.
- **`process_fields.json`** — says what a key's label, type and range are.
  The CLIs emit none of that, so it is hand-curated and is the only source.

Anything that fails either check is rejected with **422** rather than being
dropped: a setting that quietly does nothing is the exact failure this work
exists to prevent — the user changes a value, the slice succeeds, the G-code
is identical, and nothing says why.

Values are also **coerced to the string spelling real process profiles use**
before they reach the patcher. This is not cosmetic. Verified 2026-08-01
against `ghcr.io/jappyjan/bambu-studio-api:latest` (BambuStudio 02.07.01.57),
slicing a cube through the sidecar's `/slice`:

    {"sparse_infill_density": "25%", "wall_loops": "4"}  -> G-code has
        `; sparse_infill_density = 25%`, `; wall_loops = 4`
    {"sparse_infill_density": 25,    "wall_loops": 4}    -> G-code has
        `; sparse_infill_density = 20%`, `; wall_loops = 2`  (the preset's
        own defaults — the override vanished, HTTP 200, no error)

The CLI logs `load_from_json: parse ... error, invalid json type for
<key>` for each numeric value and carries on with the preset default. Every
value in `/schema`'s `defaults` is a string (`'0.2'`, `'20%'`, `'0'`) or a
list of strings, so the string spelling is what the parser is built for.
"""

from __future__ import annotations

import json
import logging
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Curated field metadata — label, unit, type, range and category. The only
# source for these; the slicer CLIs expose none of them.
_PROCESS_FIELDS_PATH = Path(__file__).resolve().parents[1] / "data" / "process_fields.json"

# How long a fetched `/schema` stays good for. The sidecar's key set changes
# only when its image does, and the sidecar itself caches the underlying
# `--export-settings` run for the life of its process, so this is purely
# about not paying an HTTP round-trip per slice.
_SCHEMA_TTL_S = 3600.0

# base_url -> (expires_at, version, keys).
#
# Cached per sidecar URL *and* slicer version: the URL because a BambuStudio
# install and an OrcaSlicer install have materially different key sets, and
# the version because a sidecar upgrade must be picked up rather than masked
# by a stale entry. Storing the version alongside the keys is what makes the
# pair the cache identity — a refresh reporting a new version replaces the
# entry wholesale.
_schema_cache: dict[str, tuple[float, str, frozenset[str]]] = {}


@lru_cache(maxsize=1)
def load_process_fields() -> list[dict[str, Any]]:
    """The curated field list, read once."""
    return json.loads(_PROCESS_FIELDS_PATH.read_text(encoding="utf-8"))["fields"]


def curated_fields_for_slicer(slicer: str) -> list[dict[str, Any]]:
    """Curated fields valid on `slicer`.

    A field carries `slicers` only when it is *not* valid on every supported
    slicer; absent means universal (see the file's own header). This is the
    same filter `GET /slicer/process-fields` renders the editor from, so the
    fields offered and the fields accepted cannot drift apart.
    """
    return [f for f in load_process_fields() if slicer in f.get("slicers", [slicer])]


async def _fetch_slicer_keys(api_url: str) -> frozenset[str] | None:
    """The target slicer's real key set, or None when `/schema` is unavailable.

    None is a normal outcome, not an error: an older sidecar image has no
    `/schema` route at all, and a sidecar that is down should not turn an
    override into a hard failure before the slice has even been attempted.
    """
    from backend.app.services.slicer_api import SlicerApiError, SlicerApiService

    cached = _schema_cache.get(api_url)
    if cached is not None and cached[0] > time.monotonic():
        return cached[2]

    try:
        payload = await SlicerApiService(api_url).schema()
        version = str(payload["version"])
        keys = frozenset(payload["keys"])
    except (SlicerApiError, KeyError, TypeError, ValueError) as exc:
        logger.warning(
            "Slicer /schema unavailable at %s (%s) — validating process_overrides against the curated key list instead",
            api_url,
            exc,
        )
        return None

    if cached is not None and cached[1] != version:
        logger.info("Slicer at %s upgraded: %s -> %s, schema cache replaced", api_url, cached[1], version)
    _schema_cache[api_url] = (time.monotonic() + _SCHEMA_TTL_S, version, keys)
    return keys


def _coerce(value: Any, field: dict[str, Any]) -> str:
    """Spell `value` the way a real process profile spells it.

    See the module docstring: the CLI's JSON config loader takes strings and
    silently discards anything else, so this is what makes an override take
    effect at all. Booleans are `"1"`/`"0"`, percent-unit fields keep their
    `%` suffix, and an integral float loses its `.0` so `4.0` does not become
    the profile-alien `"4.0"`.
    """
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if field.get("unit") == "%":
        return f"{value}%"
    return str(value)


def _check(key: str, value: Any, field: dict[str, Any]) -> str | None:
    """The curated type/range check for one key. Returns an error, or None."""
    kind = field["type"]

    if kind == "boolean":
        if not isinstance(value, bool):
            return f"'{key}' expects true or false, got {type(value).__name__}"
        return None

    if kind == "select":
        options = [o["value"] for o in field.get("options", [])]
        if not isinstance(value, str) or value not in options:
            return f"'{key}' must be one of {', '.join(options)} — got {value!r}"
        return None

    # number
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return f"'{key}' expects a number, got {type(value).__name__}"
    low, high = field.get("min"), field.get("max")
    if low is not None and value < low:
        return f"'{key}' must be at least {low}{field.get('unit', '')} — got {value}"
    if high is not None and value > high:
        return f"'{key}' must be at most {high}{field.get('unit', '')} — got {value}"
    return None


async def validate_process_overrides(
    overrides: dict[str, Any],
    *,
    api_url: str,
    slicer: str,
) -> dict[str, str]:
    """Validate per-slice overrides and return them spelled for the profile.

    Raises `HTTPException(422)` listing every problem, so an editor with
    several bad values gets one answer rather than one per round-trip.
    """
    if not overrides:
        return {}

    curated = {f["key"]: f for f in curated_fields_for_slicer(slicer)}
    slicer_keys = await _fetch_slicer_keys(api_url)
    if slicer_keys is None:
        # Degraded but working: the curated file's own key list stands in.
        # It is tagged per slicer against the real `--export-settings` key
        # sets, so it is a strict subset of the truth — this can reject a
        # key the slicer does have, never accept one it does not.
        slicer_keys = frozenset(curated)

    errors: list[str] = []
    coerced: dict[str, str] = {}
    for key, value in overrides.items():
        if key not in slicer_keys:
            errors.append(f"'{key}' is not a setting {slicer} has")
        elif key not in curated:
            # No curated metadata means no label, no type and no range to
            # check against, so the editor never offers it and a request
            # naming it is not something Bambuddy can validate.
            errors.append(f"'{key}' has no curated metadata and cannot be overridden")
        else:
            error = _check(key, value, curated[key])
            if error:
                errors.append(error)
            else:
                coerced[key] = _coerce(value, curated[key])

    if errors:
        raise HTTPException(status_code=422, detail="; ".join(errors))
    return coerced
