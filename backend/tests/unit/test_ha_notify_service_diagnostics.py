"""Tests for diagnosing a nonexistent Home Assistant notify service (#60).

Home Assistant answers a POST to `/api/services/<domain>/<service>` for a
service it does not have with a bare `400: Bad Request`. Every HA notification
on the reporter's instance failed that way because the stored service was
`notify.iphone_von_jan` instead of `notify.mobile_app_iphone_von_jan`, and the
error told them nothing.

These tests pin the two halves of the fix:

  * the send path turns *that specific* 400 into a message naming the service
    and listing the real ones — while leaving 401, an unreachable HA, and a
    400 for a service that *does* exist reporting what they always did;
  * save time rejects the bad name up front, but still lets the save through
    when HA cannot be asked.
"""

import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from backend.app.services.notification_service import NotificationService

# What the reporter's HA actually exposes, verbatim from `GET /api/services`.
HA_NOTIFY_SERVICES = {
    "notify": [
        "mobile_app_ipad_von_jan",
        "mobile_app_iphone_von_carina",
        "mobile_app_iphone_von_jan",
        "mobile_app_macbook_air_von_jan",
        "notify",
        "persistent_notification",
        "send_message",
    ],
    "switch": ["turn_on", "turn_off", "toggle"],
}

BAD_SERVICE = {"service": "notify.iphone_von_jan"}
GOOD_SERVICE = {"service": "notify.mobile_app_iphone_von_jan"}


class _StubClient:
    """httpx.AsyncClient stand-in returning a canned response."""

    def __init__(self, status_code: int, text: str = ""):
        self.status_code = status_code
        self.text = text
        self.is_closed = False
        self.calls = 0

    async def post(self, url, json=None, headers=None):
        self.calls += 1
        return httpx.Response(self.status_code, text=self.text)


@pytest.fixture
def ha_env(monkeypatch):
    """Configure HA credentials via env so `db=None` still resolves them."""
    monkeypatch.setenv("HA_URL", "http://ha.local:8123")
    monkeypatch.setenv("HA_TOKEN", "test-token")


def _service_with(status_code: int, text: str = "400: Bad Request"):
    service = NotificationService()
    client = _StubClient(status_code, text)
    service._http_client = client
    return service, client


def _patch_list_services(return_value):
    return patch(
        "backend.app.services.homeassistant.homeassistant_service.list_services",
        AsyncMock(return_value=return_value),
    )


# ---------------------------------------------------------------------------
# Send path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.unit
async def test_send_400_missing_service_names_the_available_ones(ha_env):
    service, _ = _service_with(400)

    with _patch_list_services(HA_NOTIFY_SERVICES):
        ok, message = await service._send_homeassistant(BAD_SERVICE, "T", "M")

    assert ok is False
    assert message == (
        "Home Assistant has no service 'notify.iphone_von_jan'. Available: "
        "notify.mobile_app_ipad_von_jan, notify.mobile_app_iphone_von_carina, "
        "notify.mobile_app_iphone_von_jan, notify.mobile_app_macbook_air_von_jan, "
        "notify.notify, notify.persistent_notification, notify.send_message"
    )
    # The generic dump must be gone, not merely prefixed.
    assert "400: Bad Request" not in message


@pytest.mark.asyncio
@pytest.mark.unit
async def test_send_400_for_existing_service_keeps_generic_error(ha_env):
    """A 400 for a service HA *does* have is a payload problem, not a name
    problem — it must not be relabelled as 'no such service'."""
    service, _ = _service_with(400)

    with _patch_list_services(HA_NOTIFY_SERVICES):
        ok, message = await service._send_homeassistant(GOOD_SERVICE, "T", "M")

    assert ok is False
    assert message == "HTTP 400: 400: Bad Request"


@pytest.mark.asyncio
@pytest.mark.unit
async def test_send_400_falls_back_when_service_lookup_fails(ha_env):
    """If we cannot ask HA what it has, we say what we always said rather
    than claiming a service is missing on no evidence."""
    service, _ = _service_with(400)

    with _patch_list_services(None):
        ok, message = await service._send_homeassistant(BAD_SERVICE, "T", "M")

    assert ok is False
    assert message == "HTTP 400: 400: Bad Request"


@pytest.mark.asyncio
@pytest.mark.unit
async def test_send_401_still_reports_authentication_failure(ha_env):
    service, _ = _service_with(401, "401: Unauthorized")

    with _patch_list_services(HA_NOTIFY_SERVICES) as mocked:
        ok, message = await service._send_homeassistant(BAD_SERVICE, "T", "M")

    assert ok is False
    assert message == "Home Assistant authentication failed - check your token"
    mocked.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.unit
async def test_send_unconfigured_ha_still_reports_not_configured(monkeypatch):
    monkeypatch.delenv("HA_URL", raising=False)
    monkeypatch.delenv("HA_TOKEN", raising=False)
    service, _ = _service_with(400)

    ok, message = await service._send_homeassistant(BAD_SERVICE, "T", "M")

    assert ok is False
    assert "not configured" in message


@pytest.mark.asyncio
@pytest.mark.unit
async def test_successful_send_never_queries_the_service_list(ha_env):
    """The extra lookup belongs on the 400 path only."""
    service, _ = _service_with(200)

    with _patch_list_services(HA_NOTIFY_SERVICES) as mocked:
        ok, message = await service._send_homeassistant(GOOD_SERVICE, "T", "M")

    assert ok is True
    assert message == "Notification sent via Home Assistant"
    mocked.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.unit
