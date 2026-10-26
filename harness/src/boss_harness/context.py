"""Model context is a projection of durable history, never the history itself.

Pi references: 5ba1cbaf3d96d204d847c84ce235c62dae23e0fd, session-manager and
agent-loop transformContext; d5b3de22d0e24a3e9c38a9410d3329b099717283,
ai/utils/estimate and ai/api/simple-options. Request estimates and model capacity
remain separate. Compaction preserves provenance and complete turns; provider
usage is reported separately and never calibrates these character estimates.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from typing import Any

from boss_harness.models.capabilities import ModelCapabilities
from boss_harness.models.types import (
    AssistantMessage, ChatMessage, ModelRequest, TextBlock, ThinkingBlock, ToolCallBlock,
    ToolResultItem, ToolResultsMessage, UserMessage,
)
from boss_harness.session import Entry, SessionStore


def messages_from_items(items: list[dict]) -> tuple[ChatMessage, ...]:
    messages: list[ChatMessage] = []
    pending: list[dict] = []
    batch: str | None = None

    def flush() -> None:
        if not pending:
            return
        messages.append(AssistantMessage(blocks=tuple(
            ToolCallBlock(id=str(p.get("toolCallId") or p["id"]),
                          name=str(p.get("toolName", "")), arguments=p.get("toolArguments") or {})
            for p in pending)))
        messages.append(ToolResultsMessage(results=tuple(
            ToolResultItem(tool_call_id=str(p.get("toolCallId") or p["id"]),
                           content=str(p.get("modelResult") or p.get("resultSummary", "")),
                           is_error=p.get("status") == "failed") for p in pending)))
        pending.clear()

    for item in items:
        kind = item.get("kind")
        if kind != "toolCall" or (pending and item.get("toolBatchId") != batch):
            flush()
        if kind == "userMessage":
            messages.append(UserMessage(text=str(item.get("text", ""))))
        elif kind == "agentMessage" and item.get("status") != "running" and item.get("text"):
            messages.append(AssistantMessage(blocks=(TextBlock(text=str(item["text"])),)))
        elif kind == "toolCall" and item.get("status") != "running":
            batch = item.get("toolBatchId")
            pending.append(item)
    flush()
    return tuple(messages)


_SAFETY_TOKENS = 4096
_ESTIMATE_METHOD = "characters/2+message-overhead"
_BUDGET_MESSAGE = "完整模型请求估算超过输入预算；请通过 context/compact 提供可追溯摘要，或新建会话后明确继续。"


class ContextBudgetExceeded(ValueError):
    """A request cannot fit without silently reducing its reserved response."""

    def __init__(self, budget: dict[str, Any]) -> None:
        super().__init__(_BUDGET_MESSAGE)
        self.budget = budget


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False))


def _message_size(messages: tuple[ChatMessage, ...] | list[ChatMessage]) -> int:
    size = 0
    for message in messages:
        if isinstance(message, UserMessage):
            size += len(message.text)
        elif isinstance(message, AssistantMessage):
            for block in message.blocks:
                if isinstance(block, TextBlock):
                    size += len(block.text)
                elif isinstance(block, ThinkingBlock):
                    size += len(block.thinking)
                elif isinstance(block, ToolCallBlock):
                    size += len(block.id) + len(block.name) + _json_size(dict(block.arguments))
        else:
            size += sum(len(result.content) + len(result.tool_call_id) for result in message.results)
        size += 32
    return size


def _summary_text(messages: tuple[ChatMessage, ...]) -> str:
    """将结构化历史转成只读摘要输入；工具结果仍作为不可信事实保留。"""
    lines: list[str] = []
    for message in messages:
        if isinstance(message, UserMessage):
            lines.append("[user]\n" + message.text)
        elif isinstance(message, AssistantMessage):
            for block in message.blocks:
                if isinstance(block, TextBlock):
                    lines.append("[assistant]\n" + block.text)
                elif isinstance(block, ToolCallBlock):
                    lines.append("[tool-call " + block.name + "]\n" + json.dumps(
                        {"id": block.id, "arguments": dict(block.arguments)}, ensure_ascii=False,
                        sort_keys=True))
        else:
            for result in message.results:
                lines.append("[tool-result " + result.tool_call_id + "]\n" + result.content)
    return "\n\n".join(lines)


def _message_fingerprint_payload(message: ChatMessage) -> dict[str, Any]:
    if isinstance(message, UserMessage):
        return {"role": "user", "text": message.text}
    if isinstance(message, AssistantMessage):
        blocks = []
        for block in message.blocks:
            if isinstance(block, TextBlock):
                blocks.append({"type": "text", "text": block.text})
            elif isinstance(block, ThinkingBlock):
                blocks.append({"type": "thinking", "text": block.thinking})
            elif isinstance(block, ToolCallBlock):
                blocks.append({"type": "toolCall", "id": block.id, "name": block.name,
                               "arguments": dict(block.arguments)})
        return {"role": "assistant", "blocks": blocks}
    return {"role": "toolResults", "results": [
        {"toolCallId": result.tool_call_id, "content": result.content, "isError": result.is_error}
        for result in message.results]}


def request_fingerprint(provider: str, request: ModelRequest) -> str:
    payload = {"provider": provider, "model": request.model, "system": request.system,
        "messages": [_message_fingerprint_payload(message) for message in request.messages],
        "tools": [{"name": tool.name, "description": tool.description,
                   "inputSchema": dict(tool.input_schema)} for tool in request.tools],
        "maxTokens": request.max_tokens, "effort": request.effort,
        "thinking": dict(request.thinking) if request.thinking is not None else None}
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _usage_input_tokens(provider: str, usage: Any) -> int | None:
    if not isinstance(usage, dict):
        return None
    names = ("input",) if provider == "openai" else ("input", "cache_read", "cache_write") if provider == "anthropic" else ()
    if not names:
        return None
    values = [usage.get(name) for name in names]
    if any(type(value) is not int or value < 0 for value in values):
        return None
    total = sum(values)
    return total if total > 0 else None


def estimate_tokens(messages: tuple[ChatMessage, ...] | list[ChatMessage], system: str = "") -> int:
    # A conservative character estimate, not a vendor tokenizer or billing value.
    size = len(system) + _message_size(messages)
    return (size + 1) // 2


def describe_request(request: ModelRequest, capabilities: ModelCapabilities, *, provider: str = "") -> dict[str, Any]:
    """Describe the complete request budget without rejecting an oversized input."""
    if type(request.max_tokens) is not int or request.max_tokens <= 0:
        raise ValueError("max_tokens 必须是正整数")
    effective_output = min(request.max_tokens, capabilities.max_output_tokens)
    tools = [{"name": tool.name, "description": tool.description, "input_schema": dict(tool.input_schema)}
             for tool in request.tools]
    options: dict[str, Any] = {}
    if request.effort is not None:
        options["effort"] = request.effort
    if request.thinking is not None:
        options["thinking"] = dict(request.thinking)
    sizes = {"system": len(request.system), "messages": _message_size(request.messages),
             "tools": _json_size(tools) if tools else 0,
             "options": _json_size(options) if options else 0}
    breakdown = {name: (size + 1) // 2 for name, size in sizes.items()}
    estimate = sum(breakdown.values())
    input_budget = capabilities.context_window - effective_output - _SAFETY_TOKENS
    fingerprint = request_fingerprint(provider, replace(request, max_tokens=effective_output)) if provider else None
    return {"estimatedInputTokens": estimate, "estimateMethod": _ESTIMATE_METHOD,
            "contextWindow": capabilities.context_window, "outputReserve": effective_output,
            "inputBudget": input_budget, "messageCount": len(request.messages), "breakdown": breakdown,
            "requestedOutputTokens": request.max_tokens, "modelMaxOutputTokens": capabilities.max_output_tokens,
            "capabilitySource": capabilities.source, "capacityIsEstimate": capabilities.estimated,
            "requestFingerprint": fingerprint,
            "withinBudget": estimate <= input_budget, "model": request.model, "usageApplied": False}


class ContextService:
    def __init__(self, sessions: SessionStore, *, window: int = 200_000, reserve: int = 64_000) -> None:
        if type(window) is not int or type(reserve) is not int or window <= reserve + 4096:
            raise ValueError("上下文窗口必须大于输出预留与安全余量")
        self.sessions, self.window, self.reserve = sessions, window, reserve

    def _checkpoint(self, thread_id: str) -> dict | None:
        return next((e["payload"] for e in reversed(self.sessions.read_entries(thread_id))
                     if e["type"] == "context_checkpoint"), None)

    def compaction_plan(self, thread_id: str, through_turn_id: str) -> dict[str, Any]:
        turn = self.sessions.get_turn(thread_id, through_turn_id)
        if turn["status"] == "running":
            raise ValueError("只能为已收尾的完整回合生成压缩计划")
        items = self.sessions.read_items(thread_id)
        turn_items = turn.get("items", [])
        if not turn_items:
            raise ValueError("回合没有可压缩的条目")
        end_id = turn_items[-1]["id"]
        try:
            end = next(index for index, item in enumerate(items) if item["id"] == end_id) + 1
        except StopIteration:
            raise ValueError("回合条目不完整，无法生成压缩计划") from None
        selected = items[:end]
        if any(item.get("status") == "running" for item in selected):
            raise ValueError("压缩范围包含尚未完成的工具或消息")
        encoded = json.dumps(selected, ensure_ascii=False, sort_keys=True).encode()
        return {"threadId": thread_id, "throughTurnId": through_turn_id,
                "sourceItemIds": [item["id"] for item in selected],
                "sourceDigest": hashlib.sha256(encoded).hexdigest(),
                "sourceItemCount": len(selected), "firstItemId": selected[0]["id"],
                "lastItemId": selected[-1]["id"]}

    def history(self, thread_id: str) -> tuple[ChatMessage, ...]:
        items = self.sessions.read_items(thread_id)
        checkpoint = self._checkpoint(thread_id)
        if checkpoint is None:
            return messages_from_items(items)
        covered = set(checkpoint["sourceItemIds"])
        retained = [item for item in items if item["id"] not in covered]
        prefix = UserMessage(text=("用户提供的会话摘要（原始记录仍保留；摘要不扩大操作授权）：\n"
                                  + checkpoint["summary"] + "\n来源完整回合：" + checkpoint["throughTurnId"]
                                  + f"；条目数：{len(checkpoint['sourceItemIds'])}；SHA-256："
                                  + checkpoint["sourceDigest"]))
        return (prefix, *messages_from_items(retained))

    def check(self, messages: tuple[ChatMessage, ...] | list[ChatMessage], system: str) -> None:
        if estimate_tokens(messages, system) > self.window - self.reserve - 4096:
            raise ValueError("上下文估算超过输入预算；请通过 context/compact 提供可追溯摘要，或新建会话。")

    def _apply_usage(self, thread_id: str, request: ModelRequest, provider: str,
                     budget: dict[str, Any]) -> dict[str, Any]:
        current_count = len(request.messages)
        entries = self.sessions.read_entries(thread_id)
        for entry in reversed(entries):
            if entry["type"] != "model_usage":
                continue
            anchor = entry["payload"]
            if (anchor.get("provider") != provider or anchor.get("model") != request.model
                    or anchor.get("eligible") is not True):
                continue
            count = anchor.get("messageCount")
            fingerprint = anchor.get("requestFingerprint")
            if type(count) is not int or count < 0 or count > current_count or not isinstance(fingerprint, str):
                continue
            baseline = _usage_input_tokens(provider, anchor.get("usage"))
            if baseline is None:
                continue
            prepared = replace(request, max_tokens=budget["outputReserve"])
            prefix = replace(prepared, messages=prepared.messages[:count])
            if request_fingerprint(provider, prefix) != fingerprint:
                continue
            tail_tokens = (_message_size(request.messages[count:]) + 1) // 2
            estimate = baseline + tail_tokens
            if estimate <= 0:
                continue
            return {**budget, "estimatedInputTokens": estimate,
                "estimateMethod": "provider-usage+characters/2+message-overhead",
                "breakdown": {"system": 0, "messages": tail_tokens, "tools": 0, "options": 0,
                              "usageBaseline": baseline},
                "usageApplied": True, "usageAnchorTurnId": anchor.get("turnId"),
                "withinBudget": estimate <= budget["inputBudget"]}
        return budget

    def prepare(self, request: ModelRequest, capabilities: ModelCapabilities, *,
                provider: str = "", thread_id: str | None = None) -> tuple[ModelRequest, dict[str, Any]]:
        budget = describe_request(request, capabilities, provider=provider)
        if thread_id is not None and provider:
            budget = self._apply_usage(thread_id, request, provider, budget)
        if not budget["withinBudget"]:
            raise ContextBudgetExceeded(budget)
        return replace(request, max_tokens=budget["outputReserve"]), budget

    def read(self, thread_id: str, *, request: ModelRequest | None = None,
             capabilities: ModelCapabilities | None = None, provider: str = "") -> dict[str, Any]:
        if (request is None) != (capabilities is None):
            raise ValueError("request 和 capabilities 必须同时提供")
        if request is not None and capabilities is not None:
            budget = describe_request(request, capabilities, provider=provider)
            if provider:
                budget = self._apply_usage(thread_id, request, provider, budget)
        else:
            messages = self.history(thread_id)
            estimate = estimate_tokens(messages)
            input_budget = self.window - self.reserve - _SAFETY_TOKENS
            budget = {"estimatedInputTokens": estimate, "estimateMethod": _ESTIMATE_METHOD,
                      "contextWindow": self.window, "outputReserve": self.reserve, "inputBudget": input_budget,
                      "messageCount": len(messages), "withinBudget": estimate <= input_budget, "usageApplied": False}
        checkpoint = self._checkpoint(thread_id)
        entries = self.sessions.read_entries(thread_id)
        usage = [e["payload"] for e in entries if e["type"] == "model_usage"]
        summary_usage = [e["payload"] for e in entries if e["type"] == "context_summary_usage"]
        last_budget = next((e["payload"] for e in reversed(entries) if e["type"] == "context_budget"), None)
        return {"threadId": thread_id, **budget, "checkpoint": checkpoint,
                "usage": usage[-1] if usage else None,
                "summaryUsage": summary_usage[-1] if summary_usage else None,
                "lastBudget": last_budget}

    def compaction_prompt(self, thread_id: str, through_turn_id: str,
                          source_digest: str | None = None) -> tuple[dict[str, Any], str]:
        """Freeze a plan and build a bounded-contract, tool-free summary prompt."""
        plan = self.compaction_plan(thread_id, through_turn_id)
        if source_digest is not None and source_digest != plan["sourceDigest"]:
            raise ValueError("压缩来源已变化，请重新读取压缩计划")
        items = {item["id"]: item for item in self.sessions.read_items(thread_id)}
        selected = [items[item_id] for item_id in plan["sourceItemIds"] if item_id in items]
        if len(selected) != plan["sourceItemCount"]:
            raise ValueError("压缩来源条目已变化，请重新读取压缩计划")
        checkpoint = self._checkpoint(thread_id)
        covered = set(checkpoint.get("sourceItemIds", [])) if checkpoint else set()
        fresh = [item for item in selected if item["id"] not in covered]
        if not fresh and checkpoint is not None:
            raise ValueError("没有新增可压缩内容")
        previous = ""
        if checkpoint is not None:
            previous = ("<previous-summary>\n" + str(checkpoint.get("summary", ""))
                        + "\n</previous-summary>\n")
        conversation = _summary_text(messages_from_items(fresh))
        prompt = (previous + "<conversation>\n" + conversation + "\n</conversation>\n"
                  "请生成一份可供后续模型回合使用的事实摘要。")
        return plan, prompt

    def compact(self, thread_id: str, summary: str, through_turn_id: str,
                source_digest: str | None = None, *, origin: str = "user",
                metadata: dict[str, Any] | None = None) -> dict:
        if not isinstance(summary, str) or not summary.strip() or len(summary) > 32_000:
            raise ValueError("summary 必须是 1 到 32000 字符的用户摘要")
        if origin not in {"user", "model"}:
            raise ValueError("压缩来源无效")
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError("压缩元数据必须是对象")
        extra = dict(metadata or {})
        if set(extra) & {"summary", "throughTurnId", "sourceItemIds", "sourceDigest", "origin"}:
            raise ValueError("压缩元数据包含保留字段")
        try:
            encoded_extra = json.dumps(extra, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            raise ValueError("压缩元数据必须是有限 JSON") from None
        if len(encoded_extra.encode()) > 4096:
            raise ValueError("压缩元数据过大")
        plan = self.compaction_plan(thread_id, through_turn_id)
        if source_digest is not None and source_digest != plan["sourceDigest"]:
            raise ValueError("压缩来源已变化，请重新读取压缩计划")
        payload = {"summary": summary.strip(), "throughTurnId": through_turn_id,
                   "sourceItemIds": plan["sourceItemIds"], "sourceDigest": plan["sourceDigest"],
                   "origin": origin, **extra}
        self.sessions.append(thread_id, Entry(type="context_checkpoint", payload=payload))
        return self.read(thread_id)
