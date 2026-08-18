"""Per-person AgentX homes.

AgentX Workmate installs onto an employee's own machine, but the accounts are
central: everybody signs in with the Keycloak account AgentX already knows.
This module gives each of those accounts a state directory of its own at
``<root>/accounts/<slug>``, so two people who sign in on the same laptop share
nothing — not the provider key, not the chat history, not the memory files,
not the config.

The two axes do not compete:

    <root>/                                   install: checkout, venv, node
    <root>/accounts/<slug>/                   a person
    <root>/accounts/<slug>/profiles/<name>/   that person's workspaces

An install with nobody signed in has no ``accounts/`` directory at all and
keeps using ``<root>`` directly, which is exactly what every pre-account
install already does. Nothing migrates, nothing moves.

The slug is derived from the Keycloak identity rather than chosen by the user,
because the desktop app has to pick the directory *before* it can ask a
backend anything (see ``apps/desktop/electron/account-slug.ts``, which
implements the identical derivation and is locked to this one by shared test
vectors). Deriving it means the same person always lands in the same home, on
every machine, with no state to keep in sync.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from hermes_constants import (
    ACCOUNTS_DIR_NAME,
    account_slug_for_home,
    get_account_home,
    get_accounts_root,
    get_active_account,
)

# Same shape as a profile id so both namespaces read alike on disk and in argv.
ACCOUNT_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# Identity sidecar written next to the account's state. It exists so
# ``agentx account list`` can name a person instead of a slug, and so a
# support engineer reading a laptop's disk can tell whose home is whose.
# It holds no credential — the tokens live in the OS keychain (desktop) and
# the provider key lives in the account's .env.
ACCOUNT_IDENTITY_FILENAME = "account.json"

# Directories bootstrapped inside a new account home. Mirrors the profile
# skeleton (hermes_cli.profiles._PROFILE_DIRS) because an account home IS an
# AGENTX_HOME — everything that reads a profile home reads this too.
_ACCOUNT_DIRS = (
    "memories",
    "sessions",
    "skills",
    "skins",
    "logs",
    "plans",
    "workspace",
    "cron",
    "home",
)

# Longest human-readable prefix kept in a slug. The suffix that follows is
# what actually guarantees uniqueness, so this only has to stay short enough
# that the whole slug is comfortable to type and read in a path.
_SLUG_LABEL_MAX = 24

# Hex characters of the subject digest appended to every slug. Eight is the
# same width the gateway uses to disambiguate arbitrary homes
# (hermes_cli.gateway._profile_suffix) and is far past collision risk for the
# number of accounts one machine will ever hold.
_SLUG_DIGEST_CHARS = 8

# Longest username fragment in a LiteLLM key alias (`second-brain-letrungkien`).
_LITELLM_KEY_ALIAS_LABEL_MAX = 48


class AccountError(Exception):
    """Raised when an account cannot be resolved, created, or removed."""


@dataclass(frozen=True)
class AccountIdentity:
    """Who an account belongs to, as told to us by the identity provider."""

    subject: str
    username: str = ""
    email: str = ""
    display_name: str = ""
    issuer: str = ""

    def to_json(self) -> dict[str, str]:
        return {
            "subject": self.subject,
            "username": self.username,
            "email": self.email,
            "display_name": self.display_name,
            "issuer": self.issuer,
        }

    @classmethod
    def from_json(cls, data: dict) -> "AccountIdentity":
        return cls(
            subject=str(data.get("subject") or ""),
            username=str(data.get("username") or ""),
            email=str(data.get("email") or ""),
            display_name=str(data.get("display_name") or ""),
            issuer=str(data.get("issuer") or ""),
        )


@dataclass(frozen=True)
class AccountInfo:
    """An account home on disk, plus whatever identity it recorded."""

    slug: str
    home: Path
    identity: AccountIdentity | None
    is_active: bool

    @property
    def label(self) -> str:
        """Return the friendliest name we can put in front of a human."""
        ident = self.identity
        if ident:
            for candidate in (ident.display_name, ident.email, ident.username):
                if candidate:
                    return candidate
        return self.slug


def litellm_key_alias_label(
    *,
    username: str = "",
    display_name: str = "",
    email: str = "",
    subject: str = "",
) -> str:
    """Return the human-readable half of a LiteLLM key alias.

    Keycloak usernames and display names may carry accents and spaces; LiteLLM
    aliases are plain ASCII labels. ``Lê Trung Kiên`` becomes ``letrungkien``.
    """
    raw = (username or display_name or "").strip()
    if not raw:
        raw = (email or "").strip().split("@", 1)[0]

    normalized = unicodedata.normalize("NFD", raw)
    stripped = "".join(c for c in normalized if unicodedata.category(c) != "Mn")
    label = re.sub(r"[^a-z0-9]+", "", stripped.casefold())

    if label:
        return label[:_LITELLM_KEY_ALIAS_LABEL_MAX]

    subject = (subject or "").strip()
    if subject:
        digest = hashlib.sha256(subject.encode("utf-8")).hexdigest()[:_SLUG_DIGEST_CHARS]
        return f"u{digest}"
    return "user"


def litellm_key_alias_for_identity(
    prefix: str,
    *,
    subject: str,
    username: str = "",
    display_name: str = "",
    email: str = "",
) -> str:
    """Build ``{prefix}-{username}``, e.g. ``second-brain-letrungkien``."""
    label = litellm_key_alias_label(
        username=username,
        display_name=display_name,
        email=email,
        subject=subject,
    )
    return f"{prefix}-{label}"


def _slug_label(username: str, email: str) -> str:
    """Return the readable half of a slug, or ``""`` when there is none.

    Prefers the username, falls back to the local part of the email. Anything
    that is not ``[a-z0-9]`` becomes a hyphen, because this ends up as a
    directory name on three operating systems and inside argv.
    """
    raw = (username or "").strip()
    if not raw:
        raw = (email or "").strip().split("@", 1)[0]
    lowered = raw.casefold()
    hyphenated = re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")
    return hyphenated[:_SLUG_LABEL_MAX].strip("-")


def account_slug_for_identity(
    subject: str,
    username: str = "",
    email: str = "",
) -> str:
    """Return the stable account slug for a Keycloak identity.

    ``subject`` is the only input that must be present and must be the IdP's
    immutable ``sub`` claim: it is what the digest is taken over, so the slug
    survives a user renaming themselves or changing their email. The readable
    label is cosmetic — two people whose usernames collide after sanitizing
    still get different homes.

    Mirrored byte-for-byte by ``accountSlugForIdentity`` in
    ``apps/desktop/electron/account-slug.ts``; the shared vectors in
    ``tests/hermes_cli/test_accounts.py`` and ``account-slug.test.ts`` are what
    keep them honest.
    """
    subject = (subject or "").strip()
    if not subject:
        raise AccountError("cannot derive an account slug without a subject claim")

    digest = hashlib.sha256(subject.encode("utf-8")).hexdigest()[:_SLUG_DIGEST_CHARS]
    label = _slug_label(username, email)
    slug = f"{label}-{digest}" if label else f"u-{digest}"

    if not ACCOUNT_SLUG_RE.match(slug):
        # Unreachable for any label the sanitizer can produce; a raise here
        # beats writing a path we did not intend.
        raise AccountError(f"derived an invalid account slug: {slug!r}")
    return slug


def validate_account_slug(slug: str) -> None:
    """Raise :class:`AccountError` unless *slug* is a legal account id."""
    if not isinstance(slug, str) or not ACCOUNT_SLUG_RE.match(slug):
        raise AccountError(
            f"Invalid account {slug!r}. Must match [a-z0-9][a-z0-9_-]{{0,63}}"
        )
    if slug in {ACCOUNTS_DIR_NAME, "profiles", "default"}:
        raise AccountError(
            f"Account name {slug!r} is reserved — it collides with the "
            "on-disk layout."
        )


def account_home(slug: str) -> Path:
    """Return the AGENTX_HOME for *slug* after validating it."""
    validate_account_slug(slug)
    return get_account_home(slug)


def account_exists(slug: str) -> bool:
    """Return True when *slug* already has a home on this machine."""
    try:
        return account_home(slug).is_dir()
    except AccountError:
        return False


def read_account_identity(slug_or_home: str | Path) -> AccountIdentity | None:
    """Return the identity recorded for an account, or None when unreadable.

    Accepts either a slug or the home directory itself, which is what lets
    ``list_accounts`` reuse it while walking paths it already has. A slug can
    never contain a separator (:data:`ACCOUNT_SLUG_RE` forbids one), so the two
    cannot be confused.

    A missing or corrupt sidecar is not an error: the account's *state* is the
    directory, and losing the display name must never cost somebody access to
    their sessions.
    """
    if isinstance(slug_or_home, Path):
        home = slug_or_home
    elif ACCOUNT_SLUG_RE.match(str(slug_or_home)):
        home = account_home(str(slug_or_home))
    else:
        home = Path(slug_or_home)
    path = home / ACCOUNT_IDENTITY_FILENAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    identity = AccountIdentity.from_json(data)
    return identity if identity.subject else None


def write_account_identity(slug: str, identity: AccountIdentity) -> Path:
    """Record who an account belongs to. Returns the sidecar path."""
    home = account_home(slug)
    home.mkdir(parents=True, exist_ok=True)
    path = home / ACCOUNT_IDENTITY_FILENAME
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(identity.to_json(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    try:
        os.chmod(str(tmp), 0o600)
    except OSError:
        pass
    tmp.replace(path)
    return path


def ensure_account_home(slug: str, identity: AccountIdentity | None = None) -> Path:
    """Create (or adopt) the account home for *slug* and return it.

    Idempotent: an existing home is left alone apart from refreshing the
    identity sidecar, so signing in twice is not a destructive act. Unlike
    ``agentx profile create`` this does not seed bundled skills — the account
    home is created on the sign-in path, where a 9 MB synchronous copy would
    be felt, and ``agentx update``'s skill sync reaches it afterwards.
    """
    home = account_home(slug)
    created = not home.exists()
    home.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(str(home), 0o700)
    except OSError:
        pass

    for subdir in _ACCOUNT_DIRS:
        (home / subdir).mkdir(parents=True, exist_ok=True)

    env_path = home / ".env"
    if not env_path.exists():
        try:
            env_path.write_text(
                "# Secrets for this AgentX Workmate account.\n"
                "# Written by sign-in; API keys here override the shell environment.\n"
                "# Behavioral settings belong in config.yaml, not here.\n",
                encoding="utf-8",
            )
            os.chmod(str(env_path), 0o600)
        except OSError:
            pass  # best-effort — save_env_value creates the file on demand

    soul_path = home / "SOUL.md"
    if created and not soul_path.exists():
        try:
            from hermes_cli.default_soul import DEFAULT_SOUL_MD

            soul_path.write_text(DEFAULT_SOUL_MD, encoding="utf-8")
        except Exception:
            pass  # best-effort — an account without a SOUL.md still works

    if identity is not None:
        try:
            write_account_identity(slug, identity)
        except OSError:
            pass  # cosmetic; never block sign-in on it

    return home


def list_accounts() -> list[AccountInfo]:
    """Return every account on this machine, slug-sorted."""
    root = get_accounts_root()
    active = get_active_account()
    try:
        entries = sorted(p for p in root.iterdir() if p.is_dir())
    except OSError:
        return []

    accounts: list[AccountInfo] = []
    for entry in entries:
        slug = entry.name
        if not ACCOUNT_SLUG_RE.match(slug):
            continue
        accounts.append(
            AccountInfo(
                slug=slug,
                home=entry,
                identity=read_account_identity(entry),
                is_active=(slug == active),
            )
        )
    return accounts


def find_account_for_subject(subject: str) -> AccountInfo | None:
    """Return the account whose recorded identity has this ``sub`` claim.

    Used to recognise a returning user whose username or email changed since
    the home was created: the slug would derive differently now, but the
    subject still points at the state they already have.
    """
    subject = (subject or "").strip()
    if not subject:
        return None
    for info in list_accounts():
        if info.identity and info.identity.subject == subject:
            return info
    return None


def resolve_account_for_identity(
    subject: str,
    username: str = "",
    email: str = "",
) -> str:
    """Return the slug this identity should use, adopting an existing home.

    Prefers a home already recorded against this subject over a freshly
    derived slug, so a rename in Keycloak does not silently orphan somebody's
    sessions behind a new directory.
    """
    existing = find_account_for_subject(subject)
    if existing:
        return existing.slug
    return account_slug_for_identity(subject, username=username, email=email)


def delete_account(slug: str) -> Path:
    """Remove an account home and everything inside it. Returns the path.

    Refuses to touch the account the calling process is running under: the
    directory would be recreated underneath us by the next ``load_config()``,
    leaving a half-deleted home that looks fine and has lost its data.
    """
    home = account_home(slug)
    if not home.is_dir():
        raise AccountError(f"Account {slug!r} does not exist at {home}")
    if account_slug_for_home(os.environ.get("AGENTX_HOME", "")) == slug:
        raise AccountError(
            f"Refusing to delete account {slug!r} while it is the active "
            "account for this process. Switch accounts first."
        )
    shutil.rmtree(home)
    return home
