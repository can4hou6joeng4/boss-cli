"""Private, bounded provider metadata needed to resume tool continuations."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from boss_harness.models.types import AssistantMessage, ThinkingBlock, TextBlock, ToolCallBlock

ANTHROPIC_CONTINUATION_FIELD = "_anthropicContinuation"
MAX_ANTHROPIC_SIGNATURE_BYTES = 16 * 1024
MAX_ANTHROPIC_SIGNATURE_TOTAL_BYTES = 96 * 1024
MAX_ANTHROPIC_CONTINUATION_BYTES = 128 * 1024
MAX_ANTHROPIC_CONTINUATION_CHARS = 1024 * 1024


def anthropic_prefix_digest(system: str, tools: object, messages: object) -> str:
    """Bind opaque thinking to the exact model-visible prefix that produced it."""
    value = {"system": system, "tools": tools or [], "messages": messages}
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def anthropic_continuation(message: AssistantMessage, assistant_item_id: str | None) -> dict[str, Any] | None:
    """Describe signed assistant blocks without duplicating persisted text or thinking."""
    calls = [block for block in message.blocks if isinstance(block, ToolCallBlock)]
    has_continuation = any(
        isinstance(block, ThinkingBlock) and (block.signature is not None or block.redacted_data is not None)
        for block in message.blocks
    )
    if not calls or not has_continuation:
        return None
    payload: dict[str, Any] = {
        "version": 1,
        "provider": "anthropic",
        "assistantItemId": assistant_item_id,
        "toolCallIds": [block.id for block in calls],
        "requestPrefix": next(
            block.prefix_digest for block in message.blocks
            if isinstance(block, ThinkingBlock) and (block.signature is not None or block.redacted_data is not None)
        ),
        "blocks": [],
    }
    total_signature_bytes = 0
    descriptors: list[dict[str, Any]] = []
    for block in message.blocks:
        if isinstance(block, TextBlock):
            descriptors.append({"type": "text", "length": len(block.text),
                                "sha256": hashlib.sha256(block.text.encode("utf-8")).hexdigest()})
        elif isinstance(block, ThinkingBlock):
            if block.prefix_digest != payload["requestPrefix"]:
                raise ValueError("Anthropic thinking blocks do not share a request prefix")
            if block.redacted_data is not None:
                if block.signature is not None or block.thinking:
                    raise ValueError("Anthropic redacted thinking block is invalid")
                size = len(block.redacted_data.encode("utf-8"))
                if not block.redacted_data or size > MAX_ANTHROPIC_SIGNATURE_BYTES:
                    raise ValueError("Anthropic redacted thinking exceeds its private storage limit")
                total_signature_bytes += size
                descriptors.append({"type": "redactedThinking", "data": block.redacted_data})
                continue
            signature = block.signature
            if signature is not None:
                size = len(signature.encode("utf-8"))
                if not signature or size > MAX_ANTHROPIC_SIGNATURE_BYTES:
                    raise ValueError("Anthropic thinking signature exceeds its private storage limit")
                total_signature_bytes += size
            descriptors.append({"type": "thinking", "length": len(block.thinking),
                                "signature": signature,
                                "sha256": hashlib.sha256(block.thinking.encode("utf-8")).hexdigest()})
        elif isinstance(block, ToolCallBlock):
            descriptors.append({"type": "toolCall", "id": block.id})
    if (total_signature_bytes > MAX_ANTHROPIC_SIGNATURE_TOTAL_BYTES
            or len(descriptors) > 4096):
        raise ValueError("Anthropic thinking signatures exceed their private storage limit")
    payload["blocks"] = descriptors
    if len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_ANTHROPIC_CONTINUATION_BYTES:
        raise ValueError("Anthropic tool continuation exceeds its private storage limit")
    return payload


def assistant_from_tool_batch(items: list[dict], pending: list[dict]) -> AssistantMessage:
    """Restore an assistant tool batch, including its private signed block order."""
    tool_calls = tuple(
        ToolCallBlock(
            id=str(item.get("toolCallId") or item["id"]),
            name=str(item.get("toolName", "")),
            arguments=item.get("toolArguments") or {},
        )
        for item in pending
    )
    continuations = [item[ANTHROPIC_CONTINUATION_FIELD] for item in pending
                     if ANTHROPIC_CONTINUATION_FIELD in item]
    if not continuations:
        return AssistantMessage(blocks=tool_calls)
    calls = {call.id: call for call in tool_calls}
    if len(continuations) != 1 or ANTHROPIC_CONTINUATION_FIELD not in pending[0]:
        raise ValueError("Anthropic continuation metadata is duplicated")
    payload = continuations[0]
    if (not isinstance(payload, dict)
            or set(payload) != {"version", "provider", "assistantItemId", "toolCallIds", "requestPrefix", "blocks"}
            or type(payload.get("version")) is not int or payload["version"] != 1
            or payload.get("provider") != "anthropic"
            or len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            > MAX_ANTHROPIC_CONTINUATION_BYTES):
        raise ValueError("Anthropic continuation metadata is invalid")
    prefix_digest = payload["requestPrefix"]
    if prefix_digest is not None and (
            not isinstance(prefix_digest, str) or re.fullmatch(r"[a-f0-9]{64}", prefix_digest) is None):
        raise ValueError("Anthropic continuation request prefix is invalid")
    call_ids = [str(item.get("toolCallId") or item["id"]) for item in pending]
    intended_call_ids = payload.get("toolCallIds")
    # Tool items are durable before dispatch. After a process exit only a
    # contiguous prefix may exist; absent suffix calls have never been dispatched.
    if (not isinstance(intended_call_ids, list) or not intended_call_ids
            or not all(isinstance(value, str) and value for value in intended_call_ids)
            or len(set(intended_call_ids)) != len(intended_call_ids)
            or len(calls) != len(pending)
            or intended_call_ids[:len(call_ids)] != call_ids):
        raise ValueError("Anthropic continuation no longer matches its tool batch")
    assistant_item_id = payload.get("assistantItemId")
    assistant_item = None
    if assistant_item_id is not None:
        if not isinstance(assistant_item_id, str):
            raise ValueError("Anthropic continuation assistant item reference is invalid")
        assistant_item = next((item for item in items if item.get("id") == assistant_item_id), None)
        if assistant_item is None or assistant_item.get("kind") != "agentMessage":
            raise ValueError("Anthropic continuation assistant item is missing")
        if assistant_item.get("turnId") != pending[0].get("turnId"):
            raise ValueError("Anthropic continuation assistant belongs to another turn")
    if any(item.get("turnId") != pending[0].get("turnId") for item in pending):
        raise ValueError("Anthropic continuation tools belong to different turns")
    text_value = str(assistant_item.get("text", "")) if assistant_item is not None else ""
    thinking_value = str(assistant_item.get("thinking", "")) if assistant_item is not None else ""
    blocks = payload.get("blocks")
    if not isinstance(blocks, list) or len(blocks) > 4096:
        raise ValueError("Anthropic continuation block list is invalid")
    text_length = thinking_length = signature_bytes = 0
    described_calls: list[str] = []
    missing_call_seen = False
    if assistant_item is not None and assistant_item.get("contextEdit"):
        raise ValueError("Signed Anthropic assistant responses cannot be context edited")
    text_offset = thinking_offset = 0
    restored: list[TextBlock | ThinkingBlock | ToolCallBlock] = []
    for block in blocks:
        if not isinstance(block, dict) or not isinstance(block.get("type"), str):
            raise ValueError("Anthropic continuation block is invalid")
        kind = block["type"]
        if kind in {"text", "thinking"}:
            if missing_call_seen:
                raise ValueError("Anthropic continuation has content after an unpersisted tool call")
            if set(block) != ({"type", "length", "sha256"} if kind == "text"
                              else {"type", "length", "sha256", "signature"}):
                raise ValueError("Anthropic continuation content descriptor is invalid")
            content_digest = block.get("sha256")
            if not isinstance(content_digest, str) or re.fullmatch(r"[a-f0-9]{64}", content_digest) is None:
                raise ValueError("Anthropic continuation content digest is invalid")
            length = block.get("length")
            if type(length) is not int or not 0 <= length <= MAX_ANTHROPIC_CONTINUATION_CHARS:
                raise ValueError("Anthropic continuation content length is invalid")
            if kind == "text":
                text_length += length
                if assistant_item is not None:
                    value = text_value[text_offset:text_offset + length]
                    if hashlib.sha256(value.encode("utf-8")).hexdigest() != content_digest:
                        raise ValueError("Anthropic continuation text has changed")
                    if value:
                        restored.append(TextBlock(text=value))
                text_offset += length
            else:
                thinking_length += length
                signature = block["signature"]
                if signature is not None:
                    if not isinstance(signature, str) or not signature:
                        raise ValueError("Anthropic continuation signature is invalid")
                    size = len(signature.encode("utf-8"))
                    signature_bytes += size
                    if size > MAX_ANTHROPIC_SIGNATURE_BYTES:
                        raise ValueError("Anthropic continuation signature exceeds its limit")
                value = thinking_value[thinking_offset:thinking_offset + length]
                if hashlib.sha256(value.encode("utf-8")).hexdigest() != content_digest:
                    raise ValueError("Anthropic continuation thinking has changed")
                restored.append(ThinkingBlock(thinking=value, signature=signature, prefix_digest=prefix_digest))
                thinking_offset += length
        elif kind == "redactedThinking":
            if set(block) != {"type", "data"} or not isinstance(block.get("data"), str) or not block["data"]:
                raise ValueError("Anthropic redacted thinking block is invalid")
            size = len(block["data"].encode("utf-8"))
            if size > MAX_ANTHROPIC_SIGNATURE_BYTES:
                raise ValueError("Anthropic redacted thinking exceeds its limit")
            signature_bytes += size
            restored.append(ThinkingBlock(redacted_data=block["data"], prefix_digest=prefix_digest))
        elif kind == "toolCall":
            if set(block) != {"type", "id"} or not isinstance(block.get("id"), str):
                raise ValueError("Anthropic continuation tool descriptor is invalid")
            call_id = block["id"]
            call = calls.get(call_id)
            described_calls.append(call_id)
            if call is not None:
                restored.append(call)
            else:
                missing_call_seen = True
        else:
            raise ValueError("Anthropic continuation block type is unsupported")
    if (text_length > MAX_ANTHROPIC_CONTINUATION_CHARS
            or thinking_length > MAX_ANTHROPIC_CONTINUATION_CHARS
            or signature_bytes > MAX_ANTHROPIC_SIGNATURE_TOTAL_BYTES
            or described_calls != intended_call_ids
            or (assistant_item is None and (text_length or thinking_length))
            or (assistant_item is not None
                and (text_offset != len(text_value) or thinking_offset != len(thinking_value)))):
        raise ValueError("Anthropic continuation does not match its assistant response")
    return AssistantMessage(blocks=tuple(restored))
