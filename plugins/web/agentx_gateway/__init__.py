"""AgentX AI Gateway web search plugin — bundled, auto-loaded.

Mirrors the ``plugins/web/xai/`` layout: ``provider.py`` holds the provider
class, ``__init__.py::register(ctx)`` registers an instance.
"""

from __future__ import annotations

from plugins.web.agentx_gateway.provider import AgentXGatewayWebSearchProvider


def register(ctx) -> None:
    """Register the AgentX AI Gateway web search provider with the plugin context."""
    ctx.register_web_search_provider(AgentXGatewayWebSearchProvider())
