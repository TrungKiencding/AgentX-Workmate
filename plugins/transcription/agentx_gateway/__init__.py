"""AgentX AI Gateway speech-to-text — bundled, auto-loaded.

Transcribes through the gateway the signed-in AgentX account already uses for
chat, with that account's own key and the transcription model its key service
names (``transcription_model`` beside the chat models, recorded by
``hermes_cli.account_provisioning``). The model is never offered for chat; this
backend is the only thing that calls it — for the desktop's dictation, voice
mode and voice messages alike, since all of them go through
``tools.transcription_tools.transcribe_audio``. The HTTP work lives in
``tools.agentx_gateway_stt``.

There is nothing to set up: provisioning makes this the STT provider of an
account whose key carries a transcription grant, unless the person already
chose one.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from agent.transcription_provider import TranscriptionProvider
from tools import agentx_gateway_stt as gateway_stt


class AgentXGatewayTranscriptionProvider(TranscriptionProvider):
    """Speech-to-text with the account's granted transcription model on the AgentX gateway."""

    @property
    def name(self) -> str:
        return gateway_stt.PROVIDER_NAME

    @property
    def display_name(self) -> str:
        return "AgentX AI Gateway"

    def is_available(self) -> bool:
        """Signed in with an account whose key carries a transcription grant."""
        return gateway_stt.account_transcription_gateway() is not None

    def list_models(self) -> List[Dict[str, Any]]:
        gateway = gateway_stt.account_transcription_gateway()
        if gateway is None:
            return []
        return [{"id": gateway["model"], "display": gateway["model"]}]

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "AgentX AI Gateway",
            "badge": "",
            "tag": "Transcribe through your AgentX account — no API key to set up.",
            "env_vars": [],
            "requires_account_sign_in": True,
        }

    def transcribe(
        self,
        file_path: str,
        *,
        model: Optional[str] = None,
        language: Optional[str] = None,
        **extra: Any,
    ) -> Dict[str, Any]:
        # Neither hint is passed on; the backend resolves both from what the person
        # wrote (see tools.agentx_gateway_stt). ``model`` can be a caller's legacy
        # top-level ``stt.model`` — a name meant for another provider, which the
        # key cannot reach — while the account's grant (or
        # ``stt.agentx_gateway.model``) is what this gateway serves. ``language``
        # comes from the merged config, where the shipped ``stt.language: en``
        # would make Whisper write Vietnamese speech down as English.
        return gateway_stt.transcribe(file_path)


def register(ctx: Any) -> None:
    """Register the AgentX AI Gateway STT backend with the plugin context."""
    ctx.register_transcription_provider(AgentXGatewayTranscriptionProvider())
