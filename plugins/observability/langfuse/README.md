# Langfuse Observability Plugin

This plugin ships bundled with AgentX but is **opt-in** — it only loads when
you explicitly enable it.

## Enable

Pick one:

```bash
# Interactive: walks you through credentials + SDK install + enable
agentx tools  # → Langfuse Observability

# Manual
pip install langfuse
agentx plugins enable observability/langfuse
```

## Required credentials

Set these in `~/.agentx/.env` (or via `agentx tools`):

```bash
AGENTX_LANGFUSE_PUBLIC_KEY=pk-lf-...
AGENTX_LANGFUSE_SECRET_KEY=sk-lf-...
AGENTX_LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or your self-hosted URL
```

Without the SDK or credentials the hooks no-op silently — the plugin fails
open.

## Verify

```bash
agentx plugins list                 # observability/langfuse should show "enabled"
agentx chat -q "hello"              # then check Langfuse for a "AgentX turn" trace
```

## Optional tuning

```bash
AGENTX_LANGFUSE_ENV=production       # environment tag
AGENTX_LANGFUSE_RELEASE=v1.0.0       # release tag
AGENTX_LANGFUSE_SAMPLE_RATE=0.5      # sample 50% of traces
AGENTX_LANGFUSE_MAX_CHARS=12000      # max chars per field (default: 12000)
AGENTX_LANGFUSE_DEBUG=true           # verbose plugin logging
```

## Disable

```bash
agentx plugins disable observability/langfuse
```
