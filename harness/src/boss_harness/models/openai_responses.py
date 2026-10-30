"""OpenAI Responses provider：面向 `wire_api = "responses"` 的兼容端点。

为什么单独有一个 provider：Anthropic 的 Messages 与 OpenAI 的 Responses 是两套不同的
线协议（请求体字段、流事件名、工具调用回填方式都不同）。Pi 的做法是每个协议一份
`src/api/<api>.ts` 实现，再把「供应商 = 目录 + 凭据 + 该协议实现」组合起来；本项目沿用
同一划分，把协议实现放在一个模块里，`provider.py` 只负责选择与构造。

实现要点（对照 Pi 的 `openai-responses.ts` / `openai-responses-shared.ts`）：
- 用官方 `openai` SDK，但取 `responses.create(stream=True)` 的**原始事件流**，不用它自带的
  流式状态机（见 `stream()` 里的注释）；
- 流事件到本项目 `StreamEvent` 的映射逐条对齐 Pi 的 `processResponsesStream`；
- 生成开始后的任何失败都转成 `error` 事件，不向上抛（`provider.py` 的协议约定）；
- 思考块在回放历史时丢弃（我们没有可回传的 encrypted_content），但不影响对话有效性。
"""
from __future__ import annotations

import json
import os
import sys
import threading
from collections.abc import Iterator, Sequence
from dataclasses import replace
from typing import Any

import openai

from boss_harness.models.errors import SDK_TRANSPORT_ERRORS, openai_error_info
from boss_harness.models.output_budget import (
    MAX_RESPONSE_TEXT_BYTES,
    OutputBudgetExceeded,
    ResponseTextBudget,
    ToolArgumentBudget,
    bounded_error,
)
from boss_harness.models.provider import ModelConfig
from boss_harness.models.secret import redact_secrets
from boss_harness.models.stream_pump import (
    AsyncStreamPump,
    StreamAborted,
    StreamDeadlineExceeded,
    StreamPumpCapacityExceeded,
)
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

#: Responses 的终态原因 → 我们的 StopReason。Pi 的 mapStopReason 同此。
_STOP_REASONS = {
    "completed": "stop",
    "in_progress": "stop",
    "queued": "stop",
    "incomplete": "length",  # 仅当 incomplete_details.reason == max_output_tokens，见 _stop_reason()
    "failed": "error",
    "cancelled": "error",
}

#: 会把文本增量推给调用方的两个事件。
_TEXT_DELTA_EVENTS = ("response.output_text.delta", "response.refusal.delta")
#: 会把思考增量推给调用方的两个事件。
_THINKING_DELTA_EVENTS = ("response.reasoning_summary_text.delta", "response.reasoning_text.delta")

#: 可重试的 HTTP 状态：请求超时/冲突/限流/服务端错误。
_RETRYABLE_STATUS = frozenset({408, 409, 429, 500, 502, 503, 504})
#: 单次退避的上限（秒）。
_MAX_RETRY_DELAY_SECONDS = 8.0
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_RETRY_BASE_MS = 500

#: 网关把失败写在流里时用的标记。这是对当前网关的启发式识别，不是协议保证。
_TRANSIENT_ERROR_MARKERS = ("service_unavailable", "server_error", "overloaded", "temporarily")


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"非法 JSON 常量: {value}")


def _retry_settings() -> tuple[int, float]:
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


def _looks_transient(code: str, detail: str) -> bool:
    haystack = f"{code} {detail}".lower()
    return any(marker in haystack for marker in _TRANSIENT_ERROR_MARKERS)


def to_input_items(messages: Sequence[ChatMessage]) -> list[dict[str, Any]]:
    """把内部消息翻成 Responses 的 `input` 数组。

    形状与 Pi 的 `convertResponsesMessages` 对齐：文本按角色回放，工具调用是一条
    `function_call` 条目、工具结果是一条 `function_call_output` 条目，两者靠 `call_id` 配对。
    """
    items: list[dict[str, Any]] = []
    for message in messages:
        if isinstance(message, ToolResultsMessage):
            for result in message.results:
                items.append(
                    {
                        "type": "function_call_output",
                        "call_id": result.tool_call_id,
                        "output": result.content,
                    }
                )
            continue
        if isinstance(message, AssistantMessage):
            for block in message.blocks:
                if isinstance(block, TextBlock):
                    if block.text:
                        items.append(
                            {"role": "assistant", "content": [{"type": "output_text", "text": block.text}]}
                        )
                elif isinstance(block, ToolCallBlock):
                    items.append(
                        {
                            "type": "function_call",
                            "call_id": block.id,
                            "name": block.name,
                            "arguments": json.dumps(dict(block.arguments), ensure_ascii=False),
                        }
                    )
                # ThinkingBlock 不回放：没有可回传的 encrypted_content。
            continue
        items.append({"role": "user", "content": message.text})  # type: ignore[union-attr]
    return items


