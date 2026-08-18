"""Tests for the account axis: ``<root>/accounts/<slug>`` homes.

The account axis sits above the profile axis, so most of what is asserted here
is a *relationship* between the two:

    <root>/                                    install (checkout, venv, node)
    <root>/accounts/<slug>/                    one signed-in person
    <root>/accounts/<slug>/profiles/<name>/    that person's workspaces

The load-bearing property is isolation — with account A active, nothing the
profile machinery resolves may live outside A's home.  ``TestAccountIsolation``
is the test that fails if the profile anchor is ever re-pointed at the install
root.
"""

import json
import os
import stat
from pathlib import Path

import pytest

from hermes_constants import (
    ACCOUNTS_DIR_NAME,
    PROFILES_DIR_NAME,
    account_slug_for_home,
    get_account_home,
    get_accounts_root,
    get_active_account,
    get_default_hermes_root,
    get_user_root,
    split_home_scope,
)
from hermes_cli import profiles
from hermes_cli.accounts import (
    ACCOUNT_SLUG_RE,
    AccountError,
    AccountIdentity,
    account_exists,
    account_home,
    account_slug_for_identity,
    delete_account,
    ensure_account_home,
    find_account_for_subject,
    list_accounts,
    litellm_key_alias_for_identity,
    litellm_key_alias_label,
    read_account_identity,
    resolve_account_for_identity,
    validate_account_slug,
    write_account_identity,
)


# ---------------------------------------------------------------------------
# Fixtures
#
# Path.home() is redirected the same way tests/hermes_cli/test_profiles.py does
# it: the conftest sandbox moves AGENTX_HOME but deliberately leaves HOME
# alone, and the account root is derived from the platform-native home.
# ---------------------------------------------------------------------------

@pytest.fixture()
def install_root(tmp_path, monkeypatch):
    """Return the platform-native install root, with AGENTX_HOME pointed at it."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "AppData" / "Local"))
    monkeypatch.delenv("AGENTX_HOME", raising=False)
    root = get_default_hermes_root()
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("AGENTX_HOME", str(root))
    return root


@pytest.fixture()
def docker_root(tmp_path, monkeypatch):
    """Return a custom root outside the native home, Docker-deployment style."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "AppData" / "Local"))
    root = tmp_path / "opt" / "data"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("AGENTX_HOME", str(root))
    return root


def use_home(monkeypatch, home: Path) -> Path:
    """Scope the process to *home* the way the CLI's ``--account``/``-p`` do."""
    monkeypatch.setenv("AGENTX_HOME", str(home))
    return home


# ---------------------------------------------------------------------------
# Cross-language slug vectors
#
# The desktop app derives the account slug in TypeScript before it can ask the
# backend anything, so the two implementations must agree byte for byte.  This
# exact table also lives in apps/desktop/electron/account-slug.test.ts — the
# two copies must not drift.  The expected values are hard-coded on purpose:
# re-deriving them from the function under test would let an algorithm change
# pass silently on this side and break the desktop side.
# ---------------------------------------------------------------------------

ACCOUNT_SLUG_VECTORS = [
    # (subject, username, email, expected_slug)
    (
        "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
        "Kien.Le",
        "kien.le@astralx.vn",
        "kien-le-30a5154b",
    ),
    (
        "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
        "",
        "kien.le@astralx.vn",
        "kien-le-30a5154b",
    ),
    (
        "00000000-0000-0000-0000-000000000001",
        "",
        "",
        "u-7ac1b8d7",
    ),
    (
        "subject-with-unicode",
        "Nguyễn Văn A",
        "nva@astralx.vn",
        "nguy-n-v-n-a-ab1c1834",
    ),
    (
        "longname",
        "a-very-long-username-that-exceeds-the-label-budget-by-a-lot",
        "",
        "a-very-long-username-tha-7dc98c29",
    ),
    (
        "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
        "  ",
        "  KIEN.LE@Astralx.VN ",
        "kien-le-30a5154b",
    ),
    (
        "other-subject",
        "Kien Le",
        "kien.le@astralx.vn",
        "kien-le-9fe36593",
    ),
]


