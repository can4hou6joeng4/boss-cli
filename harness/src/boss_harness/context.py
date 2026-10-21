"""Model context is a projection of durable history, never the history itself.

Pi reference: 5ba1cbaf3d96d204d847c84ce235c62dae23e0fd, session-manager and
agent-loop transformContext. Compaction preserves provenance and complete turns.
Token estimates are deliberately labelled estimates; provider usage stays separate.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from boss_harness.models.types import (
    AssistantMessage, ChatMessage, TextBlock, ToolCallBlock,
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


def estimate_tokens(messages: tuple[ChatMessage, ...] | list[ChatMessage], system: str = "") -> int:
    # A conservative character estimate, not a vendor tokenizer or billing value.
    size = len(system)
    for message in messages:
        if isinstance(message, UserMessage):
            size += len(message.text)
        elif isinstance(message, AssistantMessage):
            size += len(message.text())
            for call in message.tool_calls():
                size += len(call.name) + len(json.dumps(dict(call.arguments), ensure_ascii=False))
        else:
            size += sum(len(result.content) + len(result.tool_call_id) for result in message.results)
        size += 32
    return (size + 1) // 2


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

    def read(self, thread_id: str) -> dict[str, Any]:
        messages = self.history(thread_id)
        checkpoint = self._checkpoint(thread_id)
        usage = [e["payload"] for e in self.sessions.read_entries(thread_id) if e["type"] == "model_usage"]
        return {"threadId": thread_id, "estimatedInputTokens": estimate_tokens(messages),
                "estimateMethod": "characters/2+message-overhead", "contextWindow": self.window,
                "outputReserve": self.reserve, "inputBudget": self.window - self.reserve - 4096,
                "messageCount": len(messages), "checkpoint": checkpoint,
                "usage": usage[-1] if usage else None}

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
