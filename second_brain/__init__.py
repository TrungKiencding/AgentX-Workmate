"""The AgentX second brain — one account, one model key, many devices.

AgentX Workmate installs onto each person's own machine, and until this
service existed everything a person owned lived on exactly one of them. That
was not a missing feature so much as an active fault: the LiteLLM virtual key
each person receives is looked up by an alias derived from their immutable
``sub`` claim, so every machine they signed in on competed for the same alias,
and both mint paths deleted the existing key before minting a new one. Signing
in on a second laptop revoked the first laptop's key; the first laptop then
rotated and revoked the second. One person could hold one working device.

This service is the fix, and the place the rest of the multi-device story
lands. It does three things for one person, identified by the ``sub`` claim on
a Keycloak token they already hold:

``keys``     mint the model key **once** and hand the same plaintext back to
             every device, so no device's sign-in can cost another device its
             access.
``devices``  record which machines a person uses, so Settings can list them
             and revoke one.
``sync``     accept pushed documents and serve them back as an ordered change
             feed, so conversation history converges. (Phase 3.)

They are one service rather than three because all three need exactly the same
two primitives — verify a Keycloak bearer into a subject, and a durable
per-account store — and three deploys of the same auth code is three chances to
drift from the realm the product actually trusts. The module boundaries inside
the process stay hard, so splitting later is mechanical.

Layout::

    settings.py   configuration, resolved from the environment, once
    errors.py     the wire format for a refusal, and the codes clients switch on
    store/        the only place SQL is written
    auth.py       bearer + device header -> Principal, on every route
    devices.py    the device registry and revocation
    keys.py       the key vault: mint once, wrap, hand back, rotate
    app.py        build_app(), /health, and the uvicorn entry point

Run it with::

    agentx second-brain serve --host 0.0.0.0 --port 8811

behind TLS termination. ``deploy/second-brain/`` carries a compose file that
stands the whole thing up, including the database.

Not a laptop component: nothing in this package is imported by the CLI or the
desktop app, and it is installed by the ``second-brain`` extra rather than the
base distribution.
"""

from __future__ import annotations

# Bumped when the wire contract changes in a way a client can observe. The
# route prefix (/v1) is the compatibility promise; this is for /health, so an
# operator can tell which build answered.
__version__ = "1.0.0"

API_PREFIX = "/v1"

__all__ = ["API_PREFIX", "__version__"]
