"""Scheduled runs reach the SSO usage metrics (cron/usage_outbox.py).

Each run that started leaves exactly one ``cron.run`` event file for the desktop
to send (apps/desktop/electron/cron-usage-outbox.ts), with the run's outcome and a
stable failure code, and nothing of what the run said.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import cron.scheduler as s
from cron import usage_outbox

#: The file the desktop's tests read too: one shape on both sides.
FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "desktop"
    / "electron"
    / "cron-usage-event.fixture.json"
)
UUID_NAME = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$"
)


def _events(home: Path) -> list[dict]:
    directory = usage_outbox.outbox_dir(home)
    if not directory.exists():
        return []
    return [
        json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(directory.iterdir())
        if p.suffix == ".json"
    ]


# ── The file ──────────────────────────────────────────────────────────────────


class TestRecordFire:
    def test_a_success_is_one_file_named_by_its_event(self, tmp_path):
        execution = uuid.uuid4().hex
        moment = datetime(2026, 11, 15, 14, 8, 3, 456789, tzinfo=timezone.utc)

        path = usage_outbox.record_fire(
            tmp_path, execution, success=True, duration_ms=1234.6, now=moment
        )

        assert path is not None and UUID_NAME.match(path.name)
        assert json.loads(path.read_text(encoding="utf-8")) == {
            "event_id": str(uuid.UUID(execution)),
            "occurred_at": "2026-11-15T14:08:03.456Z",
            "feature": "cron.run",
            "outcome": "success",
            "duration_ms": 1235,
        }
        assert sorted(p.name for p in path.parent.iterdir()) == [
            path.name
        ]  # no temporary left

    def test_a_failure_carries_its_code_and_a_bad_one_falls_back(self, tmp_path):
        usage_outbox.record_fire(
            tmp_path, "a" * 32, success=False, duration_ms=5, error_code="rate_limited"
        )
        usage_outbox.record_fire(
            tmp_path,
            "b" * 32,
            success=False,
            duration_ms=5,
            error_code="no spaces allowed",
        )
        usage_outbox.record_fire(tmp_path, "c" * 32, success=False, duration_ms=5)

        codes = {e["event_id"][0]: e.get("error_code") for e in _events(tmp_path)}
        assert codes == {
            "a": "rate_limited",
            "b": "operation_failed",
            "c": "operation_failed",
        }

    def test_a_success_never_carries_a_code(self, tmp_path):
        usage_outbox.record_fire(
            tmp_path, "d" * 32, success=True, duration_ms=1, error_code="timeout"
        )
        assert "error_code" not in _events(tmp_path)[0]

    def test_the_duration_stays_in_the_consoles_range(self, tmp_path):
        usage_outbox.record_fire(tmp_path, "e" * 32, success=True, duration_ms=-40)
        usage_outbox.record_fire(tmp_path, "f" * 32, success=True, duration_ms=9e9)
        assert sorted(e["duration_ms"] for e in _events(tmp_path)) == [0, 3_600_000]

    def test_the_same_run_written_twice_is_one_event(self, tmp_path):
        execution = uuid.uuid4().hex
        usage_outbox.record_fire(tmp_path, execution, success=False, duration_ms=1)
        usage_outbox.record_fire(tmp_path, execution, success=False, duration_ms=2)
        assert [e["duration_ms"] for e in _events(tmp_path)] == [2]

    def test_an_id_that_is_no_uuid_still_gets_a_stable_one(self):
        first = usage_outbox.event_id_for("exec-3")
        assert (
            first
            == usage_outbox.event_id_for("exec-3")
            != usage_outbox.event_id_for("exec-4")
        )
        assert str(uuid.UUID(first)) == first

    def test_what_the_console_would_refuse_is_pruned(self, tmp_path):
        directory = usage_outbox.outbox_dir(tmp_path)
        directory.mkdir(parents=True)
        stale, stale_tmp, fresh_tmp = (
            directory / f"{uuid.uuid4()}.json",
            directory / ".x.tmp",
            directory / ".y.tmp",
        )
        for path in (stale, stale_tmp, fresh_tmp):
            path.write_text("{}", encoding="utf-8")
        eight_days = time.time() - 8 * 86400
        os.utime(stale, (eight_days, eight_days))
        os.utime(stale_tmp, (eight_days, eight_days))
        unrelated = directory / "notes.txt"
        unrelated.write_text("kept", encoding="utf-8")

        usage_outbox.record_fire(
            tmp_path, uuid.uuid4().hex, success=True, duration_ms=1
        )

        assert not stale.exists() and not stale_tmp.exists()
        assert fresh_tmp.exists(), "a file being written right now is not touched"
        assert unrelated.exists()
        assert len(_events(tmp_path)) == 1

    def test_at_most_max_pending_wait_and_the_oldest_go(self, tmp_path, monkeypatch):
        monkeypatch.setattr(usage_outbox, "MAX_PENDING", 3)
        directory = usage_outbox.outbox_dir(tmp_path)
        directory.mkdir(parents=True)
        names = []
        for age in (40, 30, 20):
            path = directory / f"{uuid.uuid4()}.json"
            path.write_text("{}", encoding="utf-8")
            moment = time.time() - age
            os.utime(path, (moment, moment))
            names.append(path.name)

        newest = usage_outbox.record_fire(
            tmp_path, uuid.uuid4().hex, success=True, duration_ms=1
        )

        assert newest is not None
        assert sorted(p.name for p in directory.iterdir()) == sorted([
            names[1],
            names[2],
            newest.name,
        ])

    def test_it_never_raises(self, tmp_path, caplog):
        blocked = tmp_path / "home-is-a-file"
        blocked.write_text("", encoding="utf-8")

        assert (
            usage_outbox.record_fire(blocked, "x", success=True, duration_ms=1) is None
        )
        assert "cron usage event not queued" in caplog.text

    def test_the_file_matches_the_desktops_fixture(self, tmp_path):
        """The desktop's tests read this fixture; a change of shape here must show there."""
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        path = usage_outbox.record_fire(
            tmp_path,
            fixture["event_id"].replace("-", ""),
            success=False,
            duration_ms=fixture["duration_ms"],
            error_code=fixture["error_code"],
            now=datetime.fromisoformat(fixture["occurred_at"].replace("Z", "+00:00")),
        )
        assert path is not None
        assert json.loads(path.read_text(encoding="utf-8")) == fixture
        assert (
            usage_outbox.OUTBOX_DIR.as_posix() == "cron/usage-outbox"
        )  # OUTBOX_DIR in cron-usage-outbox.ts