class TestAccountSlugVectors:
    """The slug contract shared with apps/desktop/electron/account-slug.ts."""

    @pytest.mark.parametrize(
        "subject,username,email,expected", ACCOUNT_SLUG_VECTORS
    )
    def test_vector(self, subject, username, email, expected):
        assert (
            account_slug_for_identity(subject, username=username, email=email)
            == expected
        )

    @pytest.mark.parametrize(
        "subject,username,email,expected", ACCOUNT_SLUG_VECTORS
    )
    def test_vector_is_a_legal_slug(self, subject, username, email, expected):
        assert ACCOUNT_SLUG_RE.match(expected)
        validate_account_slug(expected)


class TestAccountSlugDerivation:
    """Properties the vectors above are only samples of."""

    def test_stable_for_the_same_subject(self):
        first = account_slug_for_identity("sub-1", username="ana", email="a@x.vn")
        second = account_slug_for_identity("sub-1", username="ana", email="a@x.vn")
        assert first == second

    def test_survives_a_rename(self):
        """The digest is over the subject, so renaming keeps only the label."""
        before = account_slug_for_identity("sub-1", username="ana")
        after = account_slug_for_identity("sub-1", username="ana.smith")
        assert before.split("-")[-1] == after.split("-")[-1]

    def test_colliding_labels_still_get_different_slugs(self):
        """Two people whose usernames sanitize identically must not share a home."""
        one = account_slug_for_identity("sub-a", username="Kien Le")
        two = account_slug_for_identity("sub-b", username="kien.le")
        assert one != two
        assert one.startswith("kien-le-") and two.startswith("kien-le-")

    def test_username_wins_over_email(self):
        slug = account_slug_for_identity("sub-1", username="ana", email="bob@x.vn")
        assert slug.startswith("ana-")

    def test_email_local_part_used_when_username_missing(self):
        slug = account_slug_for_identity("sub-1", username="", email="bob@x.vn")
        assert slug.startswith("bob-")

    def test_anonymous_identity_gets_the_u_prefix(self):
        slug = account_slug_for_identity("sub-1")
        assert slug.startswith("u-")
        assert ACCOUNT_SLUG_RE.match(slug)

    @pytest.mark.parametrize(
        "username",
        [
            "UPPER.CASE",
            "with spaces",
            "dots.and.more.dots",
            "Nguyễn",
            "!!!weird!!!",
            "trailing---",
            "---leading",
        ],
    )
    def test_sanitized_output_is_always_a_legal_slug(self, username):
        slug = account_slug_for_identity("sub-1", username=username)
        assert ACCOUNT_SLUG_RE.match(slug), slug
        validate_account_slug(slug)

    def test_label_is_length_capped_but_digest_survives(self):
        slug = account_slug_for_identity("sub-1", username="x" * 200)
        assert ACCOUNT_SLUG_RE.match(slug)
        assert len(slug) < 40
        assert slug.endswith(account_slug_for_identity("sub-1").removeprefix("u-"))

    @pytest.mark.parametrize("subject", ["", "   ", None])
    def test_blank_subject_is_refused(self, subject):
        with pytest.raises(AccountError):
            account_slug_for_identity(subject, username="ana")


class TestLitellmKeyAlias:
    def test_vietnamese_display_name_becomes_ascii_username(self):
        assert litellm_key_alias_label(display_name="Lê Trung Kiên") == "letrungkien"
        assert litellm_key_alias_for_identity(
            "second-brain", subject="sub-1", display_name="Lê Trung Kiên"
        ) == "second-brain-letrungkien"

    def test_username_beats_display_name(self):
        assert litellm_key_alias_label(username="kien", display_name="Kien Le") == "kien"


class TestValidateAccountSlug:
    @pytest.mark.parametrize("slug", ["kien-le-30a5154b", "u-7ac1b8d7", "a", "a_b-1"])
    def test_accepts_legal_slugs(self, slug):
        validate_account_slug(slug)

    @pytest.mark.parametrize(
        "slug",
        ["", "UPPER", "-leading", "has space", "has/slash", "..", "x" * 65, None],
    )
    def test_rejects_malformed_slugs(self, slug):
        with pytest.raises(AccountError):
            validate_account_slug(slug)

    @pytest.mark.parametrize("slug", [ACCOUNTS_DIR_NAME, PROFILES_DIR_NAME, "default"])
    def test_rejects_layout_reserved_slugs(self, slug):
        with pytest.raises(AccountError):
            validate_account_slug(slug)


