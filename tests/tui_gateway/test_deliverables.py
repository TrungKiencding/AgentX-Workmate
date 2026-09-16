"""Turn deliverables: which files a turn produced, for the desktop's file cards."""

from __future__ import annotations

import json
import os
import time

import pytest

from tui_gateway import deliverables as d


def _touch(path, content=b"data", *, mtime=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
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
