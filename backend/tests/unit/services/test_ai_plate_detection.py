"""Tests for the AI/vision-model empty-plate detector (#63).

Only the HTTP layer is mocked. ``cv2``/``numpy`` are imported for real (they
are real dependencies), unlike ``test_plate_detection.py`` which replaces them
with ``MagicMock``s.

The single most important property under test is FAIL OPEN. ``check_plate_empty``
runs inside ``on_print_start()`` while the print is already extruding, and its
only power is to PAUSE. Every AI failure mode - unreachable host, timeout, HTTP
error, prose instead of JSON, missing credentials - must yield
``is_empty is True`` so the print keeps running. A fail-closed detector would
pause a legitimate print on every API hiccup, which is worse than the bug this
feature exists to fix.

The second is ``needs_calibration is False``: ``main.py`` short-circuits the
pause on that flag, so a True there would leave the feature dead while looking
alive in the UI.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from backend.app.services.ai_plate_detection import (
    DEFAULT_TIMEOUT,
    MAX_TIMEOUT,
    MIN_TIMEOUT,
    PROVIDER_AI,
    PROVIDER_OPENCV,
    AIPlateConfig,
    analyze_frame_with_ai,
    build_request_payload,
    clamp_timeout,
    parse_verdict,
)
from backend.app.services.plate_detection import check_plate_empty

FRAME = b"\xff\xd8\xff\xe0 fake jpeg bytes"

CONFIG = AIPlateConfig(
    endpoint="https://api.example.test/v1",
    model="vision-model",
    api_key="sk-test",
    timeout=5,
)


# --------------------------------------------------------------------------
# helpers - HTTP layer only
# --------------------------------------------------------------------------


def _chat_response(content: str) -> MagicMock:
    """A well-formed OpenAI-compatible response carrying ``content``."""
    response = MagicMock()
    response.raise_for_status = MagicMock()
    response.json = MagicMock(return_value={"choices": [{"message": {"content": content}}]})
    return response


def _mock_async_client(*, response=None, error: Exception | None = None) -> MagicMock:
    client = MagicMock()
    if error is not None:
        client.post = AsyncMock(side_effect=error)
    else:
        client.post = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    return client


async def _run_check(client_mock: MagicMock | None, *, config=CONFIG, provider=PROVIDER_AI, frame=FRAME):
    """Drive the real ``check_plate_empty`` with camera + HTTP mocked out."""
    capture = AsyncMock(return_value=(frame, "built-in"))
    load = AsyncMock(return_value=(provider, config))
    factory = MagicMock(return_value=client_mock)
    with (
        patch("backend.app.services.plate_detection.capture_camera_image", capture),
        patch("backend.app.services.ai_plate_detection.load_ai_config", load),
        patch("httpx.AsyncClient", factory),
    ):
        result = await check_plate_empty(
            printer_id=1,
            ip_address="192.0.2.10",
            access_code="00000000",
            model="X1C",
        )
    return result, factory


# --------------------------------------------------------------------------
# happy path
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_not_empty_verdict_is_reported_and_never_needs_calibration():
    """A confident "not empty" answer is the one case that may pause a print."""
    client = _mock_async_client(
        response=_chat_response(
            '{"is_empty": false, "confidence": 0.93, "reason": "A grey printed bracket sits mid-plate"}'
        )
    )

    result, _factory = await _run_check(client)

    assert result.is_empty is False
    # main.py:2532 short-circuits the pause on needs_calibration. The AI path
    # has no reference images, so this MUST be False or the feature is dead.
    assert result.needs_calibration is False
    assert result.confidence == pytest.approx(0.93)
    # difference_percent is meaningless for this path - do not invent a number.
    assert result.difference_percent == 0.0
    # The reason must reach the paused-print alert.
    assert "A grey printed bracket sits mid-plate" in result.message


@pytest.mark.asyncio
async def test_empty_verdict_does_not_pause():
    client = _mock_async_client(
        response=_chat_response('{"is_empty": true, "confidence": 0.99, "reason": "Bare textured plate"}')
    )

    result, _factory = await _run_check(client)

    assert result.is_empty is True
    assert result.needs_calibration is False
    assert "Bare textured plate" in result.message


@pytest.mark.asyncio
async def test_json_wrapped_in_markdown_fence_is_accepted():
    client = _mock_async_client(
        response=_chat_response('```json\n{"is_empty": false, "confidence": 0.7, "reason": "Leftover skirt"}\n```')
    )

    result, _factory = await _run_check(client)

    assert result.is_empty is False
    assert "Leftover skirt" in result.message


@pytest.mark.asyncio
async def test_request_targets_chat_completions_with_bearer_and_base64_image():
    client = _mock_async_client(response=_chat_response('{"is_empty": true, "confidence": 1.0, "reason": "ok"}'))

    await _run_check(client)

    url = client.post.call_args.args[0]
    kwargs = client.post.call_args.kwargs
    assert url == "https://api.example.test/v1/chat/completions"
    assert kwargs["headers"]["Authorization"] == "Bearer sk-test"
    body = kwargs["json"]
    assert body["model"] == "vision-model"
    image_part = body["messages"][1]["content"][1]
    assert image_part["image_url"]["url"].startswith("data:image/jpeg;base64,")


# --------------------------------------------------------------------------
# fail open - one test per failure mode
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fail_open_on_unreachable_endpoint():
    client = _mock_async_client(error=httpx.ConnectError("connection refused"))

    result, _factory = await _run_check(client)

    assert result.is_empty is True
    assert result.needs_calibration is False


@pytest.mark.asyncio
async def test_fail_open_on_timeout():
    client = _mock_async_client(error=httpx.ReadTimeout("timed out"))

    result, _factory = await _run_check(client)

    assert result.is_empty is True
    assert result.needs_calibration is False


@pytest.mark.asyncio
async def test_fail_open_on_http_error_status():
    response = MagicMock()
    response.raise_for_status = MagicMock(
        side_effect=httpx.HTTPStatusError("401", request=MagicMock(), response=MagicMock())
    )
    client = _mock_async_client(response=response)

    result, _factory = await _run_check(client)

    assert result.is_empty is True
    assert result.needs_calibration is False


@pytest.mark.asyncio
async def test_fail_open_on_prose_instead_of_json():
    """Prose is an error, not a verdict - we never scan it for yes/no."""
    client = _mock_async_client(response=_chat_response("No, the build plate is definitely not empty."))

    result, _factory = await _run_check(client)

    assert result.is_empty is True
    assert result.needs_calibration is False


@pytest.mark.asyncio
async def test_fail_open_on_undecodable_response_body():
    response = MagicMock()
    response.raise_for_status = MagicMock()
    response.json = MagicMock(side_effect=ValueError("not json"))
    client = _mock_async_client(response=response)

    result, _factory = await _run_check(client)

    assert result.is_empty is True
    assert result.needs_calibration is False


@pytest.mark.asyncio
async def test_fail_open_on_missing_api_key_without_calling_the_provider():
    client = _mock_async_client(response=_chat_response('{"is_empty": false, "confidence": 1.0, "reason": "part"}'))
    config = AIPlateConfig(endpoint="https://api.example.test/v1", model="vision-model", api_key="")

    result, factory = await _run_check(client, config=config)

    assert result.is_empty is True
    assert result.needs_calibration is False
    factory.assert_not_called()
    client.post.assert_not_called()


@pytest.mark.asyncio
async def test_fail_open_when_camera_capture_returns_nothing():
    client = _mock_async_client(response=_chat_response('{"is_empty": false, "confidence": 1.0, "reason": "part"}'))

    result, factory = await _run_check(client, frame=None)

    assert result.is_empty is True
    factory.assert_not_called()


@pytest.mark.asyncio
async def test_missing_is_empty_key_fails_open():
    client = _mock_async_client(response=_chat_response('{"confidence": 0.9, "reason": "unsure"}'))

    result, _factory = await _run_check(client)

    assert result.is_empty is True


@pytest.mark.asyncio
async def test_non_boolean_is_empty_fails_open():
    """A verdict we cannot trust is an error, not a "maybe"."""
    client = _mock_async_client(response=_chat_response('{"is_empty": "false", "confidence": 0.9, "reason": "x"}'))

    result, _factory = await _run_check(client)

    assert result.is_empty is True


# --------------------------------------------------------------------------
# timeout is bounded and actually applied
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timeout_is_passed_to_httpx():
    client = _mock_async_client(response=_chat_response('{"is_empty": true, "confidence": 1.0, "reason": "ok"}'))
    config = AIPlateConfig(endpoint="https://api.example.test/v1", model="m", api_key="k", timeout=7)

    _result, factory = await _run_check(client, config=config)

    assert factory.call_args.kwargs["timeout"] == 7


@pytest.mark.asyncio
async def test_timeout_is_clamped_to_single_digit_seconds_before_reaching_httpx():
    """Obico's 30s budget would be terrible here - the nozzle is printing."""
    client = _mock_async_client(response=_chat_response('{"is_empty": true, "confidence": 1.0, "reason": "ok"}'))
    config = AIPlateConfig(endpoint="https://api.example.test/v1", model="m", api_key="k", timeout=30)

    _result, factory = await _run_check(client, config=config)

    assert factory.call_args.kwargs["timeout"] == MAX_TIMEOUT
    assert MAX_TIMEOUT < 10