# ---------------------------------------------------------------------------
# Path decomposition
# ---------------------------------------------------------------------------

class TestSplitHomeScope:
    def test_install_root_has_neither_axis(self, install_root):
        assert split_home_scope(install_root) == (None, None)

    def test_bare_profile(self, install_root):
        home = install_root / PROFILES_DIR_NAME / "work"
        assert split_home_scope(home) == (None, "work")

    def test_bare_account(self, install_root):
        home = install_root / ACCOUNTS_DIR_NAME / "kien-le-30a5154b"
        assert split_home_scope(home) == ("kien-le-30a5154b", None)

    def test_profile_inside_account(self, install_root):
        home = (
            install_root
            / ACCOUNTS_DIR_NAME
            / "kien-le-30a5154b"
            / PROFILES_DIR_NAME
            / "work"
        )
        assert split_home_scope(home) == ("kien-le-30a5154b", "work")

    @pytest.mark.parametrize(
        "relative",
        [
            "elsewhere",
            "accounts/kien/profiles/work/deeper",
            "accounts/kien/sessions",
        ],
    )
    def test_unrecognised_shapes_decline_to_guess(self, install_root, relative):
        home = install_root.parent / relative
        assert split_home_scope(home) == (None, None)

    def test_explicit_root_overrides_the_ambient_one(self, install_root, tmp_path):
        """Generating a unit for another user's root must not consult ours."""
        other_root = tmp_path / "srv" / "agentx"
        home = other_root / ACCOUNTS_DIR_NAME / "ana-1234abcd"
        assert split_home_scope(home) == (None, None)
        assert split_home_scope(home, other_root) == ("ana-1234abcd", None)


class TestAccountSlugForHome:
    def test_none_outside_an_account(self, install_root):
        assert account_slug_for_home(install_root) is None
        assert account_slug_for_home(install_root / PROFILES_DIR_NAME / "work") is None
        assert account_slug_for_home("") is None
        assert account_slug_for_home(None) is None

    def test_slug_from_account_and_from_nested_profile(self, install_root):
        home = install_root / ACCOUNTS_DIR_NAME / "ana-1234abcd"
        assert account_slug_for_home(home) == "ana-1234abcd"
        assert account_slug_for_home(home / PROFILES_DIR_NAME / "work") == "ana-1234abcd"


# ---------------------------------------------------------------------------
# Root resolution
# ---------------------------------------------------------------------------

class TestUserRootAndActiveAccount:
    def test_no_account_means_user_root_is_the_install_root(self, install_root):
        assert get_active_account() is None
        assert get_user_root() == get_default_hermes_root()

    def test_account_home_becomes_the_user_root(self, install_root, monkeypatch):
        home = get_account_home("ana-1234abcd")
        use_home(monkeypatch, home)
        assert get_active_account() == "ana-1234abcd"
        assert get_user_root() == home

    def test_profile_inside_account_reports_the_same_user_root(
        self, install_root, monkeypatch
    ):
        home = get_account_home("ana-1234abcd")
        use_home(monkeypatch, home / PROFILES_DIR_NAME / "work")
        assert get_active_account() == "ana-1234abcd"
        assert get_user_root() == home


