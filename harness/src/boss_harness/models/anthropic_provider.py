"""Anthropic provider：用官方 SDK 的官方流式接口。

约束（来自 claude-api 技能）：
- 必须用官方 `anthropic` SDK，不手写 HTTP/SSE；
- 默认模型 `claude-opus-5-5`，默认流式（大 max_tokens 非流式会被 SDK 拒绝）；
- `thinking` 默认不显式传：Opus 5.5 省略即等价于 adaptive，也能避免网关拒绝未知字段；
- 生成开始后的失败一律转成 `error` 事件，不向上抛。
"""
from __future__ import annotations

import json
import os
from collections.abc import Iterator, Sequence

import anthropic

from boss_harness.models.provider import ModelConfig
from boss_harness.models.secret import redact_secrets
from boss_harness.models.types import (
    AssistantMessage,
    ChatMessage,
    ModelRequest,
    StreamEvent,
    TextBlock,
    ThinkingBlock,
    ToolCallBlock,
    ToolResultsMessage,
    Usage,
)

_FALLBACK_BETA = "server-side-fallback-2026-07-01"
#: SDK 的停止原因 -> 我们的 StopReason
_STOP_REASONS = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "tool_use": "tool_use",
    "max_tokens": "length",
    "pause_turn": "stop",
    "refusal": "error",
}


def to_sdk_messages(messages: Sequence[ChatMessage]) -> list[dict[str, object]]:
    """把内部消息翻成 SDK 形状。

    注意：ThinkingBlock 在回放时被丢弃（我们没有可回传的签名），这不影响对话有效性。
    """
    out: list[dict[str, object]] = []
    for message in messages:
        if isinstance(message, ToolResultsMessage):
            out.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": item.tool_call_id,
                            "content": item.content,
                            **({"is_error": True} if item.is_error else {}),
                        }
                        for item in message.results
                    ],
                }
            )
            continue
        if isinstance(message, AssistantMessage):
            blocks: list[dict[str, object]] = []
            for block in message.blocks:
                if isinstance(block, TextBlock):
                    blocks.append({"type": "text", "text": block.text})
                elif isinstance(block, ToolCallBlock):
                    blocks.append(
                        {"type": "tool_use", "id": block.id, "name": block.name, "input": dict(block.arguments)}
                    )
            if blocks:
                out.append({"role": "assistant", "content": blocks})
            continue
        out.append({"role": "user", "content": message.text})  # type: ignore[union-attr]
    return out


def _usage_from_sdk(usage: object) -> Usage:
    get = lambda name: int(getattr(usage, name, 0) or 0)  # noqa: E731
    return Usage(
        input=get("input_tokens"),
        output=get("output_tokens"),
        cache_read=get("cache_read_input_tokens"),
        cache_write=get("cache_creation_input_tokens"),
    )