def _usage_from_response(response: object) -> Usage:
    usage = getattr(response, "usage", None)
    if usage is None:
        return Usage()
    details = getattr(usage, "input_tokens_details", None)
    output_details = getattr(usage, "output_tokens_details", None)
    return Usage(
        input=int(getattr(usage, "input_tokens", 0) or 0),
        output=int(getattr(usage, "output_tokens", 0) or 0),
        cache_read=int(getattr(details, "cached_tokens", 0) or 0) if details is not None else 0,
        cache_write=int(getattr(details, "cache_write_tokens", 0) or 0) if details is not None else 0,
        reasoning=int(getattr(output_details, "reasoning_tokens", 0) or 0)
        if output_details is not None
        else None,
    )


def _stop_reason(response: object, has_tool_calls: bool) -> tuple[str, str]:
    """返回 (StopReason, 出错说明)。Pi 的 mapStopReason 同此，另加工具调用的覆盖规则。"""
    status = str(getattr(response, "status", "") or "")
    incomplete = getattr(response, "incomplete_details", None)
    reason = str(getattr(incomplete, "reason", "") or "") if incomplete is not None else ""

    if status == "completed":
        return ("tool_use" if has_tool_calls else "stop"), ""
    if status == "incomplete":
        if reason == "max_output_tokens":
            return "length", ""
        return "error", f"响应未完成（{reason or '原因未知'}）"
    if status in ("failed", "cancelled"):
        error = getattr(response, "error", None)
        message = str(getattr(error, "message", "") or "") or f"响应状态 {status}"
        return "error", message
    if status in ("in_progress", "queued"):
        return ("tool_use" if has_tool_calls else "stop"), ""
    return ("tool_use" if has_tool_calls else "stop"), ""