def test_clamp_timeout_bounds():
    assert clamp_timeout(30) == MAX_TIMEOUT
    assert clamp_timeout(0) == MIN_TIMEOUT
    assert clamp_timeout(-5) == MIN_TIMEOUT
    assert clamp_timeout("6") == 6
    assert clamp_timeout("nonsense") == DEFAULT_TIMEOUT
    assert clamp_timeout(None) == DEFAULT_TIMEOUT
    assert MIN_TIMEOUT >= 1 and MAX_TIMEOUT <= 9


# --------------------------------------------------------------------------
# provider switching
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_opencv_provider_never_calls_the_ai_endpoint():
    client = _mock_async_client(response=_chat_response('{"is_empty": false, "confidence": 1.0, "reason": "part"}'))

    opencv_result = MagicMock(message="Plate appears empty (difference: 0.2%)")

    with patch("backend.app.services.plate_detection.PlateDetector") as detector_cls:
        detector_cls.return_value.analyze_frame.return_value = opencv_result
        result, factory = await _run_check(client, provider=PROVIDER_OPENCV)

    factory.assert_not_called()
    assert result is opencv_result
    detector_cls.return_value.analyze_frame.assert_called_once()


# --------------------------------------------------------------------------
# unit-level pieces
# --------------------------------------------------------------------------


