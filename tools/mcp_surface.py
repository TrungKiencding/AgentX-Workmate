"""The tool surface of an MCP server, in one canonical form (MCP plan §2.9).

A *surface* is what a server offers a model: its tools, prompts and resource
templates. A hub admin approves a version *and* its surface; afterwards the
gateway and AgentX Workmate re-hash what the server announces and block every
tool whose hash differs from the approved one (tool poisoning, rug pulls).
Both sides must hash the same way, so this module is self-contained — plain
Python, no imports beyond the standard library — and Workmate keeps a copy of
it (``tools/mcp_surface.py``). ``tests/vectors/surface-v2.json`` holds the
answers both copies must give.

Canonical forms (keys outside these are dropped — ``_meta``, ``icons``,
``execution`` and anything a later protocol adds):

* tool — ``{name, title?, description?, inputSchema, outputSchema?, annotations?}``;
  ``inputSchema`` defaults to ``{"type": "object"}`` (the protocol requires one);
  ``annotations`` keeps ``title`` and the four hints (:data:`ANNOTATION_KEYS`);
* prompt — ``{name, title?, description?, arguments?}``; each argument keeps
  ``name``, ``title``, ``description`` and ``required`` (:data:`ARGUMENT_KEYS`);
* resource template — ``{uriTemplate, name, title?, description?, mimeType?}``.

A text field counts only when it is a string, a schema or an annotation block
only when it is a non-empty object, the argument list only when it is a
non-empty list; otherwise the key is left out, so "absent", ``null`` and
``{}`` hash alike.

**Annotations and prompt arguments are read as a client reads them**
(version 2). The MCP SDK Workmate runs (``mcp`` for Python, pydantic models)
keeps no other key there, and reads a hint or ``required`` sent as ``0`` or
``1``, ``0.0`` or ``1.0``, or one of ``true``/``false``, ``yes``/``no``,
``on``/``off``, ``t``/``f``, ``y``/``n``, ``1``/``0`` in any ASCII case, as
that boolean. So a list as a server sent it and the same list read through
the SDK hash alike: what the hub approves from a ``tools/list`` result, what
the gateway sees upstream and what Workmate reads. Version 1 kept both as
sent — a list approved as chrome-devtools-mcp sent it (``annotations.category``)
never matched on a machine. A list the SDK reads unchanged hashes as it did
in version 1.

Nothing else is rewritten: a changed description *is* a different tool, and
a value no client takes — a hint of ``2``, a ``title`` that is a number, an
argument that is not an object — stays as sent (the SDK refuses such a list
whole).

Hashes are ``sha256:<64 hex>`` over the canonical JSON of the hub (sorted
keys, no whitespace, UTF-8 kept):

* item hash — of the canonical item;
* surface hash — of ``[{"k": "tool"|"prompt"|"template", "n": name, "h": item hash}, …]``
  sorted by ``(k, n, h)``;
* the locks, ``{key: item hash}`` of each kind — ``tool_hashes`` and
  ``prompt_hashes`` by name, ``template_hashes`` by ``uriTemplate`` (two
  templates may share a name): what the gateway and Workmate compare an
  item a server announces with.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

SURFACE_VERSION = 2
KIND_TOOL = "tool"
KIND_PROMPT = "prompt"
KIND_TEMPLATE = "template"
#: The boolean hints of a tool's ``annotations`` (``ToolAnnotations``)…
ANNOTATION_HINTS = ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint")
#: …and every key the protocol defines there.
ANNOTATION_KEYS = ("title", *ANNOTATION_HINTS)
#: The keys the protocol defines for a prompt argument (``PromptArgument``).
ARGUMENT_KEYS = ("name", "title", "description", "required")
#: The words a client reads as ``true`` and as ``false`` (pydantic's lax mode), in lower case.
_TRUE_WORDS = frozenset({"1", "t", "y", "on", "yes", "true"})
_FALSE_WORDS = frozenset({"0", "f", "n", "no", "off", "false"})


def canonical_json(value: Any) -> str:
    """Sorted keys, no whitespace, non-ASCII kept as is."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_ref(value: Any) -> str:
    """``sha256:<64 hex>`` of *value*'s canonical JSON (UTF-8)."""
    return "sha256:" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _name(item: Mapping[str, Any], key: str, what: str) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"a {what} needs a non-empty string `{key}`")
    return value


