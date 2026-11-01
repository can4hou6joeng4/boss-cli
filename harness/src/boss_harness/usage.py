"""每回合 provider usage 的只读汇总。

职责参考 Pi MIT 固定提交 a14cdf90f0a76532f3e20bc3c01872837cef24ba 的
packages/ai 用量字段（input/output/cacheRead/cacheWrite）与
packages/coding-agent/src/core/cache-stats.ts（按 assistant 消息累计、
不报告缓存的 provider 不计入）。本模块独立实现，只读取已持久的
``model_usage`` / ``context_summary_usage`` 条目，不写会话、不估算 token。

只有字段类型、取值范围与 provider 语义均可验证的记录才计入合计；
缺失、类型错误、负数、超大值、内部不一致或全零的记录单独计数并标注原因。
provider 未上报 usage 的请求持久为 ``usage: null``，除计入原因 ``missing`` 外
另以 ``unreportedRequests`` 计数，与“上报为全零”（原因 ``zero``，含旧会话里
由旧版内核把缺失写成全零的记录，不改写历史）区分。
费用没有可信价目来源，始终为 ``None``。
"""
from __future__ import annotations

from typing import Any, Iterable

# 单次请求合理上限：远大于任何已知上下文窗口，用于拒绝明显异常的中转数据。
MAX_REQUEST_TOKENS = 50_000_000
_FIELDS = ("input", "output", "cache_read", "cache_write")
# provider 实际上报的字段；未上报的字段返回 None，避免把 0 当成事实。
_REPORTED = {
    "openai": {"cacheRead": True, "cacheWrite": False, "reasoning": True},
    "anthropic": {"cacheRead": True, "cacheWrite": True, "reasoning": False},
}
SOURCE = "provider-usage"


def _int(value: Any) -> bool:
    return type(value) is int


def verify_usage(provider: Any, usage: Any) -> tuple[dict | None, str | None]:
    """Return (normalized usage, None) or (None, reason)."""
    if provider not in _REPORTED:
        return None, "unknownProvider"
    if usage is None:
        return None, "missing"
    if not isinstance(usage, dict):
        return None, "invalidType"
    values = {name: usage.get(name) for name in _FIELDS}
    reasoning = usage.get("reasoning")
    if any(not _int(v) for v in values.values()) or (reasoning is not None and not _int(reasoning)):
        return None, "invalidType"
    if any(v < 0 for v in values.values()) or (reasoning is not None and reasoning < 0):
        return None, "negative"
    if any(v > MAX_REQUEST_TOKENS for v in values.values()) or (
            reasoning is not None and reasoning > MAX_REQUEST_TOKENS):
        return None, "outOfRange"
    if provider == "openai":
        # Responses 的 input_tokens 已包含 cached_tokens；reasoning 包含在 output 内。
        if values["cache_read"] > values["input"] or (reasoning is not None and reasoning > values["output"]):
            return None, "inconsistent"
        prompt = values["input"]
        uncached = values["input"] - values["cache_read"]
    else:
        # Anthropic 的 input_tokens 不含缓存读写。
        prompt = values["input"] + values["cache_read"] + values["cache_write"]
        uncached = values["input"]
    if prompt + values["output"] == 0:
        return None, "zero"
    if prompt > MAX_REQUEST_TOKENS:
        return None, "outOfRange"
    reported = _REPORTED[provider]
    return {
        "promptTokens": prompt, "uncachedInputTokens": uncached, "outputTokens": values["output"],
        "cacheReadTokens": values["cache_read"] if reported["cacheRead"] else None,
        "cacheWriteTokens": values["cache_write"] if reported["cacheWrite"] else None,
        "reasoningTokens": reasoning if reported["reasoning"] else None,
    }, None


def _empty() -> dict:
    return {"requests": 0, "verifiedRequests": 0, "unverifiedRequests": 0, "unreportedRequests": 0,
            "unverifiedReasons": {},
            "promptTokens": 0, "uncachedInputTokens": 0, "outputTokens": 0,
            "cacheReadTokens": None, "cacheWriteTokens": None, "reasoningTokens": None,
            "costUsd": None, "costSource": "unavailable"}


def _add(bucket: dict, provider: Any, model: Any, usage: Any) -> None:
    bucket["requests"] += 1
    if isinstance(provider, str) and "providers" in bucket and provider not in bucket["providers"]:
        bucket["providers"].append(provider)
    if isinstance(model, str) and "models" in bucket and model not in bucket["models"] and len(bucket["models"]) < 8:
        bucket["models"].append(model)
    normalized, reason = verify_usage(provider, usage)
    if normalized is None:
        bucket["unverifiedRequests"] += 1
        if reason == "missing":
            # unverifiedRequests 的子集：provider 没有给出 usage，不是上报为 0。
            bucket["unreportedRequests"] += 1
        bucket["unverifiedReasons"][reason] = bucket["unverifiedReasons"].get(reason, 0) + 1
        return
    bucket["verifiedRequests"] += 1
    for key in ("promptTokens", "uncachedInputTokens", "outputTokens"):
        bucket[key] += normalized[key]
    for key in ("cacheReadTokens", "cacheWriteTokens", "reasoningTokens"):
        if normalized[key] is not None:
            bucket[key] = (bucket[key] or 0) + normalized[key]


def _merge(total: dict, part: dict) -> None:
    for key in ("requests", "verifiedRequests", "unverifiedRequests", "unreportedRequests",
                "promptTokens", "uncachedInputTokens", "outputTokens"):
        total[key] += part[key]
    for reason, count in part["unverifiedReasons"].items():
        total["unverifiedReasons"][reason] = total["unverifiedReasons"].get(reason, 0) + count
    for key in ("cacheReadTokens", "cacheWriteTokens", "reasoningTokens"):
        if part[key] is not None:
            total[key] = (total[key] or 0) + part[key]


def summarize_usage(entries: Iterable[dict], active_turn_ids: set[str] | None = None) -> dict:
    """Aggregate persisted usage records per turn (file order) plus summary-task totals."""
    turns: dict[str, dict] = {}
    summary = _empty()
    for entry in entries:
        kind = entry.get("type")
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if kind == "model_usage":
            turn_id = payload.get("turnId")
            if not isinstance(turn_id, str) or (active_turn_ids is not None and turn_id not in active_turn_ids):
                continue
            bucket = turns.get(turn_id)
            if bucket is None:
                bucket = turns[turn_id] = {"turnId": turn_id, "providers": [], "models": [], **_empty()}
            _add(bucket, payload.get("provider"), payload.get("model"), payload.get("usage"))
        elif kind == "context_summary_usage":
            _add(summary, payload.get("provider"), payload.get("model"), payload.get("usage"))
    totals = _empty()
    for bucket in turns.values():
        _merge(totals, bucket)
    _merge(totals, summary)
    return {"turns": list(turns.values()), "summaryTasks": summary, "totals": totals}
