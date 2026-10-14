"""What a finished turn counts as in the AgentX SSO usage metrics.

The desktop reports one ``chat.turn`` event per turn (apps/desktop/electron/
usage-reporter.ts). A failed turn carries a stable code saying what went wrong
— the words AgentX Chat and WebMate use too, so the SSO dashboard and the
developers' alerts group failures by them (AgentX-sso docs/dashboard.md,
"Mã lỗi"). The code rides the turn's ``message.complete`` frame as
``failure_code``; it is derived from the turn's result, never its text.

A turn "fails" when the person did not get what they asked for: an error ended
it (``status: "error"``), or it ended without one but without its answer — out
of iterations, an empty answer, a stream that broke off, a guardrail halt.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from agent.error_classifier import classify_api_error
from hermes_cli.account_license import READ_ONLY_CODE, LicenseReadOnly

#: Sent when nothing more precise is known.
FALLBACK_CODE = "operation_failed"
_CODE_SHAPE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$")

#: ``agent.error_classifier.FailoverReason`` values, in the shared words.
_REASON_CODES = {
    "auth": "auth_failed",
    "auth_permanent": "auth_failed",
    "billing": "quota_exceeded",
    "billing_unverified": "quota_exceeded",
    "rate_limit": "rate_limited",
    "upstream_rate_limit": "rate_limited",
    "overloaded": "upstream_error",
    "server_error": "upstream_error",
    "timeout": "timeout",
    "ssl_cert_verification": "network_error",
    "context_overflow": "context_too_long",
    "payload_too_large": "context_too_long",
    "long_context_tier": "context_too_long",
    "image_too_large": "bad_request",
    "model_not_found": "model_unavailable",
    "provider_policy_blocked": "content_filtered",
    "content_policy_blocked": "content_filtered",
    "format_error": "bad_request",
    "invalid_encrypted_content": "bad_request",
    "multimodal_tool_content_unsupported": "bad_request",
    "thinking_signature": "bad_request",
    "oauth_long_context_beta_forbidden": "bad_request",
    "llama_cpp_grammar_pattern": "bad_request",
    "unknown": FALLBACK_CODE,
}

#: A read-only AgentX license, by its state (hermes_cli.account_license).
_LICENSE_CODES = {
    "none": "license_required",
    "scheduled": "license_required",
    "expired": "license_expired",
    "revoked": "license_revoked",
}

#: Why a turn that raised no error still ended without its answer (``turn_exit_reason``,
#: before any "(…)" detail). A reason not listed here, on an incomplete turn, is sent as is.
_EXIT_CODES = {
    "budget_exhausted": "max_steps",
    "max_iterations_reached": "max_steps",
    "error_near_max_iterations": "max_steps",
    "empty_response_exhausted": "empty_response",
    "all_retries_exhausted_no_response": "no_response",
    "partial_stream_recovery": "stream_interrupted",
    "ollama_runtime_context_too_small": "context_too_long",
    "local_processing_error": "local_error",
    "repeated_outer_errors": "local_error",
    "guardrail_halt": "guardrail_halt",
}


def turn_failure_code(result: Any, status: str) -> str | None:
    """The failure code of a turn that ended with ``status`` and ``result``, or None when the
    person got their answer (or stopped the turn: an interruption is not a failure)."""
    if status == "interrupted" or not isinstance(result, Mapping):
        return None
    failed = status == "error" or bool(result.get("failed"))
    if not failed and result.get("completed", True):
        return None
    reason = _failure_reason_code(result)
    if reason:
        return reason
    exit_reason = str(result.get("turn_exit_reason") or "").split("(", 1)[0].strip()
    code = _EXIT_CODES.get(exit_reason) or exit_reason
    return code if code and code != "unknown" and _CODE_SHAPE.match(code) else FALLBACK_CODE


def exception_failure_code(error: BaseException) -> str:
    """The failure code of a turn an exception ended (the turn dispatcher's last resort)."""
    if isinstance(error, LicenseReadOnly):
        return _license_code(error.license)
    try:
        return _REASON_CODES.get(classify_api_error(error).reason.value, FALLBACK_CODE)
    except Exception:  # classifying never stands in the way of closing the turn
        return FALLBACK_CODE


def _failure_reason_code(result: Mapping[str, Any]) -> str | None:
    """The code of the classified reason a failed result carries, if it carries one."""
    reason = str(result.get("failure_reason") or "")
    if not reason:
        return None
    if reason == READ_ONLY_CODE:
        return _license_code(result.get("license"))
    if reason.startswith("session_persistence_failed"):
        return "session_save_failed"
    if reason == "interpreter_shutdown":
        return "app_shutdown"
    return _REASON_CODES.get(reason, FALLBACK_CODE)


def _license_code(info: Any) -> str:
    state = info.get("state") if isinstance(info, Mapping) else None
    return _LICENSE_CODES.get(str(state), "license_read_only")