def _texts(item: Mapping[str, Any], keys: Iterable[str], out: dict[str, Any]) -> None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, str):
            out[key] = value


def _object(value: Any) -> dict[str, Any] | None:
    return dict(value) if isinstance(value, Mapping) and value else None


def _boolean(value: Any) -> Any:
    """*value* of a boolean field as a client reads it (the module
    docstring): ``True`` or ``False`` when it takes the value for one,
    anything else as it is."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value.isascii() and value.lower() in _TRUE_WORDS | _FALSE_WORDS:
        return value.lower() in _TRUE_WORDS
    return value


def _annotations(value: Any) -> dict[str, Any] | None:
    """A tool's annotation block as a client reads it: the keys the protocol
    defines, the hints as booleans; ``None`` when nothing is left."""
    block = _object(value)
    if block is None:
        return None
    read = {key: _boolean(sent) if key in ANNOTATION_HINTS else sent for key, sent in block.items() if key in ANNOTATION_KEYS}
    return read or None


def _argument(value: Any) -> Any:
    """A prompt argument as a client reads it: the keys the protocol defines,
    ``required`` as a boolean. One that is not an object stays as it is."""
    if not isinstance(value, Mapping):
        return value
    return {key: _boolean(sent) if key == "required" else sent for key, sent in value.items() if key in ARGUMENT_KEYS}


def canonical_tool(tool: Mapping[str, Any]) -> dict[str, Any]:
    """The canonical form of one ``tools/list`` entry."""
    if not isinstance(tool, Mapping):
        raise ValueError("a tool must be an object")
    out: dict[str, Any] = {"name": _name(tool, "name", "tool")}
    _texts(tool, ("title", "description"), out)
    out["inputSchema"] = _object(tool.get("inputSchema")) or {"type": "object"}
    output_schema = _object(tool.get("outputSchema"))
    if output_schema is not None:
        out["outputSchema"] = output_schema
    annotations = _annotations(tool.get("annotations"))
    if annotations is not None:
        out["annotations"] = annotations
    return out


def canonical_prompt(prompt: Mapping[str, Any]) -> dict[str, Any]:
    """The canonical form of one ``prompts/list`` entry."""
    if not isinstance(prompt, Mapping):
        raise ValueError("a prompt must be an object")
    out: dict[str, Any] = {"name": _name(prompt, "name", "prompt")}
    _texts(prompt, ("title", "description"), out)
    arguments = prompt.get("arguments")
    if isinstance(arguments, list) and arguments:
        out["arguments"] = [_argument(argument) for argument in arguments]
    return out


def canonical_template(template: Mapping[str, Any]) -> dict[str, Any]:
    """The canonical form of one ``resources/templates/list`` entry."""
    if not isinstance(template, Mapping):
        raise ValueError("a resource template must be an object")
    out: dict[str, Any] = {
        "uriTemplate": _name(template, "uriTemplate", "resource template"),
        "name": _name(template, "name", "resource template"),
    }
    _texts(template, ("title", "description", "mimeType"), out)
    return out


def item_hash(canonical: Mapping[str, Any]) -> str:
    """The hash of one canonical tool, prompt or template."""
    return sha256_ref(canonical)


def surface_hash(entries: Iterable[Mapping[str, str]]) -> str:
    """The hash of a whole surface from its ``{k, n, h}`` entries."""
    ordered = sorted(({"k": e["k"], "n": e["n"], "h": e["h"]} for e in entries), key=lambda e: (e["k"], e["n"], e["h"]))
    return sha256_ref(ordered)


@dataclass(frozen=True)
class Surface:
    """A canonical surface: the three lists (sorted by name) and the hashes."""

    tools: list[dict[str, Any]] = field(default_factory=list)
    prompts: list[dict[str, Any]] = field(default_factory=list)
    resource_templates: list[dict[str, Any]] = field(default_factory=list)

    def entries(self) -> list[dict[str, str]]:
        out = [{"k": KIND_TOOL, "n": t["name"], "h": item_hash(t)} for t in self.tools]
        out += [{"k": KIND_PROMPT, "n": p["name"], "h": item_hash(p)} for p in self.prompts]
        out += [{"k": KIND_TEMPLATE, "n": r["name"], "h": item_hash(r)} for r in self.resource_templates]
        return out

    @property
    def hash(self) -> str:
        return surface_hash(self.entries())

    @property
    def tool_hashes(self) -> dict[str, str]:
        """``{tool name: item hash}`` — what the gateway and Workmate compare."""
        return {t["name"]: item_hash(t) for t in self.tools}

    @property
    def prompt_hashes(self) -> dict[str, str]:
        """``{prompt name: item hash}``, made as :attr:`tool_hashes` is."""
        return {p["name"]: item_hash(p) for p in self.prompts}

    @property
    def template_hashes(self) -> dict[str, str]:
        """``{uriTemplate: item hash}`` of the resource templates, made as :attr:`tool_hashes` is."""
        return {r["uriTemplate"]: item_hash(r) for r in self.resource_templates}

    def to_json(self) -> dict[str, Any]:
        return {"version": SURFACE_VERSION, "tools": self.tools, "prompts": self.prompts, "resource_templates": self.resource_templates}


def _unique(items: list[dict[str, Any]], key: str, what: str) -> None:
    seen: set[str] = set()
    for item in items:
        name = item[key]
        if name in seen:
            raise ValueError(f"two {what}s are called {name!r}")
        seen.add(name)


def surface_from_lists(
    tools: Iterable[Mapping[str, Any]] = (),
    prompts: Iterable[Mapping[str, Any]] = (),
    resource_templates: Iterable[Mapping[str, Any]] = (),
) -> Surface:
    """Canonicalise what ``tools/list``, ``prompts/list`` and
    ``resources/templates/list`` returned. Raises ``ValueError`` for an entry
    without a name, or for two tools (or prompts) with the same name — a
    server like that cannot be gated tool by tool."""
    canonical_tools = sorted((canonical_tool(t) for t in tools), key=lambda t: t["name"])
    canonical_prompts = sorted((canonical_prompt(p) for p in prompts), key=lambda p: p["name"])
    canonical_templates = sorted((canonical_template(r) for r in resource_templates), key=lambda r: (r["name"], r["uriTemplate"]))
    _unique(canonical_tools, "name", "tool")
    _unique(canonical_prompts, "name", "prompt")
    _unique(canonical_templates, "uriTemplate", "resource template")
    return Surface(tools=canonical_tools, prompts=canonical_prompts, resource_templates=canonical_templates)


def surface_from_payload(payload: Any) -> Surface:
    """A surface from what a person or a client sends: a ``tools/list``
    result (``{"tools": [...]}``, ``nextCursor`` ignored), a bare list of
    tools, or ``{"tools", "prompts", "resource_templates"|"resourceTemplates"}``."""
    if isinstance(payload, list):
        return surface_from_lists(payload)
    if not isinstance(payload, Mapping):
        raise ValueError("a surface is a tools/list result or a list of tools")
    tools = payload.get("tools") or []
    prompts = payload.get("prompts") or []
    templates = payload.get("resource_templates") or payload.get("resourceTemplates") or []
    for label, value in (("tools", tools), ("prompts", prompts), ("resource_templates", templates)):
        if not isinstance(value, list):
            raise ValueError(f"`{label}` must be a list")
    return surface_from_lists(tools, prompts, templates)
