"""Turn deliverables: which files a turn produced, for the desktop's file cards."""

from __future__ import annotations

import json
import os
import time

import pytest

from tui_gateway import deliverables as d


# A file the test backdates looks old to every clock the scanner reads. The
# disk cannot fake that: writing it just now stamps a fresh inode change time
# whatever mtime it is given (which is exactly how an unzipped file looks).
_BACKDATED: dict[str, float] = {}


@pytest.fixture(autouse=True)
def _backdated_change_time(monkeypatch):
    _BACKDATED.clear()
    real = d.changed_time
    monkeypatch.setattr(d, "changed_time", lambda path, stat: _BACKDATED.get(str(path), real(path, stat)))
    yield
    _BACKDATED.clear()


def _touch(path, content=b"data", *, mtime=None, placed=False):
    """Write *path*; ``mtime`` backdates it. ``placed`` keeps the fresh change
    time, as an extracted or downloaded file has."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
        if not placed:
            _BACKDATED[str(path)] = mtime
    return path


def _assistant_with_tool(name, args):
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"id": "tc1", "function": {"name": name, "arguments": json.dumps(args)}}],
    }


class TestKinds:
    def test_deliverable_kinds_cover_documents_media_and_archives(self):
        assert d.deliverable_kind("/x/report.docx") == "document"
        assert d.deliverable_kind("/x/Q3.XLSX") == "spreadsheet"
        assert d.deliverable_kind("/x/deck.pptx") == "presentation"
        assert d.deliverable_kind("/x/a.pdf") == "pdf"
        assert d.deliverable_kind("/x/a.zip") == "archive"
        assert d.deliverable_kind("/x/chart.png") == "image"
        assert d.deliverable_kind("/x/voice.mp3") == "audio"
        assert d.deliverable_kind("/x/clip.mp4") == "video"
        assert d.deliverable_kind("/x/data.csv") == "data"
        assert d.deliverable_kind("/x/notes.md") == "text"

    def test_source_code_is_never_a_deliverable(self):
        for name in ("main.py", "index.ts", "app.tsx", "lib.rs", "Makefile", "config.json", "styles.css"):
            assert d.deliverable_kind(f"/x/{name}") is None, name


class TestPathsInText:
    def test_finds_absolute_tilde_and_windows_paths(self):
        text = (
            "Saved to /tmp/out/report.docx and ~/Desktop/chart.png; "
            "on Windows it went to C:\\Users\\me\\deck.pptx."
        )
        found = d.paths_in_text(text, "/work")
        assert "/tmp/out/report.docx" in found
        assert os.path.expanduser("~/Desktop/chart.png") in found
        assert any(p.endswith("deck.pptx") for p in found)

    def test_url_tails_are_not_paths(self):
        found = d.paths_in_text("see https://example.com/files/report.pdf for the source", "/work")
        assert found == []

    def test_relative_tokens_resolve_against_cwd(self):
        found = d.paths_in_text("python make.py -o out/report.docx && ls report.docx", "/work")
        assert "/work/out/report.docx" in found
        assert "/work/report.docx" in found

    def test_trailing_punctuation_and_quotes_are_stripped(self):
        found = d.paths_in_text('Done: "/tmp/a.pdf", then `/tmp/b.xlsx`. Also /tmp/c.docx.', "/work")
        assert found == ["/tmp/a.pdf", "/tmp/b.xlsx", "/tmp/c.docx"]

    def test_dotted_hostnames_are_ignored(self):
        assert d.paths_in_text("open api.internal.example.com.pdf", "/work") == []


class TestCollect:
    def test_reads_file_names_out_of_a_json_tool_result(self, tmp_path):
        """A terminal result is a JSON string whose output carries escaped
        newlines; every name on every line must still resolve."""
        started = time.time() - 5
        names = ["a.pdf", "b.xlsx", "c.docx"]
        for name in names:
            _touch(tmp_path / name, b"x")
        listing = "\n".join(f"-rw-r--r--  1 me  staff  1 Sep 16 10:00 {name}" for name in names)
        messages = [
            _assistant_with_tool("terminal", {"command": "ls -l"}),
            {"role": "tool", "name": "terminal", "content": json.dumps({"output": listing, "exit_code": 0})},
        ]

        records = d.collect_turn_deliverables(messages, cwd=str(tmp_path), started_at=started)

        assert sorted(r["name"] for r in records) == names

    def test_reports_files_the_turn_mentioned_and_produced(self, tmp_path):
        started = time.time() - 30
        fresh = _touch(tmp_path / "report.docx", b"PK" * 10)
        stale = _touch(tmp_path / "old.pdf", b"%PDF", mtime=started - 3600)
        messages = [
            _assistant_with_tool("terminal", {"command": f"python gen.py -o {fresh} && cat {stale}"}),
            {"role": "tool", "name": "terminal", "content": f"wrote {fresh}"},
            {"role": "assistant", "content": f"Report saved at {fresh}. The old one was {stale}."},
        ]

        records = d.collect_turn_deliverables(messages, cwd=str(tmp_path), started_at=started)

        assert [r["name"] for r in records] == ["report.docx"]
        record = records[0]
        assert record["path"] == str(fresh)
        assert record["kind"] == "document"
        assert record["size_bytes"] == 20
        assert record["mime_type"].endswith("wordprocessingml.document")
        assert record["modified_at"] == pytest.approx(fresh.stat().st_mtime)

    def test_final_text_alone_is_enough(self, tmp_path):
        started = time.time() - 5
        fresh = _touch(tmp_path / "summary.pdf", b"%PDF-1.4")

        records = d.collect_turn_deliverables(
            [], cwd=str(tmp_path), started_at=started, final_text=f"Here is {fresh}"
        )

        assert [r["path"] for r in records] == [str(fresh)]

    def test_files_delivered_through_the_tool_are_not_repeated(self, tmp_path):
        started = time.time() - 5
        delivered = _touch(tmp_path / "deck.pptx", b"PK" * 4)
        other = _touch(tmp_path / "notes.md", b"# notes")
        messages = [
            _assistant_with_tool("deliver_file", {"path": str(delivered)}),
            {
                "role": "tool",
                "name": "deliver_file",
                "content": json.dumps({"success": True, "path": str(delivered)}),
            },
            {"role": "assistant", "content": f"Also wrote {other}"},
        ]

        records = d.collect_turn_deliverables(messages, cwd=str(tmp_path), started_at=started)

        assert [r["name"] for r in records] == ["notes.md"]

    def test_hidden_and_dependency_folders_and_agentx_home_are_skipped(self, tmp_path):
        started = time.time() - 5
        home = tmp_path / "agentx-home"
        memory = _touch(home / "memories" / "note.md", b"m")
        hidden = _touch(tmp_path / ".worktrees" / "x" / "out.pdf", b"%PDF")
        deps = _touch(tmp_path / "node_modules" / "pkg" / "README.md", b"r")
        good = _touch(tmp_path / "docs" / "guide.md", b"g")
        text = " ".join(str(p) for p in (memory, hidden, deps, good))

        records = d.collect_turn_deliverables(
            [], cwd=str(tmp_path), started_at=started, excluded_roots=[str(home)], final_text=text
        )

        assert [r["path"] for r in records] == [str(good)]

    def test_empty_missing_and_directory_candidates_are_dropped(self, tmp_path):
        started = time.time() - 5
        empty = _touch(tmp_path / "empty.csv", b"")
        folder = tmp_path / "reports.pdf"
        folder.mkdir()
        text = f"{empty} {folder} {tmp_path / 'missing.docx'}"

        assert d.collect_turn_deliverables([], cwd=str(tmp_path), started_at=started, final_text=text) == []

    def test_workspace_scan_finds_files_created_during_the_turn(self, tmp_path):
        started = time.time() - 5
        fresh = _touch(tmp_path / "out" / "export.xlsx", b"PK" * 3)
        _touch(tmp_path / "old.xlsx", b"PK", mtime=started - 600)
        _touch(tmp_path / "src" / "main.py", b"print(1)")

        records = d.collect_turn_deliverables(
            [], cwd=str(tmp_path), started_at=started, workspace_root=str(tmp_path)
        )

        assert [r["path"] for r in records] == [str(fresh)]

    def test_newest_first_and_capped(self, tmp_path):
        started = time.time() - 60
        paths = []
        for index in range(5):
            path = _touch(tmp_path / f"file-{index}.pdf", b"%PDF", mtime=started + 1 + index)
            paths.append(str(path))
        text = " ".join(paths)

        records = d.collect_turn_deliverables([], cwd=str(tmp_path), started_at=started, final_text=text, limit=3)

        assert [r["path"] for r in records] == [paths[4], paths[3], paths[2]]

    def test_symlink_duplicates_collapse(self, tmp_path):
        started = time.time() - 5
        real = _touch(tmp_path / "real.pdf", b"%PDF")
        link = tmp_path / "link.pdf"
        link.symlink_to(real)

        records = d.collect_turn_deliverables(
            [], cwd=str(tmp_path), started_at=started, final_text=f"{real} {link}"
        )

        assert len(records) == 1


class TestScanBounds:
    def test_scan_respects_entry_budget(self, tmp_path):
        started = time.time() - 5
        for index in range(20):
            _touch(tmp_path / f"f{index:02d}.pdf", b"%PDF")

        found = d.scan_workspace(str(tmp_path), started, max_entries=5)

        assert len(found) <= 5

    def test_scan_respects_depth(self, tmp_path):
        started = time.time() - 5
        shallow = _touch(tmp_path / "a" / "shallow.pdf", b"%PDF")
        _touch(tmp_path / "a" / "b" / "c" / "d" / "deep.pdf", b"%PDF")

        found = d.scan_workspace(str(tmp_path), started, max_depth=1)

        assert found == [str(shallow)]

    def test_scan_stops_when_the_time_budget_is_spent(self, tmp_path):
        started = time.time() - 5
        for index in range(10):
            _touch(tmp_path / f"f{index}.pdf", b"%PDF")
        ticks = iter([0.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0])

        found = d.scan_workspace(str(tmp_path), started, budget_seconds=1.0, clock=lambda: next(ticks))

        assert found == []

    def test_missing_root_is_empty(self, tmp_path):
        assert d.scan_workspace(str(tmp_path / "nope"), 0) == []


def _terminal(command, output):
    return [
        _assistant_with_tool("terminal", {"command": command}),
        {"role": "tool", "name": "terminal", "content": json.dumps({"output": output, "exit_code": 0})},
    ]


class TestPathsWithSpaces:
    """Vietnamese file names are full of spaces; a pattern alone stops at the first."""

    def test_absolute_path_with_spaces_in_a_tool_result(self, tmp_path):
        started = time.time() - 5
        report = _touch(tmp_path / "Desktop" / "Báo cáo tháng 11.docx", b"PK")
        messages = _terminal("python make.py", f"Saved to {report}\n")

        # (tmp_path is under the temp folder: the session's own folder keeps
        # it from reading as scratch.)
        records = d.collect_turn_deliverables(messages, cwd=str(tmp_path), started_at=started)

        assert [r["path"] for r in records] == [str(report)]

    def test_path_with_spaces_in_inline_code_of_the_reply(self, tmp_path):
        started = time.time() - 5
        report = _touch(tmp_path / "Bao cao" / "q3 final.xlsx", b"PK")

        records = d.collect_turn_deliverables(
            [], cwd=str(tmp_path / "elsewhere"), started_at=started, final_text=f"Đã lưu tại `{report}`."
        )

        assert [r["name"] for r in records] == ["q3 final.xlsx"]

    def test_relative_path_with_spaces_resolves_against_cwd(self, tmp_path):
        started = time.time() - 5
        _touch(tmp_path / "ket qua.csv", b"a,b")

        found = d.spaced_paths_in_text("Đã lưu file ket qua.csv xong.", str(tmp_path))

        assert found == [str(tmp_path / "ket qua.csv")]

    def test_nearest_existing_start_wins(self, tmp_path):
        near = _touch(tmp_path / "b c.pdf", b"%PDF")

        found = d.spaced_paths_in_text(f"from /nowhere and {tmp_path}/b c.pdf", "/")

        assert found == [str(near)]

    def test_prose_that_is_not_a_path_costs_nothing(self, tmp_path):
        assert d.spaced_paths_in_text("Tôi đã lưu báo cáo.docx và bảng tính.xlsx cho bạn.", str(tmp_path)) == []

    def test_probe_budget_is_respected(self, tmp_path, monkeypatch):
        calls = []
        monkeypatch.setattr(d.os.path, "isfile", lambda path: calls.append(path) or False)
        text = " ".join(f"word word word x{i}.pdf" for i in range(200))

        d.spaced_paths_in_text(text, str(tmp_path), d._ProbeBudget(10))

        assert len(calls) == 10


class TestPlacedFiles:
    """unzip / wget / cp -p keep the archived mtime; the file is still new here."""

    def test_named_file_with_an_archived_mtime_is_reported(self, tmp_path):
        started = time.time() - 5
        pdf = _touch(tmp_path / "Downloads" / "dummy.pdf", b"%PDF", mtime=started - 86400 * 400, placed=True)
        messages = _terminal(f"wget -P {pdf.parent} https://x/dummy.pdf", f"Saving to: '{pdf}'\n")

        records = d.collect_turn_deliverables(messages, cwd=str(tmp_path), started_at=started)

        assert [r["path"] for r in records] == [str(pdf)]

    def test_walk_finds_extracted_files(self, tmp_path):
        started = time.time() - 5
        extracted = [
            _touch(tmp_path / "tai-lieu" / f"tai-lieu-{i}.txt", b"x", mtime=started - 86400 * 300, placed=True)
            for i in range(3)
        ]
        messages = _terminal("unzip -o tai-lieu.zip -d tai-lieu", "")

        records = d.collect_turn_deliverables(
            messages, cwd=str(tmp_path), started_at=started, workspace_root=str(tmp_path)
        )

        assert sorted(r["path"] for r in records) == sorted(str(p) for p in extracted)

    def test_a_changed_inode_in_an_untouched_folder_is_not_new(self, tmp_path):
        """A sync client rewriting an xattr bumps the inode change time, but
        the folder gains no entry."""
        started = time.time() - 5
        synced = _touch(tmp_path / "docs" / "old.pdf", b"%PDF", mtime=started - 86400, placed=True)
        os.utime(synced.parent, (started - 86400, started - 86400))

        records = d.collect_turn_deliverables(
            [], cwd=str(tmp_path), started_at=started, workspace_root=str(tmp_path), final_text=f"see {synced}"
        )

        assert records == []


class TestSecondaryOutputs:
    def test_data_and_scripts_the_turn_named_are_reported(self, tmp_path):
        started = time.time() - 5
        data = _touch(tmp_path / "out" / "du-lieu.json", b"{}")
        script = _touch(tmp_path / "rename.py", b"print(1)")
        messages = _terminal(f"cat > {script} <<'EOF'\nprint(1)\nEOF\npython gen.py", f"Saved {data}\n")

        records = d.collect_turn_deliverables(messages, cwd=str(tmp_path), started_at=started)

        assert sorted(r["name"] for r in records) == ["du-lieu.json", "rename.py"]
        assert {r["kind"] for r in records} == {"file"}

    def test_the_walk_never_reports_them(self, tmp_path):
        started = time.time() - 5
        _touch(tmp_path / "package-lock.json", b"{}")
        _touch(tmp_path / "src" / "app.py", b"x = 1")

        records = d.collect_turn_deliverables(
            [], cwd=str(tmp_path), started_at=started, workspace_root=str(tmp_path)
        )

        assert records == []

    def test_files_a_file_tool_wrote_are_left_to_the_diff(self, tmp_path):
        started = time.time() - 5
        written = _touch(tmp_path / "config.yaml", b"a: 1")
        added = _touch(tmp_path / "tool.py", b"x")
        messages = [
            _assistant_with_tool("write_file", {"path": "config.yaml", "content": "a: 1"}),
            {"role": "tool", "name": "write_file", "content": json.dumps({"success": True})},
            _assistant_with_tool("patch", {"mode": "patch", "patch": "*** Begin Patch\n*** Add File: tool.py\n+x\n*** End Patch"}),
            {"role": "tool", "name": "patch", "content": json.dumps({"success": True})},
        ]

        records = d.collect_turn_deliverables(
            messages, cwd=str(tmp_path), started_at=started, final_text=f"Wrote {written} and {added}"
        )

        assert records == []

    def test_existing_scripts_the_turn_only_ran_are_not_reported(self, tmp_path):
        started = time.time() - 5
        script = _touch(tmp_path / "build.py", b"x", mtime=started - 3600)

        records = d.collect_turn_deliverables(_terminal(f"python {script}", "ok"), cwd=str(tmp_path), started_at=started)

        assert records == []


class TestWorkingFiles:
    """Scratch renders and checks are not what the person asked for."""

    def test_temp_files_need_the_reply_to_name_them(self, tmp_path):
        started = time.time() - 5
        scratch = _touch(tmp_path / "scratch" / "page-1.png", b"png")
        kept = _touch(tmp_path / "scratch" / "final.pdf", b"%PDF")
        messages = _terminal("render", f"wrote {scratch}\nwrote {kept}")

        records = d.collect_turn_deliverables(
            messages, cwd=str(tmp_path / "home"), started_at=started, final_text=f"Bản cuối: {kept}"
        )

        assert [r["path"] for r in records] == [str(kept)]

    def test_after_a_hand_over_only_files_the_reply_names_remain(self, tmp_path):
        started = time.time() - 5
        deck = _touch(tmp_path / "deck.pptx", b"PK")
        slides = [_touch(tmp_path / f"slide-{i}.jpg", b"jpg") for i in range(3)]
        notes = _touch(tmp_path / "speaker-notes.md", b"# notes")
        messages = [
            *_terminal("render", "\n".join(str(s) for s in slides)),
            _assistant_with_tool("deliver_file", {"path": str(deck)}),
            {"role": "tool", "name": "deliver_file", "content": json.dumps({"success": True, "path": str(deck)})},
        ]

        records = d.collect_turn_deliverables(
            messages,
            cwd=str(tmp_path),
            started_at=started,
            workspace_root=str(tmp_path),
            final_text=f"Bộ slide ở trên; ghi chú thuyết trình ở {notes}.",
        )

        assert [r["path"] for r in records] == [str(notes)]


class TestDeepWorkspace:
    def test_walk_reaches_six_levels(self, tmp_path):
        started = time.time() - 5
        deep = _touch(tmp_path / "bao-cao" / "2026" / "quy-4" / "thang-11" / "tong-hop.csv", b"1,2")

        assert d.scan_workspace(str(tmp_path), started) == [str(deep)]

    def test_walk_survives_a_large_folder(self, tmp_path):
        started = time.time() - 5
        bulk = tmp_path / "old"
        bulk.mkdir()
        for index in range(4000):
            (bulk / f"{index}.txt").write_bytes(b"x")
        stale = started - 86400
        for entry in os.scandir(bulk):
            os.utime(entry.path, (stale, stale))
            _BACKDATED[entry.path] = stale
        fresh = _touch(tmp_path / "zz" / "new" / "result.docx", b"PK")

        assert d.scan_workspace(str(tmp_path), started) == [str(fresh)]


class TestNamedFolders:
    def test_files_extracted_into_a_named_folder_are_reported(self, tmp_path):
        started = time.time() - 5
        home = tmp_path / "home"
        home.mkdir()
        dest = tmp_path / "Downloads" / "tai-lieu"
        extracted = [_touch(dest / f"tai-lieu-{i}.txt", b"x", mtime=started - 86400 * 300, placed=True) for i in range(3)]
        messages = _terminal(f"unzip -o {tmp_path}/tai-lieu.zip -d {dest}", "")

        records = d.collect_turn_deliverables(
            messages, cwd=str(home), started_at=started, final_text=f"Đã giải nén vào {dest}."
        )

        assert sorted(r["path"] for r in records) == sorted(str(p) for p in extracted)

    def test_a_relative_folder_word_of_a_command_counts(self, tmp_path):
        started = time.time() - 5
        made = _touch(tmp_path / "out" / "a.pdf", b"%PDF")

        assert d.named_directories(_terminal("python split.py -d out", ""), str(tmp_path)) == [str(tmp_path / "out")]
        records = d.collect_turn_deliverables(_terminal("python split.py -d out", ""), cwd=str(tmp_path), started_at=started)
        assert [r["path"] for r in records] == [str(made)]

    def test_only_direct_children_of_a_folder_that_changed(self, tmp_path):
        started = time.time() - 5
        busy = tmp_path / "Desktop"
        nested = _touch(busy / "other-project" / "README.md", b"r")
        os.utime(busy, (started - 600, started - 600))

        assert d.files_arrived_in(str(busy), started) == []  # the folder itself gained nothing
        _touch(busy / "new.pdf", b"%PDF")
        assert d.files_arrived_in(str(busy), started) == [str(busy / "new.pdf")]
        assert str(nested) not in d.files_arrived_in(str(busy), started)

    def test_the_session_folder_home_and_root_are_never_named(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path / "home"))
        (tmp_path / "home").mkdir()
        work = tmp_path / "home" / "work"
        work.mkdir()

        text = f"cd {tmp_path / 'home'} && ls / && ls {work} && ls {tmp_path / 'home'}"

        assert d.named_directories(_terminal(text, ""), str(work)) == []


class TestBranchSeedRows:
    def test_a_branch_keeps_the_files_its_parent_was_handed(self, tmp_path):
        deck = _touch(tmp_path / "deck.pptx", b"PK")
        listed = {"path": str(tmp_path / "notes.md"), "name": "notes.md"}
        history = [
            {"role": "user", "content": "make a deck", "timestamp": 1.0},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "t", "function": {"name": "deliver_file"}}]},
            {
                "role": "tool",
                "name": "deliver_file",
                "tool_call_id": "t",
                "content": json.dumps({"success": True, "path": str(deck), "name": "deck.pptx"}),
            },
            {"role": "assistant", "content": "Here it is.", "display_metadata": {"files_created": [listed]}},
            {"role": "user", "content": "thanks"},
            {"role": "assistant", "content": "Any time."},
        ]

        rows = d.branch_seed_rows(history)

        assert [r["role"] for r in rows] == ["user", "assistant", "tool", "assistant", "user", "assistant"]
        assert all("tool_calls" not in r and "tool_call_id" not in r for r in rows)
        assert rows[0]["timestamp"] == 1.0
        files = rows[3]["display_metadata"]["files_created"]
        assert [f["name"] for f in files] == ["notes.md", "deck.pptx"]
        assert "display_metadata" not in rows[5]

    def test_a_failed_or_missing_delivery_is_handled(self, tmp_path):
        gone = tmp_path / "gone.pdf"
        history = [
            {"role": "user", "content": "x"},
            {"role": "tool", "name": "deliver_file", "content": json.dumps({"success": False, "error": "no"})},
            {"role": "tool", "name": "deliver_file", "content": json.dumps({"success": True, "path": str(gone)})},
            {"role": "tool", "name": "deliver_file", "content": "not json"},
            {"role": "assistant", "content": "done"},
        ]

        files = d.branch_seed_rows(history)[-1]["display_metadata"]["files_created"]

        assert [(f["name"], f["size_bytes"]) for f in files] == [("gone.pdf", 0)]

    def test_presentation_fields_survive(self):
        divider = {"role": "assistant", "content": "summary", "display_kind": "compaction", "display_metadata": {"compaction": {"n": 3}}}

        assert d.branch_seed_rows([divider])[0]["display_kind"] == "compaction"


class TestBranchCutIndex:
    """The desktop branches at the N-th message it shows, not the N-th row."""

    HISTORY = [
        {"role": "user", "content": "make a deck"},  # shown 1
        {"role": "assistant", "content": "Let me check.", "tool_calls": [{"id": "a"}]},
        {"role": "tool", "content": "{}"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "b"}]},
        {"role": "tool", "content": "{}"},
        {"role": "assistant", "content": "Here it is."},  # shown 2 (one turn)
        {"role": "user", "content": "[System: model switched]", "display_kind": "model_switch"},
        {"role": "user", "content": "thanks"},  # shown 3
        {"role": "assistant", "content": "Any time."},  # shown 4
    ]

    def test_cuts_after_whole_turns(self):
        assert d.branch_cut_index(self.HISTORY, 1) == 1
        assert d.branch_cut_index(self.HISTORY, 2) == 6
        assert d.branch_cut_index(self.HISTORY, 3) == 8
        assert d.branch_cut_index(self.HISTORY, 4) == 9

    def test_a_count_past_the_end_keeps_everything(self):
        assert d.branch_cut_index(self.HISTORY, 99) == len(self.HISTORY)