class OpenAIResponsesProvider:
    id = "openai"

    def __init__(self, config: ModelConfig) -> None:
        if not config.api_key:
            raise ValueError("openai provider 需要 bearer 凭据（~/.codex/config.toml 或 BOSS_HARNESS_OPENAI_API_KEY）")
        self.model = config.model
        self.max_tokens = config.max_tokens
        self.effort = config.effort
        self.base_url = config.base_url
        self._secret = config.api_key.get()
        self._request_timeout_seconds = config.request_timeout_seconds
        self._max_attempts, self._retry_base_delay = _retry_settings()
        #: 当前正在读的流；`request_abort()` 从别的线程关掉它，用来打断卡住的连接。
        self._active_stream: object | None = None
        #: 本次请求是否被要求中止（中止导致的失败不重试）。
        self._abort_requested = False
        self._abort_event = threading.Event()
        #: 上一次失败是否可重试、以及建议的等待秒数；由 `_stream_once` 写、`stream()` 读。
        self._last_error_retryable = False
        self._last_error_retry_after: float | None = None

    def _redact(self, text: object) -> str:
        """错误文本会被写进会话文件并推给外壳，落盘前先把凭据抹掉。"""
        return bounded_error("", redact_secrets(str(text), extra=(self._secret,)))

    # ---------- 请求参数 ----------

    def _request_kwargs(self, request: ModelRequest) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": request.model,
            "instructions": request.system,
            "input": to_input_items(request.messages),
            "store": False,  # 我们自己在会话里保存历史，不依赖服务端状态
            "max_output_tokens": request.max_tokens,
        }
        if request.tools:
            kwargs["tools"] = [
                {
                    "type": "function",
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": dict(spec.input_schema),
                }
                for spec in request.tools
            ]
            kwargs["tool_choice"] = "auto"
            kwargs["parallel_tool_calls"] = True
        if request.effort:
            # Responses 把推理强度放在 reasoning.effort，而不是 Anthropic 的 output_config。
            kwargs["reasoning"] = {"effort": request.effort}
        return kwargs

    # ---------- 中断 ----------

    def request_abort(self) -> None:
        """从另一个线程打断当前请求：关掉底层流，让阻塞中的读取立刻抛错。

        这是 best-effort：取消点本身在回合执行器那边（每次取事件前检查），这里是给「流卡住、
        取消点轮不到」的情况兜底。
        """
        self._abort_requested = True
        self._abort_event.set()
        stream = self._active_stream
        cancel = getattr(stream, "cancel", None)
        close = getattr(stream, "close", None)
        stop = cancel if callable(cancel) else close
        if callable(stop):
            try:
                stop()
            except Exception:  # noqa: BLE001 - 关不上也不该把中断本身搞成异常
                pass

    # ---------- 事件流 ----------

    def stream(self, request: ModelRequest) -> Iterator[StreamEvent]:
        events = self._stream(request)
        try:
            for event in events:
                # The producer may already have queued EOF/an exception before
                # abort reaches its pump. Cancellation still wins until this
                # provider delivers a failure; valid completed output is kept.
                if event.type == "error" and self._abort_requested:
                    self._last_error_retryable = False
                    self._last_error_retry_after = None
                    event = StreamEvent(type="error", reason="aborted", error="请求已取消")
                yield event
        finally:
            events.close()

    def _stream(self, request: ModelRequest) -> Iterator[StreamEvent]:
        """带重试的事件流。

        重试必须同时满足两条：
        1. **还没有向调用方产出过任何内容**。一旦文本或工具参数增量已经发出，调用方就看到了
           半截结果，重发只会造成重复；此时失败一律照实上报。
        2. 失败是可重试的：连接/超时、HTTP 408/409/429/5xx、以及网关在流里回的
           `service_unavailable_error` 一类过载标记。参数错、鉴权错等不重试。

        `start` 只发一次；重试期间对调用方是静默的，只往 stderr 记一行。
        """
        self._abort_requested = False
        self._abort_event.clear()
        yield StreamEvent(type="start")

        attempts = self._max_attempts
        try:
            for attempt in range(1, attempts + 1):
                if self._abort_requested:
                    yield StreamEvent(type="error", reason="aborted", error="请求已取消")
                    return
                emitted = False
                retry_message: str | None = None
                retry_after: float | None = None
                retry_event: StreamEvent | None = None
                attempt_stream = self._stream_once(request)
                try:
                    for event in attempt_stream:
                        if event.type == "start":
                            continue  # 外层已经发过
                        if event.type == "error":
                            retryable = self._last_error_retryable and not self._abort_requested
                            retry_after = self._last_error_retry_after
                            if retryable and not emitted and attempt < attempts:
                                retry_message = event.error
                                retry_event = event
                                break
                            yield event
                            return
                        emitted = True
                        yield event
                finally:
                    attempt_stream.close()

                if retry_message is None:
                    return
                active = self._active_stream
                if isinstance(active, AsyncStreamPump) and not active.worker_done:
                    self._last_error_retryable = False
                    assert retry_event is not None
                    info = (replace(retry_event.error_info, retryable=False)
                            if retry_event.error_info is not None else None)
                    yield replace(retry_event, error=self._redact(
                        retry_message + "；后台清理未确认，已停止自动重试"), error_info=info)
                    return
                delay = self._retry_delay(attempt, retry_after)
                print(
                    f"[harness] 模型请求第 {attempt}/{attempts} 次尝试失败，{delay:.1f}s 后重试：{retry_message}",
                    file=sys.stderr,
                )
                if self._abort_event.wait(delay):
                    yield StreamEvent(type="error", reason="aborted", error="请求已取消")
                    return

            # 走到这里说明最后一次尝试也是可重试失败（上面每次都会 return），保险起见报出去。
            yield StreamEvent(
                type="error", reason="error", error=retry_message or "模型请求失败"
            )
        finally:
            self._active_stream = None

    def _retry_delay(self, attempt: int, retry_after: float | None) -> float:
        """退避时长：网关给了 Retry-After 就听它的，否则指数退避，两者都设上限。"""
        if retry_after is not None:
            return max(0.0, min(retry_after, _MAX_RETRY_DELAY_SECONDS))
        return min(self._retry_base_delay * (2 ** (attempt - 1)), _MAX_RETRY_DELAY_SECONDS)

    # ---------- 单次尝试 ----------

    def _stream_once(self, request: ModelRequest) -> Iterator[StreamEvent]:
        """单次尝试：把一段事件流映射成本项目的 StreamEvent（含开头那条 `start`）。"""
        self._last_error_retryable = False
        self._last_error_retry_after = None
        kwargs = self._request_kwargs(request)
        #: output_index -> 已完成的块（按 Responses 的输出项下标保序）
        blocks: dict[int, object] = {}
        text_buffers: dict[int, list[str]] = {}
        thinking_buffers: dict[int, list[str]] = {}
        #: output_index -> function_call 的参数 JSON 缓冲
        json_buffers: dict[int, str] = {}
        #: output_index -> arguments.done 中的权威原始 JSON
        arguments_done: dict[int, str | None] = {}
        #: output_index -> function_call 的稳定身份；Responses 的 item id 可选
        function_call_identities: dict[int, tuple[str | None, str, str]] = {}
        item_ids: dict[str, int] = {}
        call_id_indexes: dict[str, int] = {}
        started_function_calls: set[int] = set()
        final_argument_sources: dict[int, str] = {}
        final_items_seen: set[int] = set()
        budget = ToolArgumentBudget()
        text_budget = ResponseTextBudget()
        #: 参数不是完整 JSON 的 function_call（用名字记），收尾时按失败处理
        broken: list[str] = []
        #: 是否已经发出过思考增量（没有内容时不补空行）
        saw_delta = False
        #: 是否有一段思考待分隔：延后到下一段真正开始时再发，避免尾部分隔符
        pending_break = False
        terminal: object | None = None
        #: response.completed / response.incomplete 的 output 是权威集合。
        #: 流中曾出现、但终态已撤回的块不能继续落入最终 AssistantMessage，
        #: 否则调用方会把已撤回的工具调用交给执行器。
        terminal_indexes: set[int] | None = None

        def function_call_identity(item: object) -> tuple[str | None, str, str]:
            raw_item_id = getattr(item, "id", None)
            identity = (
                str(raw_item_id) if raw_item_id else None,
                str(getattr(item, "call_id", "") or ""),
                str(getattr(item, "name", "") or ""),
            )
            if not all(identity[1:]):
                raise ValueError("工具调用缺少 call_id 或工具名")
            return identity

        def require_function_call_identity(index: int, item: object) -> tuple[str | None, str, str]:
            actual = function_call_identity(item)
            expected = function_call_identities.get(index)
            if expected is None or expected[1:] != actual[1:]:
                raise ValueError("工具调用身份与初始输出项不一致")
            if expected[0] and actual[0] and expected[0] != actual[0]:
                raise ValueError("工具调用输出项标识不一致")
            item_id = expected[0] or actual[0]
            if item_id:
                existing_index = item_ids.get(item_id)
                if existing_index is not None and existing_index != index:
                    raise ValueError("响应重复使用输出项标识")
                item_ids[item_id] = index
            identity = (item_id, actual[1], actual[2])
            function_call_identities[index] = identity
            return identity

        def require_event_item_id(index: int, event: object) -> None:
            event_item_id = getattr(event, "item_id", None)
            if not isinstance(event_item_id, str) or not event_item_id:
                raise ValueError("工具参数事件缺少输出项标识")
            identity = function_call_identities.get(index)
            if identity is None or (identity[0] and event_item_id != identity[0]):
                raise ValueError("工具参数事件的输出项标识不一致")
            existing_index = item_ids.get(event_item_id)
            if existing_index is not None and existing_index != index:
                raise ValueError("工具参数事件重复使用输出项标识")
            item_ids[event_item_id] = index
            function_call_identities[index] = (event_item_id, identity[1], identity[2])

        yield StreamEvent(type="start")

        try:
            async def produce(send) -> None:
                async with openai.AsyncOpenAI(api_key=self._secret, base_url=self.base_url,
                                              timeout=30.0, max_retries=0) as client:
                    stream = await client.responses.create(**kwargs, stream=True)
                    async with stream:
                        async for event in stream:
                            await send(event)

            pump = AsyncStreamPump(produce, timeout=self._request_timeout_seconds,
                                   name="openai-response-stream")
            self._active_stream = pump
            # Keep raw Responses events so gateway errors inside HTTP 200 streams
            # retain their provider diagnostics.
            with pump as stream:
                # The pump is registered before connecting, so abort also covers
                # response-header waits as well as an active response body.
                if self._abort_requested:
                    yield StreamEvent(type="error", reason="aborted", error="请求已取消")
                    return
                for event in stream:
                    if terminal is not None:
                        raise ValueError("响应终态之后仍收到流事件")
                    kind = str(getattr(event, "type", ""))
                    index = int(getattr(event, "output_index", 0) or 0)

                    if kind == "response.output_item.added":
                        item = getattr(event, "item", None)
                        item_type = str(getattr(item, "type", "") or "")
                        item_id = str(getattr(item, "id", "") or "")
                        if item_id:
                            if item_id in item_ids:
                                raise ValueError("响应重复使用输出项标识")
                            item_ids[item_id] = index
                        if item_type == "reasoning":
                            # 每个 reasoning 项自成一段：不清零的话，上一项遗留的待分隔标记会被
                            # 下一项的首个增量吃掉，凭空插进一个空行。
                            saw_delta = False
                            pending_break = False
                            text = _reasoning_text(item, text_budget, index)
                            thinking_buffers[index] = [text] if text else []
                            yield StreamEvent(type="thinking_start", content_index=index)
                            if text:
                                yield StreamEvent(type="thinking_delta", content_index=index, delta=text)
                        elif item_type == "message":
                            text = _message_text(item, text_budget, index)
                            text_buffers[index] = [text] if text else []
                            yield StreamEvent(type="text_start", content_index=index)
                            if text:
                                yield StreamEvent(type="text_delta", content_index=index, delta=text)
                        elif item_type == "function_call":
                            if index in started_function_calls:
                                raise ValueError("响应重复使用工具调用索引")
                            identity = (
                                item_id or None,
                                str(getattr(item, "call_id", "") or ""),
                                str(getattr(item, "name", "") or ""),
                            )
                            if not all(identity[1:]):
                                raise ValueError("工具调用初始项缺少 call_id 或工具名")
                            if identity[1] in call_id_indexes:
                                raise ValueError("响应重复使用工具调用 call_id")
                            call_id_indexes[identity[1]] = index
                            initial = getattr(item, "arguments", "")
                            if not isinstance(initial, str):
                                raise ValueError("工具调用初始参数不是文本")
                            budget.account(index, initial)
                            json_buffers[index] = initial
                            function_call_identities[index] = identity
                            started_function_calls.add(index)
                            yield StreamEvent(type="toolcall_start", content_index=index)

                    elif kind in _THINKING_DELTA_EVENTS:
                        delta = str(getattr(event, "delta", "") or "")
                        if delta:
                            if pending_break:
                                pending_break = False
                                text_budget.account(("thinking", index), "\n\n")
                                thinking_buffers.setdefault(index, []).append("\n\n")
                                yield StreamEvent(
                                    type="thinking_delta", content_index=index, delta="\n\n"
                                )
                            saw_delta = True
                            text_budget.account(("thinking", index), delta)
                            thinking_buffers.setdefault(index, []).append(delta)
                            yield StreamEvent(type="thinking_delta", content_index=index, delta=delta)

                    elif kind == "response.reasoning_summary_part.done":
                        # 把段落分隔符延后到下一段真正开始时再发：这样流式文本恰好等于
                        # "\n\n".join(各段)，既不会多出尾分隔符，也不会与 thinking_end 的文本不一致。
                        if saw_delta:
                            pending_break = True

                    elif kind in _TEXT_DELTA_EVENTS:
                        delta = str(getattr(event, "delta", "") or "")
                        if delta:
                            text_budget.account(("text", index), delta)
                            text_buffers.setdefault(index, []).append(delta)
                            yield StreamEvent(type="text_delta", content_index=index, delta=delta)

                    elif kind == "response.function_call_arguments.delta":
                        if index not in started_function_calls or index in final_items_seen:
                            raise ValueError("工具参数增量没有活动的工具调用")
                        require_event_item_id(index, event)
                        if index in arguments_done:
                            raise ValueError("工具调用参数终态之后仍收到增量")
                        fragment = getattr(event, "delta", "")
                        if not isinstance(fragment, str):
                            raise ValueError("工具调用参数增量不是文本")
                        if fragment:
                            budget.account(index, fragment)
                            json_buffers[index] = json_buffers.get(index, "") + fragment
                            yield StreamEvent(type="toolcall_delta", content_index=index, delta=fragment)

                    elif kind == "response.function_call_arguments.done":
                        # 权威参数以 done 为准；只把新增后缀当作增量补发，避免重复。
                        if index not in started_function_calls or index in arguments_done or index in final_items_seen:
                            raise ValueError("工具参数终态没有对应的活动工具调用")
                        require_event_item_id(index, event)
                        authoritative = getattr(event, "arguments", None)
                        if not isinstance(authoritative, str):
                            authoritative = None
                        previous = json_buffers.get(index, "")
                        if authoritative is not None:
                            budget.reconcile(index, authoritative)
                            json_buffers[index] = authoritative
                        arguments_done[index] = authoritative
                        if (authoritative is not None and authoritative.startswith(previous)
                                and len(authoritative) > len(previous)):
                            yield StreamEvent(
                                type="toolcall_delta",
                                content_index=index,
                                delta=authoritative[len(previous):],
                            )

                    elif kind == "response.output_item.done":
                        item = getattr(event, "item", None)
                        item_type = str(getattr(item, "type", "") or "")
                        item_id = str(getattr(item, "id", "") or "")
                        item_index = item_ids.get(item_id, index) if item_id else index
                        if item_type == "reasoning":
                            text = _reasoning_text(item, text_budget, item_index)
                            thinking_buffers[item_index] = [text]
                            blocks[item_index] = ThinkingBlock(thinking=text)
                            yield StreamEvent(type="thinking_end", content_index=item_index, text=text)
                        elif item_type == "message":
                            text = _message_text(item, text_budget, item_index)
                            text_buffers[item_index] = [text]
                            blocks[item_index] = TextBlock(text=text)
                            yield StreamEvent(type="text_end", content_index=item_index, text=text)
                        elif item_type == "function_call":
                            if index not in started_function_calls or index in final_items_seen:
                                raise ValueError("工具调用终态没有对应的唯一初始项")
                            _, call_id, name = require_function_call_identity(index, item)
                            buffered = json_buffers.pop(index, None)
                            has_done_arguments = index in arguments_done
                            done_raw = arguments_done.pop(index, None)
                            has_final_arguments = (hasattr(item, "arguments")
                                                   and getattr(item, "arguments") is not None)
                            final_raw = getattr(item, "arguments", None)
                            if has_final_arguments:
                                if not isinstance(final_raw, str):
                                    raise ValueError("工具调用参数终态不是文本")
                                budget.reconcile(index, final_raw)
                                final_argument_sources[index] = final_raw
                            arguments = None
                            if has_final_arguments:
                                final_parsed = (_parse_arguments(final_raw)
                                                if isinstance(final_raw, str) else None)
                                if has_done_arguments:
                                    done_parsed = (_parse_arguments(done_raw)
                                                   if isinstance(done_raw, str) else None)
                                    if (final_parsed is not None and done_parsed is not None
                                            and final_parsed == done_parsed):
                                        arguments = final_parsed
                                else:
                                    arguments = final_parsed
                            elif has_done_arguments:
                                arguments = (_parse_arguments(done_raw)
                                             if isinstance(done_raw, str) else None)
                            else:
                                arguments = _parse_arguments(buffered)
                            if index not in final_argument_sources:
                                if has_done_arguments and isinstance(done_raw, str):
                                    final_argument_sources[index] = done_raw
                                elif isinstance(buffered, str):
                                    final_argument_sources[index] = buffered
                            if arguments is None:
                                broken.append(name or str(getattr(item, "call_id", "") or ""))
                                arguments = {}
                            call = ToolCallBlock(
                                id=call_id,
                                name=name,
                                arguments=arguments,
                            )
                            blocks[index] = call
                            final_items_seen.add(index)
                            yield StreamEvent(type="toolcall_end", content_index=index, tool_call=call)

                    elif kind in ("response.completed", "response.incomplete"):
                        terminal = getattr(event, "response", None)
                        if terminal is None:
                            raise ValueError("响应终态缺少 response 对象")
                        terminal_output = getattr(terminal, "output", None)
                        if terminal_output is None:
                            raise ValueError("响应终态缺少 output 集合")
                        terminal_indexes = set()
                        terminal_ids: set[str] = set()
                        for output_index, item in enumerate(terminal_output):
                            item_type = str(getattr(item, "type", "") or "")
                            item_id = str(getattr(item, "id", "") or "")
                            if item_id:
                                if item_id in terminal_ids:
                                    raise ValueError("响应终态重复使用输出项标识")
                                terminal_ids.add(item_id)
                            item_index = item_ids.get(item_id, output_index) if item_id else output_index
                            if item_type == "function_call":
                                terminal_identity = function_call_identity(item)
                                mapped_index = (
                                    item_ids.get(
                                        terminal_identity[0],
                                        call_id_indexes.get(terminal_identity[1], output_index),
                                    )
                                    if terminal_identity[0]
                                    else call_id_indexes.get(terminal_identity[1], output_index)
                                )
                                require_function_call_identity(mapped_index, item)
                                item_index = mapped_index
                            if item_index in terminal_indexes:
                                raise ValueError("响应终态重复使用输出项索引")
                            terminal_indexes.add(item_index)
                            if item_type == "reasoning":
                                text = _reasoning_text(item, text_budget, item_index)
                                thinking_buffers[item_index] = [text]
                                blocks[item_index] = ThinkingBlock(thinking=text)
                                yield StreamEvent(type="thinking_end", content_index=item_index, text=text)
                                continue
                            if item_type == "message":
                                text = _message_text(item, text_budget, item_index)
                                text_buffers[item_index] = [text]
                                blocks[item_index] = TextBlock(text=text)
                                yield StreamEvent(type="text_end", content_index=item_index, text=text)
                                continue
                            if item_type != "function_call":
                                continue
                            if item_index not in final_items_seen:
                                raise ValueError("工具调用缺少完整的 output_item.done 事件")
                            raw = getattr(item, "arguments", None)
                            if raw is None:
                                continue
                            if not isinstance(raw, str):
                                raise ValueError("工具调用终态参数不是文本")
                            previous_final = final_argument_sources.get(item_index)
                            budget.reconcile(item_index, raw)
                            if previous_final is not None and raw != previous_final:
                                expected = _parse_arguments(previous_final)
                                actual = _parse_arguments(raw)
                                if expected is None or actual is None or expected != actual:
                                    raise ValueError("响应中的工具参数终态来源冲突")

                    elif kind == "response.failed":
                        # 网关过载时会在 HTTP 200 的流里回这个事件，例如
                        # {"type":"service_unavailable_error","code":"server_error",
                        #  "message":"Our servers are currently overloaded. Please try again later."}。
                        # 必须在这里接住：交给 SDK 的状态机会变成裸 RuntimeError，端点原话会丢。
                        response = getattr(event, "response", None)
                        error = getattr(response, "error", None)
                        code = str(
                            getattr(error, "code", "") or getattr(error, "type", "") or "unknown"
                        )
                        error_type = str(getattr(error, "type", "") or "")
                        message = str(getattr(error, "message", "") or "") or "响应失败"
                        error_info = openai_error_info(error, source="stream_error", status_code=200)
                        self._last_error_retryable = not (
                            error_info is not None and error_info.code == "CONTEXT_OVERFLOW"
                        ) and _looks_transient(code, f"{error_type} {message}")
                        yield StreamEvent(
                            type="error", reason="error", error=self._redact(f"接口错误 {code}：{message}"),
                            error_info=error_info,
                        )
                        return

                    elif kind == "error":
                        code = str(getattr(event, "code", "") or "unknown")
                        message = str(getattr(event, "message", "") or "")
                        error_info = openai_error_info(event, source="stream_error", status_code=200)
                        self._last_error_retryable = not (
                            error_info is not None and error_info.code == "CONTEXT_OVERFLOW"
                        ) and _looks_transient(code, message)
                        yield StreamEvent(
                            type="error", reason="error", error=self._redact(f"接口错误 {code}：{message}"),
                            error_info=error_info,
                        )
                        return

                # 终态响应由 response.completed / response.incomplete 事件记录，见上面的分支；
                # 原始事件流没有 get_final_response()。
                if started_function_calls != final_items_seen:
                    raise ValueError("工具调用缺少完整的 output_item.done 事件")

        except StreamDeadlineExceeded:
            retryable = not self._abort_requested and pump.worker_done
            self._last_error_retryable = retryable
            error_info = openai_error_info(None, source="transport_error", retryable=retryable)
            if self._abort_requested:
                yield StreamEvent(type="error", reason="aborted", error="请求已取消")
            else:
                detail = "" if retryable else "；后台清理未确认，已停止自动重试"
                yield StreamEvent(type="error", reason="error",
                                  error=f"模型请求超过 {self._request_timeout_seconds} 秒总时限{detail}",
                                  error_info=error_info)
            return
        except StreamAborted:
            self._last_error_retryable = False
            yield StreamEvent(type="error", reason="aborted", error="请求已取消")
            return
        except StreamPumpCapacityExceeded:
            self._last_error_retryable = False
            yield StreamEvent(type="error", reason="error",
                              error="模型流并发容量已满，当前请求未发出；请稍后重试")
            return
        except OutputBudgetExceeded as exc:
            self._last_error_retryable = False
            yield StreamEvent(type="error", reason="error", error=self._redact(exc))
            return
        except openai.APIStatusError as exc:
            error_info = openai_error_info(exc.body, source="http_error", status_code=exc.status_code)
            self._last_error_retryable = not (
                error_info is not None and error_info.code == "CONTEXT_OVERFLOW"
            ) and exc.status_code in _RETRYABLE_STATUS
            self._last_error_retry_after = _retry_after_seconds(exc)
            yield StreamEvent(
                type="error",
                reason="error",
                error=self._redact(f"接口错误 {exc.status_code}：{_error_message(exc)}"),
                error_info=error_info,
            )
            return
        except openai.APIConnectionError as exc:
            # 连接被掐断通常是瞬时的（网关抖动、代理换路），值得重试。
            self._last_error_retryable = True
            error_info = openai_error_info(None, source="transport_error", retryable=True,
                                           transport_error=exc)
            yield StreamEvent(type="error", reason="error", error=self._redact(f"连接失败：{exc}"),
                              error_info=error_info)
            return
        except SDK_TRANSPORT_ERRORS as exc:
            # Preserve the existing no-retry policy for unwrapped body failures.
            self._last_error_retryable = False
            error_info = openai_error_info(None, source="transport_error", transport_error=exc)
            yield StreamEvent(type="error", reason="error", error="模型流传输失败",
                              error_info=error_info)
            return
        except openai.APIError as exc:
            self._last_error_retryable = False
            yield StreamEvent(type="error", reason="error", error=self._redact(f"接口异常：{exc}"))
            return
        except Exception as exc:  # noqa: BLE001
            # 兜底：SDK 的流管理器会用**裸 RuntimeError** 报告协议异常（例如
            # "Expected to have received `response.created` before ..."），它不属于
            # openai.APIError 体系。契约要求「生成开始后不抛异常」，所以这里必须接住，
            # 并把异常类型一并回报，避免它变成 JSON-RPC 的内部错误而丢掉上下文。
            # 这类失败是协议层面的，重试同一请求大概率还会失败，因此不重试。
            self._last_error_retryable = False
            yield StreamEvent(
                type="error",
                reason="error",
                error=f"模型流处理异常（{type(exc).__name__}）",
            )
            return

        for index, parts in text_buffers.items():
            if index not in blocks and (terminal_indexes is None or index in terminal_indexes):
                blocks[index] = TextBlock(text=text_budget.reconcile_parts(("text", index), parts))
        for index, parts in thinking_buffers.items():
            if index not in blocks and (terminal_indexes is None or index in terminal_indexes):
                blocks[index] = ThinkingBlock(thinking=text_budget.reconcile_parts(("thinking", index), parts))
        if terminal_indexes is not None:
            blocks = {index: block for index, block in blocks.items() if index in terminal_indexes}
        ordered: list[object] = [blocks[key] for key in sorted(blocks)]
        calls = tuple(block for block in ordered if isinstance(block, ToolCallBlock))
        # 参数 JSON 没解析成功时，视为这一轮未完成，交由调用方报错而不是带着空参数执行。
        unfinished = broken
        stop_reason, error_message = (
            _stop_reason(terminal, has_tool_calls=bool(calls)) if terminal is not None else ("error", "流在没有终态响应前结束")
        )
        if not error_message and unfinished:
            error_message = f"工具调用参数不完整：{'、'.join(unfinished)}"

        if error_message:
            yield StreamEvent(type="error", reason="error", error=self._redact(error_message))
            return

        message = AssistantMessage(
            blocks=tuple(ordered),  # type: ignore[arg-type]
            stop_reason=stop_reason,  # type: ignore[arg-type]
            usage=_usage_from_response(terminal),
        )
        yield StreamEvent(type="done", reason=stop_reason, message=message)


