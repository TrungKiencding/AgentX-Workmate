"""The branding gate must catch regressions, not merely report a clean tree.

``scripts/rebrand/check_branding.py`` reports zero on this tree.  A gate that
reports zero because it stopped looking is worse than no gate, so these tests
drive it from both sides: strings that MUST fail it, and the deliberately-kept
names that must not.

The first case is the one that motivated this file.  The gate's brand pattern
was compiled with a blanket ``re.IGNORECASE``, which also folded the ``[a-z]``
in its own "followed by an underscore and a lowercase letter" guard — so ``_H``
satisfied the internal-identifier exemption and ``HERMES_HOME``, the single
most likely way for the brand to come back, was silently allowed by the check
whose docstring promised to catch it.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
_SPEC = importlib.util.spec_from_file_location(
    "branding_gate", REPO_ROOT / "scripts" / "rebrand" / "check_branding.py"
)
gate = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = gate
_SPEC.loader.exec_module(gate)


# ── Things the gate must flag ────────────────────────────────────────────
#
# One per way the brand could plausibly come back: an env var, a config dir, a
# display string, a CLI command in prose, the glyph, an IPC channel, the dead
# docs host, the vendor credit, and the transliteration no ASCII check sees.
MUST_FAIL = [
    ("hermes_cli/main.py", 'os.environ["HERMES_HOME"]'),
    ("hermes_cli/main.py", 'if os.getenv("HERMES_YOLO_MODE"):'),
    ("hermes_cli/main.py", 'config_dir = Path.home() / ".hermes"'),
    ("agent/prompt_builder.py", '"You are Hermes Agent, an AI assistant."'),
    ("agent/prompt_builder.py", '"You run on Hermes Desktop."'),
    ("README.md", "Install with `hermes setup` to get started."),
    ("README.md", "Built by [Nous Research](https://nousresearch.com)."),
    ("hermes_cli/banner.py", "print('Hermes ⚕')"),
    ("apps/desktop/electron/main.ts", "ipcRenderer.invoke('hermes:api')"),
    ("docs/install.md", "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"),
    ("README.ur-pk.md", "ہرمیس ایجنٹ انسٹال کریں"),
    ("hermes_cli/x.py", 'subprocess.run(["hermes", "--version"])'),
    ("web/src/App.tsx", 'localStorage.getItem("hermes-sidebar-collapsed")'),
]

# ── Things the gate must NOT flag ────────────────────────────────────────
#
# The deliberately-kept names, one per ALLOWED entry: module names, model
# slugs a provider API expects, third-party packages, upstream citations, the
# provider's own hosts, internal identifiers, migration allowlists, and the
# unicode fixture that is not a brand mark.
MUST_PASS = [
    ("hermes_cli/main.py", "from hermes_cli.config import get_hermes_home"),
    ("hermes_cli/state.py", "hermes_home = get_hermes_home()"),
    ("agent/models.py", 'model = "hermes-4-405b"'),
    ("agent/coding_context.py", '("claude", "hermes", "llama", "mistral")'),
    ("apps/desktop/src/a.tsx", "import { listSessions } from '@/hermes'"),
    ("apps/desktop/src/b.ts", "import type { Cfg } from '@/types/hermes'"),
    ("package.json", '"hermes-parser": "^0.20.0"'),
    ("agent/x.py", "# See https://github.com/NousResearch/hermes-agent/issues/10454"),
    ("agent/y.py", "# Fixed in NousResearch/hermes-agent#53027"),
    ("hermes_cli/auth.py", 'PORTAL = "https://portal.nousresearch.com"'),
    ("plugins/model-providers/nous/__init__.py", 'display_name = "Nous Research"'),
    ("apps/desktop/src/b.ts", "const cfg: HermesConfigRecord = load()"),
    ("nix/agentx-agent.nix", "hermesAgent = finalAttrs.finalPackage;"),
    ("hermes_cli/gateway.py", '_LEGACY_SERVICE_NAMES = ("hermes.service",)'),
    ("agent/skill_utils.py", 'ns = metadata.get("hermes") or {}'),
    ("acp_adapter/server.py", '_meta.hermes carries the provenance block'),
    ("tests/agent/test_tool_guardrails.py", '{"β": "☤", "a": 1}'),
    ("tools/wake_word.py", '_BUNDLED_MODEL_NAME = "hey_hermes"'),
]


@pytest.mark.parametrize(("path", "line"), MUST_FAIL)
def test_gate_flags_a_reintroduced_brand(path, line):
    assert gate.violations_in(path, line), (
        f"the gate would let this through: {line!r}"
    )


@pytest.mark.parametrize(("path", "line"), MUST_PASS)
def test_gate_allows_deliberately_kept_names(path, line):
    assert not gate.violations_in(path, line), (
        f"the gate flags a name we keep on purpose: {line!r}"
    )


def test_allowlist_entries_all_carry_a_justification():
    """An allowlist entry without a reason is how a gate quietly rots."""
    for name, pattern, why in gate.ALLOWED:
        assert why and len(why) > 20, f"{name} has no real justification"
        assert pattern.pattern, f"{name} has an empty pattern"


def test_allowed_names_are_unique():
    names = [name for name, _p, _w in gate.ALLOWED]
    assert len(names) == len(set(names)), "duplicate ALLOWED entry name"


def test_scoped_allowances_name_a_real_entry():
    names = {name for name, _p, _w in gate.ALLOWED}
    for name in gate.ALLOWED_SCOPES:
        assert name in names, f"ALLOWED_SCOPES names an entry that does not exist: {name}"


def test_the_tree_is_clean():
    """The gate must report zero on the tree it ships with."""
    assert gate.main.__module__  # the module imported cleanly
    dirty = []
    for rel in gate.tracked_files():
        if gate.allowed_file(rel):
            continue
        path = gate.REPO_ROOT / rel
        if not path.is_file() or path.is_symlink():
            continue
        text = gate.read_text(path)
        if text is None:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for name in gate.violations_in(rel, line):
                dirty.append(f"{rel}:{lineno} [{name}] {line.strip()[:90]}")
    assert not dirty, "upstream branding reintroduced:\n" + "\n".join(dirty[:20])
