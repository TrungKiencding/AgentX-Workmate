"""The canonical tool surface (Agent Hub P3.7) against the hub's vectors.

``tools/mcp_surface.py`` is a copy of the hub's ``agentx_mcpkit/surface.py``,
kept as is: Workmate hashes what a hub server announces the way the hub
hashed what it approved, or every tool of every hub server reads as
changed. ``tests/fixtures/mcp/surface-v1.json`` is the hub's
``tests/vectors/surface-v1.json`` — both copies must give its answers (the
hub's contract test runs this module at the pinned Workmate commit).
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest

from tools import mcp_surface
from tools.mcp_surface import SURFACE_VERSION, canonical_json, surface_from_payload

VECTORS = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "mcp" / "surface-v1.json").read_text(encoding="utf-8"))
CASES = {case["id"]: case for case in VECTORS["cases"]}


def test_the_vectors_are_the_version_this_module_computes():
    assert VECTORS["version"] == SURFACE_VERSION == 1


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_every_vector(case_id):
    case = CASES[case_id]
    surface = surface_from_payload(case["input"])
    assert surface.to_json() == case["canonical"]
    assert sorted(surface.entries(), key=lambda e: (e["k"], e["n"], e["h"])) == case["entries"]
    assert surface.tool_hashes == case["tool_hashes"]
    assert surface.hash == case["surface_hash"]


@pytest.mark.parametrize("error", VECTORS["errors"], ids=lambda e: e["id"])
def test_every_refusal(error):
    with pytest.raises(ValueError, match=re.escape(error["error"])):
        surface_from_payload(error["input"])


def test_a_hash_is_sha256_over_the_canonical_json():
    literal = '{"inputSchema":{"type":"object"},"name":"ping"}'
    expected = "sha256:" + hashlib.sha256(literal.encode("utf-8")).hexdigest()
    assert CASES["minimal-tool"]["tool_hashes"]["ping"] == expected
    assert "\\u" not in canonical_json({"d": "hoá đơn"})


def test_the_copy_imports_nothing_but_the_standard_library():
    source = Path(mcp_surface.__file__).read_text(encoding="utf-8")
    imports = [line.split()[1] for line in source.splitlines() if line.startswith(("import ", "from "))]
    assert set(imports) <= {"__future__", "hashlib", "json", "collections.abc", "dataclasses", "typing"}, imports
