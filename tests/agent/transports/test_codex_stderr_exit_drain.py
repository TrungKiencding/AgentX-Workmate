"""A crashed app-server's diagnostic backlog must be read before reporting its exit."""

import subprocess
import sys
import threading

import pytest

from agent.transports.codex_app_server import CodexAppServerClient


@pytest.mark.timeout(5)
def test_crash_stderr_tail_waits_for_the_reader_backlog(monkeypatch):
    release = threading.Event()
    real_popen = subprocess.Popen

    def spawn_fixture(cmd, **kwargs):
        return real_popen([sys.executable, "-c", "import sys; sys.stderr.write('fatal fixture error\\n'); sys.exit(1)"], **kwargs)

    class DelayedReader(CodexAppServerClient):
        def _read_stderr(self):
            release.wait(timeout=3)
            super()._read_stderr()

    monkeypatch.setattr("agent.transports.codex_app_server.subprocess.Popen", spawn_fixture)
    client = DelayedReader()
    timer = None
    try:
        assert client._proc.wait(timeout=2) == 1
        # The child has exited, but stderr is deliberately still held by its reader.
        timer = threading.Timer(0.2, release.set)
        timer.start()
        assert client.stderr_tail() == ["fatal fixture error"]
    finally:
        release.set()
        if timer is not None:
            timer.cancel()
            timer.join(timeout=1)
        client.close()
        client._stderr_reader.join(timeout=1)
        client._reader.join(timeout=1)
        for stream in (client._proc.stdin, client._proc.stdout, client._proc.stderr):
            if stream is not None:
                stream.close()