async def test_send_400_when_domain_is_absent_entirely(ha_env):
    service, _ = _service_with(400)

    with _patch_list_services({"switch": ["turn_on"]}):
        ok, message = await service._send_homeassistant(BAD_SERVICE, "T", "M")

    assert ok is False
    assert message == (
        "Home Assistant has no service 'notify.iphone_von_jan'. Home Assistant exposes no 'notify' services at all."
    )


@pytest.mark.asyncio
@pytest.mark.unit
async def test_malformed_service_name_is_rejected_without_asking_ha(ha_env):
    service, _ = _service_with(400)

    with _patch_list_services(HA_NOTIFY_SERVICES) as mocked:
        ok, message = await service._send_homeassistant({"service": "notify.bad-name!"}, "T", "M")

    assert ok is False
    assert "letters, numbers, and underscores" in message
    mocked.assert_not_called()


# ---------------------------------------------------------------------------
# `list_services` on the shared HA client
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.unit
async def test_list_services_returns_none_when_ha_is_unreachable():
    from backend.app.services.homeassistant import HomeAssistantService

    ha = HomeAssistantService()

    async def _boom(*args, **kwargs):
        raise httpx.ConnectError("no route to host")

    with patch("httpx.AsyncClient.get", _boom):
        assert await ha.list_services("http://ha.local:8123", "token") is None


@pytest.mark.asyncio
@pytest.mark.unit
async def test_list_services_flattens_domains():
    from backend.app.services.homeassistant import HomeAssistantService

    ha = HomeAssistantService()
    payload = [
        {"domain": "notify", "services": {"mobile_app_x": {}, "notify": {}}},
        {"domain": "switch", "services": {"turn_on": {}}},
    ]

    async def _ok(*args, **kwargs):
        return httpx.Response(200, json=payload, request=httpx.Request("GET", "http://ha.local:8123/api/services"))

    with patch("httpx.AsyncClient.get", _ok):
        result = await ha.list_services("http://ha.local:8123", "token")

    assert result == {"notify": ["mobile_app_x", "notify"], "switch": ["turn_on"]}


@pytest.mark.asyncio
@pytest.mark.unit
async def test_list_services_rejects_unsafe_url():
    from backend.app.services.homeassistant import HomeAssistantService

    assert await HomeAssistantService().list_services("http://169.254.169.254", "token") is None


# ---------------------------------------------------------------------------
# Save-time validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.unit
async def test_create_provider_rejects_nonexistent_service(async_client, ha_env):
    with _patch_list_services(HA_NOTIFY_SERVICES):
        response = await async_client.post(
            "/api/v1/notifications/",
            json={
                "name": "iPhone von Jan - HA",
                "provider_type": "homeassistant",
                "config": BAD_SERVICE,
            },
        )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "Home Assistant has no service 'notify.iphone_von_jan'" in detail
    assert "notify.mobile_app_iphone_von_jan" in detail


@pytest.mark.asyncio
@pytest.mark.unit
async def test_create_provider_allows_save_when_ha_unreachable(async_client, ha_env):
    """A down Home Assistant must warn, not block editing your setup."""
    with _patch_list_services(None):
        response = await async_client.post(
            "/api/v1/notifications/",
            json={
                "name": "iPhone von Jan - HA",
                "provider_type": "homeassistant",
                "config": BAD_SERVICE,
            },
        )

    assert response.status_code == 200
    assert response.json()["config"]["service"] == "notify.iphone_von_jan"


@pytest.mark.asyncio
@pytest.mark.unit
async def test_create_provider_accepts_existing_service(async_client, ha_env):
    with _patch_list_services(HA_NOTIFY_SERVICES):
        response = await async_client.post(
            "/api/v1/notifications/",
            json={
                "name": "iPhone von Jan - HA",
                "provider_type": "homeassistant",
                "config": GOOD_SERVICE,
            },
        )

    assert response.status_code == 200


@pytest.mark.asyncio
@pytest.mark.unit
async def test_create_non_ha_provider_never_asks_ha(async_client, ha_env):
    with _patch_list_services(HA_NOTIFY_SERVICES) as mocked:
        response = await async_client.post(
            "/api/v1/notifications/",
            json={
                "name": "ntfy",
                "provider_type": "ntfy",
                "config": {"server": "https://ntfy.sh", "topic": "t", "service": "notify.nope"},
            },
        )

    assert response.status_code == 200
    mocked.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.unit
async def test_update_provider_rejects_nonexistent_service(async_client, notification_provider_factory, ha_env):
    provider = await notification_provider_factory(provider_type="homeassistant", config=json.dumps(GOOD_SERVICE))

    with _patch_list_services(HA_NOTIFY_SERVICES):
        response = await async_client.patch(
            f"/api/v1/notifications/{provider.id}",
            json={"config": BAD_SERVICE},
        )

    assert response.status_code == 400
    assert "Home Assistant has no service 'notify.iphone_von_jan'" in response.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.unit
async def test_validate_skips_when_no_service_configured(ha_env):
    """The default (persistent_notification.create) needs no lookup."""
    service = NotificationService()

    with _patch_list_services(HA_NOTIFY_SERVICES) as mocked:
        assert await service.validate_homeassistant_config({}) is None
        assert await service.validate_homeassistant_config(None) is None

    mocked.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.unit
async def test_validate_allows_save_when_ha_unconfigured(monkeypatch):
    monkeypatch.delenv("HA_URL", raising=False)
    monkeypatch.delenv("HA_TOKEN", raising=False)
    service = NotificationService()

    with _patch_list_services(HA_NOTIFY_SERVICES) as mocked:
        assert await service.validate_homeassistant_config(BAD_SERVICE) is None

    mocked.assert_not_called()