# ── The code ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("error", "agent_run", "code"),
    [
        ("[failure_reason:rate_limit] HTTP 429", True, "rate_limited"),
        ("[failure_reason:billing] spent", True, "quota_exceeded"),
        ("[failure_reason:billing_unverified] 402", True, "bad_request"),
        ("[failure_reason:auth] 401 from gateway", True, "auth_failed"),
        (
            "[failure_reason:session_persistence_failed] disk full",
            True,
            "session_save_failed",
        ),
        ("[failure_reason:interpreter_shutdown] gone", True, "app_shutdown"),
        ("[failure_reason:something_new] x", True, "operation_failed"),
        ("[drift_skip] the model changed", True, "config_drift"),
        ("[drift_skip:silent] the model changed", True, "config_drift"),
        ("[blocked_config] no provider", True, "invalid_config"),
        ("[blocked_config:silent] no provider", True, "invalid_config"),
        (
            "Interrupted by gateway shutdown before the run finished",
            True,
            "app_shutdown",
        ),
        ("idle for 600s (limit 600s)", True, "timeout"),
        ("Script timed out after 120s", False, "timeout"),
        ("Traceback: the script printed HTTP 400", False, "script_failed"),
        ("HTTP 429 Too Many Requests", True, "rate_limited"),
        ("", True, "operation_failed"),
        (None, True, "operation_failed"),
    ],
)
def test_a_failed_run_is_named_in_the_shared_words(error, agent_run, code):
    assert s.cron_usage_failure_code(error, agent_run=agent_run) == code


def test_every_failure_kind_has_a_code_the_console_takes():
    shape = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$")
    assert set(s._KIND_USAGE_CODES) == set(s.CRON_FAILURE_KINDS)
    assert all(shape.match(code) for code in s._KIND_USAGE_CODES.values())


def test_naming_a_failure_never_raises(monkeypatch):
    def broken(*_a, **_k):
        raise RuntimeError("classifier bug")

    monkeypatch.setattr(s, "classify_cron_failure", broken)
    assert s.cron_usage_failure_code("anything") == "operation_failed"


# ── One event per run, through the real firing body ──────────────────────────


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(s, "_get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(
        s, "save_job_output", lambda jid, out: str(tmp_path / f"{jid}.md")
    )
    monkeypatch.setattr(s, "_deliver_result", lambda *a, **k: None)
    monkeypatch.setattr(s, "mark_job_run", lambda *a, **k: None)
    monkeypatch.setattr(s, "claim_dispatch", lambda job_id: True)
    return tmp_path


def _run(monkeypatch, job, *, result=None, raises=None):
    def fake_run_job(job, *, defer_agent_teardown=None):
        if raises is not None:
            raise raises
        return result

    monkeypatch.setattr(s, "run_job", fake_run_job)
    return s.run_one_job(job)