class TestDefaultRootStaysTheInstallRoot:
    """The venv, the checkout and node_modules are shared by the whole machine."""

    def test_native_root_from_inside_an_account(self, install_root, monkeypatch):
        use_home(monkeypatch, install_root / ACCOUNTS_DIR_NAME / "ana-1234abcd")
        assert get_default_hermes_root() == install_root

    def test_native_root_from_a_profile_inside_an_account(
        self, install_root, monkeypatch
    ):
        use_home(
            monkeypatch,
            install_root / ACCOUNTS_DIR_NAME / "ana-1234abcd" / PROFILES_DIR_NAME / "w",
        )
        assert get_default_hermes_root() == install_root

    def test_docker_root_from_inside_an_account(self, docker_root, monkeypatch):
        use_home(monkeypatch, docker_root / ACCOUNTS_DIR_NAME / "ana-1234abcd")
        assert get_default_hermes_root() == docker_root

    def test_docker_root_from_a_profile_inside_an_account(
        self, docker_root, monkeypatch
    ):
        use_home(
            monkeypatch,
            docker_root / ACCOUNTS_DIR_NAME / "ana-1234abcd" / PROFILES_DIR_NAME / "w",
        )
        assert get_default_hermes_root() == docker_root

    def test_docker_root_from_a_bare_profile(self, docker_root, monkeypatch):
        use_home(monkeypatch, docker_root / PROFILES_DIR_NAME / "w")
        assert get_default_hermes_root() == docker_root

    def test_accounts_root_hangs_off_the_install_root(self, install_root, monkeypatch):
        use_home(monkeypatch, install_root / ACCOUNTS_DIR_NAME / "ana-1234abcd")
        assert get_accounts_root() == install_root / ACCOUNTS_DIR_NAME
        assert get_account_home("bob-5678") == install_root / ACCOUNTS_DIR_NAME / "bob-5678"


# ---------------------------------------------------------------------------
# THE ISOLATION INVARIANT
# ---------------------------------------------------------------------------

class TestAccountIsolation:
    """With an account active, every profile path lives inside that account.

    Two people signed in on one laptop must not share a profile namespace: the
    profile store, the sticky ``active_profile`` marker and the ``default``
    profile all have to resolve under the active account's home.  If somebody
    re-points ``profiles._get_default_hermes_home()`` back at the install root,
    this is the test that catches it.
    """

    def _profile_paths(self):
        return {
            "profiles_root": profiles._get_profiles_root(),
            "active_marker": profiles._get_active_profile_path(),
            "default_profile": profiles.get_profile_dir("default"),
            "named_profile": profiles.get_profile_dir("work"),
        }

    def test_every_profile_path_is_inside_the_active_account(
        self, install_root, monkeypatch
    ):
        home = ensure_account_home("ana-1234abcd")
        use_home(monkeypatch, home)
        for label, path in self._profile_paths().items():
            assert path.is_relative_to(home), f"{label} escaped the account home"

    def test_two_accounts_share_no_profile_path(self, install_root, monkeypatch):
        home_a = ensure_account_home("ana-1234abcd")
        home_b = ensure_account_home("bob-5678abcd")

        use_home(monkeypatch, home_a)
        paths_a = self._profile_paths()
        use_home(monkeypatch, home_b)
        paths_b = self._profile_paths()

        assert set(paths_a) == set(paths_b)
        for label in paths_a:
            assert paths_a[label] != paths_b[label], f"{label} is shared between accounts"
        assert not set(paths_a.values()) & set(paths_b.values())
        for path in paths_b.values():
            assert not path.is_relative_to(home_a)

    def test_account_profile_paths_differ_from_the_no_account_ones(
        self, install_root, monkeypatch
    ):
        rootless = self._profile_paths()
        home = ensure_account_home("ana-1234abcd")
        use_home(monkeypatch, home)
        scoped = self._profile_paths()
        for label in rootless:
            assert rootless[label] != scoped[label], label

    def test_a_real_profile_created_under_an_account_lands_inside_it(
        self, install_root, monkeypatch
    ):
        home = ensure_account_home("ana-1234abcd")
        use_home(monkeypatch, home)
        created = profiles.create_profile("work", no_alias=True)
        assert created.is_relative_to(home)
        assert created == home / PROFILES_DIR_NAME / "work"
        assert "work" in {p.name for p in profiles.list_profiles()}

        use_home(monkeypatch, ensure_account_home("bob-5678abcd"))
        assert "work" not in {p.name for p in profiles.list_profiles()}


# ---------------------------------------------------------------------------
# Account homes on disk
# ---------------------------------------------------------------------------

