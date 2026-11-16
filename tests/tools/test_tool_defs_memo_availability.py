"""The quiet-mode ``get_tool_definitions`` memo must not outlive the check_fn verdicts it filtered on.

An MCP server whose connection dropped (check_fn False) and came back without re-registering its
tools left the memo holding the omission: ``tool_search`` / ``tool_describe`` read the memo, so the
recovered server stayed invisible for the life of the process, ``/new`` included.
"""

import pytest

import model_tools
from model_tools import get_tool_definitions
from tools import registry as registry_mod
from tools.registry import invalidate_check_fn_cache, registry

MAIL = "mcp__probe_mail__list_messages"
ANCHOR = "mcp__probe_anchor__ping"
BRIDGE_KW = {"quiet_mode": True, "skip_tool_search_assembly": True}
BOTH = ["mcp-probe-mail", "mcp-probe-anchor"]


def _schema(name, description):
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": {}}}


def _names(defs):
    return {d["function"]["name"] for d in defs}


def _reprobe():
    invalidate_check_fn_cache()
    model_tools._clear_tool_defs_cache()


class _Clock:
    """A ``time`` stand-in whose monotonic() only moves when a test advances it."""

    def __init__(self, real):
        self._real = real
        self.now = real.monotonic()

    def monotonic(self):
        return self.now

    def __getattr__(self, name):
        return getattr(self._real, name)


@pytest.fixture
def mail_state():
    """A recovering MCP-style tool (mail) next to an always-healthy one (anchor)."""
    state = {"up": False, "probes": 0}

    def mail_connected():
        state["probes"] += 1
        return state["up"]

    registry.register(name=MAIL, toolset="mcp-probe-mail",
                      schema=_schema(MAIL, "List messages in the probe mailbox"),
                      handler=lambda args, **kw: "MAIL_OK", check_fn=mail_connected)
    registry.register(name=ANCHOR, toolset="mcp-probe-anchor",
                      schema=_schema(ANCHOR, "Ping the anchor server"),
                      handler=lambda args, **kw: "ANCHOR_OK", check_fn=lambda: True)
    _reprobe()
    yield state
    registry.deregister(MAIL)
    registry.deregister(ANCHOR)
    _reprobe()


@pytest.fixture
def clock(monkeypatch):
    """One fake monotonic clock for the verdict cache and the definitions memo."""
    module_clock = _Clock(registry_mod.time)
    monkeypatch.setattr(registry_mod, "time", module_clock)
    monkeypatch.setattr(model_tools, "time", module_clock)
    return module_clock


def test_reporter_reproducer_explicit_invalidation_reaches_quiet_memo(mail_state):
    kwargs = {"enabled_toolsets": ["mcp-probe-mail"], **BRIDGE_KW}
    assert get_tool_definitions(**kwargs) == []

    mail_state["up"] = True
    invalidate_check_fn_cache()  # e.g. after `agentx tools enable`

    assert _names(get_tool_definitions(**kwargs)) == {MAIL}


def test_false_to_true_recovers_on_natural_ttl_expiry(mail_state, clock):
    kwargs = {"enabled_toolsets": BOTH, **BRIDGE_KW}
    assert _names(get_tool_definitions(**kwargs)) == {ANCHOR}

    mail_state["up"] = True  # the server reconnected; nothing re-registered, nothing invalidated
    clock.now += registry_mod._CHECK_FN_TTL_SECONDS - 1
    assert _names(get_tool_definitions(**kwargs)) == {ANCHOR}  # the False verdict is still within its TTL

    clock.now += 2
    assert _names(get_tool_definitions(**kwargs)) == {ANCHOR, MAIL}


def test_memo_hits_within_verdict_ttl(mail_state, clock, monkeypatch):
    computes = []
    real_compute = model_tools._compute_tool_definitions

    def counting_compute(*args, **kwargs):
        computes.append(1)
        return real_compute(*args, **kwargs)

    monkeypatch.setattr(model_tools, "_compute_tool_definitions", counting_compute)
    kwargs = {"enabled_toolsets": BOTH, **BRIDGE_KW}
    for _ in range(5):
        get_tool_definitions(**kwargs)
        clock.now += 5
    assert len(computes) == 1
    assert mail_state["probes"] == 1

    clock.now += registry_mod._CHECK_FN_TTL_SECONDS
    get_tool_definitions(**kwargs)
    get_tool_definitions(**kwargs)
    assert len(computes) == 2
    assert mail_state["probes"] == 2


def test_true_to_false_respects_ttl_then_failure_grace(mail_state, clock):
    ttl, grace = registry_mod._CHECK_FN_TTL_SECONDS, registry_mod._CHECK_FN_FAILURE_GRACE_SECONDS
    kwargs = {"enabled_toolsets": BOTH, **BRIDGE_KW}
    mail_state["up"] = True
    start = clock.now
    assert MAIL in _names(get_tool_definitions(**kwargs))

    mail_state["up"] = False  # connection dropped
    clock.now = start + ttl - 1
    assert MAIL in _names(get_tool_definitions(**kwargs))  # cached True verdict
    assert mail_state["probes"] == 1

    clock.now = start + ttl + 1
    assert MAIL in _names(get_tool_definitions(**kwargs))  # failure inside the grace window: a flake
    clock.now += 1
    assert MAIL in _names(get_tool_definitions(**kwargs))
    assert mail_state["probes"] == 3  # the grace verdict is not memoized: every call re-probes

    clock.now = start + grace + 1
    assert _names(get_tool_definitions(**kwargs)) == {ANCHOR}  # grace over: the failure is honored


def test_restricted_toolset_never_gains_the_recovered_tool(mail_state, clock):
    restricted = {"enabled_toolsets": ["mcp-probe-anchor"], **BRIDGE_KW}
    assert _names(get_tool_definitions(**restricted)) == {ANCHOR}
    mail_state["up"] = True
    clock.now += registry_mod._CHECK_FN_TTL_SECONDS + 1
    invalidate_check_fn_cache()
    assert _names(get_tool_definitions(**restricted)) == {ANCHOR}


def test_tool_search_scope_reads_the_live_memo(monkeypatch):
    """tool_call's scope check reads the memo on every call, never a per-agent copy that
    would keep a recovered tool uncallable for the agent's lifetime."""
    from types import SimpleNamespace

    from agent.tool_executor import _tool_search_scoped_names

    calls = []

    def fake_defs(**kwargs):
        calls.append(kwargs)
        return []

    monkeypatch.setattr(model_tools, "get_tool_definitions", fake_defs)
    agent = SimpleNamespace(enabled_toolsets=BOTH, disabled_toolsets=None)
    _tool_search_scoped_names(agent)
    _tool_search_scoped_names(agent)
    assert len(calls) == 2
    assert calls[0] == {"enabled_toolsets": BOTH, "disabled_toolsets": None, **BRIDGE_KW}
    assert not hasattr(agent, "_tool_search_scope_cache")
