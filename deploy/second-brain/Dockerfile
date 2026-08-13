# The second-brain service. Build context is the REPOSITORY ROOT, not this
# directory:
#
#   docker build -f deploy/second-brain/Dockerfile .
#
# or just `make up`, which the compose file wires up correctly.
#
# Deliberately not the root Dockerfile. That one builds the whole agent
# runtime — Node, Playwright, a patched SQLite, a supervision tree — because
# it has to run an agent. This runs a small HTTP service in front of Postgres,
# and every megabyte and every package it does not carry is attack surface it
# does not have.

FROM ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie@sha256:b3c543b6c4f23a5f2df22866bd7857e5d304b67a564f4feab6ac22044dde719b AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /src
COPY . /src

# One virtualenv, at a fixed path, copied wholesale into the runtime stage.
#
# `-e` is not a developer convenience here, it is the only path that works.
# `setup.py` refuses `bdist_wheel` outside a Nix build on purpose: a wheel
# ships without the assets AgentX resolves from the source layout, and this
# service needs one of them — `plugins/dashboard_auth/keycloak/plugin.yaml`,
# without which there is no Keycloak verifier and every bearer is rejected.
# Editable installs go through `build_editable`, which the guard deliberately
# leaves alone. The consequence is that /src must exist at the SAME path in
# the runtime stage, because that is where the venv now points; the copy
# below keeps it there. Moving it re-breaks this in a way that only shows up
# at container start.
#
# `--python 3.13` is load-bearing. The repository ships a `.python-version` of
# 3.11 — the floor `requires-python` allows — and uv reads that file from /src
# ahead of everything else, so an unpinned `uv venv` asks for an interpreter
# this image does not carry and is not allowed to download
# (UV_PYTHON_DOWNLOADS=never above). Even if it could download one, the runtime
# stage below is python:3.13 and copies this venv wholesale: a 3.11 venv would
# point at an interpreter that does not exist there, and the failure would move
# from the build to the first container start. Keep this in step with both FROM
# lines.
RUN uv venv --python 3.13 /opt/brain-venv && \
    VIRTUAL_ENV=/opt/brain-venv uv pip install --no-cache -e "/src[second-brain]"

FROM python:3.13.13-slim-trixie

# Unbuffered so `docker logs` shows what is happening while it happens; no
# .pyc at runtime because the image is immutable and writing them would only
# dirty the layer.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/brain-venv/bin:$PATH"

# curl is here for the healthcheck below and nothing else.
# hadolint ignore=DL3008
RUN apt-get -o Acquire::Retries=3 update && \
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/brain-venv /opt/brain-venv
# /src, not a tidier name: the venv above is an editable install and its
# finder records this exact path. See the note in the builder stage.
COPY --from=builder /src /src

WORKDIR /src

# The service holds the LiteLLM admin key and every stored model key. It has
# no reason to be able to write to its own code, and no reason to be root.
RUN useradd --system --create-home --uid 10001 brain && \
    chown -R brain:brain /src
USER brain

EXPOSE 8811

# /health answers 503 when Postgres is unreachable, which is exactly when this
# container should stop taking traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8811/health || exit 1

# 0.0.0.0 inside the container only. Caddy is what the internet reaches.
ENTRYPOINT ["agentx", "second-brain", "serve", "--host", "0.0.0.0", "--port", "8811"]
