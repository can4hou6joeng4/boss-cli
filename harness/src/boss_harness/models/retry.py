"""各 provider 共用的模型请求自动重试参数。

只负责「等多久、最多几次、网关建议等多久」；是否可重试由各 provider 按自己的错误形状判断，
重试只发生在向调用方产出首个内容事件之前，并受回合共享的模型恢复预算约束。
"""
from __future__ import annotations

import os

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
