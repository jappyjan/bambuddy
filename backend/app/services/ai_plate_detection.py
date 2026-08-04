"""AI / vision-model build-plate emptiness detection (#63).

Optional alternative to the OpenCV reference-diffing detector in
``plate_detection.py``. Posts the captured JPEG frame to any OpenAI-compatible
``/chat/completions`` endpoint — OpenAI, OpenRouter, Ollama, LM Studio, vLLM —
and parses a strict-JSON verdict out of the reply.

No new dependency: ``httpx`` is already used for exactly this shape of call by
``obico_detection.py``.

FAIL OPEN, ALWAYS
-----------------
This runs inside ``main.py:on_print_start()``. The print is *already running*
by the time it executes, and the detector's only power is to PAUSE it. So:

* a wrong "empty" verdict costs nothing beyond a missed safety net;
* a wrong "not empty" verdict pauses a legitimate print.

Every error path in this module therefore returns ``None`` and the caller
reports "empty", exactly like every existing error path in
``plate_detection.py``. An unreachable endpoint, an expired API key or a
model that answers in prose must never stop somebody's print.

Latency, not cost, is the constraint here: the nozzle is extruding while this
request is in flight, so the timeout is bounded to single-digit seconds
(``MIN_TIMEOUT``..``MAX_TIMEOUT``) rather than Obico's 30s poller budget.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

PROVIDER_OPENCV = "opencv"
PROVIDER_AI = "ai"
VALID_PROVIDERS = (PROVIDER_OPENCV, PROVIDER_AI)

# Single-digit seconds on purpose — see module docstring.
DEFAULT_TIMEOUT = 5
MIN_TIMEOUT = 1
MAX_TIMEOUT = 9

MAX_REASON_CHARS = 300

# Settings rows overridable by environment variables, mirroring HA_URL/HA_TOKEN.
ENV_OVERRIDES: dict[str, str] = {
    "plate_detection_ai_endpoint": "PLATE_DETECTION_AI_ENDPOINT",
    "plate_detection_ai_model": "PLATE_DETECTION_AI_MODEL",
    "plate_detection_ai_api_key": "PLATE_DETECTION_AI_API_KEY",
}

SETTING_KEYS: tuple[str, ...] = (
    "plate_detection_provider",
    "plate_detection_ai_timeout",
    *ENV_OVERRIDES,
)

SYSTEM_PROMPT = "You are a machine-vision inspector for a 3D printer. You answer only with a single JSON object."

USER_PROMPT = (
    "This photo shows the build plate of a 3D printer, viewed through the chamber camera.\n"
    "Decide whether the plate is EMPTY, meaning it carries no finished print, no leftover part, "
    "no support material and no debris that a new print would collide with.\n"
    "The plate itself, its texture, its markings, the nozzle, the toolhead, the AMS and the chamber "
    "are not objects. The plate being shifted, rotated, dirty, scratched or lit differently does not "
    "make it non-empty. A purge line or a few millimetres of freshly extruded first layer is normal at "
    "print start and still counts as empty.\n"
    'Reply with ONLY this JSON object and nothing else: {"is_empty": true or false, '
    '"confidence": number between 0 and 1, "reason": "one short sentence"}'
)


def clamp_timeout(value: object) -> int:
    """Coerce any stored/user value into the bounded single-digit timeout window."""
    try:
        seconds = int(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT
    return max(MIN_TIMEOUT, min(MAX_TIMEOUT, seconds))


def env_setting_overrides() -> dict[str, str]:
    """Return {settings_key: value} for the AI settings supplied via environment."""
    overrides: dict[str, str] = {}
    for key, env_name in ENV_OVERRIDES.items():
        value = os.environ.get(env_name)
        if value:
            overrides[key] = value
    return overrides


@dataclass
class AIPlateConfig:
    """Resolved AI-provider configuration (DB row values with env overrides applied)."""

    endpoint: str = ""
    model: str = ""
    api_key: str = ""
    timeout: int = DEFAULT_TIMEOUT

    def __post_init__(self) -> None:
        self.endpoint = (self.endpoint or "").strip().rstrip("/")
        self.model = (self.model or "").strip()
        self.api_key = (self.api_key or "").strip()
        self.timeout = clamp_timeout(self.timeout)

    @property
    def is_configured(self) -> bool:
        return bool(self.endpoint and self.model and self.api_key)

    @property
    def chat_completions_url(self) -> str:
        """Base URL + ``/chat/completions``; tolerate a full URL being pasted in."""
        if self.endpoint.endswith("/chat/completions"):
            return self.endpoint
        return f"{self.endpoint}/chat/completions"


@dataclass
class AIPlateVerdict:
    """Parsed model answer."""

    is_empty: bool
    confidence: float
    reason: str

    @property
    def message(self) -> str:
        headline = "AI: plate appears empty" if self.is_empty else "AI: objects detected on plate"
        return f"{headline} — {self.reason}" if self.reason else headline


async def load_ai_config() -> tuple[str, AIPlateConfig]:
    """Read the plate-detection provider settings.

    Returns ``(provider, config)``. Any failure — missing table, DB error,
    unknown provider string — resolves to ``("opencv", <empty config>)`` so the
    existing detector keeps running unchanged.
    """
    rows: dict[str, str] = {}
    try:
        from sqlalchemy import select

        from backend.app.core.database import async_session
        from backend.app.models.settings import Settings

        async with async_session() as db:
            result = await db.execute(select(Settings).where(Settings.key.in_(SETTING_KEYS)))
            rows = {r.key: r.value for r in result.scalars().all() if r.value is not None}
    except Exception as e:
        logger.warning(
            "Plate detection: could not load AI provider settings (%s: %s) — using OpenCV",
            type(e).__name__,
            e,
        )
        return PROVIDER_OPENCV, AIPlateConfig()

    rows.update(env_setting_overrides())

    provider = (rows.get("plate_detection_provider") or PROVIDER_OPENCV).strip().lower()
    if provider not in VALID_PROVIDERS:
        logger.warning("Unknown plate_detection_provider %r — using OpenCV", provider)
        provider = PROVIDER_OPENCV

    config = AIPlateConfig(
        endpoint=rows.get("plate_detection_ai_endpoint", ""),
        model=rows.get("plate_detection_ai_model", ""),
        api_key=rows.get("plate_detection_ai_api_key", ""),
        timeout=rows.get("plate_detection_ai_timeout", DEFAULT_TIMEOUT),
    )
    return provider, config


def build_request_payload(image_data: bytes, config: AIPlateConfig) -> dict:
    """Build the OpenAI-compatible chat-completions body carrying the JPEG frame."""
    b64 = base64.b64encode(image_data).decode("ascii")
    return {
        "model": config.model,
        "temperature": 0,
        "max_tokens": 200,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                ],
            },
        ],
    }


def _extract_message_content(data: object) -> str | None:
    """Pull the assistant text out of a chat-completions response body."""
    if not isinstance(data, dict):
        return None
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if isinstance(content, str):
        return content
    # Some OpenAI-compatible proxies return content as a list of parts.
    if isinstance(content, list):
        parts = [p.get("text", "") for p in content if isinstance(p, dict) and isinstance(p.get("text"), str)]
        joined = "".join(parts)
        return joined or None
    return None


def _extract_json_object(text: str) -> dict | None:
    """Parse a JSON object out of the model's reply.

    Tolerates a ```json fence or leading/trailing whitespace, and nothing else.
    Anything that is not a JSON object is an error — we never scan prose for
    "yes"/"no".
    """
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`")
        if stripped.lower().startswith("json"):
            stripped = stripped[4:]
        stripped = stripped.strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(stripped[start : end + 1])
    except (json.JSONDecodeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def parse_verdict(data: object) -> AIPlateVerdict | None:
    """Turn a chat-completions response body into a verdict, or None if unusable."""
    content = _extract_message_content(data)
    if not content:
        return None

    obj = _extract_json_object(content)
    if obj is None:
        return None

    is_empty = obj.get("is_empty")
    if not isinstance(is_empty, bool):
        # A verdict we cannot trust is an error, not a "maybe".
        return None

    try:
        confidence = float(obj.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    reason_raw = obj.get("reason", "")
    reason = " ".join(str(reason_raw).split())[:MAX_REASON_CHARS] if reason_raw else ""

    return AIPlateVerdict(is_empty=is_empty, confidence=confidence, reason=reason)


async def analyze_frame_with_ai(image_data: bytes, config: AIPlateConfig) -> AIPlateVerdict | None:
    """Ask the configured vision model whether the plate is empty.

    Returns ``None`` on *every* failure — unconfigured, unreachable, timed out,
    HTTP error, unparseable body. The caller must treat ``None`` as "do not
    pause". See the module docstring.
    """
    if not config.is_configured:
        logger.warning(
            "AI plate detection selected but endpoint/model/API key are incomplete — skipping check (fail open)"
        )
        return None
    if not image_data:
        logger.warning("AI plate detection got no frame to analyze — skipping check (fail open)")
        return None

    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {config.api_key}"}
    payload = build_request_payload(image_data, config)

    try:
        async with httpx.AsyncClient(timeout=config.timeout) as client:
            response = await client.post(config.chat_completions_url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
    except Exception as e:
        logger.warning(
            "AI plate detection request to %s failed (%s: %s) — failing open",
            config.chat_completions_url,
            type(e).__name__,
            e,
        )
        return None

    verdict = parse_verdict(data)
    if verdict is None:
        logger.warning("AI plate detection returned an unparseable verdict — failing open")
    return verdict
