"""The laptop's half of AgentX licensing: remember, re-evaluate, refuse.

Everything runs against a real record on disk under a temporary home, with a
fixed clock passed in, and — where the service is involved — an
``httpx.MockTransport`` standing in for it. Two contracts are under test above
all others: an outage never locks anybody (and never unlocks them either), and
a boundary the service named takes effect on time even when nobody can ask it
again.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from hermes_cli import account_license
from hermes_cli.account_license import (
    LICENSE_FILENAME,
    READ_ONLY_CODE,
    KnownLicense,
    current_license,
    dispatch_blocked,
    effective_access,
    evaluate,
    forget_license,
    format_day,
    license_behind_gateway_refusal,
    license_path,
    read_known_license,
    read_only_license,
    read_only_message,
    refresh_license,
    remember_license,
    turn_refusal,
)

ICT = timezone(timedelta(hours=7))
BRAIN_URL = "https://brain.test"
DEVICE = "8f2b1c3d-0000-4000-8000-000000000001"


def _at(day: str, time: str = "00:00:00") -> datetime:
    """A moment in the company's time zone (Asia/Ho_Chi_Minh)."""
    return datetime.fromisoformat(f"{day}T{time}+07:00")


def _license(**overrides) -> dict:
    """An enforced plan running 15/10/2026–31/12/2026 with 7 days of grace,
    as the service reports it on 03/12/2026 (active, 29 days left)."""
    body = {
        "state": "active",
        "access": "full",
        "enforced": True,
        "notice": None,
        "plan": {"slug": "pilot-2026", "name": "Pilot nội bộ 2026"},
        "products": ["workmate", "webmate", "chat"],
        "starts_at": "2026-10-15T00:00:00+07:00",
        "ends_at": "2027-01-01T00:00:00+07:00",
        "grace_until": "2027-01-08T00:00:00+07:00",
        "starts_on": "2026-10-15",
        "last_day": "2026-12-31",
        "read_only_from": "2027-01-08",
        "revoked_at": None,
        "days_left": 29,
        "reminder": None,
        "warn_days": [14, 7, 1],
        "contact": "it@astralx.com.vn",
        "server_time": "2026-12-03T09:00:00+07:00",
    }
    body.update(overrides)
    return body


@pytest.fixture
def home(tmp_path) -> Path:
    path = tmp_path / "accounts" / "kien"
    path.mkdir(parents=True)
    return path


# ---------------------------------------------------------------------------
# Re-evaluating a license at a moment
# ---------------------------------------------------------------------------


