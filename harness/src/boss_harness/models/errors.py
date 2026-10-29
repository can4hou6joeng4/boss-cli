"""Conservative overflow classification at the trusted provider error boundary.

Pi d5b3de22d0e24a3e9c38a9410d3329b099717283 ai/utils/overflow separates overflow
from transient retries. This adapter accepts only an exact OpenAI error code,
bounded provider-specific context rejections, or Anthropic's typed numeric prompt
rejection. Length stops, estimates and generic request byte limits are not overflow.
"""
from __future__ import annotations

import errno
import re
import socket
from typing import Literal

from boss_harness.models.types import ModelErrorInfo


ErrorSource = Literal["http_error", "stream_error", "transport_error"]
_PROVIDER_CODE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_QUOTA_CODES = frozenset({"insufficient_quota", "billing_hard_limit_reached", "billing_error",
                          "usage_limit_error", "credits_exhausted"})
_TRANSIENT_CODES = frozenset({"rate_limit_exceeded", "rate_limit_error", "server_error",
                              "service_unavailable_error", "overloaded_error"})
_TRANSIENT_STATUSES = frozenset({408, 409, 500, 502, 503, 504})
_ANTHROPIC_PROMPT_LIMIT = re.compile(
    r"prompt is too long:\s*([0-9]+) tokens\s*>\s*([0-9]+) maximum\.?",
    re.IGNORECASE,
)
_LLAMA_CONTEXT_EXHAUSTED = re.compile(r"context size has been exceeded\.?", re.IGNORECASE)
_LITELLM_CONTEXT_WINDOW = re.compile(
    r"^litellm\.ContextWindowExceededError:.*?Context Window exceeded for given call\."
    r".*?\bMax Input Tokens=([0-9]{1,12}),\s*Got=([0-9]{1,12})\b",
    re.DOTALL,
)
_MAX_LITELLM_ERROR_MESSAGE = 2048
_PROXY_BODY_TOO_LARGE = re.compile(r"(?:request body|payload) too large\.?", re.IGNORECASE)
_MAX_PROXY_ERROR_MESSAGE = 512
_TRANSPORT_CAUSE_BY_TYPE = {
    "ConnectTimeout": "connect_timeout",
    "ReadTimeout": "read_timeout",
    "WriteTimeout": "write_timeout",
    "PoolTimeout": "pool_timeout",
    "TimeoutException": "timeout",
    "TimeoutError": "timeout",
    "gaierror": "dns_error",
    "SSLError": "tls_error",
    "CertificateError": "tls_error",
    "ConnectError": "connect_error",
    "ConnectionRefusedError": "connect_error",
    "ReadError": "read_error",
    "WriteError": "write_error",
    "RemoteProtocolError": "protocol_error",
    "LocalProtocolError": "protocol_error",
    "ProtocolError": "protocol_error",
    "ConnectionError": "connection_error",
    "ConnectionResetError": "connection_error",
    "ConnectionAbortedError": "connection_error",
    "BrokenPipeError": "connection_error",
    "OSError": "os_error",
}
_TRANSPORT_ERRNO_CODES = frozenset({
    "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
    "ENETUNREACH", "ETIMEDOUT", "EPIPE",
})
_TRANSPORT_SOCKET_CODES = {
    value: name for name in ("EAI_AGAIN", "EAI_NONAME")
    if type(value := getattr(socket, name, None)) is int
}
_TRANSPORT_LABELS = {
    "connect_timeout": "连接建立超时",
    "read_timeout": "读取响应超时",
    "write_timeout": "发送请求超时",
    "pool_timeout": "等待连接资源超时",
    "timeout": "传输超时",
    "dns_error": "域名解析失败",
    "tls_error": "TLS 连接失败",
    "connect_error": "连接建立失败",
    "read_error": "读取响应失败",
    "write_error": "发送请求失败",
    "protocol_error": "传输协议错误",
    "connection_error": "连接中断",
    "os_error": "底层网络错误",
    "unknown": "传输原因未识别",
}


def _field(value: object, name: str) -> object:
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)


def _error_payload(value: object) -> object:
    nested = _field(value, "error")
    return nested if nested is not None else value


def _transport_diagnostics(error: BaseException | None) -> tuple[str | None, str | None]:
    """Extract fixed transport categories and allowlisted errno names only."""
    if error is None:
        return None, None

    cause: str | None = None
    code: str | None = None
    pending = [error]
    visited: set[int] = set()
    has_nested_cause = False
    while pending and len(visited) < 8:
        current = pending.pop(0)
        identity = id(current)
        if identity in visited:
            continue
        visited.add(identity)
        if current is not error:
            has_nested_cause = True

        if cause is None:
            for exception_type in type(current).__mro__:
                mapped = _TRANSPORT_CAUSE_BY_TYPE.get(exception_type.__name__)
                if mapped is not None:
                    cause = mapped
                    break

        if code is None and isinstance(current, OSError):
            error_number = current.errno
            error_name = errno.errorcode.get(error_number) if type(error_number) is int else None
            if error_name in _TRANSPORT_ERRNO_CODES:
                code = error_name
            elif error_number in _TRANSPORT_SOCKET_CODES:
                code = _TRANSPORT_SOCKET_CODES[error_number]

        for linked in (getattr(current, "__cause__", None), getattr(current, "__context__", None)):
            if isinstance(linked, BaseException) and id(linked) not in visited:
                pending.append(linked)

    if cause is None and has_nested_cause:
        cause = "unknown"
    return cause, code