def test_a_run_that_answered_is_one_success(home, monkeypatch):
    job = {"id": "j1", "name": "Báo cáo sáng", "execution_id": uuid.uuid4().hex}

    assert (
        _run(monkeypatch, job, result=(True, "# out", "Đây là báo cáo", None)) is True
    )

    (event,) = _events(home)
    assert event["event_id"] == str(uuid.UUID(job["execution_id"]))
    assert event["outcome"] == "success" and event["feature"] == "cron.run"
    assert "Báo cáo" not in json.dumps(event, ensure_ascii=False), (
        "nothing the run said is kept"
    )


def test_a_silent_run_is_a_success(home, monkeypatch):
    _run(
        monkeypatch, {"id": "j2", "name": "t"}, result=(True, "# out", "[SILENT]", None)
    )
    assert [e["outcome"] for e in _events(home)] == ["success"]


def test_a_failed_run_carries_the_agents_reason(home, monkeypatch):
    error = "[failure_reason:rate_limit] RuntimeError: HTTP 429 from aigw"
    _run(monkeypatch, {"id": "j3", "name": "t"}, result=(False, "# out", "", error))

    (event,) = _events(home)
    assert (event["outcome"], event["error_code"]) == ("failure", "rate_limited")
    assert "aigw" not in json.dumps(event)


def test_an_empty_answer_is_an_empty_response(home, monkeypatch):
    _run(monkeypatch, {"id": "j4", "name": "t"}, result=(True, "# out", "   ", None))
    assert [(e["outcome"], e.get("error_code")) for e in _events(home)] == [
        ("failure", "empty_response")
    ]


def test_a_script_only_job_that_failed_is_script_failed(home, monkeypatch):
    job = {"id": "j5", "name": "t", "no_agent": True}
    _run(
        monkeypatch,
        job,
        result=(False, "", "", "exit 2: could not reach http://intranet (HTTP 400)"),
    )
    assert [e.get("error_code") for e in _events(home)] == ["script_failed"]


def test_a_run_whose_claim_was_refused_is_no_run(home, monkeypatch):
    monkeypatch.setattr(s, "claim_dispatch", lambda job_id: False)
    assert (
        _run(monkeypatch, {"id": "j6", "name": "t"}, result=(True, "", "x", None))
        is True
    )
    assert _events(home) == []


def test_a_run_that_raised_is_one_failure(home, monkeypatch):
    assert (
        _run(monkeypatch, {"id": "j7", "name": "t"}, raises=RuntimeError("boom"))
        is False
    )
    assert [(e["outcome"], e.get("error_code")) for e in _events(home)] == [
        ("failure", "operation_failed")
    ]


def test_a_run_the_process_went_down_under_is_app_shutdown(home, monkeypatch):
    with pytest.raises(KeyboardInterrupt):
        _run(monkeypatch, {"id": "j8", "name": "t"}, raises=KeyboardInterrupt())
    assert [e.get("error_code") for e in _events(home)] == ["app_shutdown"]


def test_each_run_of_a_job_is_its_own_event(home, monkeypatch):
    for _ in range(3):
        _run(monkeypatch, {"id": "j9", "name": "t"}, result=(True, "", "ok", None))
    events = _events(home)
    assert len(events) == 3 and len({e["event_id"] for e in events}) == 3


def test_a_metrics_failure_never_changes_the_run(home, monkeypatch):
    def broken(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(s, "_record_cron_usage", broken)
    marks = []
    monkeypatch.setattr(s, "mark_job_run", lambda *a, **k: marks.append(a))

    assert (
        _run(monkeypatch, {"id": "j10", "name": "t"}, result=(True, "", "ok", None))
        is True
    )
    assert marks == [("j10", True, None)]


def test_the_event_is_written_in_the_runs_own_home(tmp_path, monkeypatch):
    """Profiles and Bot Mode assistants each keep their own store: a run's event goes beside it."""
    assistant = tmp_path / "accounts" / "u-abc" / "profiles" / "tro-ly"
    monkeypatch.setattr(s, "_get_hermes_home", lambda: assistant)
    monkeypatch.setattr(s, "save_job_output", lambda jid, out: "")
    monkeypatch.setattr(s, "_deliver_result", lambda *a, **k: None)
    monkeypatch.setattr(s, "mark_job_run", lambda *a, **k: None)
    monkeypatch.setattr(s, "claim_dispatch", lambda job_id: True)

    _run(monkeypatch, {"id": "j11", "name": "t"}, result=(True, "", "ok", None))

    assert len(_events(assistant)) == 1


def test_occurred_at_is_when_the_run_ended(home, monkeypatch):
    before = datetime.now(timezone.utc) - timedelta(seconds=1)
    _run(monkeypatch, {"id": "j12", "name": "t"}, result=(True, "", "ok", None))
    (event,) = _events(home)
    moment = datetime.fromisoformat(event["occurred_at"].replace("Z", "+00:00"))
    assert before <= moment <= datetime.now(timezone.utc) + timedelta(seconds=1)