class TestEvaluate:
    def test_the_answer_at_the_moment_the_service_gave_it_is_the_services(self):
        result = evaluate(_license(), _at("2026-12-03", "09:00:00"))

        assert result["state"] == "active"
        assert result["access"] == "full"
        assert result["days_left"] == 29
        assert result["reminder"] is None
        assert result["notice"] is None

    def test_a_scheduled_plan_becomes_active_when_it_starts(self):
        scheduled = _license(state="scheduled", access="read_only", notice="read_only",
                             server_time="2026-10-14T08:00:00+07:00")

        before = evaluate(scheduled, _at("2026-10-14", "23:59:59"))
        after = evaluate(scheduled, _at("2026-10-15"))

        assert (before["state"], before["access"], before["notice"]) == ("scheduled", "read_only", "read_only")
        assert (after["state"], after["access"], after["notice"]) == ("active", "full", None)
        assert after["days_left"] == 78

    def test_an_active_plan_enters_grace_when_it_ends(self):
        last_moment = evaluate(_license(), _at("2026-12-31", "23:59:59"))
        ended = evaluate(_license(), _at("2027-01-01"))

        # Still the last covered day: one day left, the last reminder.
        assert (last_moment["state"], last_moment["days_left"], last_moment["reminder"]) == ("active", 1, 1)
        assert last_moment["notice"] == "expiring"
        # The day after: normal use, with a warning, for the grace period.
        assert (ended["state"], ended["access"], ended["notice"]) == ("grace", "full", "grace")
        assert ended["days_left"] == 7
        assert ended["reminder"] is None

    def test_grace_ends_in_read_only(self):
        grace = _license(state="grace", notice="grace", server_time="2027-01-03T09:00:00+07:00")

        still = evaluate(grace, _at("2027-01-07", "23:59:59"))
        over = evaluate(grace, _at("2027-01-08"))

        assert (still["state"], still["access"], still["days_left"]) == ("grace", "full", 1)
        assert (over["state"], over["access"], over["notice"]) == ("expired", "read_only", "read_only")
        assert over["days_left"] is None

    def test_a_plan_with_no_grace_goes_straight_to_read_only(self):
        no_grace = _license(grace_until="2027-01-01T00:00:00+07:00", read_only_from="2027-01-01")

        result = evaluate(no_grace, _at("2027-01-01"))

        assert (result["state"], result["access"]) == ("expired", "read_only")

    def test_an_active_plan_left_far_behind_lands_in_expired(self):
        # A laptop that slept through the end of the plan AND its grace.
        result = evaluate(_license(), _at("2027-03-01"))

        assert (result["state"], result["access"]) == ("expired", "read_only")

    @pytest.mark.parametrize("state", ["none", "revoked"])
    def test_only_the_service_can_lift_none_or_revoked(self, state):
        stuck = _license(state=state, access="read_only", notice="read_only",
                         plan=None if state == "none" else {"slug": "p", "name": "P"})

        result = evaluate(stuck, _at("2026-11-01"))

        assert (result["state"], result["access"]) == (state, "read_only")

    def test_nothing_is_enforced_while_the_switch_is_off(self):
        unenforced = _license(enforced=False, state="expired", access="full", notice=None)

        result = evaluate(unenforced, _at("2027-02-01"))

        # The plan still reads as expired — Settings shows it — but nothing is
        # blocked and nothing is announced.
        assert result["state"] == "expired"
        assert result["access"] == "full"
        assert result["notice"] is None

    def test_an_unenforced_plan_is_never_reminded_about(self):
        result = evaluate(_license(enforced=False), _at("2026-12-30"))

        assert result["reminder"] == 7
        assert result["notice"] is None

    @pytest.mark.parametrize(
        "moment,days_left,reminder",
        [
            ("2026-12-16T12:00:00", 16, None),
            ("2026-12-17T12:00:00", 15, None),
            ("2026-12-18T00:00:00", 14, 14),
            ("2026-12-21T12:00:00", 11, 14),
            ("2026-12-25T00:00:00", 7, 7),
            ("2026-12-29T09:00:00", 3, 7),
            ("2026-12-31T09:00:00", 1, 1),
        ],
    )
    def test_the_reminder_is_the_smallest_threshold_not_yet_passed(self, moment, days_left, reminder):
        result = evaluate(_license(), datetime.fromisoformat(f"{moment}+07:00"))

        assert result["days_left"] == days_left
        assert result["reminder"] == reminder
        assert result["notice"] == ("expiring" if reminder else None)

    def test_the_thresholds_come_from_the_license(self):
        result = evaluate(_license(warn_days=[30]), _at("2026-12-11"))

        assert (result["days_left"], result["reminder"]) == (21, 30)

    def test_unusable_thresholds_fall_back_to_the_documented_ones(self):
        result = evaluate(_license(warn_days="soon"), _at("2026-12-25"))

        assert result["reminder"] == 7

    def test_the_input_is_left_alone(self):
        original = _license()
        snapshot = json.loads(json.dumps(original))

        evaluate(original, _at("2027-02-01"))

        assert original == snapshot


# ---------------------------------------------------------------------------
# The record
# ---------------------------------------------------------------------------


