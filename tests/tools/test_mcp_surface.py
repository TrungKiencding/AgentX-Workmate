"""The canonical tool surface (Agent Hub P3.7) against the hub's vectors.

``tools/mcp_surface.py`` is a copy of the hub's ``agentx_mcpkit/surface.py``,
kept as is: Workmate hashes what a hub server announces the way the hub
hashed what it approved, or every tool of every hub server reads as
changed. ``tests/fixtures/mcp/surface-v2.json`` is the hub's
``tests/vectors/surface-v2.json`` — both copies must give its answers (the
hub's contract test runs this module at the pinned Workmate commit);
``surface-v1.json`` is version 1's, whose every hash version 2 keeps.

The hub hashes a list as the server sent it, Workmate as its MCP SDK read it
(``mcp_hub.tool_payload``): version 2 reads a tool's annotations and a
prompt's arguments as the SDK does (Agent Hub decision §9.1 #20), so every
case a client takes gives the same answers read through this machine's SDK.
"""

from __future__ import annotations

import copy
import hashlib
import itertools
import json
import re
from pathlib import Path

import pytest

from tools import mcp_hub, mcp_surface
from tools.mcp_surface import ANNOTATION_HINTS, SURFACE_VERSION, canonical_json, canonical_prompt, canonical_tool, surface_from_payload

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "mcp"
VECTORS = json.loads((FIXTURES / "surface-v2.json").read_text(encoding="utf-8"))
CASES = {case["id"]: case for case in VECTORS["cases"]}
V1 = json.loads((FIXTURES / "surface-v1.json").read_text(encoding="utf-8"))
ERAS = ("2025-11-25", "2026-07-28")
#: The words the SDK (pydantic's lax mode) takes for a boolean, in ASCII lower case.
WORDS = ("1", "t", "y", "on", "yes", "true", "0", "f", "n", "no", "off", "false")


def test_the_vectors_are_the_version_this_module_computes():
    assert VECTORS["version"] == SURFACE_VERSION == 2


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_every_vector(case_id):
    case = CASES[case_id]
    surface = surface_from_payload(case["input"])
    assert surface.to_json() == case["canonical"]
    assert sorted(surface.entries(), key=lambda e: (e["k"], e["n"], e["h"])) == case["entries"]
    assert surface.tool_hashes == case["tool_hashes"]
    # the locks of the prompts (by name) and resource templates (by uriTemplate), Agent Hub P6.1
    assert surface.prompt_hashes == case["prompt_hashes"]
    assert surface.template_hashes == case["template_hashes"]
    assert surface.hash == case["surface_hash"]


@pytest.mark.parametrize("case", V1["cases"], ids=lambda c: c["id"])
def test_every_hash_of_version_1_holds(case):
    surface = surface_from_payload(case["input"])
    assert {**surface.to_json(), "version": 1} == case["canonical"]
    assert (surface.tool_hashes, surface.prompt_hashes, surface.template_hashes, surface.hash) == \
        (case["tool_hashes"], case["prompt_hashes"], case["template_hashes"], case["surface_hash"])


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


# ─── What this machine's MCP SDK reads ───────────────────────────────────────


def _as_this_machine_reads(payload, era="2025-11-25"):
    """*payload*'s lists as the MCP client reads a server's results (the
    session's check, then the SDK's models), as SDK objects."""
    from mcp.types import ListPromptsResult, ListResourceTemplatesResult, ListToolsResult
    from mcp_types import methods

    if isinstance(payload, list):
        payload = {"tools": payload}
    modern = {"resultType": "complete", "ttlMs": 0, "cacheScope": "private"} if era == "2026-07-28" else {}
    read = {}
    for family, method, key, model, attribute in (
        ("tools", "tools/list", "tools", ListToolsResult, "tools"),
        ("prompts", "prompts/list", "prompts", ListPromptsResult, "prompts"),
        ("resource_templates", "resources/templates/list", "resourceTemplates", ListResourceTemplatesResult, "resource_templates"),
    ):
        items = payload.get(family) if payload.get(family) is not None else payload.get(key)
        if items is None:
            continue
        result = {key: copy.deepcopy(items), **modern}
        methods.validate_server_result(method, era, result)
        read[family] = getattr(model.model_validate(result, by_name=False), attribute)
    return read


@pytest.mark.parametrize("era", ERAS)
@pytest.mark.parametrize("case_id", sorted(CASES))
def test_every_vector_a_client_takes_hashes_alike_read_through_the_sdk(case_id, era):
    from pydantic import ValidationError

    case = CASES[case_id]
    if not case["sdk"]:
        with pytest.raises(ValidationError):
            _as_this_machine_reads(case["input"], era)
        return
    read = _as_this_machine_reads(case["input"], era)
    surface = surface_from_payload({family: [mcp_hub.tool_payload(item) for item in items] for family, items in read.items()})
    assert surface.to_json() == case["canonical"]
    assert (surface.tool_hashes, surface.prompt_hashes, surface.template_hashes, surface.hash) == \
        (case["tool_hashes"], case["prompt_hashes"], case["template_hashes"], case["surface_hash"])


def _spellings():
    words = sorted({"".join(letters) for word in WORDS for letters in itertools.product(*((c.lower(), c.upper()) for c in word))})
    return [*words, True, False, None, 0, 1, 2, -1, 0.0, 1.0, -0.0, 0.5, "", " true", "01", "tru", "ＴＲＵＥ", [], {}]


@pytest.mark.parametrize("sent", _spellings(), ids=repr)
def test_a_boolean_reads_as_this_machines_sdk_reads_it(sent):
    from pydantic import ValidationError

    tool = {"name": "t", "inputSchema": {"type": "object"}, "annotations": {hint: sent for hint in ANNOTATION_HINTS}}
    prompt = {"name": "p", "arguments": [{"name": "a", "required": sent}]}
    try:
        read = _as_this_machine_reads({"tools": [tool], "prompts": [prompt]})
    except ValidationError:
        assert canonical_tool(tool)["annotations"] == tool["annotations"]  # no client takes it: kept as sent
        return
    assert canonical_tool(tool) == canonical_tool(mcp_hub.tool_payload(read["tools"][0]))
    assert canonical_prompt(prompt) == canonical_prompt(mcp_hub.tool_payload(read["prompts"][0]))


def test_a_list_the_hub_approved_as_the_server_sent_it_opens_whole_on_this_machine():
    """chrome-devtools-mcp 1.10.1 sends ``annotations.category`` (and
    ``conditions``), which the SDK drops: the hub approved the list as sent,
    this machine reads it through the SDK — and the lock opens every tool and
    the prompt, and the surface it reports is the approved one."""
    sent = {"tools": CASES["chrome-devtools-mcp-as-sent"]["input"]["tools"],
            "prompts": CASES["prompt-arguments-as-a-client-reads-them"]["input"]["prompts"]}
    approved = surface_from_payload(sent)
    config = {"command": "npx", "hub": {"slug": "chrome-devtools", "version": "1.10.1", "surface_hash": approved.hash,
                                        "tool_hashes": approved.tool_hashes, "prompt_hashes": approved.prompt_hashes, "template_hashes": {}}}
    read = _as_this_machine_reads(sent)
    check = mcp_hub.check_tools(config, read["tools"], read["prompts"], [])
    assert check.blocked == () and check.allowed == frozenset(approved.tool_hashes)
    assert check.prompts == frozenset({"forecast"}) and check.blocked_prompts == ()
    assert check.surface_hash == approved.hash
