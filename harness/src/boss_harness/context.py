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


def estimate_tokens(messages: tuple[ChatMessage, ...] | list[ChatMessage], system: str = "") -> int:
    # A conservative character estimate, not a vendor tokenizer or billing value.
    size = len(system) + _message_size(messages)
    return (size + 1) // 2


def describe_request(request: ModelRequest, capabilities: ModelCapabilities) -> dict[str, Any]:
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
    return {"estimatedInputTokens": estimate, "estimateMethod": _ESTIMATE_METHOD,
            "contextWindow": capabilities.context_window, "outputReserve": effective_output,
            "inputBudget": input_budget, "messageCount": len(request.messages), "breakdown": breakdown,
            "requestedOutputTokens": request.max_tokens, "modelMaxOutputTokens": capabilities.max_output_tokens,
            "capabilitySource": capabilities.source, "capacityIsEstimate": capabilities.estimated,
            "withinBudget": estimate <= input_budget, "model": request.model, "usageApplied": False}


class ContextService:
    def __init__(self, sessions: SessionStore, *, window: int = 200_000, reserve: int = 64_000) -> None:
        if type(window) is not int or type(reserve) is not int or window <= reserve + 4096:
            raise ValueError("上下文窗口必须大于输出预留与安全余量")
        self.sessions, self.window, self.reserve = sessions, window, reserve

    def _checkpoint(self, thread_id: str) -> dict | None:
        return next((e["payload"] for e in reversed(self.sessions.read_entries(thread_id))
                     if e["type"] == "context_checkpoint"), None)

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

    def prepare(self, request: ModelRequest, capabilities: ModelCapabilities) -> tuple[ModelRequest, dict[str, Any]]:
        budget = describe_request(request, capabilities)
        if not budget["withinBudget"]:
            raise ContextBudgetExceeded(budget)
        return replace(request, max_tokens=budget["outputReserve"]), budget

    def read(self, thread_id: str, *, request: ModelRequest | None = None,
             capabilities: ModelCapabilities | None = None) -> dict[str, Any]:
        if (request is None) != (capabilities is None):
            raise ValueError("request 和 capabilities 必须同时提供")
        if request is not None and capabilities is not None:
            budget = describe_request(request, capabilities)
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
        last_budget = next((e["payload"] for e in reversed(entries) if e["type"] == "context_budget"), None)
        return {"threadId": thread_id, **budget, "checkpoint": checkpoint,
                "usage": usage[-1] if usage else None, "lastBudget": last_budget}

    def compact(self, thread_id: str, summary: str, through_turn_id: str) -> dict:
        if not isinstance(summary, str) or not summary.strip() or len(summary) > 32_000:
            raise ValueError("summary 必须是 1 到 32000 字符的用户摘要")
        turn = self.sessions.get_turn(thread_id, through_turn_id)
        if turn["status"] == "running":
            raise ValueError("只能压缩已收尾的完整回合")
        items = self.sessions.read_items(thread_id)
        turn_items = turn.get("items", [])
        if not turn_items:
            raise ValueError("回合没有可压缩的条目")
        end_id = turn_items[-1]["id"]
        end = next(i for i, item in enumerate(items) if item["id"] == end_id) + 1
        selected = items[:end]
        if any(item.get("status") == "running" for item in selected):
            raise ValueError("压缩范围包含尚未完成的工具或消息")
        payload = {"summary": summary.strip(), "throughTurnId": through_turn_id,
                   "sourceItemIds": [item["id"] for item in selected],
                   "sourceDigest": hashlib.sha256(json.dumps(selected, ensure_ascii=False,
                       sort_keys=True).encode()).hexdigest(), "origin": "user"}
        self.sessions.append(thread_id, Entry(type="context_checkpoint", payload=payload))
        return self.read(thread_id)