class TestEnsureAccountHome:
    def test_creates_the_skeleton(self, install_root):
        home = ensure_account_home("ana-1234abcd")
        assert home == get_account_home("ana-1234abcd")
        assert home.is_dir()
        for subdir in ("memories", "sessions", "logs", "workspace"):
            assert (home / subdir).is_dir(), subdir
        assert account_exists("ana-1234abcd")

    def test_env_file_is_owner_only_and_holds_no_secret(self, install_root):
        home = ensure_account_home("ana-1234abcd")
        env_path = home / ".env"
        assert env_path.exists()
        content = env_path.read_text(encoding="utf-8")
        assert all(
            line.startswith("#") or not line.strip() for line in content.splitlines()
        )
        assert stat.S_IMODE(env_path.stat().st_mode) == 0o600

    def test_idempotent_and_non_destructive(self, install_root):
        home = ensure_account_home("ana-1234abcd")
        env_path = home / ".env"
        env_path.write_text("AGENTX_CUSTOM_LITELLM_API_KEY=sk-keepme\n", encoding="utf-8")
        (home / "sessions" / "chat.json").write_text("{}", encoding="utf-8")

        again = ensure_account_home("ana-1234abcd")

        assert again == home
        assert "sk-keepme" in env_path.read_text(encoding="utf-8")
        assert (home / "sessions" / "chat.json").exists()

    def test_records_and_re_reads_the_identity_sidecar(self, install_root):
        identity = AccountIdentity(
            subject="f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
            username="Kien.Le",
            email="kien.le@astralx.vn",
            display_name="Kien Le",
            issuer="https://id.astralx.vn/realms/agentx",
        )
        slug = account_slug_for_identity(
            identity.subject, username=identity.username, email=identity.email
        )
        home = ensure_account_home(slug, identity)

        assert read_account_identity(slug) == identity
        assert read_account_identity(home) == identity

    def test_sidecar_carries_no_credential(self, install_root):
        identity = AccountIdentity(subject="sub-1", username="ana", email="a@x.vn")
        path = write_account_identity("ana-1234abcd", identity)
        data = json.loads(path.read_text(encoding="utf-8"))
        assert set(data) == set(identity.to_json())
        assert not any("key" in k or "token" in k or "secret" in k for k in data)

    def test_corrupt_sidecar_does_not_cost_access(self, install_root):
        home = ensure_account_home("ana-1234abcd")
        (home / "account.json").write_text("{not json", encoding="utf-8")
        assert read_account_identity("ana-1234abcd") is None
        assert account_exists("ana-1234abcd")

    def test_missing_sidecar_reads_as_none(self, install_root):
        ensure_account_home("ana-1234abcd")
        assert read_account_identity("ana-1234abcd") is None

    @pytest.mark.parametrize(
        "slug", ["", "UPPER", "../escape", "has space", ACCOUNTS_DIR_NAME, "default"]
    )
    def test_refuses_reserved_or_malformed_slugs(self, install_root, slug):
        with pytest.raises(AccountError):
            ensure_account_home(slug)
        with pytest.raises(AccountError):
            account_home(slug)
        assert not account_exists(slug)

    def test_traversal_slug_creates_nothing(self, install_root):
        with pytest.raises(AccountError):
            ensure_account_home("../../escape")
        assert not (install_root.parent / "escape").exists()


