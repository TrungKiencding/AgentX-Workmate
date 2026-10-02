"""AgentX AI Gateway text-to-speech — bundled, auto-loaded.

Reads text aloud through the gateway the signed-in AgentX account already uses
for chat, with that account's own key and the speech model its key service
names (``speech_model`` beside the chat models, recorded by
``hermes_cli.account_provisioning``). The model is never offered for chat; this
backend and its streaming twin (``tools.tts_streaming.AgentXGatewayStreamer``)
are the only things that call it. The HTTP and audio work lives in
``tools.agentx_gateway_tts``.

There is nothing to set up: provisioning makes this the TTS provider of an
account whose key carries a speech grant, unless the person already chose one.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from agent.tts_provider import TTSProvider
from tools import agentx_gateway_tts as gateway_tts

logger = logging.getLogger(__name__)


class AgentXGatewayTTSProvider(TTSProvider):
    """Text-to-speech with the account's granted speech model on the AgentX gateway."""

    @property
    def name(self) -> str:
        return gateway_tts.PROVIDER_NAME

    @property
    def display_name(self) -> str:
        return "AgentX AI Gateway"

    def is_available(self) -> bool:
        """Signed in with an account whose key carries a speech grant."""
        return gateway_tts.account_speech_gateway() is not None

    def list_voices(self) -> List[Dict[str, Any]]:
        return [{"id": voice, "display": voice} for voice in gateway_tts.GEMINI_VOICES]

    def default_voice(self) -> Optional[str]:
        return gateway_tts.DEFAULT_VOICE

    def list_models(self) -> List[Dict[str, Any]]:
        gateway = gateway_tts.account_speech_gateway()
        if gateway is None:
            return []
        return [{"id": gateway["model"], "display": gateway["model"]}]

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "AgentX AI Gateway",
            "badge": "",
            "tag": "Read aloud through your AgentX account — no API key to set up.",
            "env_vars": [],
            "requires_account_sign_in": True,
        }

    @property
    def voice_compatible(self) -> bool:
        """Opt into voice bubbles only where the platform delivers them.

        The dispatcher transcodes a voice-compatible plugin's audio to Opus on
        every surface; the desktop and the CLI play the container they asked
        for (MP3/WAV), so only a messaging platform that wants Opus voice
        notes (Telegram et al.) gets the conversion and the voice bubble.
        """
        try:
            from gateway.session_context import get_session_env
            from tools.tts_tool import OPUS_VOICE_PLATFORMS
        except Exception:  # noqa: BLE001 — no gateway, no voice bubbles
            return False
        return get_session_env("AGENTX_SESSION_PLATFORM", "").lower() in OPUS_VOICE_PLATFORMS

    def synthesize(
        self,
        text: str,
        output_path: str,
        *,
        voice: Optional[str] = None,
        model: Optional[str] = None,
        speed: Optional[float] = None,
        format: str = "mp3",
        **extra: Any,
    ) -> str:
        # ``model`` is the account's grant (or ``tts.agentx_gateway.model``), never a
        # name meant for another provider; ``speed`` has no gateway parameter.
        pcm = gateway_tts.synthesize_pcm(text, voice)
        written = gateway_tts.write_audio(pcm, output_path)
        logger.info("AgentX gateway speech: %d bytes of PCM -> %s", len(pcm), written)
        return written


def register(ctx: Any) -> None:
    """Register the AgentX AI Gateway TTS backend with the plugin context."""
    ctx.register_tts_provider(AgentXGatewayTTSProvider())
