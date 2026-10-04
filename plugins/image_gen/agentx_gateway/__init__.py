"""AgentX AI Gateway image generation — bundled, auto-loaded.

Generates through the gateway the signed-in AgentX account already uses for
chat, with that account's own key and the image model its key service names
(``image_model`` beside the chat models, recorded by
``hermes_cli.account_provisioning`` in ``litellm-account.json``). The model is
never offered for chat; this backend is the only thing that calls it.

The gateway is LiteLLM, which answers OpenAI's image API for every image model
it serves — including OpenRouter's Gemini image models, which it reaches over
chat completions and hands back as ``data[].b64_json``:

* text-to-image: ``POST /v1/images/generations`` (JSON)
* editing / references: ``POST /v1/images/edits`` (multipart, ``image[]``)

There is nothing to set up. With no ``image_gen.provider`` chosen and no FAL
key, ``tools.image_generation_tool`` picks this backend whenever it is
available — an account whose key carries an image grant.

Optional knobs (under ``image_gen.agentx_gateway`` in ``config.yaml``)::

    image_gen:
      agentx_gateway:
        model: "google/gemini-3.1-flash-image"  # must also be granted on the key
        timeout: 180                              # seconds (default 180)
"""

from __future__ import annotations

import base64
import logging
import mimetypes
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agent.image_gen_provider import (
    DEFAULT_ASPECT_RATIO,
    ImageGenProvider,
    error_response,
    resolve_aspect_ratio,
    save_b64_image,
    save_url_image,
    success_response,
)

logger = logging.getLogger(__name__)

PROVIDER_NAME = "agentx-gateway"
DEFAULT_TIMEOUT = 180.0

#: The image_gen contract's aspect ratios, as OpenAI sizes. LiteLLM maps a size
#: onto the model's own aspect-ratio setting (1:1, 3:2, 2:3 for Gemini).
_SIZES = {
    "square": "1024x1024",
    "landscape": "1536x1024",
    "portrait": "1024x1536",
}

#: Gemini image models take up to three pictures to edit or follow.
_MAX_REFERENCE_IMAGES = 3

_EXTENSIONS = {b"\xff\xd8\xff": "jpg", b"\x89PNG": "png", b"RIFF": "webp", b"GIF8": "gif"}


def _load_config() -> Dict[str, Any]:
    """``image_gen.agentx_gateway`` from config.yaml ({} on a miss)."""
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        section = cfg.get("image_gen") if isinstance(cfg, dict) else None
        inner = section.get("agentx_gateway") if isinstance(section, dict) else None
        return inner if isinstance(inner, dict) else {}
    except Exception as exc:  # noqa: BLE001 — config is best-effort
        logger.debug("Could not load image_gen.agentx_gateway config: %s", exc)
        return {}


def account_image_gateway() -> Optional[Dict[str, str]]:
    """The signed-in account's gateway URL, key and image model, or None.

    Read from what provisioning recorded for this account — a file read and an
    env lookup, so cheap enough for ``is_available()``.
    """
    try:
        from agent.web_search_provider import get_provider_env
        from hermes_cli.account_provisioning import read_state
        from hermes_cli.litellm_admin import openai_base_url
        from hermes_constants import get_hermes_home

        state = read_state(get_hermes_home())
    except Exception as exc:  # noqa: BLE001 — no account machinery, no gateway
        logger.debug("AgentX gateway image generation: account state unreadable: %s", exc)
        return None

    key_env = str(state.get("key_env") or "").strip()
    base_url = openai_base_url(str(state.get("base_url") or ""))
    if not (key_env and base_url):
        return None
    configured = _load_config().get("model")
    model = (configured.strip() if isinstance(configured, str) else "") or str(
        state.get("image_model") or ""
    ).strip()
    if not model:
        return None
    api_key = get_provider_env(key_env)
    if not api_key:
        return None
    return {"base_url": base_url.rstrip("/"), "api_key": api_key, "model": model}