def test_config_normalisation_and_url_building():
    config = AIPlateConfig(endpoint="  https://host.test/v1/  ", model=" m ", api_key=" k ")
    assert config.chat_completions_url == "https://host.test/v1/chat/completions"
    assert config.is_configured is True
    # A user pasting the full URL must not get it doubled.
    full = AIPlateConfig(endpoint="https://host.test/v1/chat/completions", model="m", api_key="k")
    assert full.chat_completions_url == "https://host.test/v1/chat/completions"


def test_is_configured_requires_endpoint_model_and_key():
    assert AIPlateConfig(endpoint="", model="m", api_key="k").is_configured is False
    assert AIPlateConfig(endpoint="e", model="", api_key="k").is_configured is False
    assert AIPlateConfig(endpoint="e", model="m", api_key="").is_configured is False


def test_confidence_is_clamped_and_defaulted():
    assert (
        parse_verdict({"choices": [{"message": {"content": '{"is_empty": true, "confidence": 5}'}}]}).confidence == 1.0
    )
    assert (
        parse_verdict({"choices": [{"message": {"content": '{"is_empty": true, "confidence": -2}'}}]}).confidence == 0.0
    )
    assert (
        parse_verdict({"choices": [{"message": {"content": '{"is_empty": true, "confidence": "high"}'}}]}).confidence
        == 0.0
    )
    assert parse_verdict({"choices": [{"message": {"content": '{"is_empty": true}'}}]}).confidence == 0.0


