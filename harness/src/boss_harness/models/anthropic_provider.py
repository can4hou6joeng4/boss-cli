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
from dataclasses import replace

import anthropic

from boss_harness.models.errors import anthropic_error_info
from boss_harness.models.continuation import (
    MAX_ANTHROPIC_SIGNATURE_BYTES,
    MAX_ANTHROPIC_SIGNATURE_TOTAL_BYTES,
    anthropic_prefix_digest,
)
from boss_harness.models.output_budget import (
    OutputBudgetExceeded,
    ResponseTextBudget,
    ToolArgumentBudget,
    bounded_error,
)
from boss_harness.models.provider import ModelConfig
from boss_harness.models.secret import redact_secrets
from boss_harness.models.stream_pump import AsyncStreamPump, StreamAborted, StreamDeadlineExceeded
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


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"非法 JSON 常量: {value}")


def _parse_tool_arguments(raw: str) -> dict[str, object] | None:
    try:
        parsed = json.loads(raw, parse_constant=_reject_json_constant)
    except (TypeError, ValueError, RecursionError):
        return None
    return parsed if isinstance(parsed, dict) else None


def to_sdk_messages(messages: Sequence[ChatMessage], *, system: str | None = None,
                    tools: object = None) -> list[dict[str, object]]:
    """把内部消息翻成 SDK 形状，并原样回放已签名的 thinking blocks。"""
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
            prefix_digest = anthropic_prefix_digest(system, tools, out) if system is not None else None
            for block in message.blocks:
                if isinstance(block, TextBlock):
                    blocks.append({"type": "text", "text": block.text})
                elif isinstance(block, ThinkingBlock):
                    if (prefix_digest is not None and block.prefix_digest is not None
                            and block.prefix_digest != prefix_digest):
                        continue
                    if block.redacted_data is not None:
                        blocks.append({"type": "redacted_thinking", "data": block.redacted_data})
                    elif block.signature is not None:
                        blocks.append({"type": "thinking", "thinking": block.thinking,
                                       "signature": block.signature})
                elif isinstance(block, ToolCallBlock):
                    blocks.append(
                        {"type": "tool_use", "id": block.id, "name": block.name, "input": dict(block.arguments)}
                    )
            if blocks:
                out.append({"role": "assistant", "content": blocks})
            continue
        out.append({"role": "user", "content": message.text})  # type: ignore[union-attr]
    return out


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
        self._request_timeout_seconds = config.request_timeout_seconds
        self._active_stream: object | None = None
        self._abort_requested = False

    def request_abort(self) -> None:
        self._abort_requested = True
        stream = self._active_stream
        cancel = getattr(stream, "cancel", None)
        close = getattr(stream, "close", None)
        stop = cancel if callable(cancel) else close
        if callable(stop):
            try:
                stop()
            except Exception:
                pass

    def _redact(self, text: object) -> str:
        """错误文本会被写进会话文件并推给外壳，落盘前先把凭据抹掉。"""
        return bounded_error("", redact_secrets(str(text), extra=(self._secret,)))

    # ---------- 请求参数 ----------

    def _request_kwargs(self, request: ModelRequest) -> dict[str, object]:
        tools = [
            {"name": spec.name, "description": spec.description, "input_schema": dict(spec.input_schema)}
            for spec in request.tools
        ]
        kwargs: dict[str, object] = {
            "model": request.model,
            "max_tokens": request.max_tokens,
            "system": request.system,
            "messages": to_sdk_messages(request.messages, system=request.system, tools=tools),
        }
        if request.tools:
            kwargs["tools"] = tools
        if request.thinking:
            kwargs["thinking"] = dict(request.thinking)
        if request.effort:
            kwargs["output_config"] = {"effort": request.effort}
        return kwargs

    # ---------- 事件流 ----------

    def stream(self, request: ModelRequest) -> Iterator[StreamEvent]:
        self._abort_requested = False
        kwargs = self._request_kwargs(request)
        prefix_digest = anthropic_prefix_digest(request.system, kwargs.get("tools"), kwargs["messages"])
        buffers: dict[int, list[str]] = {}
        signatures: dict[int, str] = {}
        signature_sizes: dict[int, int] = {}
        redacted_data: dict[int, str] = {}
        tool_argument_buffers: dict[int, list[str]] = {}
        tool_names: dict[int, str] = {}
        tool_ids: dict[int, str] = {}
        block_types: dict[int, str] = {}
        started_tools: set[int] = set()
        snapshot_only_tools: set[int] = set()
        closed_tool_blocks: set[int] = set()
        closed_blocks: set[int] = set()
        budget = ToolArgumentBudget()
        text_budget = ResponseTextBudget()
        signature_bytes = 0
        usage = {"input_tokens": 0, "output_tokens": 0,
                 "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        stop_reason: str | None = None
        saw_message_stop = False
        request_has_private = any(
            isinstance(message, AssistantMessage)
            and any(isinstance(block, ThinkingBlock)
                    and (block.signature is not None or block.redacted_data is not None)
                    for block in message.blocks)
            for message in request.messages
        )

        def has_private() -> bool:
            return request_has_private or bool(signatures or redacted_data)

        def private_error_info(info):
            return replace(info, provider_code=None) if has_private() else info

        yield StreamEvent(type="start")

        try:
            async def produce(send) -> None:
                async with anthropic.AsyncAnthropic(timeout=30.0, max_retries=0) as client:
                    if self.server_side_fallback:
                        stream = await client.beta.messages.create(
                            **kwargs,  # type: ignore[arg-type]
                            betas=[_FALLBACK_BETA],
                            fallbacks="default",
                            stream=True,
                        )
                    else:
                        stream = await client.messages.create(**kwargs, stream=True)  # type: ignore[arg-type]
                    async with stream:
                        async for event in stream:
                            await send(event)

            pump = AsyncStreamPump(produce, timeout=self._request_timeout_seconds,
                                   name="anthropic-message-stream")
            self._active_stream = pump
            with pump as stream:
                if self._abort_requested:
                    yield StreamEvent(type="error", reason="aborted", error="请求已取消")
                    return
                for event in stream:
                    if self._abort_requested:
                        yield StreamEvent(type="error", reason="aborted", error="请求已取消")
                        return
                    if saw_message_stop:
                        raise ValueError("message_stop 之后收到额外模型流事件")
                    kind = getattr(event, "type", "")
                    if kind == "message_start":
                        message = getattr(event, "message", None)
                        start_usage = getattr(message, "usage", None)
                        if start_usage is not None:
                            for field in usage:
                                usage[field] = int(getattr(start_usage, field, 0) or 0)
                    elif kind == "message_delta":
                        delta = getattr(event, "delta", None)
                        stop_reason = getattr(delta, "stop_reason", None)
                        delta_usage = getattr(event, "usage", None)
                        if delta_usage is not None:
                            for field in usage:
                                value = getattr(delta_usage, field, None)
                                if value is not None:
                                    usage[field] = int(value or 0)
                    elif kind == "message_stop":
                        saw_message_stop = True
                    elif kind == "content_block_start":
                        index = int(getattr(event, "index", 0))
                        if index in block_types:
                            raise ValueError("响应重复使用内容块索引")
                        buffers[index] = []
                        block_type = getattr(getattr(event, "content_block", None), "type", "")
                        block_types[index] = str(block_type)
                        if block_type == "text":
                            yield StreamEvent(type="text_start", content_index=index)
                            initial_text = str(getattr(event.content_block, "text", "") or "")
                            if initial_text:
                                text_budget.account(index, initial_text)
                                buffers[index].append(initial_text)
                                yield StreamEvent(type="text_delta", content_index=index, delta=initial_text)
                        elif block_type == "thinking":
                            yield StreamEvent(type="thinking_start", content_index=index)
                            initial_thinking = str(getattr(event.content_block, "thinking", "") or "")
                            if initial_thinking:
                                text_budget.account(index, initial_thinking)
                                buffers[index].append(initial_thinking)
                                yield StreamEvent(type="thinking_delta", content_index=index, delta=initial_thinking)
                            initial_signature = getattr(event.content_block, "signature", None)
                            if initial_signature:
                                if not isinstance(initial_signature, str):
                                    raise ValueError("思考初始签名无效")
                                size = len(initial_signature.encode("utf-8"))
                                if (size > MAX_ANTHROPIC_SIGNATURE_BYTES
                                        or signature_bytes + size > MAX_ANTHROPIC_SIGNATURE_TOTAL_BYTES):
                                    raise ValueError("思考签名超过私有续接预算")
                                signature_bytes += size
                                signatures[index] = initial_signature
                                signature_sizes[index] = size
                        elif block_type == "redacted_thinking":
                            data = getattr(event.content_block, "data", None)
                            if not isinstance(data, str) or not data:
                                raise ValueError("加密思考块无效")
                            size = len(data.encode("utf-8"))
                            if (size > MAX_ANTHROPIC_SIGNATURE_BYTES
                                    or signature_bytes + size > MAX_ANTHROPIC_SIGNATURE_TOTAL_BYTES):
                                raise ValueError("加密思考块超过私有续接预算")
                            signature_bytes += size
                            redacted_data[index] = data
                        elif block_type == "fallback":
                            raise ValueError("当前内核不支持服务端 fallback 续接块")
                        elif block_type == "tool_use":
                            block = event.content_block
                            tool_names[index] = str(getattr(block, "name", "") or "")
                            tool_ids[index] = str(getattr(block, "id", "") or "")
                            tool_argument_buffers[index] = []
                            initial = getattr(block, "input", None)
                            if initial not in (None, {}):
                                if not isinstance(initial, dict):
                                    raise ValueError("工具调用初始参数不是 JSON object")
                                initial_json = budget.snapshot(index, initial)
                                tool_argument_buffers[index].append(initial_json)
                                snapshot_only_tools.add(index)
                            started_tools.add(index)
                            yield StreamEvent(type="toolcall_start", content_index=index)
                    elif kind == "content_block_delta":
                        index = int(getattr(event, "index", 0))
                        delta = getattr(event, "delta", None)
                        delta_type = getattr(delta, "type", "")
                        if delta_type == "text_delta":
                            text = str(getattr(delta, "text", ""))
                            text_budget.account(index, text)
                            buffers.setdefault(index, []).append(text)
                            yield StreamEvent(type="text_delta", content_index=index, delta=text)
                        elif delta_type == "thinking_delta":
                            text = str(getattr(delta, "thinking", ""))
                            text_budget.account(index, text)
                            buffers.setdefault(index, []).append(text)
                            yield StreamEvent(type="thinking_delta", content_index=index, delta=text)
                        elif delta_type == "signature_delta":
                            if block_types.get(index) != "thinking" or index in closed_blocks:
                                raise ValueError("思考签名增量没有唯一的活动 thinking block")
                            signature = getattr(delta, "signature", None)
                            if not isinstance(signature, str) or not signature:
                                raise ValueError("思考签名增量无效")
                            size = len(signature.encode("utf-8"))
                            additional = max(0, size - signature_sizes.get(index, 0))
                            if (size > MAX_ANTHROPIC_SIGNATURE_BYTES
                                    or signature_bytes + additional > MAX_ANTHROPIC_SIGNATURE_TOTAL_BYTES):
                                raise ValueError("思考签名超过私有续接预算")
                            signature_bytes += additional
                            signature_sizes[index] = max(size, signature_sizes.get(index, 0))
                            signatures[index] = signature
                        elif delta_type == "input_json_delta":
                            if index not in started_tools or index in closed_tool_blocks:
                                raise ValueError("工具参数增量没有对应的活动工具块")
                            if index in snapshot_only_tools:
                                raise ValueError("工具调用初始参数与增量来源冲突")
                            fragment = str(getattr(delta, "partial_json", ""))
                            budget.account(index, fragment)
                            tool_argument_buffers[index].append(fragment)
                            yield StreamEvent(
                                type="toolcall_delta",
                                content_index=index,
                                delta=fragment,
                            )
                    elif kind == "content_block_stop":
                        index = int(getattr(event, "index", 0))
                        if index in closed_blocks:
                            raise ValueError("响应重复关闭内容块")
                        closed_blocks.add(index)
                        joined = "".join(buffers.get(index, []))
                        if joined:
                            end_type = "thinking_end" if block_types.get(index) == "thinking" else "text_end"
                            yield StreamEvent(type=end_type, content_index=index, text=joined)
                        if index in tool_argument_buffers:
                            closed_tool_blocks.add(index)
                if not saw_message_stop:
                    raise ValueError("模型流未正常结束")
                if started_tools and any(
                        index not in signatures or index not in closed_blocks
                        for index, value in block_types.items() if value == "thinking"):
                    raise ValueError("工具响应缺少完整的 thinking 签名")
        except StreamDeadlineExceeded:
            if self._abort_requested:
                yield StreamEvent(type="error", reason="aborted", error="请求已取消")
            else:
                error_info = private_error_info(
                    anthropic_error_info(None, source="transport_error", retryable=True))
                yield StreamEvent(type="error", reason="error",
                                  error=f"模型请求超过 {self._request_timeout_seconds} 秒总时限",
                                  error_info=error_info)
            return
        except StreamAborted:
            yield StreamEvent(type="error", reason="aborted", error="请求已取消")
            return
        except anthropic.APIConnectionError as exc:
            error_info = private_error_info(anthropic_error_info(None, source="transport_error"))
            message = "模型连接失败" if has_private() else f"连接失败：{exc}"
            yield StreamEvent(type="error", reason="error", error=self._redact(message),
                              error_info=error_info)
            return
        except anthropic.RateLimitError as exc:
            status_code = getattr(exc, "status_code", 429)
            error_info = private_error_info(
                anthropic_error_info(exc.body, source="http_error", status_code=status_code))
            message = "模型请求被限流" if has_private() else f"被限流：{exc}"
            yield StreamEvent(type="error", reason="error", error=self._redact(message),
                              error_info=error_info)
            return
        except anthropic.APIStatusError as exc:
            error_info = private_error_info(anthropic_error_info(exc.body,
                source="stream_error" if exc.status_code == 200 else "http_error",
                status_code=exc.status_code))
            message = (f"接口错误 {exc.status_code}" if has_private()
                       else f"接口错误 {exc.status_code}：{exc.message}")
            yield StreamEvent(
                type="error",
                reason="error",
                error=self._redact(message),
                error_info=error_info,
            )
            return
        except OutputBudgetExceeded as exc:
            yield StreamEvent(type="error", reason="error", error=self._redact(exc))
            return
        except Exception as exc:  # noqa: BLE001
            # SDK exceptions can contain the full malformed partial JSON payload.
            yield StreamEvent(
                type="error",
                reason="error",
                error=f"模型流处理异常（{type(exc).__name__}）",
            )
            return

        finally:
            self._active_stream = None

        tool_arguments: dict[int, dict[str, object]] = {}
        for index in sorted(started_tools):
            if index not in closed_tool_blocks:
                yield StreamEvent(
                    type="error",
                    reason="error",
                    error=self._redact(f"工具调用参数流未完整结束：{tool_names.get(index) or 'unknown'}"),
                )
                return
            raw = "".join(tool_argument_buffers.get(index, []))
            parsed = {} if raw == "" else _parse_tool_arguments(raw)
            if parsed is None:
                name = tool_names.get(index, "")
                yield StreamEvent(
                    type="error",
                    reason="error",
                    error=self._redact(f"工具调用参数不是完整 JSON object：{name or 'unknown'}"),
                )
                return
            tool_arguments[index] = parsed

        blocks: list[object] = []
        for index in sorted(block_types):
            block_type = block_types[index]
            if block_type == "text":
                blocks.append(TextBlock(text="".join(buffers[index])))
            elif block_type == "thinking":
                blocks.append(ThinkingBlock(thinking="".join(buffers[index]),
                                            signature=signatures.get(index), prefix_digest=prefix_digest))
            elif block_type == "redacted_thinking":
                blocks.append(ThinkingBlock(redacted_data=redacted_data[index], prefix_digest=prefix_digest))
            elif block_type == "tool_use":
                call = ToolCallBlock(
                    id=tool_ids[index],
                    name=tool_names[index],
                    arguments=tool_arguments[index],
                )
                blocks.append(call)
                yield StreamEvent(type="toolcall_end", tool_call=call)

        mapped_stop_reason = _STOP_REASONS.get(str(stop_reason or ""), "stop")
        message = AssistantMessage(
            blocks=tuple(blocks),  # type: ignore[arg-type]
            stop_reason=mapped_stop_reason,  # type: ignore[arg-type]
            usage=Usage(input=usage["input_tokens"], output=usage["output_tokens"],
                        cache_read=usage["cache_read_input_tokens"],
                        cache_write=usage["cache_creation_input_tokens"]),
        )
        if str(stop_reason) == "refusal":
            yield StreamEvent(type="error", reason="error", error="模型以安全原因拒绝")
            return
        yield StreamEvent(type="done", reason=mapped_stop_reason, message=message)


def tool_result_payload(result: object) -> str:
    """把工具返回压成一段文本回填给模型。"""
    try:
        return json.dumps(result, ensure_ascii=False)[:20000]
    except TypeError:
        return str(result)[:20000]