def _image_bytes(ref: str) -> Optional[Tuple[str, bytes, str]]:
    """``(filename, bytes, mime)`` for a reference image: a path, a data URI or a URL."""
    ref = str(ref or "").strip()
    if not ref:
        return None
    if ref.startswith("data:"):
        header, _, payload = ref.partition(",")
        mime = header[5:].split(";", 1)[0] or "image/png"
        try:
            raw = base64.b64decode(payload)
        except ValueError:
            return None
        return f"reference.{mime.rsplit('/', 1)[-1]}", raw, mime
    if ref.startswith(("http://", "https://")):
        import httpx

        try:
            resp = httpx.get(ref, timeout=30.0, follow_redirects=True)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.debug("could not fetch reference image %s: %s", ref, exc)
            return None
        mime = resp.headers.get("content-type", "image/png").split(";", 1)[0].strip()
        return f"reference.{mime.rsplit('/', 1)[-1]}", resp.content, mime
    from agent.file_safety import raise_if_read_blocked

    raise_if_read_blocked(ref)
    path = Path(ref).expanduser()
    try:
        raw = path.read_bytes()
    except OSError as exc:
        logger.debug("could not read reference image %s: %s", ref, exc)
        return None
    return path.name, raw, mimetypes.guess_type(path.name)[0] or "image/png"


def _extension(b64_data: str) -> str:
    head = base64.b64decode(b64_data[:16] + "=" * (-len(b64_data[:16]) % 4))
    return next((ext for magic, ext in _EXTENSIONS.items() if head.startswith(magic)), "png")


