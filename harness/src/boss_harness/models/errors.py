"""Conservative overflow classification at the trusted provider error boundary.

Pi d5b3de22d0e24a3e9c38a9410d3329b099717283 ai/utils/overflow separates overflow
from transient retries. This adapter deliberately accepts fewer signals: only
the exact OpenAI error code or Anthropic's typed, numeric prompt rejection.
Length stops, estimates and generic request byte limits are not token overflow.
"""
from __future__ import annotations

import re
from typing import Literal

from boss_harness.models.types import ModelErrorInfo


ErrorSource = Literal["http_error", "stream_error"]
_ANTHROPIC_PROMPT_LIMIT = re.compile(
    r"prompt is too long:\s*([0-9]+) tokens\s*>\s*([0-9]+) maximum\.?",
    re.IGNORECASE,
)


def _field(value: object, name: str) -> object:
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)


def _error_payload(value: object) -> object:
    nested = _field(value, "error")
    return nested if nested is not None else value


def _allowed_source(source: ErrorSource, status_code: int | None) -> bool:
    if source == "http_error":
        return type(status_code) is int and status_code == 400
    if source == "stream_error":
        # The Anthropic SDK raises an APIStatusError for SSE errors under HTTP
        # 200; Responses errors are already parsed stream objects without status.
        return status_code is None or (type(status_code) is int and status_code == 200)
    return False


def openai_error_info(error: object, *, source: ErrorSource,
                      status_code: int | None = None) -> ModelErrorInfo | None:
    """Use a parsed error code; never infer overflow from free-form text."""
    if not _allowed_source(source, status_code):
        return None
    code = _field(_error_payload(error), "code")
    if type(code) is not str or code != "context_length_exceeded":
        return None
    return ModelErrorInfo(code="CONTEXT_OVERFLOW", provider="openai", source=source,
                          provider_code="context_length_exceeded", status_code=status_code)


def anthropic_error_info(error: object, *, source: ErrorSource,
                         status_code: int | None = None) -> ModelErrorInfo | None:
    """Recognize only Anthropic's typed, explicit input-token limit rejection."""
    if not _allowed_source(source, status_code):
        return None
    payload = _field(error, "error")
    if _field(payload, "type") != "invalid_request_error":
        return None
    message = _field(payload, "message")
    if type(message) is not str or len(message) > 512:
        return None
    match = _ANTHROPIC_PROMPT_LIMIT.fullmatch(message.strip())
    if match is None:
        return None
    actual, limit = map(int, match.groups())
    if limit <= 0 or actual <= limit:
        return None
    return ModelErrorInfo(code="CONTEXT_OVERFLOW", provider="anthropic", source=source,
                          provider_code="invalid_request_error", status_code=status_code)
