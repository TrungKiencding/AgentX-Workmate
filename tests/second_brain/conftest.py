"""Fixtures for the second-brain service: a real Postgres and a fake realm.

**A real Postgres, never a SQLite stand-in.** The service's correctness rests
on things SQLite does not have — ``FOR UPDATE`` row locking inside
``brain_put_document``, JSONB, ``ON CONFLICT`` with a guard clause, genuine
concurrent transactions. A test suite that swapped the database for SQLite
would be testing an abstraction layer nobody deploys, and the abstraction layer
itself is precisely the debt this design set out not to accumulate.

Where that Postgres comes from, in order:

1. ``AGENTX_BRAIN_TEST_DSN`` — a database you already have. Fastest, and how
   CI should supply one.
2. Docker, if it is running: a throwaway ``postgres:17-alpine`` on a random
   port, created for this pytest process and removed when it exits. The data
   directory is a tmpfs, so it is fast and leaves nothing behind.
3. Neither — the module skips, with the two commands that would fix it.

Isolation is two-layered, because the suite runs one process per test FILE and
twenty of them at once (``scripts/run_tests_parallel.py``):

* each **process** gets a Postgres schema of its own, so one file's migrations
  and one file's truncates cannot touch another file's rows;
* each **test** starts with that schema emptied.

A single shared set of tables would look fine when a file is run alone and fail
intermittently under the real runner, which is the worst way for a test suite
to be wrong.

The realm is a fake. Nothing here reaches Keycloak: the point of injecting a
provider is that the outage path — the one that must answer 503 and not 401 —
is exercised on every run instead of being reasoned about.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
import uuid
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio

from hermes_cli.dashboard_auth.base import ProviderError, Session
from second_brain.settings import BrainSettings
from second_brain.store.engine import Store
from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider

#: Point the suite at a database you already have to skip the container.
DSN_ENV_VAR = "AGENTX_BRAIN_TEST_DSN"

#: A KEK that is obviously a test KEK. 32 bytes, base64, as the real one must
#: be — the settings loader validates the length and would reject a shorter
#: placeholder.
TEST_KEK = "c2Vjb25kLWJyYWluLXRlc3Qta2VrLTMyLWJ5dGVzISE="

_IMAGE = "postgres:17-alpine"
_BOOT_TIMEOUT_SECONDS = 60.0


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _docker_available() -> bool:
    if not shutil.which("docker"):
        return False
    return (
        subprocess.run(
            ["docker", "info"],
            capture_output=True,
            timeout=30,
            check=False,
        ).returncode
        == 0
    )


@pytest.fixture(scope="session")
def postgres_dsn():
    """A DSN pointing at a Postgres this session may create tables in."""
    existing = (os.environ.get(DSN_ENV_VAR) or "").strip()
    if existing:
        yield existing
        return

    if not _docker_available():
        pytest.skip(
            "The second-brain suite needs a real Postgres. Either export "
            f"{DSN_ENV_VAR}=postgresql://user:pass@host:port/db, or start "
            "Docker and let the fixture create a throwaway one "
            "(`make -C deploy/second-brain test-db` prints a ready-made DSN)."
        )

    port = _free_port()
    name = f"agentx-brain-test-{uuid.uuid4().hex[:8]}"
    subprocess.run(
        [
            "docker", "run", "--rm", "-d",
            "--name", name,
            "-e", "POSTGRES_PASSWORD=brain",
            "-e", "POSTGRES_USER=brain",
            "-e", "POSTGRES_DB=brain",
            "-p", f"127.0.0.1:{port}:5432",
            # No durability wanted from a database that lives for one test run.
            "--tmpfs", "/var/lib/postgresql/data",
            _IMAGE,
        ],
        check=True,
        capture_output=True,
        timeout=300,
    )

    try:
        deadline = time.monotonic() + _BOOT_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            ready = subprocess.run(
                # ``-h 127.0.0.1`` forces the probe over TCP, and that is the
                # whole point of it. The postgres entrypoint runs initdb
                # against a temporary server that listens on the unix socket
                # ONLY, so a plain `pg_isready` answers "ready" during a phase
                # in which nothing outside the container can connect. The
                # tests connect over TCP, so the probe must too — otherwise
                # the first test to touch the database loses a race with
                # initdb and fails with "unexpected connection_lost()".
                ["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "brain", "-d", "brain"],
                capture_output=True,
                check=False,
                timeout=30,
            )
            if ready.returncode == 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError(f"{_IMAGE} did not become ready in {_BOOT_TIMEOUT_SECONDS}s")

        yield f"postgresql://brain:brain@127.0.0.1:{port}/brain"
    finally:
        subprocess.run(
            ["docker", "rm", "-f", name], capture_output=True, check=False, timeout=60
        )


@pytest.fixture(scope="session")
def brain_dsn(postgres_dsn):
    """A DSN scoped to a schema this pytest process owns outright.

    The runner gives each test FILE its own process and runs twenty at once
    against one database. Without a schema per process, one file's ``TRUNCATE``
    lands in the middle of another file's test — which shows up as a handful of
    unrelated failures that pass when rerun alone, and costs a day to diagnose.

    ``search_path`` carries it: the migrations create their tables unqualified,
    so they land here, and every query in the process resolves here too.
    """
    import asyncio
    import os
    import urllib.parse

    import asyncpg

    schema = f"brain_test_{os.getpid()}_{uuid.uuid4().hex[:8]}"

    async def _run(statement: str) -> None:
        connection = await asyncpg.connect(postgres_dsn)
        try:
            await connection.execute(statement)
        finally:
            await connection.close()

    asyncio.run(_run(f'CREATE SCHEMA "{schema}"'))
    try:
        separator = "&" if "?" in postgres_dsn else "?"
        yield postgres_dsn + separator + urllib.parse.urlencode(
            {"options": f"-c search_path={schema}"}
        )
    finally:
        asyncio.run(_run(f'DROP SCHEMA "{schema}" CASCADE'))


@pytest.fixture(scope="session")
def brain_settings(brain_dsn) -> BrainSettings:
    """Settings pointed at this process's schema."""
    from second_brain.settings import decode_kek

    return BrainSettings(
        database_url=brain_dsn,
        kek=decode_kek(TEST_KEK),
        kek_id="test",
        pool_min=1,
        # Above the number of connections any single test holds concurrently,
        # so the cursor test's genuinely parallel transactions do not simply
        # queue on the pool and stop being concurrent.
        pool_max=8,
    )