class TestRecord:
    def test_the_record_lives_in_the_account_home_by_default(self, monkeypatch, tmp_path):
        root = tmp_path / "root"
        account = root / "accounts" / "kien"
        account.mkdir(parents=True)
        monkeypatch.setenv("AGENTX_HOME", str(account / "profiles" / "work"))

        # A profile inside an account shares the person's license.
        assert license_path() == account / LICENSE_FILENAME

    def test_what_was_remembered_reads_back(self, home):
        received = _at("2026-12-03", "09:00:00")

        known = remember_license(_license(), home=home, now=received)

        again = read_known_license(home)
        assert again is not None
        assert again.license == known.license == _license()
        assert again.fetched_at == received
        assert again.clock_offset == 0.0

    def test_the_write_leaves_no_temporary_files_behind(self, home):
        remember_license(_license(), home=home)
        remember_license(_license(state="grace", notice="grace"), home=home)

        assert sorted(p.name for p in home.iterdir()) == [LICENSE_FILENAME]
        assert read_known_license(home).license["state"] == "grace"

    def test_something_that_is_not_a_license_is_never_written(self, home):
        remember_license(_license(state="revoked", access="read_only"), home=home)

        for junk in (None, "expired", {}, {"state": "dormant", "access": "full"}, {"state": "active"}):
            assert remember_license(junk, home=home) is None

        # What an earlier answer said still stands.
        assert read_known_license(home).license["state"] == "revoked"

    @pytest.mark.parametrize(
        "content",
        ["", "{", "null", "[]", '{"license": {"state": "active"}}', '{"license": 5, "fetched_at": "x"}'],
    )
    def test_an_unreadable_record_is_unknown_and_unknown_is_full_access(self, home, content):
        (home / LICENSE_FILENAME).write_text(content, encoding="utf-8")

        assert read_known_license(home) is None
        assert effective_access(home=home) == "full"

    def test_a_record_that_cannot_be_written_costs_nothing(self, home, monkeypatch):
        import utils

        def _full_disk(*_args, **_kwargs):
            raise OSError(28, "No space left on device")

        monkeypatch.setattr(utils, "atomic_json_write", _full_disk)

        known = remember_license(_license(), home=home)

        assert known is not None and known.license["state"] == "active"
        assert read_known_license(home) is None

    def test_forgetting(self, home):
        remember_license(_license(), home=home)

        assert forget_license(home) is True
        assert forget_license(home) is False
        assert current_license(home=home) is None

    def test_two_accounts_keep_two_records(self, tmp_path):
        kien, lan = tmp_path / "accounts" / "kien", tmp_path / "accounts" / "lan"
        kien.mkdir(parents=True)
        lan.mkdir(parents=True)

        remember_license(_license(state="revoked", access="read_only"), home=kien)

        assert effective_access(home=kien) == "read_only"
        assert effective_access(home=lan) == "full"


class TestTheServicesClock:
    def test_a_machine_whose_clock_is_wrong_still_expires_on_time(self, home):
        # The laptop is a whole day slow: the service said 09:00 on the 3rd
        # while the laptop read 09:00 on the 2nd.
        remember_license(
            _license(state="grace", notice="grace", server_time="2027-01-03T09:00:00+07:00"),
            home=home,
            now=_at("2027-01-02", "09:00:00"),
        )

        # 00:30 on the 7th by the laptop is 00:30 on the 8th by the service:
        # the grace period is over, whatever this machine believes.
        assert effective_access(_at("2027-01-07", "00:30:00"), home=home) == "read_only"
        assert effective_access(_at("2027-01-06", "23:30:00"), home=home) == "full"

    def test_winding_the_clock_back_does_not_walk_a_plan_back(self, home):
        remember_license(
            _license(state="expired", access="read_only", notice="read_only",
                     server_time="2027-01-09T09:00:00+07:00"),
            home=home,
            now=_at("2027-01-09", "09:00:00"),
        )
        known = read_known_license(home)

        wound_back = _at("2026-11-01")

        assert known.service_now(wound_back) == _at("2027-01-09", "09:00:00")
        assert effective_access(wound_back, home=home) == "read_only"

    def test_a_license_with_no_server_time_runs_on_the_local_clock(self):
        known = KnownLicense(license=_license(server_time=None), fetched_at=_at("2026-12-03"))

        assert known.service_now(_at("2026-12-05")) == _at("2026-12-05")


class TestEffectiveAccess:
    def test_no_record_is_full_access(self, home):
        assert effective_access(home=home) == "full"

    def test_a_read_only_record_is_read_only(self, home):
        remember_license(_license(state="none", access="read_only", plan=None, notice="read_only"), home=home)

        assert effective_access(home=home) == "read_only"

    def test_grace_runs_out_with_no_network_at_all(self, home):
        received = _at("2027-01-03", "09:00:00")
        remember_license(
            _license(state="grace", notice="grace", server_time="2027-01-03T09:00:00+07:00"),
            home=home,
            now=received,
        )

        assert effective_access(_at("2027-01-07", "23:00:00"), home=home) == "full"
        assert effective_access(_at("2027-01-08", "00:00:01"), home=home) == "read_only"

    def test_a_plan_that_starts_unlocks_on_its_own(self, home):
        remember_license(
            _license(state="scheduled", access="read_only", notice="read_only",
                     server_time="2026-10-14T20:00:00+07:00"),
            home=home,
            now=_at("2026-10-14", "20:00:00"),
        )

        assert effective_access(_at("2026-10-14", "23:00:00"), home=home) == "read_only"
        assert effective_access(_at("2026-10-15", "00:00:01"), home=home) == "full"