def _reasoning_text(item: object, budget: ResponseTextBudget | None = None, index: int = 0) -> str:
    """把 reasoning 项的 summary/content 拼成一段文本。"""
    parts: list[str] = []
    size = 0
    summary = getattr(item, "summary", None) or []
    for part in summary:
        text = str(getattr(part, "text", "") or "")
        if text:
            if budget:
                size += budget.size(text, MAX_RESPONSE_TEXT_BYTES - size)
                budget.ensure_size(("thinking", index), size + (2 * max(0, len(parts))))
            parts.append(text)
    if not parts:
        for part in getattr(item, "content", None) or []:
            text = str(getattr(part, "text", "") or "")
            if text:
                if budget:
                    size += budget.size(text, MAX_RESPONSE_TEXT_BYTES - size)
                    budget.ensure_size(("thinking", index), size + (2 * max(0, len(parts))))
                parts.append(text)
    return budget.reconcile_parts(("thinking", index), parts, separator="\n\n") if budget else "\n\n".join(parts)


def _message_text(item: object, budget: ResponseTextBudget | None = None, index: int = 0) -> str:
    """把 message 项的 output_text / refusal 片段拼起来。"""
    parts: list[str] = []
    size = 0
    for part in getattr(item, "content", None) or []:
        text = getattr(part, "text", None)
        if text is None:
            text = getattr(part, "refusal", None)
        if text:
            if budget:
                size += budget.size(str(text), MAX_RESPONSE_TEXT_BYTES - size)
                budget.ensure_size(("text", index), size)
            parts.append(str(text))
    return budget.reconcile_parts(("text", index), parts) if budget else "".join(parts)


def _parse_arguments(raw: str | None) -> dict[str, Any] | None:
    """解析函数参数；**返回 None 表示拿到的不是合法 JSON**。

    空串与 `None` 都等价于空对象：无参工具（例如 boss_list_tools）的参数形态就是 `""` 或 `{}`，
    上游不发参数事件时缓冲也会停在 `""`。把它们判成失败会让一次合法调用整轮报错。
    真正要拦的只有「参数被截断/不是 JSON」这一种。
    """
    if raw is None or raw == "":
        return {}
    text = raw.strip()
    if not text:
        return None
    try:
        parsed = json.loads(text, parse_constant=_reject_json_constant)
    except (TypeError, ValueError, RecursionError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _retry_after_seconds(exc: openai.APIStatusError) -> float | None:
    """读 Retry-After / Retry-After-Ms 头；网关没给就返回 None 走指数退避。"""
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


def _error_message(exc: openai.APIStatusError) -> str:
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
        if body.get("message"):
            return str(body["message"])
    return str(getattr(exc, "message", "") or exc)