@pytest_asyncio.fixture
async def store(brain_settings):
    """A migrated store on an empty schema.

    Function-scoped and truncating rather than session-scoped, because a test
    that can see another test's devices is a test that passes for the wrong
    reason. The truncate runs on its own connection rather than through the
    store, so no reset path has to exist in the production API just to make
    the suite convenient.
    """
    import asyncpg

    opened = await Store.connect(brain_settings)
    await opened.migrate()

    scrub = await asyncpg.connect(brain_settings.database_url)
    try:
        # accounts cascades to devices, model_keys and documents.
        await scrub.execute("TRUNCATE accounts CASCADE")
    finally:
        await scrub.close()

    try:
        yield opened
    finally:
        await opened.close()


@pytest_asyncio.fixture
async def raw_pg(brain_settings):
    """A connection of the test's own, outside the store.

    For the two things a test legitimately needs that the store's API does
    not offer: reading the catalog to check what the migration created, and
    holding a transaction open to prove that one person's write does not block
    another's.
    """
    import asyncpg

    connection = await asyncpg.connect(brain_settings.database_url)
    try:
        yield connection
    finally:
        await connection.close()


class FakeRealm(StubAuthProvider):
    """A realm that recognises exactly the tokens a test hands it.

    Subclasses the suite's stub so the provider protocol stays satisfied, and
    overrides only ``verify_session`` — the single method the service calls —
    so one test can hold two people and simulate an identity-provider outage.
    """

    name = "fake-realm"

    def __init__(self) -> None:
        super().__init__()
        self.sessions: dict[str, Session] = {}
        self.outage_tokens: set[str] = set()

    def add(
        self,
        token: str,
        *,
        subject: str,
        email: str = "",
        display_name: str = "",
    ) -> Session:
        session = Session(
            user_id=subject,
            email=email,
            display_name=display_name,
            org_id="",
            provider=self.name,
            expires_at=int(time.time()) + 3600,
            access_token=token,
            refresh_token="",
        )
        self.sessions[token] = session
        return session

    def verify_session(self, *, access_token: str):
        if access_token in self.outage_tokens:
            raise ProviderError("JWKS endpoint unreachable")
        return self.sessions.get(access_token)


@pytest.fixture
def realm() -> FakeRealm:
    return FakeRealm()


@pytest.fixture
def build_brain(brain_settings, store, realm):
    """Build an app on the session's database and this test's realm.

    Returns a callable so a test can pass its own ``rotate_key`` hook or its
    own LiteLLM double without repeating the wiring.
    """
    from second_brain.app import build_app

    def _build(**overrides):
        kwargs = {
            "settings": brain_settings,
            "provider": realm,
            "store": store,
            # Explicitly absent rather than resolved from the environment: a
            # test must never be one stray variable away from calling a real
            # proxy.
            "litellm": None,
        }
        kwargs.update(overrides)
        return build_app(**kwargs)

    return _build


@asynccontextmanager
async def brain_client(app):
    """Drive *app* over ASGI from the test's own event loop.

    Not ``TestClient``: that runs the app in a private event loop on another
    thread, and an asyncpg pool belongs to exactly one loop — sharing one
    across the two fails with "another operation is in progress" the moment a
    route touches the database. Going through ``ASGITransport`` keeps the app,
    the store and the test in one loop, which is also closer to how the
    service actually runs.

    The lifespan is entered explicitly so startup and shutdown are exercised
    rather than skipped.
    """
    import httpx

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://second-brain.test"
        ) as client:
            yield client


@pytest_asyncio.fixture
async def client(build_brain):
    """An HTTP client over the real app, with the real routes and real auth."""
    async with brain_client(build_brain()) as connected:
        yield connected


def auth_headers(token: str, device_id: str, name: str = "test device") -> dict[str, str]:
    """The headers every authenticated request carries."""
    return {
        "Authorization": f"Bearer {token}",
        "X-AgentX-Device": device_id,
        "X-AgentX-Device-Name": name,
    }


def new_device_id() -> str:
    """A device id in the shape ``device-id.ts`` generates."""
    return str(uuid.uuid4())