# ---------------------------------------------------------------------------
# Asking the service
# ---------------------------------------------------------------------------


class _Service:
    """The keys service's license route, with the failures that matter."""

    def __init__(self) -> None:
        self.license: dict | None = _license()
        self.status = 200
        self.code = ""
        self.unreachable = False
        self.requests: list[httpx.Request] = []

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.unreachable:
            raise httpx.ConnectError("connection refused", request=request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": self.code, "detail": "no"})
        if request.url.path != "/v1/license":
            return httpx.Response(404, json={"error": "not_found", "detail": request.url.path})
        if self.license is None:
            return httpx.Response(404, json={"error": "not_found", "detail": "No route 'v1/license' here."})
        return httpx.Response(200, json={"license": self.license})


@pytest.fixture
def service() -> _Service:
    return _Service()


def _refresh(service: _Service, home: Path, **overrides):
    kwargs = {
        "bearer": "tok",
        "device_id": DEVICE,
        "device_name": "MacBook",
        "base_url": BRAIN_URL,
        "timeout": 5.0,
        "home": home,
        "now": _at("2026-12-03", "09:00:00"),
        "transport": service.transport,
        "sleep": lambda _seconds: None,
    }
    kwargs.update(overrides)
    return refresh_license(**kwargs)


class TestRefresh:
    def test_an_answer_is_recorded_and_returned(self, service, home):
        result = _refresh(service, home)

        assert result.ok
        assert result.status == "ok"
        assert result.license["state"] == "active"
        assert read_known_license(home).license == _license()
        sent = service.requests[-1]
        assert sent.headers["Authorization"] == "Bearer tok"
        assert sent.headers["X-AgentX-Device"] == DEVICE

    def test_a_service_that_predates_licensing_is_unknown_and_drops_the_record(self, service, home):
        remember_license(_license(state="revoked", access="read_only"), home=home)
        service.license = None

        result = _refresh(service, home)

        assert result.status == "unsupported"
        assert result.license is None
        assert read_known_license(home) is None
        assert effective_access(home=home) == "full"

    @pytest.mark.parametrize(
        "status,code,expected",
        [
            (503, "store_unavailable", "offline"),
            (500, "", "offline"),
            (401, "invalid_token", "unauthorized"),
            (403, "device_revoked", "revoked"),
            (403, "client_not_allowed", "error"),
        ],
    )
    def test_a_refusal_or_an_outage_keeps_the_last_license(self, service, home, status, code, expected):
        remember_license(
            _license(state="expired", access="read_only", notice="read_only"),
            home=home,
            now=_at("2026-12-03", "09:00:00"),
        )
        service.status, service.code = status, code

        result = _refresh(service, home)

        assert result.status == expected
        assert result.license["state"] == "expired"
        assert read_known_license(home).license["state"] == "expired"

    def test_an_unreachable_service_with_nothing_known_is_full_access(self, service, home):
        service.unreachable = True

        result = _refresh(service, home)

        assert result.status == "offline"
        assert result.license is None
        assert effective_access(home=home) == "full"

    def test_an_answer_without_a_readable_license_changes_nothing(self, service, home):
        remember_license(_license(state="revoked", access="read_only"), home=home)
        service.license = {"state": "mystery"}

        result = _refresh(service, home)

        assert result.status == "error"
        assert read_known_license(home).license["state"] == "revoked"

    def test_nothing_is_asked_without_a_service_or_a_token(self, service, home):
        assert _refresh(service, home, base_url="").status == "unconfigured"
        assert _refresh(service, home, bearer="").status == "unauthorized"
        assert service.requests == []

    def test_a_backend_with_no_desktop_still_names_its_machine(self, service, home, monkeypatch):
        from hermes_cli import second_brain_client

        monkeypatch.setattr(
            second_brain_client, "install_device_identity", lambda: ("install-device", "build-box")
        )

        _refresh(service, home, device_id="", device_name="")

        assert service.requests[-1].headers["X-AgentX-Device"] == "install-device"
        assert service.requests[-1].headers["X-AgentX-Device-Name"] == "build-box"

    def test_the_configured_service_is_used_by_default(self, service, home, monkeypatch):
        from hermes_cli import account_provisioning

        monkeypatch.setattr(account_provisioning, "second_brain_service", lambda: (BRAIN_URL, 3.0))

        result = refresh_license(
            bearer="tok", device_id=DEVICE, home=home, transport=service.transport,
            sleep=lambda _s: None,
        )

        assert result.ok
        assert str(service.requests[-1].url) == f"{BRAIN_URL}/v1/license"


# ---------------------------------------------------------------------------
# Refusing a turn
# ---------------------------------------------------------------------------


class TestTurnGuard:
    def test_no_license_known_never_refuses(self, home):
        assert read_only_license(home=home) is None

    def test_full_access_never_refuses(self, home):
        remember_license(_license(), home=home, now=_at("2026-12-03", "09:00:00"))

        assert read_only_license(home=home, now=_at("2026-12-03", "10:00:00")) is None

    def test_read_only_names_the_license_that_refuses(self, home):
        remember_license(_license(state="revoked", access="read_only", notice="read_only"), home=home)

        refusing = read_only_license(home=home)

        assert refusing is not None and refusing["state"] == "revoked"

    def test_the_end_of_grace_refuses_without_asking_anybody(self, home):
        remember_license(
            _license(state="grace", notice="grace", server_time="2027-01-03T09:00:00+07:00"),
            home=home,
            now=_at("2027-01-03", "09:00:00"),
        )

        assert read_only_license(home=home, now=_at("2027-01-07", "12:00:00")) is None
        assert read_only_license(home=home, now=_at("2027-01-08", "00:00:00"))["state"] == "expired"

    def test_a_refused_turn_is_a_failed_result_every_surface_already_handles(self):
        history = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
        license = _license(state="revoked", access="read_only", notice="read_only")

        result = turn_refusal(license, history)

        assert result["failed"] is True
        assert result["completed"] is False
        assert result["failure_reason"] == READ_ONLY_CODE == "license_read_only"
        assert result["license"] == license
        assert result["final_response"] == result["error"] == read_only_message(license)
        assert result["api_calls"] == 0
        # Adopted as the new history by the desktop's chat: nothing lost.
        assert result["messages"] == history
        assert result["messages"] is not history


class TestDispatchGate:
    def test_it_blocks_while_read_only_and_says_so_once(self, home, monkeypatch, caplog):
        import logging

        monkeypatch.setenv("AGENTX_HOME", str(home))
        log = logging.getLogger("test.dispatch")
        remember_license(_license(state="revoked", access="read_only", notice="read_only"))

        with caplog.at_level(logging.INFO, logger="test.dispatch"):
            assert dispatch_blocked("cron-test", log) is True
            assert dispatch_blocked("cron-test", log) is True
            forget_license()
            assert dispatch_blocked("cron-test", log) is False
            assert dispatch_blocked("cron-test", log) is False

        lines = [r.getMessage() for r in caplog.records if r.name == "test.dispatch"]
        assert len(lines) == 2
        assert "read-only" in lines[0]
        assert "again" in lines[1]

    def test_no_license_never_blocks(self, home, monkeypatch):
        import logging

        monkeypatch.setenv("AGENTX_HOME", str(home))

        assert dispatch_blocked("cron-test-2", logging.getLogger("test.dispatch")) is False


class TestGatewayRefusal:
    """A 401/403 from the AgentX AI Gateway mid-turn may be the SSO locking the person."""

    PROXY = "https://aigw.test"

    @pytest.fixture
    def account(self, home, monkeypatch):
        from hermes_cli.account_provisioning import write_state

        monkeypatch.setenv("AGENTX_HOME", str(home))
        write_state(home, {"base_url": self.PROXY, "mode": "second_brain"})
        return home

    @pytest.fixture
    def no_bearer(self, monkeypatch):
        from hermes_cli import sync_engine

        monkeypatch.setattr(sync_engine.mailbox(), "current", lambda: None)

    def test_another_provider_is_not_the_licenses_business(self, account, no_bearer):
        remember_license(_license(state="revoked", access="read_only"))

        assert license_behind_gateway_refusal("https://api.openai.com/v1") is None

    def test_without_a_bearer_the_record_decides(self, account, no_bearer):
        assert license_behind_gateway_refusal(f"{self.PROXY}/v1") is None

        remember_license(_license(state="revoked", access="read_only"))

        assert license_behind_gateway_refusal(f"{self.PROXY}/v1/")["state"] == "revoked"

    def test_with_a_bearer_the_service_is_asked_first(self, account, monkeypatch):
        from hermes_cli import account_provisioning, sync_engine
        from hermes_cli.sync_engine import SyncCredentials

        service = _Service()
        service.license = _license(state="revoked", access="read_only", notice="read_only")
        asked: list[dict] = []
        real_refresh = account_license.refresh_license

        def _refresh(**kwargs):
            asked.append(kwargs)
            return real_refresh(**kwargs, transport=service.transport, sleep=lambda _s: None)

        monkeypatch.setattr(account_license, "refresh_license", _refresh)
        monkeypatch.setattr(account_provisioning, "second_brain_service", lambda: (BRAIN_URL, 15.0))
        monkeypatch.setattr(
            sync_engine.mailbox(),
            "current",
            lambda: SyncCredentials(bearer="tok-live", device_id=DEVICE, device_name="MacBook"),
        )

        # Nothing was known before the gateway refused; the service says revoked.
        refusing = license_behind_gateway_refusal(self.PROXY.upper())

        assert refusing is not None and refusing["state"] == "revoked"
        assert asked[0]["bearer"] == "tok-live"
        assert asked[0]["timeout"] <= 5.0
        assert service.requests[-1].headers["Authorization"] == "Bearer tok-live"

    def test_an_install_with_no_account_key_is_never_matched(self, home, monkeypatch, no_bearer):
        monkeypatch.setenv("AGENTX_HOME", str(home))
        remember_license(_license(state="revoked", access="read_only"))

        assert license_behind_gateway_refusal(f"{self.PROXY}/v1") is None


class TestMessages:
    @pytest.mark.parametrize(
        "license,expected",
        [
            (
                {"state": "none", "plan": None},
                "Tài khoản chưa được cấp giấy phép AgentX.",
            ),
            (
                {"state": "scheduled", "starts_on": "2026-10-15"},
                "Gói Pilot nội bộ 2026 bắt đầu từ ngày 15/10/2026.",
            ),
            (
                {"state": "expired"},
                "Gói Pilot nội bộ 2026 đã hết hạn ngày 31/12/2026. Workmate đang ở chế độ chỉ xem.",
            ),
            (
                {"state": "revoked"},
                "Giấy phép AgentX của bạn đã bị thu hồi. Workmate đang ở chế độ chỉ xem.",
            ),
        ],
    )
    def test_each_reason_in_vietnamese(self, license, expected):
        body = _license(access="read_only", contact="", **license)

        assert read_only_message(body, lang="vi") == expected

    def test_the_contact_is_appended_when_there_is_one(self):
        body = _license(state="revoked", access="read_only")

        assert read_only_message(body, lang="vi").endswith(
            "Liên hệ it@astralx.com.vn để được cấp lại hoặc gia hạn."
        )
        assert read_only_message(body, lang="en") == (
            "Your AgentX license has been revoked. Workmate is in read-only mode. "
            "Contact it@astralx.com.vn to get a license or renew it."
        )

    def test_english_dates_read_naturally(self):
        body = _license(state="expired", access="read_only", contact="")

        assert read_only_message(body, lang="en") == (
            "Your Pilot nội bộ 2026 plan expired on Dec 31, 2026. Workmate is in read-only mode."
        )

    def test_a_reason_missing_its_facts_falls_back_to_the_general_one(self):
        body = _license(state="expired", access="read_only", contact="", last_day=None)

        assert read_only_message(body, lang="en") == (
            "Your AgentX license does not cover AI right now. Workmate is in read-only mode."
        )

    @pytest.mark.parametrize(
        "day,lang,expected",
        [
            ("2026-12-31", "vi", "31/12/2026"),
            ("2027-01-08", "vi", "08/01/2027"),
            ("2027-01-08", "en", "Jan 8, 2027"),
            ("2027-01-08", "ja", "2027-01-08"),
            ("", "vi", ""),
            (None, "en", ""),
            ("31/12/2026", "vi", ""),
        ],
    )
    def test_days_are_written_the_way_each_language_writes_them(self, day, lang, expected):
        assert format_day(day, lang) == expected


def test_the_module_never_reaches_the_network_on_import():
    # Reading the license happens on every turn; it must stay a file read.
    assert not hasattr(account_license, "httpx")
