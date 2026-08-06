"""A small, honest client for LiteLLM's virtual-key admin API.

Only the four calls per-account provisioning needs, and nothing else:

    /key/list?key_alias=…   find the key we minted for this person last time
    /key/generate           mint one
    /key/delete             retire the old one
    /v1/models              prove a key still works, and list what it reaches

Two facts about LiteLLM shape everything here.

**A minted key's plaintext is returned exactly once.** ``/key/list`` and
``/key/info`` answer with the *hash* (``token``), never the ``sk-…`` value.
So the plaintext has to be stored on our side at mint time; if we ever lose
it, the only recovery is to delete the alias and mint a fresh key. LiteLLM
does have a ``/key/{token}/regenerate`` that would return a new plaintext for
the same budget and settings, but on the open-source build it answers HTTP 500
with "Regenerating Virtual Keys is an Enterprise feature" — so delete-then-mint
is the recovery path that actually exists.

**The alias is the identity.** ``key_alias`` is unique per key and searchable,
which makes it the idempotency handle: one alias per account means a second
sign-in finds the first key instead of minting a duplicate every launch.

The client is synchronous. Every existing outbound-HTTP path in the CLI is
(see ``hermes_cli/dashboard_keycloak.py``, ``plugins/dashboard_auth/keycloak``),
and async callers wrap it in a threadpool rather than forcing a second style
into the tree.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

# Long enough for a proxy that is cold-starting a database connection, short
# enough that a wedged proxy cannot hold up sign-in.
DEFAULT_TIMEOUT_SECONDS = 20.0

# Retried once, briefly: provisioning happens on the sign-in path, so a
# multi-second backoff ladder would be felt as a hang. One retry covers the
# single dropped connection or restarting worker; anything more persistent is
# better reported than waited out.
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_MAX_ATTEMPTS = 2
_RETRY_DELAY_SECONDS = 0.75


class LiteLLMError(RuntimeError):
    """A LiteLLM admin call failed.

    ``status_code`` is the HTTP status when there was one, and ``None`` when
    the request never got an answer (DNS, TLS, connect timeout). Callers key
    "the proxy said no" against "the proxy could not be reached" off that
    difference — the same distinction the Keycloak refresh path draws, and for
    the same reason: an outage must not look like a revocation.
    """

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code

    @property
    def unreachable(self) -> bool:
        """True when we never got an HTTP answer at all."""
        return self.status_code is None


@dataclass(frozen=True)
class MintedKey:
    """The one moment a virtual key's plaintext exists outside LiteLLM."""

    key: str
    token: str
    key_alias: str
    models: tuple[str, ...] = ()

    @property
    def masked(self) -> str:
        """A form safe to print, log, and put in a UI."""
        return mask_key(self.key)


@dataclass(frozen=True)
class KeyRecord:
    """An existing key as LiteLLM describes it — hash only, no plaintext."""

    token: str
    key_alias: str
    user_id: str = ""
    models: tuple[str, ...] = ()
    raw: Mapping[str, Any] = field(default_factory=dict)


def mask_key(value: str) -> str:
    """Return a key in the shape LiteLLM itself uses for display: ``sk-…4Bqf``."""
    text = (value or "").strip()
    if not text:
        return ""
    tail = text[-4:] if len(text) > 8 else ""
    return f"sk-…{tail}" if tail else "sk-…"


def normalize_base_url(base_url: str) -> str:
    """Return the proxy root with any trailing slash or ``/v1`` suffix removed.

    Operators paste whichever URL their notes hold — the admin root, or the
    OpenAI-compatible ``/v1``. Admin routes live at the root, so accepting
    both here beats a 404 that reads like a broken proxy.
    """
    text = (base_url or "").strip().rstrip("/")
    if text.endswith("/v1"):
        text = text[: -len("/v1")]
    return text


def openai_base_url(base_url: str) -> str:
    """Return the ``/v1`` base URL an OpenAI-compatible client should use."""
    root = normalize_base_url(base_url)
    return f"{root}/v1" if root else ""