class AnthropicProvider:
    id = "anthropic"

    def __init__(self, config: ModelConfig) -> None:
        self.model = config.model
        self.max_tokens = config.max_tokens
        self.effort = config.effort
        self.thinking = config.thinking
        self.server_side_fallback = config.server_side_fallback
        #: 这条线路的凭据来自环境变量，因此除了 config 里可能带的，还要把环境里的也纳入脱敏。
        self._secret = (
            config.api_key.get() if config.api_key else ""
        ) or os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY") or ""
        self._client = anthropic.Anthropic(timeout=30.0, max_retries=0)
        self._active_stream: object | None = None
        self._abort_requested = False

    def request_abort(self) -> None:
        self._abort_requested = True
        close = getattr(self._active_stream, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass

    def _redact(self, text: object) -> str:
        """错误文本会被写进会话文件并推给外壳，落盘前先把凭据抹掉。"""
        return redact_secrets(str(text), extra=(self._secret,))

    # ---------- 请求参数 ----------

    def _request_kwargs(self, request: ModelRequest) -> dict[str, object]:
        kwargs: dict[str, object] = {
            "model": request.model,
            "max_tokens": request.max_tokens,
            "system": request.system,
            "messages": to_sdk_messages(request.messages),
        }
        if request.tools:
            kwargs["tools"] = [
                {
                    "name": spec.name,
                    "description": spec.description,
                    "input_schema": dict(spec.input_schema),
                }
                for spec in request.tools
            ]
        if request.thinking:
            kwargs["thinking"] = dict(request.thinking)
        if request.effort:
            kwargs["output_config"] = {"effort": request.effort}
        return kwargs

    # ---------- 事件流 ----------

    def stream(self, request: ModelRequest) -> Iterator[StreamEvent]:
        self._abort_requested = False
        kwargs = self._request_kwargs(request)
        buffers: dict[int, list[str]] = {}

        yield StreamEvent(type="start")

        try:
            if self.server_side_fallback:
                stream_ctx = self._client.beta.messages.stream(
                    **kwargs,  # type: ignore[arg-type]
                    betas=[_FALLBACK_BETA],
                    fallbacks="default",
                )
            else:
                stream_ctx = self._client.messages.stream(**kwargs)  # type: ignore[arg-type]

            with stream_ctx as stream:
                self._active_stream = stream
                for event in stream:
                    if self._abort_requested:
                        yield StreamEvent(type="error", reason="aborted", error="请求已取消")
                        return
                    kind = getattr(event, "type", "")
                    if kind == "content_block_start":
                        index = int(getattr(event, "index", 0))
                        buffers[index] = []
                        block_type = getattr(getattr(event, "content_block", None), "type", "")
                        if block_type == "text":
                            yield StreamEvent(type="text_start", content_index=index)
                        elif block_type == "thinking":
                            yield StreamEvent(type="thinking_start", content_index=index)
                        elif block_type == "tool_use":
                            yield StreamEvent(type="toolcall_start", content_index=index)
                    elif kind == "content_block_delta":
                        index = int(getattr(event, "index", 0))
                        delta = getattr(event, "delta", None)
                        delta_type = getattr(delta, "type", "")
                        if delta_type == "text_delta":
                            text = str(getattr(delta, "text", ""))
                            buffers.setdefault(index, []).append(text)
                            yield StreamEvent(type="text_delta", content_index=index, delta=text)
                        elif delta_type == "thinking_delta":
                            text = str(getattr(delta, "thinking", ""))
                            buffers.setdefault(index, []).append(text)
                            yield StreamEvent(type="thinking_delta", content_index=index, delta=text)
                        elif delta_type == "input_json_delta":
                            yield StreamEvent(
                                type="toolcall_delta",
                                content_index=index,
                                delta=str(getattr(delta, "partial_json", "")),
                            )
                    elif kind == "content_block_stop":
                        index = int(getattr(event, "index", 0))
                        joined = "".join(buffers.get(index, []))
                        if joined:
                            yield StreamEvent(type="text_end", content_index=index, text=joined)
                final = stream.get_final_message()
        except anthropic.APIConnectionError as exc:
            yield StreamEvent(type="error", reason="error", error=self._redact(f"连接失败：{exc}"))
            return
        except anthropic.RateLimitError as exc:
            yield StreamEvent(type="error", reason="error", error=self._redact(f"被限流：{exc}"))
            return
        except anthropic.APIStatusError as exc:
            yield StreamEvent(
                type="error",
                reason="error",
                error=self._redact(f"接口错误 {exc.status_code}：{exc.message}"),
            )
            return
        except Exception as exc:  # noqa: BLE001
            # 兜底：`provider.py` 的契约要求「生成开始后不抛异常」。SDK 里还有不属于
            # APIError 体系的异常（例如凭据无法解析时的 AnthropicError），漏掉它们会让
            # 一次失败变成 JSON-RPC 的内部错误，丢掉上下文。
            yield StreamEvent(
                type="error",
                reason="error",
                error=self._redact(f"流处理异常（{type(exc).__name__}）：{exc}"),
            )
            return

        finally:
            self._active_stream = None

        blocks: list[object] = []
        for block in final.content:
            block_type = getattr(block, "type", "")
            if block_type == "text":
                blocks.append(TextBlock(text=str(block.text)))
            elif block_type == "thinking":
                blocks.append(ThinkingBlock(thinking=str(getattr(block, "thinking", ""))))
            elif block_type == "tool_use":
                call = ToolCallBlock(
                    id=str(block.id),
                    name=str(block.name),
                    arguments=dict(block.input or {}),
                )
                blocks.append(call)
                yield StreamEvent(type="toolcall_end", tool_call=call)

        stop_reason = _STOP_REASONS.get(str(final.stop_reason or ""), "stop")
        message = AssistantMessage(
            blocks=tuple(blocks),  # type: ignore[arg-type]
            stop_reason=stop_reason,  # type: ignore[arg-type]
            usage=_usage_from_sdk(final.usage),
        )
        if str(final.stop_reason) == "refusal":
            details = getattr(final, "stop_details", None)
            category = getattr(details, "category", None) or "unknown"
            yield StreamEvent(type="error", reason="error", error=f"模型以安全原因拒绝（{category}）")
            return
        yield StreamEvent(type="done", reason=stop_reason, message=message)


def tool_result_payload(result: object) -> str:
    """把工具返回压成一段文本回填给模型。"""
    try:
        return json.dumps(result, ensure_ascii=False)[:20000]
    except TypeError:
        return str(result)[:20000]