class TestListAndResolveAccounts:
    def test_empty_install_lists_nothing(self, install_root):
        assert list_accounts() == []

    def test_lists_accounts_sorted_with_the_active_one_flagged(
        self, install_root, monkeypatch
    ):
        ensure_account_home("bob-5678abcd", AccountIdentity(subject="sub-b", username="bob"))
        ensure_account_home("ana-1234abcd", AccountIdentity(subject="sub-a", username="ana"))
        use_home(monkeypatch, get_account_home("ana-1234abcd"))

        infos = list_accounts()

        assert [i.slug for i in infos] == sorted(i.slug for i in infos)
        assert {i.slug for i in infos} == {"ana-1234abcd", "bob-5678abcd"}
        active = [i for i in infos if i.is_active]
        assert [i.slug for i in active] == ["ana-1234abcd"]

    def test_non_account_directories_are_ignored(self, install_root):
        ensure_account_home("ana-1234abcd")
        (get_accounts_root() / "Not A Slug").mkdir()
        (get_accounts_root() / ".tmp-partial").mkdir()
        assert [i.slug for i in list_accounts()] == ["ana-1234abcd"]

    def test_label_prefers_a_human_name_and_falls_back_to_the_slug(self, install_root):
        ensure_account_home(
            "ana-1234abcd",
            AccountIdentity(subject="sub-a", username="ana", display_name="Ana Vu"),
        )
        ensure_account_home("bob-5678abcd")
        labels = {i.slug: i.label for i in list_accounts()}
        assert labels["ana-1234abcd"] == "Ana Vu"
        assert labels["bob-5678abcd"] == "bob-5678abcd"

    def test_find_account_for_subject(self, install_root):
        ensure_account_home("ana-1234abcd", AccountIdentity(subject="sub-a", username="ana"))
        ensure_account_home("bob-5678abcd", AccountIdentity(subject="sub-b", username="bob"))

        assert find_account_for_subject("sub-b").slug == "bob-5678abcd"
        assert find_account_for_subject("sub-missing") is None
        assert find_account_for_subject("") is None

    def test_resolve_derives_a_slug_for_a_first_time_signin(self, install_root):
        slug = resolve_account_for_identity("sub-a", username="ana", email="a@x.vn")
        assert slug == account_slug_for_identity("sub-a", username="ana", email="a@x.vn")
        assert not account_exists(slug)

    def test_resolve_adopts_the_existing_home_after_a_rename(self, install_root):
        """A rename in Keycloak must not orphan somebody's sessions."""
        subject = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"
        original = resolve_account_for_identity(subject, username="Kien.Le")
        home = ensure_account_home(
            original, AccountIdentity(subject=subject, username="Kien.Le")
        )
        (home / "sessions" / "chat.json").write_text("{}", encoding="utf-8")

        renamed = resolve_account_for_identity(
            subject, username="kien.legacy", email="new@astralx.vn"
        )

        assert renamed == original
        assert renamed != account_slug_for_identity(subject, username="kien.legacy")
        assert (get_account_home(renamed) / "sessions" / "chat.json").exists()

    def test_resolve_does_not_adopt_another_persons_home(self, install_root):
        ensure_account_home("ana-1234abcd", AccountIdentity(subject="sub-a", username="ana"))
        slug = resolve_account_for_identity("sub-b", username="ana")
        assert slug != "ana-1234abcd"


class TestDeleteAccount:
    def test_removes_the_whole_tree(self, install_root, monkeypatch):
        use_home(monkeypatch, install_root)
        home = ensure_account_home("ana-1234abcd")
        (home / "sessions" / "chat.json").write_text("{}", encoding="utf-8")

        removed = delete_account("ana-1234abcd")

        assert removed == home
        assert not home.exists()
        assert not account_exists("ana-1234abcd")
        assert list_accounts() == []

    def test_refuses_to_delete_the_account_we_are_homed_in(
        self, install_root, monkeypatch
    ):
        home = ensure_account_home("ana-1234abcd")
        use_home(monkeypatch, home)

        with pytest.raises(AccountError):
            delete_account("ana-1234abcd")
        assert home.is_dir()

    def test_refuses_from_a_profile_nested_in_the_active_account(
        self, install_root, monkeypatch
    ):
        home = ensure_account_home("ana-1234abcd")
        use_home(monkeypatch, home / PROFILES_DIR_NAME / "work")

        with pytest.raises(AccountError):
            delete_account("ana-1234abcd")
        assert home.is_dir()

    def test_other_accounts_stay_deletable_while_one_is_active(
        self, install_root, monkeypatch
    ):
        ensure_account_home("ana-1234abcd")
        other = ensure_account_home("bob-5678abcd")
        use_home(monkeypatch, get_account_home("ana-1234abcd"))

        delete_account("bob-5678abcd")

        assert not other.exists()
        assert account_exists("ana-1234abcd")

    def test_unknown_account_raises(self, install_root, monkeypatch):
        use_home(monkeypatch, install_root)
        with pytest.raises(AccountError):
            delete_account("ana-1234abcd")


# ---------------------------------------------------------------------------
# Service naming / child-process argv
# ---------------------------------------------------------------------------