class LiteLLMAdminClient:
    """Talks to one LiteLLM proxy with one admin key.

    ``transport`` exists so tests drive the whole flow through
    ``httpx.MockTransport`` with no network and no fixture server — the
    convention the rest of the tree's HTTP clients follow.
    """

    def __init__(
        self,
        base_url: str,
        admin_key: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: Any | None = None,
        sleep: Any | None = None,
    ) -> None:
        root = normalize_base_url(base_url)
        if not root:
            raise LiteLLMError("LiteLLM base_url is empty")
        if not (admin_key or "").strip():
            raise LiteLLMError("LiteLLM admin key is empty")
        self._base_url = root
        self._admin_key = admin_key.strip()
        self._timeout = timeout
        self._transport = transport
        if sleep is None:
            import time

            sleep = time.sleep
        self._sleep = sleep

    # -- plumbing ---------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json_body: Mapping[str, Any] | None = None,
        api_key: str | None = None,
    ) -> Any:
        import httpx

        url = f"{self._base_url}{path}"
        headers = {
            "Authorization": f"Bearer {api_key or self._admin_key}",
            "Accept": "application/json",
        }

        last: LiteLLMError | None = None
        for attempt in range(_MAX_ATTEMPTS):
            try:
                with httpx.Client(
                    timeout=self._timeout,
                    transport=self._transport,
                    follow_redirects=True,
                ) as client:
                    response = client.request(
                        method, url, params=params, json=json_body, headers=headers
                    )
            except httpx.RequestError as exc:
                last = LiteLLMError(f"could not reach LiteLLM at {url}: {exc}")
            else:
                if response.status_code in _RETRY_STATUSES:
                    last = LiteLLMError(
                        _describe_failure(response), status_code=response.status_code
                    )
                elif response.status_code >= 400:
                    raise LiteLLMError(
                        _describe_failure(response), status_code=response.status_code
                    )
                else:
                    try:
                        return response.json()
                    except ValueError as exc:
                        raise LiteLLMError(
                            f"LiteLLM returned a non-JSON body for {path}: {exc}",
                            status_code=response.status_code,
                        ) from exc

            if attempt + 1 < _MAX_ATTEMPTS:
                self._sleep(_RETRY_DELAY_SECONDS)

        raise last or LiteLLMError(f"LiteLLM request to {path} failed")

    # -- the four calls ---------------------------------------------------

    def keys_for_alias(self, key_alias: str) -> list[KeyRecord]:
        """Return every key currently carrying *key_alias*.

        Normally zero or one. More than one means a previous mint raced or a
        delete failed halfway; the caller retires all of them so exactly one
        key per person survives.
        """
        payload = self._request(
            "GET",
            "/key/list",
            params={
                "key_alias": key_alias,
                "return_full_object": "true",
                "include_team_keys": "false",
            },
        )
        rows = payload.get("keys") if isinstance(payload, dict) else None
        records: list[KeyRecord] = []
        for row in rows or ():
            if not isinstance(row, dict):
                continue
            token = str(row.get("token") or "").strip()
            if not token:
                continue
            records.append(
                KeyRecord(
                    token=token,
                    key_alias=str(row.get("key_alias") or ""),
                    user_id=str(row.get("user_id") or ""),
                    models=tuple(str(m) for m in (row.get("models") or ())),
                    raw=row,
                )
            )
        return records

    def generate_key(
        self,
        *,
        key_alias: str,
        user_id: str = "",
        models: Sequence[str] = (),
        max_budget: float | None = None,
        budget_duration: str = "",
        tpm_limit: int | None = None,
        rpm_limit: int | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> MintedKey:
        """Mint a virtual key. The returned plaintext is not recoverable later."""
        body: dict[str, Any] = {"key_alias": key_alias}
        if user_id:
            body["user_id"] = user_id
        if models:
            body["models"] = list(models)
        if max_budget is not None:
            body["max_budget"] = max_budget
        if budget_duration:
            body["budget_duration"] = budget_duration
        if tpm_limit is not None:
            body["tpm_limit"] = tpm_limit
        if rpm_limit is not None:
            body["rpm_limit"] = rpm_limit
        if metadata:
            body["metadata"] = dict(metadata)

        payload = self._request("POST", "/key/generate", json_body=body)
        if not isinstance(payload, dict):
            raise LiteLLMError("LiteLLM /key/generate returned an unexpected body")
        key = str(payload.get("key") or "").strip()
        if not key:
            raise LiteLLMError("LiteLLM /key/generate returned no key")
        return MintedKey(
            key=key,
            token=str(payload.get("token") or ""),
            key_alias=str(payload.get("key_alias") or key_alias),
            models=tuple(str(m) for m in (payload.get("models") or ())),
        )

    def delete_keys(self, tokens: Sequence[str]) -> list[str]:
        """Retire keys by hash. Returns the hashes LiteLLM says it deleted."""
        wanted = [t for t in (tokens or ()) if t]
        if not wanted:
            return []
        payload = self._request("POST", "/key/delete", json_body={"keys": wanted})
        deleted = payload.get("deleted_keys") if isinstance(payload, dict) else None
        return [str(t) for t in (deleted or ())]

    def list_models(self, api_key: str | None = None) -> list[str]:
        """Return the model ids reachable with *api_key* (admin key by default).

        Doubles as the liveness check for a stored key: a revoked or deleted
        key answers 401 here, which is exactly the signal the provisioner
        needs and costs one cheap request.
        """
        payload = self._request("GET", "/v1/models", api_key=api_key)
        rows = payload.get("data") if isinstance(payload, dict) else None
        return [
            str(row.get("id"))
            for row in (rows or ())
            if isinstance(row, dict) and row.get("id")
        ]

    def key_is_live(self, api_key: str) -> bool:
        """True when *api_key* is still accepted by the proxy.

        An unreachable proxy answers True: "we could not ask" must not be read
        as "the key is dead", or every offline launch would rotate a perfectly
        good key and orphan the old one upstream.
        """
        try:
            self.list_models(api_key=api_key)
        except LiteLLMError as exc:
            if exc.status_code in (401, 403):
                return False
            return True
        return True


def _describe_failure(response: Any) -> str:
    """Turn a LiteLLM error body into one line an operator can act on."""
    status = response.status_code
    detail = ""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            detail = str(error.get("message") or "")
        elif isinstance(error, str):
            detail = error
        if not detail:
            detail = str(body.get("detail") or "")
    if not detail:
        detail = (getattr(response, "text", "") or "")[:300]
    detail = detail.strip()
    return f"LiteLLM returned HTTP {status}{f': {detail}' if detail else ''}"