def test_parse_verdict_rejects_malformed_envelopes():
    assert parse_verdict(None) is None
    assert parse_verdict({}) is None
    assert parse_verdict({"choices": []}) is None
    assert parse_verdict({"choices": [{"message": {}}]}) is None
    assert parse_verdict({"choices": [{"message": {"content": ""}}]}) is None
    assert parse_verdict({"choices": [{"message": {"content": "[1, 2, 3]"}}]}) is None


def test_parse_verdict_accepts_list_style_content_parts():
    data = {"choices": [{"message": {"content": [{"type": "text", "text": '{"is_empty": false, "reason": "blob"}'}]}}]}
    verdict = parse_verdict(data)
    assert verdict is not None
    assert verdict.is_empty is False
    assert verdict.reason == "blob"


def test_payload_is_openai_compatible():
    payload = build_request_payload(FRAME, CONFIG)
    assert payload["model"] == "vision-model"
    assert payload["messages"][0]["role"] == "system"
    types = [part["type"] for part in payload["messages"][1]["content"]]
    assert types == ["text", "image_url"]


@pytest.mark.asyncio
async def test_analyze_frame_with_ai_returns_none_on_empty_frame():
    assert await analyze_frame_with_ai(b"", CONFIG) is None


def test_provider_constants():
    assert PROVIDER_OPENCV == "opencv"
    assert PROVIDER_AI == "ai"


# --------------------------------------------------------------------------
# settings contract
# --------------------------------------------------------------------------


def test_settings_schema_defaults_and_validation():
    from pydantic import ValidationError

    from backend.app.schemas.settings import AppSettings, AppSettingsUpdate

    defaults = AppSettings()
    assert defaults.plate_detection_provider == "opencv"
    assert defaults.plate_detection_ai_endpoint == ""
    assert defaults.plate_detection_ai_model == ""
    assert defaults.plate_detection_ai_api_key == ""
    assert defaults.plate_detection_ai_timeout == 5

    assert AppSettingsUpdate(plate_detection_provider="ai").plate_detection_provider == "ai"
    with pytest.raises(ValidationError):
        AppSettingsUpdate(plate_detection_provider="openai")
    with pytest.raises(ValidationError):
        AppSettingsUpdate(plate_detection_ai_timeout=30)
    with pytest.raises(ValidationError):
        AppSettingsUpdate(plate_detection_ai_timeout=0)


def test_api_key_is_scrubbed_for_api_key_callers():
    from backend.app.api.routes.settings import _SENSITIVE_FIELDS_FOR_API_KEY

    assert "plate_detection_ai_api_key" in _SENSITIVE_FIELDS_FOR_API_KEY


def test_env_overrides_are_surfaced_with_from_env_flags(monkeypatch):
    from backend.app.api.routes.settings import get_plate_detection_ai_env_settings

    monkeypatch.delenv("PLATE_DETECTION_AI_ENDPOINT", raising=False)
    monkeypatch.delenv("PLATE_DETECTION_AI_MODEL", raising=False)
    monkeypatch.delenv("PLATE_DETECTION_AI_API_KEY", raising=False)
    resolved = get_plate_detection_ai_env_settings()
    assert resolved["plate_detection_ai_api_key_from_env"] is False
    assert "plate_detection_ai_api_key" not in resolved

    monkeypatch.setenv("PLATE_DETECTION_AI_API_KEY", "sk-from-env")
    resolved = get_plate_detection_ai_env_settings()
    assert resolved["plate_detection_ai_api_key"] == "sk-from-env"
    assert resolved["plate_detection_ai_api_key_from_env"] is True
    assert resolved["plate_detection_ai_model_from_env"] is False
