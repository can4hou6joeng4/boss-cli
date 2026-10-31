"""各 provider 共用的模型请求自动重试参数。

只负责「等多久、最多几次、网关建议等多久」；是否可重试由各 provider 按自己的错误形状判断，
重试只发生在向调用方产出首个内容事件之前，并受回合共享的模型恢复预算约束。
"""
from __future__ import annotations

import os
from collections.abc import Iterator

from boss_harness.models.types import StreamEvent

#: 单次退避的上限（秒）。
MAX_RETRY_DELAY_SECONDS = 8.0
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_RETRY_BASE_MS = 500


def retry_settings() -> tuple[int, float]:
    """重试次数与基础退避；可用 BOSS_HARNESS_RETRY_ATTEMPTS / _BASE_MS 覆盖。"""
    try:
        attempts = int(os.environ.get("BOSS_HARNESS_RETRY_ATTEMPTS") or DEFAULT_RETRY_ATTEMPTS)
    except ValueError:
        attempts = DEFAULT_RETRY_ATTEMPTS
    try:
        base_ms = int(os.environ.get("BOSS_HARNESS_RETRY_BASE_MS") or DEFAULT_RETRY_BASE_MS)
    except ValueError:
        base_ms = DEFAULT_RETRY_BASE_MS
    return max(1, min(attempts, 10)), max(0, base_ms) / 1000.0


def retry_delay(base_delay: float, attempt: int, retry_after: float | None) -> float:
    """退避时长：网关给了 Retry-After 就听它的，否则指数退避，两者都设上限。"""
    if retry_after is not None:
        return max(0.0, min(retry_after, MAX_RETRY_DELAY_SECONDS))
    return min(base_delay * (2 ** (attempt - 1)), MAX_RETRY_DELAY_SECONDS)


def retry_after_seconds(exc: object) -> float | None:
    """读 SDK 状态错误上的 Retry-After / Retry-After-Ms 头；网关没给就返回 None 走指数退避。"""
    headers = getattr(exc, "response", None)
    headers = getattr(headers, "headers", None)
    if headers is None:
        return None
    for name, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
        raw = headers.get(name)
        if not raw:
            continue
        try:
            return float(str(raw).strip()) * scale
        except ValueError:
            continue
    return None


def retry_start_event(next_attempt: int, attempts: int, delay: float, message: str) -> StreamEvent:
    """退避等待开始前发给调用方的观测事件；不携带任何内容，也不改变重试判定。"""
    return StreamEvent(type="retry_start", attempt=next_attempt, max_attempts=attempts,
                       delay_ms=max(0, int(round(delay * 1000))), error=message or "模型请求失败")


def with_retry_outcome(events: Iterator[StreamEvent]) -> Iterator[StreamEvent]:
    """在一段已发过 retry_start 的流里补一条 retry_end。

    首个非错误事件即视为重试成功；错误事件（含取消）先补失败的 retry_end 再原样转出。
    没有发生重试的流不会多出任何事件。
    """
    try:
        yield from _retry_outcome(events)
    finally:
        close = getattr(events, "close", None)
        if callable(close):
            close()


def _retry_outcome(events: Iterator[StreamEvent]) -> Iterator[StreamEvent]:
    pending = 0
    for event in events:
        if event.type == "retry_start":
            pending = event.attempt
        elif event.type == "retry_end":
            pending = 0
        elif pending:
            failed = event.type == "error"
            yield StreamEvent(type="retry_end", attempt=pending,
                              reason=(event.reason or "error") if failed else "success",
                              error=event.error if failed else "")
            pending = 0
        yield event