def transport_diagnostic(info: ModelErrorInfo) -> str | None:
    """Return a user-facing summary built only from fixed labels and safe codes."""
    if info.transport_cause is None:
        return None
    label = _TRANSPORT_LABELS[info.transport_cause]
    if info.transport_code is not None:
        return f"{label}（{info.transport_code}）"
    return label


def _valid_source(source: str, status_code: int | None) -> bool:
    if source == "http_error":
        return type(status_code) is int and 100 <= status_code <= 599
    if source == "stream_error":
        # The Anthropic SDK raises an APIStatusError for SSE errors under HTTP
        # 200; Responses errors are parsed from an already-open stream.
        return status_code is None or (type(status_code) is int and status_code == 200)
    if source == "transport_error":
        return status_code is None
    return False


def _safe_provider_code(error: object) -> str | None:
    payload = _error_payload(error)
    for field in ("code", "type"):
        value = _field(payload, field)
        if type(value) is str and _PROVIDER_CODE.fullmatch(value):
            return value
    return None


def _retryable_hint(error: object, status_code: int | None) -> bool | None:
    payload = _error_payload(error)
    codes = {value for field in ("code", "type")
             if type(value := _field(payload, field)) is str and _PROVIDER_CODE.fullmatch(value)}
    if codes & _QUOTA_CODES:
        return False
    if codes & _TRANSIENT_CODES or status_code in _TRANSIENT_STATUSES:
        return True
    if status_code in {400, 401, 403}:
        return False
    # A bare 429 can mean temporary throttling or an exhausted quota.
    return None


def _is_overflow_source(source: str, status_code: int | None) -> bool:
    if source == "http_error":
        return type(status_code) is int and status_code == 400
    return source == "stream_error" and (status_code is None or status_code == 200)


def _llama_context_exhausted(error: object) -> bool:
    """Recognize llama.cpp's bounded decode-time KV-pool exhaustion message."""
    message = _field(_error_payload(error), "message")
    return (type(message) is str and len(message) <= 512
            and _LLAMA_CONTEXT_EXHAUSTED.fullmatch(message.strip()) is not None)


def _litellm_context_window_exceeded(error: object) -> bool:
    """Recognize LiteLLM's explicit pre-call window rejection, not generic 400 text."""
    message = _field(_error_payload(error), "message")
    if type(message) is not str or len(message) > _MAX_LITELLM_ERROR_MESSAGE:
        return False
    match = _LITELLM_CONTEXT_WINDOW.search(message)
    if match is None:
        return False
    maximum, received = map(int, match.groups())
    return maximum > 0 and received > maximum


def _proxy_body_too_large(error: object, *, source: str, status_code: int | None) -> bool:
    """Recognize only bounded, explicit proxy body-size rejections."""
    if source != "http_error" or status_code != 413:
        return False
    message = _field(_error_payload(error), "message")
    return (type(message) is str and len(message) <= _MAX_PROXY_ERROR_MESSAGE
            and _PROXY_BODY_TOO_LARGE.fullmatch(message.strip()) is not None)


def openai_error_info(error: object, *, source: ErrorSource,
                      status_code: int | None = None,
                      retryable: bool | None = None,
                      transport_error: BaseException | None = None) -> ModelErrorInfo | None:
    """Preserve bounded provider facts; classify overflow by explicit signals and source."""
    if not _valid_source(source, status_code):
        return None
    raw_code = _field(_error_payload(error), "code")
    structured_overflow = type(raw_code) is str and raw_code == "context_length_exceeded"
    text_overflow = status_code in {400, 200} and _llama_context_exhausted(error)
    litellm_overflow = (source == "http_error" and status_code == 400
                        and _litellm_context_window_exceeded(error))
    proxy_body_overflow = _proxy_body_too_large(error, source=source, status_code=status_code)
    overflow = (
        _is_overflow_source(source, status_code)
        and (structured_overflow or text_overflow or litellm_overflow)
    ) or proxy_body_overflow
    transport_cause, transport_code = (
        _transport_diagnostics(transport_error) if source == "transport_error" else (None, None)
    )
    return ModelErrorInfo(provider="openai", source=source,
                          code="CONTEXT_OVERFLOW" if overflow else None,
                          provider_code=_safe_provider_code(error), status_code=status_code,
                          retryable=retryable if retryable is not None else _retryable_hint(error, status_code),
                          transport_cause=transport_cause, transport_code=transport_code)


def anthropic_error_info(error: object, *, source: ErrorSource,
                         status_code: int | None = None,
                         retryable: bool | None = None,
                         transport_error: BaseException | None = None) -> ModelErrorInfo | None:
    """Preserve bounded provider facts; classify only typed numeric prompt overflow."""
    if not _valid_source(source, status_code):
        return None
    payload = _error_payload(error)
    message = _field(payload, "message")
    overflow = _proxy_body_too_large(error, source=source, status_code=status_code)
    if (_is_overflow_source(source, status_code)
            and _field(payload, "type") == "invalid_request_error"
            and type(message) is str and len(message) <= 512):
        match = _ANTHROPIC_PROMPT_LIMIT.fullmatch(message.strip())
        if match is not None:
            actual, limit = map(int, match.groups())
            overflow = overflow or (limit > 0 and actual > limit)
    transport_cause, transport_code = (
        _transport_diagnostics(transport_error) if source == "transport_error" else (None, None)
    )
    return ModelErrorInfo(provider="anthropic", source=source,
                          code="CONTEXT_OVERFLOW" if overflow else None,
                          provider_code=_safe_provider_code(error), status_code=status_code,
                          retryable=retryable if retryable is not None else _retryable_hint(error, status_code),
                          transport_cause=transport_cause, transport_code=transport_code)