class AgentXGatewayImageProvider(ImageGenProvider):
    """Image generation with the account's granted image model on the AgentX gateway."""

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    @property
    def display_name(self) -> str:
        return "AgentX AI Gateway"

    def is_available(self) -> bool:
        """Signed in with an account whose key carries an image grant."""
        return account_image_gateway() is not None

    def list_models(self) -> List[Dict[str, Any]]:
        gateway = account_image_gateway()
        if gateway is None:
            return []
        return [{"id": gateway["model"], "display": gateway["model"], "strengths": "Granted by AgentX"}]

    def default_model(self) -> Optional[str]:
        gateway = account_image_gateway()
        return gateway["model"] if gateway else None

    def capabilities(self) -> Dict[str, Any]:
        return {"modalities": ["text", "image"], "max_reference_images": _MAX_REFERENCE_IMAGES}

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "AgentX AI Gateway",
            "badge": "",
            "tag": "Image generation through your AgentX account — no API key to set up.",
            "env_vars": [],
            "requires_account_sign_in": True,
        }

    def generate(
        self,
        prompt: str,
        aspect_ratio: str = DEFAULT_ASPECT_RATIO,
        *,
        image_url: Optional[str] = None,
        reference_image_urls: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        aspect = resolve_aspect_ratio(aspect_ratio)
        gateway = account_image_gateway()
        if gateway is None:
            return error_response(
                error=(
                    "Image generation through the AgentX AI Gateway needs a signed-in "
                    "AgentX account whose key includes an image model."
                ),
                error_type="auth_required",
                provider=PROVIDER_NAME,
                prompt=prompt,
                aspect_ratio=aspect,
            )
        # A model chosen for another backend (``image_gen.model``) means nothing
        # here: only the granted model, or this backend's own override, is called.
        model = gateway["model"]
        try:
            timeout = float(_load_config().get("timeout", DEFAULT_TIMEOUT))
        except (TypeError, ValueError):
            timeout = DEFAULT_TIMEOUT

        sources = [s for s in [image_url, *(reference_image_urls or [])] if isinstance(s, str) and s.strip()]
        sources = sources[:_MAX_REFERENCE_IMAGES]
        headers = {"Authorization": f"Bearer {gateway['api_key']}"}
        size = _SIZES.get(aspect, _SIZES["square"])

        import httpx

        try:
            if sources:
                files = []
                for ref in sources:
                    loaded = _image_bytes(ref)
                    if loaded is None:
                        return error_response(
                            error=f"Could not read the image to edit: {ref}",
                            error_type="invalid_reference",
                            provider=PROVIDER_NAME,
                            model=model,
                            prompt=prompt,
                            aspect_ratio=aspect,
                        )
                    files.append(("image[]", loaded))
                modality = "image"
                resp = httpx.post(
                    f"{gateway['base_url']}/images/edits",
                    headers=headers,
                    data={"model": model, "prompt": prompt, "n": "1", "size": size},
                    files=files,
                    timeout=timeout,
                )
            else:
                modality = "text"
                resp = httpx.post(
                    f"{gateway['base_url']}/images/generations",
                    headers={**headers, "Content-Type": "application/json"},
                    json={"model": model, "prompt": prompt, "n": 1, "size": size},
                    timeout=timeout,
                )
        except httpx.TimeoutException:
            return error_response(
                error=f"The AgentX AI Gateway took longer than {int(timeout)}s to draw the image.",
                error_type="timeout",
                provider=PROVIDER_NAME,
                model=model,
                prompt=prompt,
                aspect_ratio=aspect,
            )
        except httpx.RequestError as exc:
            return error_response(
                error=f"Could not reach the AgentX AI Gateway: {exc}",
                error_type="connection_error",
                provider=PROVIDER_NAME,
                model=model,
                prompt=prompt,
                aspect_ratio=aspect,
            )

        try:
            body = resp.json()
        except ValueError:
            body = None
        if resp.status_code >= 400 or not isinstance(body, dict):
            return error_response(
                error=_describe_http_error(resp.status_code, body, model, resp.text),
                error_type="model_access" if resp.status_code in (401, 403) else "api_error",
                provider=PROVIDER_NAME,
                model=model,
                prompt=prompt,
                aspect_ratio=aspect,
            )

        items = body.get("data")
        first = items[0] if isinstance(items, list) and items and isinstance(items[0], dict) else {}
        b64 = first.get("b64_json")
        url = first.get("url")
        try:
            if isinstance(b64, str) and b64:
                saved = str(save_b64_image(b64, prefix="agentx", extension=_extension(b64)))
            elif isinstance(url, str) and url:
                saved = str(save_url_image(url, prefix="agentx"))
            else:
                return error_response(
                    error=f"{model} answered without an image. Try rephrasing the request.",
                    error_type="empty_response",
                    provider=PROVIDER_NAME,
                    model=model,
                    prompt=prompt,
                    aspect_ratio=aspect,
                )
        except Exception as exc:  # noqa: BLE001 — a bad payload is an error result, not a crash
            return error_response(
                error=f"Could not save the image the gateway returned: {exc}",
                error_type="invalid_response",
                provider=PROVIDER_NAME,
                model=model,
                prompt=prompt,
                aspect_ratio=aspect,
            )

        return success_response(
            image=saved,
            model=model,
            prompt=prompt,
            aspect_ratio=aspect,
            provider=PROVIDER_NAME,
            modality=modality,
        )


def _describe_http_error(status: int, body: Any, model: str, text: str) -> str:
    error = body.get("error") if isinstance(body, dict) else None
    detail = ""
    error_type = ""
    if isinstance(error, dict):
        detail = str(error.get("message") or "")
        error_type = str(error.get("type") or "")
    elif isinstance(error, str):
        detail = error
    if not detail:
        detail = str(text or "")[:300]
    if status in (401, 403) and (
        error_type == "key_model_access_denied" or "not allowed to access model" in detail
    ):
        return (
            f"This AgentX account's gateway key is not allowed to use {model} for images yet. "
            "Ask an administrator to grant it."
        )
    detail = detail.strip()
    return f"The AgentX AI Gateway returned HTTP {status}" + (f": {detail}" if detail else "")


def register(ctx: Any) -> None:
    """Register the AgentX AI Gateway image backend with the plugin context."""
    ctx.register_image_gen_provider(AgentXGatewayImageProvider())