def _parse_profile_arg(arg: str) -> tuple[str | None, str | None]:
    """Decode ``--account a --profile p`` back into a scope tuple."""
    tokens = arg.split()
    pairs = dict(zip(tokens[0::2], tokens[1::2]))
    assert set(pairs) <= {"--account", "--profile"}, arg
    assert len(pairs) * 2 == len(tokens), arg
    return pairs.get("--account"), pairs.get("--profile")


class TestGatewayScopeArgv:
    """A service unit must reproduce the home it was generated for."""

    @pytest.mark.parametrize(
        "relative",
        [
            "",
            f"{PROFILES_DIR_NAME}/work",
            f"{ACCOUNTS_DIR_NAME}/ana-1234abcd",
            f"{ACCOUNTS_DIR_NAME}/ana-1234abcd/{PROFILES_DIR_NAME}/work",
        ],
    )
    def test_profile_arg_round_trips_the_home(
        self, install_root, monkeypatch, relative
    ):
        from hermes_cli import gateway

        home = install_root / relative if relative else install_root
        use_home(monkeypatch, home)

        assert _parse_profile_arg(gateway._profile_arg()) == split_home_scope(home)

    def test_account_flag_precedes_profile_flag(self, install_root, monkeypatch):
        from hermes_cli import gateway

        home = (
            install_root
            / ACCOUNTS_DIR_NAME
            / "ana-1234abcd"
            / PROFILES_DIR_NAME
            / "work"
        )
        use_home(monkeypatch, home)
        tokens = gateway._profile_arg().split()
        assert tokens.index("--account") < tokens.index("--profile")

    def test_explicit_home_beats_the_environment(self, install_root, monkeypatch):
        from hermes_cli import gateway

        use_home(monkeypatch, install_root)
        home = install_root / ACCOUNTS_DIR_NAME / "ana-1234abcd"
        assert _parse_profile_arg(gateway._profile_arg(str(home))) == (
            "ana-1234abcd",
            None,
        )

    def test_root_needs_no_flags(self, install_root, monkeypatch):
        from hermes_cli import gateway

        use_home(monkeypatch, install_root)
        assert gateway._profile_arg() == ""
        assert gateway._profile_suffix() == ""

    def test_suffix_distinguishes_every_scope(self, install_root, monkeypatch):
        """A collision here would have one person's unit overwrite another's."""
        from hermes_cli import gateway

        homes = {
            "root": install_root,
            "profile": install_root / PROFILES_DIR_NAME / "work",
            "account_a": install_root / ACCOUNTS_DIR_NAME / "ana-1234abcd",
            "account_b": install_root / ACCOUNTS_DIR_NAME / "bob-5678abcd",
            "account_a_profile": install_root
            / ACCOUNTS_DIR_NAME
            / "ana-1234abcd"
            / PROFILES_DIR_NAME
            / "work",
        }
        suffixes = {}
        for label, home in homes.items():
            use_home(monkeypatch, home)
            suffixes[label] = gateway._profile_suffix()

        assert len(set(suffixes.values())) == len(suffixes), suffixes
        assert suffixes["account_a"] != suffixes["account_b"]
        assert suffixes["account_a"] != suffixes["profile"]

    def test_service_names_do_not_collide_across_accounts(
        self, install_root, monkeypatch
    ):
        from hermes_cli import gateway

        use_home(monkeypatch, install_root / ACCOUNTS_DIR_NAME / "ana-1234abcd")
        first = gateway.get_service_name()
        use_home(monkeypatch, install_root / ACCOUNTS_DIR_NAME / "bob-5678abcd")
        second = gateway.get_service_name()

        assert first != second
        assert "ana-1234abcd" in first and "bob-5678abcd" in second

    def test_unrecognised_home_under_the_root_falls_back_to_a_hash(
        self, install_root, monkeypatch
    ):
        """No flags can reproduce it, so the suffix must not be reusable either."""
        from hermes_cli import gateway

        use_home(monkeypatch, install_root / "custom" / "home")
        assert gateway._profile_arg() == ""
        suffix = gateway._profile_suffix()
        assert suffix and os.sep not in suffix

        use_home(monkeypatch, install_root / "custom" / "other")
        assert gateway._profile_suffix() != suffix
