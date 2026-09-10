"""AgentX AI Gateway web search — plugin form.

Routes ``web_search`` through the gateway the signed-in AgentX account already
uses for chat, with that account's own key. The model is a Perplexity search
preset — ``perplexity/preset/pro-search`` unless the deployment grants another
— called on the gateway's Responses API: Perplexity runs the searches and reads
the pages, and the reply carries both what it found and a short cited answer.

There is nothing to set up. The second brain grants the search model on each
person's key and names it when a laptop collects the key;
``hermes_cli.account_provisioning`` records it in the account's
``litellm-account.json``, which is where this provider reads it. An account
without a grant — signed out, or on a deployment that grants none — simply does
not offer this backend.

Config keys this provider responds to::

    web:
      search_backend: "agentx-gateway"   # explicit per-capability
      backend: "agentx-gateway"          # shared fallback

With neither set it is chosen automatically whenever it is available and no
explicitly keyed paid backend is (see ``tools.web_tools._get_backend``).

Optional knobs (under ``web.agentx_gateway`` in ``config.yaml``)::

    web:
      agentx_gateway:
        model: "perplexity/preset/fast-search"  # must also be granted on the key
        timeout: 120                             # seconds (default 120)
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from agent.web_search_provider import WebSearchProvider, get_provider_env

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 120

#: The most answer text handed back to the agent. Pro-search can write at
#: length; the agent needs the gist and the sources, and a tool result has a
#: budget of its own.
MAX_ANSWER_CHARS = 6000

_MARKDOWN_LINK_RE = re.compile(r"\[([^\]\n]{1,300})\]\((https?://[^)\s]+)\)")

#: How Perplexity cites a search result inside its answer: ``[web:N]``, where N
#: is that result's ``id``.
_CITATION_RE = re.compile(r"\[web:(\d+)\]")


# ---------------------------------------------------------------------------
# Config + account
# ---------------------------------------------------------------------------


def _load_gateway_web_config() -> Dict[str, Any]:
    """Read ``web.agentx_gateway`` from config.yaml (returns {} on miss)."""
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        web_section = cfg.get("web") if isinstance(cfg, dict) else None
        section = web_section.get("agentx_gateway") if isinstance(web_section, dict) else None
        return section if isinstance(section, dict) else {}
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not load web.agentx_gateway config: %s", exc)
        return {}


def _account_gateway() -> Optional[Dict[str, str]]:
    """The signed-in account's gateway URL, key and search model, or None.

    Read from what provisioning recorded for this account: the sidecar is where
    the granted web search model lives, and the same write names the key's env
    var and the proxy it was issued for. A file read and an env lookup, so
    cheap enough for ``is_available()``.
    """
    try:
        from hermes_cli.account_provisioning import read_state
        from hermes_cli.litellm_admin import openai_base_url
        from hermes_constants import get_hermes_home

        state = read_state(get_hermes_home())
    except Exception as exc:  # noqa: BLE001 — no account machinery, no gateway
        logger.debug("AgentX gateway web search: account state unreadable: %s", exc)
        return None

    key_env = str(state.get("key_env") or "").strip()
    base_url = openai_base_url(str(state.get("base_url") or ""))
    if not (key_env and base_url):
        return None

    configured = _load_gateway_web_config().get("model")
    model = (configured.strip() if isinstance(configured, str) else "") or str(
        state.get("web_search_model") or ""
    ).strip()
    if not model:
        return None

    api_key = get_provider_env(key_env)
    if not api_key:
        return None
    return {"base_url": base_url, "api_key": api_key, "model": model}


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class AgentXGatewayWebSearchProvider(WebSearchProvider):
    """Search-only provider backed by a Perplexity preset on the AgentX gateway.

    Like the xAI backend, this is a model doing the searching rather than an
    index handing back rows: Perplexity decides which pages to read and writes
    the answer, and a crafted query can steer it. Treat the URLs it returns the
    way you would any model-produced link.

    No extract capability — the preset reads pages, but hands back its reading
    of them rather than their text.
    """

    @property
    def name(self) -> str:
        return "agentx-gateway"

    @property
    def display_name(self) -> str:
        return "AgentX AI Gateway"

    def is_available(self) -> bool:
        """Signed in with an account whose key carries a web search grant."""
        return _account_gateway() is not None

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    # -- Search -----------------------------------------------------------

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        """Run *query* through the account's search preset.

        Returns ``{"success": True, "data": {"web": [...], "answer": str}}`` —
        the usual ``{title, url, description, position}`` rows, plus
        Perplexity's cited answer when it wrote one — or
        ``{"success": False, "error": str}``.
        """
        try:
            from tools.interrupt import is_interrupted

            if is_interrupted():
                return {"success": False, "error": "Interrupted"}
        except Exception:  # noqa: BLE001 — interrupt module is best-effort
            pass

        gateway = _account_gateway()
        if gateway is None:
            return {
                "success": False,
                "error": (
                    "Web search through the AgentX AI Gateway needs a signed-in "
                    "AgentX account whose key includes a web search model."
                ),
            }

        try:
            limit = max(1, min(int(limit), 100))
        except (TypeError, ValueError):
            limit = 5

        try:
            timeout = float(_load_gateway_web_config().get("timeout", DEFAULT_TIMEOUT))
        except (TypeError, ValueError):
            timeout = DEFAULT_TIMEOUT

        import httpx

        model = gateway["model"]
        logger.info(
            "AgentX gateway web search via %s: '%s' (limit=%d)", model, query, limit
        )
        try:
            resp = httpx.post(
                f"{gateway['base_url']}/responses",
                headers={
                    "Authorization": f"Bearer {gateway['api_key']}",
                    "Content-Type": "application/json",
                },
                json={"model": model, "input": query},
                timeout=timeout,
            )
        except httpx.RequestError as exc:
            logger.warning("AgentX gateway web search request error: %s", exc)
            return {
                "success": False,
                "error": f"Could not reach the AgentX AI Gateway: {exc}",
            }

        if resp.status_code >= 400:
            error = self._describe_http_error(resp, model)
            logger.warning("AgentX gateway web search failed: %s", error)
            return {"success": False, "error": error}

        try:
            data = resp.json()
        except ValueError:
            data = None
        if not isinstance(data, dict):
            return {
                "success": False,
                "error": "The AgentX AI Gateway returned a reply that is not a JSON object",
            }

        # A Responses reply carries ``"error": null`` when all is well. A 200
        # with a filled-in error, or Perplexity's own ``status: failed``, is a
        # failure the agent should see, not an empty result list.
        api_error = data.get("error")
        if isinstance(api_error, dict) or data.get("status") == "failed":
            message = api_error.get("message") if isinstance(api_error, dict) else ""
            return {
                "success": False,
                "error": f"Web search failed at the AgentX AI Gateway: {message or 'unknown error'}",
            }

        answer, annotations = self._collect_output_text(data)
        rows, answer = self._extract_results(data, annotations, answer, limit=limit)
        payload: Dict[str, Any] = {"web": rows}
        if answer:
            if len(answer) > MAX_ANSWER_CHARS:
                answer = answer[:MAX_ANSWER_CHARS].rstrip() + " …"
            payload["answer"] = answer
        return {"success": True, "data": payload}

    # -- Parsing ----------------------------------------------------------

    @staticmethod
    def _describe_http_error(resp: Any, model: str) -> str:
        """One line the agent can act on, from a gateway error response."""
        detail = ""
        error_type = ""
        try:
            body = resp.json()
        except Exception:  # noqa: BLE001
            body = None
        error = body.get("error") if isinstance(body, dict) else None
        if isinstance(error, dict):
            detail = str(error.get("message") or "")
            error_type = str(error.get("type") or "")
        elif isinstance(error, str):
            detail = error
        if not detail:
            detail = str(getattr(resp, "text", "") or "")[:300]

        status = resp.status_code
        if status in (401, 403) and (
            error_type == "key_model_access_denied" or "not allowed to access model" in detail
        ):
            return (
                f"This AgentX account's gateway key is not allowed to use {model} "
                "for web search yet. Ask an administrator to grant it."
            )
        detail = detail.strip()
        return f"The AgentX AI Gateway returned HTTP {status}" + (f": {detail}" if detail else "")

    @staticmethod
    def _collect_output_text(data: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]]]:
        """The answer text, and the annotations citing it, from ``output`` messages."""
        texts: List[str] = []
        annotations: List[Dict[str, Any]] = []
        output = data.get("output")
        for item in output if isinstance(output, list) else ():
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            content = item.get("content")
            for chunk in content if isinstance(content, list) else ():
                if not isinstance(chunk, dict) or chunk.get("type") != "output_text":
                    continue
                text = chunk.get("text")
                if isinstance(text, str) and text.strip():
                    texts.append(text.strip())
                chunk_annotations = chunk.get("annotations")
                for ann in chunk_annotations if isinstance(chunk_annotations, list) else ():
                    if isinstance(ann, dict):
                        annotations.append(ann)
        return "\n\n".join(texts), annotations

    @staticmethod
    def _extract_results(
        data: Dict[str, Any],
        annotations: List[Dict[str, Any]],
        answer: str,
        *,
        limit: int,
    ) -> Tuple[List[Dict[str, Any]], str]:
        """``[{title, url, description, position}, ...]``, and the answer citing them.

        Rows come from whatever the reply carries, in order of how much each
        says about a page:

        1. ``search_results`` output items — the pages Perplexity searched,
           with titles, snippets and dates.
        2. A top-level ``search_results`` list, the chat-completions shape.
        3. ``output_text`` annotations — the URLs the answer cites.
        4. A top-level ``citations`` list of bare URLs.
        5. Markdown links in the answer itself.

        Folded into one list and de-duplicated by URL, so a page that was both
        found and cited appears once, with the snippet its search result had.

        Perplexity cites search results inside the answer as ``[web:N]``, N
        being the result's ``id``. Cited results lead and are always returned,
        even past *limit* — a citation the agent cannot follow is worse than
        one row more — and each marker is rewritten to its row's position, so
        ``[1]`` in the answer is ``position: 1`` in ``web``.
        """
        entries: List[Dict[str, Any]] = []
        by_url: Dict[str, Dict[str, Any]] = {}
        by_id: Dict[str, Dict[str, Any]] = {}

        def add(
            url: Any,
            title: Any = "",
            description: Any = "",
            *,
            result_id: Any = None,
            day: Any = "",
        ) -> None:
            link = str(url or "").strip()
            if not link.startswith(("http://", "https://")):
                return
            entry = by_url.get(link)
            if entry is None:
                label = str(title or "").strip()
                text = " ".join(str(description or "").split())
                stamp = str(day or "").strip()
                entry = {
                    # A citation's title is often just its number.
                    "title": "" if label.isdigit() else label,
                    "url": link,
                    # The date leads: for "today's price" a result is worth
                    # little more than how fresh it is.
                    "description": f"({stamp}) {text}".strip() if stamp else text,
                }
                by_url[link] = entry
                entries.append(entry)
            if result_id is not None:
                by_id.setdefault(str(result_id), entry)

        def add_search_results(results: Any) -> None:
            for result in results if isinstance(results, list) else ():
                if isinstance(result, dict):
                    add(
                        result.get("url"),
                        result.get("title"),
                        result.get("snippet") or result.get("description"),
                        result_id=result.get("id"),
                        # When the page last changed says more than when it
                        # was first published: price pages date from 2019 and
                        # update daily.
                        day=result.get("last_updated") or result.get("date"),
                    )

        output = data.get("output")
        for item in output if isinstance(output, list) else ():
            if isinstance(item, dict) and item.get("type") == "search_results":
                add_search_results(item.get("results"))
        add_search_results(data.get("search_results"))
        for ann in annotations:
            add(ann.get("url"), ann.get("title"))
        citations = data.get("citations")
        for url in citations if isinstance(citations, list) else ():
            if isinstance(url, str):
                add(url)
        for title, url in _MARKDOWN_LINK_RE.findall(answer or ""):
            add(url, title)

        cited: List[Dict[str, Any]] = []
        for marker in _CITATION_RE.finditer(answer or ""):
            entry = by_id.get(marker.group(1))
            if entry is not None and all(entry is not known for known in cited):
                cited.append(entry)
        rest = [entry for entry in entries if all(entry is not known for known in cited)]
        chosen = (cited + rest)[: max(limit, len(cited))]

        rows: List[Dict[str, Any]] = []
        position_of: Dict[int, int] = {}
        for position, entry in enumerate(chosen, start=1):
            position_of[id(entry)] = position
            rows.append({**entry, "position": position})

        def cite(marker: re.Match[str]) -> str:
            entry = by_id.get(marker.group(1))
            position = position_of.get(id(entry)) if entry is not None else None
            return f"[{position}]" if position else marker.group(0)

        return rows, _CITATION_RE.sub(cite, answer or "")

    # -- Setup picker -----------------------------------------------------

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "AgentX AI Gateway",
            "badge": "",
            "tag": (
                "Perplexity web search through your AgentX account — no API key "
                "to set up."
            ),
            "env_vars": [],
            # Keyless because signing in supplies the key, not because none is
            # needed: readiness reports a sign-in until the account holds one.
            "requires_account_sign_in": True,
        }
