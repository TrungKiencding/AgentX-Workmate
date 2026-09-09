"""scripts/release.py's ``get_commits`` must keep every commit in the range.

``git log --format=...%x00%b%x00`` only yields a double NUL when a commit's
body is empty. A commit with a body (every one carrying a Co-Authored-By
trailer) ends with ``\\0`` + newline + the next commit's header, so splitting
records on ``\\0\\0`` folded the commits after it into that body and they
vanished from the changelog (v2026.9.7..HEAD: 1147 commits, 8 listed).
These tests build a throwaway repo whose bodies and bare subjects alternate,
which is exactly the shape that lost commits.
"""

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import release  # noqa: E402

_GIT_IDENTITY = (
    "-c", "user.name=Tester",
    "-c", "user.email=tester@example.invalid",
    "-c", "commit.gpgsign=false",
)


def _git(repo: Path, *args: str, message: str | None = None) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *_GIT_IDENTITY, *args],
        input=message, capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return result.stdout.strip()


def _commit(repo: Path, message: str) -> None:
    # ``-F -`` keeps the message byte-for-byte, so each test controls exactly
    # which commits have a body and which are subject-only.
    _git(repo, "commit", "--allow-empty", "-q", "-F", "-", message=message)


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An empty repo that ``release.git()`` runs in, sealed off from the user's git config."""
    gitconfig = tmp_path / "gitconfig"
    gitconfig.write_text("", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    path = tmp_path / "repo"
    path.mkdir()
    _git(path, "init", "-q")
    # git() resolves REPO_ROOT at call time, so this redirects every git log.
    monkeypatch.setattr(release, "REPO_ROOT", path)
    return path


def test_get_commits_keeps_commits_with_and_without_body(repo: Path):
    # Oldest first. Splitting on "\0\0" swallowed the commit after every
    # commit that has a body, so this history used to come back as 2 entries.
    _commit(repo, "feat: first, subject only\n")
    _commit(
        repo,
        "fix: second, with trailer\n"
        "\n"
        "Explains the fix.\n"
        "\n"
        "Co-Authored-By: Alice <12345+alice@users.noreply.github.com>\n"
        "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\n",
    )
    _commit(repo, "docs: third, subject only\n")
    _commit(repo, "chore: fourth, multi-paragraph body\n\nOne.\n\nTwo.\n")
    shas = _git(repo, "rev-list", "HEAD").splitlines()  # newest first

    commits = release.get_commits()

    assert [c["subject"] for c in commits] == [
        "chore: fourth, multi-paragraph body",
        "docs: third, subject only",
        "fix: second, with trailer",
        "feat: first, subject only",
    ]
    assert [c["sha"] for c in commits] == shas
    assert [c["short_sha"] for c in commits] == [sha[:8] for sha in shas]
    assert [c["category"] for c in commits] == ["chore", "docs", "fixes", "features"]
    assert {(c["author_name"], c["author_email"], c["github_author"]) for c in commits} == {
        ("Tester", "tester@example.invalid", "Tester"),
    }
    # The body still reaches parse_coauthors: the human co-author is kept,
    # the bot trailer is dropped, and subject-only commits have none.
    assert [c["coauthors"] for c in commits] == [[], [], ["@alice"], []]


def test_get_commits_since_tag_only_returns_newer_commits(repo: Path):
    _commit(repo, "feat: released\n\nShipped in the tag.\n")
    _git(repo, "tag", "v2026.1.1")
    _commit(repo, "fix: after the tag\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\n")
    _commit(repo, "docs: also after the tag\n")
    _git(repo, "tag", "v2026.1.2")

    assert [c["subject"] for c in release.get_commits("v2026.1.1")] == [
        "docs: also after the tag",
        "fix: after the tag",
    ]
    assert release.get_commits("v2026.1.2") == []
