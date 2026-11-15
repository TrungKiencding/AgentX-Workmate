"""Characterization + unit tests for the `run_one_job` shared helper (Phase 4A).

`tick`'s per-job body (`_process_job`) is the execute → save → deliver → mark
sequence that fires ONE due job. Phase 4A extracts it into a module-level
`run_one_job(job, *, adapters=None, loop=None, verbose=False)` so the external
Chronos provider's `fire_due` can reuse the IDENTICAL body — no duplicated
correctness.

The first test characterizes the sequence as driven through `tick()` (proving
the extraction didn't change `tick`'s behavior); the rest unit-test the
extracted helper directly.
"""
import cron.scheduler as s


def _patch_pipeline(monkeypatch, *, success=True, output="out", final="final response",
                    error=None, silent_marker_in=None):
    """Patch the job pipeline primitives and record the call order."""
    calls = []

    def fake_run_job(job, *, defer_agent_teardown=None):
        calls.append(("run_job", job["id"]))
        fr = final if silent_marker_in is None else silent_marker_in
        return (success, output, fr, error)

    def fake_save(jid, out):
        calls.append(("save", jid))
        return f"/tmp/{jid}.txt"

    def fake_deliver(job, content, adapters=None, loop=None):
        calls.append(("deliver", job["id"]))
        return None

    def fake_mark(jid, ok, err=None, delivery_error=None, **_kw):
        calls.append(("mark", jid, ok))

    monkeypatch.setattr(s, "run_job", fake_run_job)
    monkeypatch.setattr(s, "save_job_output", fake_save)
    monkeypatch.setattr(s, "_deliver_result", fake_deliver)
    monkeypatch.setattr(s, "mark_job_run", fake_mark)
    return calls


def test_tick_process_job_sequence(monkeypatch):
    """Characterization: a single due job driven through tick() runs the
    sequence run_job → save → deliver → mark, in that order."""
    calls = _patch_pipeline(monkeypatch)
    monkeypatch.setattr(s, "get_due_jobs", lambda: [{"id": "j1", "name": "t"}])
    monkeypatch.setattr(s, "advance_next_runs", lambda ids: 1)

    s.tick(verbose=False, sync=True)

    assert [c[0] for c in calls] == ["run_job", "save", "deliver", "mark"]
    assert calls[-1] == ("mark", "j1", True)


def test_run_one_job_success_sequence(monkeypatch):
    """The extracted helper runs the same execute→save→deliver→mark sequence
    for a successful job."""
    calls = _patch_pipeline(monkeypatch)

    ok = s.run_one_job({"id": "j2", "name": "t"})

    assert ok is True
    assert [c[0] for c in calls] == ["run_job", "save", "deliver", "mark"]
    assert calls[-1] == ("mark", "j2", True)


def test_run_one_job_installs_secret_scope_under_multiplex(monkeypatch, tmp_path):
    """Regression: under profile isolation (multiplex active), run_one_job must
    execute run_job inside a profile secret scope so credential reads
    (resolve_runtime_provider -> get_secret) don't fail-close with
    UnscopedSecretError, and must tear the scope down afterward.

    Behavior contract: a scope is present during run_job and absent after,
    regardless of the concrete secret values.
    """
    from agent import secret_scope as ss

    # Point cron's home resolution at a profile whose .env carries a secret.
    (tmp_path / ".env").write_text("OPENROUTER_BASE_URL=https://openrouter.ai/api/v1\n")
    monkeypatch.setattr(s, "_get_hermes_home", lambda: tmp_path)

    scope_during_run = {}

    def fake_run_job(job, *, defer_agent_teardown=None):
        # This is where resolve_runtime_provider() would read a secret. Prove a
        # scope is installed and the profile's secret resolves without raising.
        scope_during_run["scope"] = ss.current_secret_scope()
        scope_during_run["base_url"] = ss.get_secret("OPENROUTER_BASE_URL")
        return (True, "out", "final", None)

    monkeypatch.setattr(s, "run_job", fake_run_job)
    monkeypatch.setattr(s, "save_job_output", lambda jid, out: f"/tmp/{jid}.txt")
    monkeypatch.setattr(s, "_deliver_result", lambda *a, **k: None)
    monkeypatch.setattr(s, "mark_job_run", lambda *a, **k: None)

    ss.set_multiplex_active(True)
    try:
        ok = s.run_one_job({"id": "j7", "name": "t"})
    finally:
        ss.set_multiplex_active(False)

    assert ok is True
    # Scope was installed during run_job and the profile secret resolved.
    assert scope_during_run["scope"] is not None
    assert scope_during_run["base_url"] == "https://openrouter.ai/api/v1"
    # And it was torn down after run_one_job returned (no leak).
    assert ss.current_secret_scope() is None




# ---------------------------------------------------------------------------
# A run's words reach the job record (desktop reminder bug, 2026-11)
#
# A reminder created from a desktop chat is stored with deliver="origin" and
# no origin: there is no chat to deliver into, so the scheduler skipped
# delivery and the only trace of the run was a status. The desktop announces
# runs off the job list, so the record itself has to carry a short excerpt.
# ---------------------------------------------------------------------------


def _patch_pipeline_capturing_mark(monkeypatch, *, success=True, final="final response", error=None):
    marks = []

    monkeypatch.setattr(
        s, "run_job",
        lambda job, *, defer_agent_teardown=None: (success, "# output", final, error),
    )
    monkeypatch.setattr(s, "save_job_output", lambda jid, out: f"/tmp/{jid}.txt")
    monkeypatch.setattr(s, "_deliver_result", lambda *a, **k: None)
    monkeypatch.setattr(s, "mark_job_run", lambda *a, **k: marks.append((a, k)))
    return marks


def test_run_one_job_records_a_preview_of_the_response(monkeypatch):
    marks = _patch_pipeline_capturing_mark(
        monkeypatch,
        final="## ⏰ Nhắc việc\n\n**20:30 rồi** — đến giờ `họp nhóm` dự án.\n\n- Xem [tài liệu](https://example.com/doc)\n",
    )

    assert s.run_one_job({"id": "r1", "name": "Nhắc họp", "deliver": "origin", "origin": None}) is True

    (_args, kwargs), = marks
    preview = kwargs["output_preview"]
    assert preview.startswith("⏰ Nhắc việc 20:30 rồi — đến giờ họp nhóm dự án.")
    # Plain text on one line: no markdown markup, no URL of a labelled link.
    for markup in ("#", "*", "`", "\n", "](", "https://"):
        assert markup not in preview
    assert "tài liệu" in preview


def test_run_one_job_preview_is_short_and_redacted(monkeypatch):
    from cron.jobs import OUTPUT_PREVIEW_MAX_CHARS

    secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD"
    marks = _patch_pipeline_capturing_mark(
        monkeypatch, final=f"Khoá mới là {secret}. " + "Chi tiết dài dòng. " * 200,
    )

    s.run_one_job({"id": "r2", "name": "t"})

    preview = marks[0][1]["output_preview"]
    assert secret not in preview
    assert len(preview) <= OUTPUT_PREVIEW_MAX_CHARS
    assert preview.endswith("…")


def test_run_one_job_records_no_preview_for_a_silent_run(monkeypatch):
    marks = _patch_pipeline_capturing_mark(monkeypatch, final="[SILENT]")

    s.run_one_job({"id": "r3", "name": "t"})

    assert not marks[0][1].get("output_preview")


def test_run_one_job_records_no_preview_for_a_failed_run(monkeypatch):
    marks = _patch_pipeline_capturing_mark(
        monkeypatch, success=False, final="partial words", error="HTTP 429 from provider",
    )

    s.run_one_job({"id": "r4", "name": "t"})

    assert not marks[0][1].get("output_preview")


def test_originless_desktop_reminder_keeps_its_words_on_the_record(monkeypatch, tmp_path):
    """End to end over the real store: the exact job shape the desktop chat
    produced (deliver="origin", origin=None, one-shot)."""
    import cron.jobs as jobs

    monkeypatch.setattr(jobs, "CRON_DIR", tmp_path / "cron")
    monkeypatch.setattr(jobs, "JOBS_FILE", tmp_path / "cron" / "jobs.json")
    monkeypatch.setattr(jobs, "OUTPUT_DIR", tmp_path / "cron" / "output")
    job = jobs.create_job(
        prompt="Nhắc họp nhóm dự án", schedule="30m", repeat=1, deliver="origin", origin=None,
    )
    assert job["deliver"] == "origin" and job["origin"] is None

    monkeypatch.setattr(
        s, "run_job",
        lambda job, *, defer_agent_teardown=None: (
            True, "# output", "⏰ 20:30 rồi — đến giờ họp nhóm dự án.", None,
        ),
    )
    monkeypatch.setattr(s, "save_job_output", lambda jid, out: f"/tmp/{jid}.txt")

    assert s.run_one_job(jobs.get_job(job["id"])) is True

    stored = jobs.get_job(job["id"])
    assert stored["last_status"] == "ok"
    assert stored["last_output_preview"] == "⏰ 20:30 rồi — đến giờ họp nhóm dự án."


def test_preview_flattening_leaves_ordinary_text_alone():
    """The excerpt can be the whole message, so only real markup goes: plain
    asterisks, identifiers and a redaction mask come through as written."""
    plain = "nhiệt độ -5°C, 2*3*4 = 24, 5 * 3 * 2, snake_case_name, KEY=*** ok"
    assert s._cron_output_preview(plain) == plain
    assert s._cron_output_preview(
        "# Bản tin\n\n---\n\n**Điểm chính:**\n* một\n- hai\n> trích *nghiêng*\n\nMEDIA:/tmp/a.png\n"
    ) == "Bản tin Điểm chính: • một • hai trích nghiêng"
    assert s._cron_output_preview("  \n ") is None
    assert s._cron_output_preview(None) is None


def test_preview_is_dropped_when_redaction_cannot_run(monkeypatch):
    """Fail closed: unredacted text never reaches a notification."""
    import agent.redact as redact

    def boom(*_a, **_k):
        raise RuntimeError("redaction unavailable")

    monkeypatch.setattr(redact, "redact_sensitive_text", boom)
    assert s._cron_output_preview("⏰ đến giờ họp") is None
