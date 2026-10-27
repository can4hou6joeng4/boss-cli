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
from typing import Any

import openai

from boss_harness.models.errors import openai_error_info
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
        self._client = openai.OpenAI(api_key=self._secret, base_url=config.base_url,
                                     timeout=30.0, max_retries=0)
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
        return redact_secrets(str(text), extra=(self._secret,))

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
        if stream is not None:
            try:
                stream.close()
            except Exception:  # noqa: BLE001 - 关不上也不该把中断本身搞成异常
                pass

    # ---------- 事件流 ----------

    def stream(self, request: ModelRequest) -> Iterator[StreamEvent]:
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

                for event in self._stream_once(request):
                    if event.type == "start":
                        continue  # 外层已经发过
                    if event.type == "error":
                        retryable = self._last_error_retryable and not self._abort_requested
                        retry_after = self._last_error_retry_after
                        if retryable and not emitted and attempt < attempts:
                            retry_message = event.error
                            break
                        yield event
                        return
                    emitted = True
                    yield event

                if retry_message is None:
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
        #: output_index -> function_call 的参数 JSON 缓冲
        json_buffers: dict[int, str] = {}
        #: output_index -> arguments.done 中的权威原始 JSON
        arguments_done: dict[int, str | None] = {}
        #: output_index -> function_call 的 call_id（回填工具结果要靠它）
        call_ids: dict[int, str] = {}
        #: 参数不是完整 JSON 的 function_call（用名字记），收尾时按失败处理
        broken: list[str] = []
        #: 是否已经发出过思考增量（没有内容时不补空行）
        saw_delta = False
        #: 是否有一段思考待分隔：延后到下一段真正开始时再发，避免尾部分隔符
        pending_break = False
        terminal: object | None = None

        yield StreamEvent(type="start")

        try:
            # 用 create(stream=True) 取**原始事件流**，而不是 SDK 的 responses.stream()：
            # 后者自带状态机，网关过载回 response.failed 时会抛裸 RuntimeError
            # （"Expected to have received `response.created` before ..."），把端点原话吞掉；
            # 而本项目本来就在自己维护状态（累积块、算停止原因），不需要它的状态机。
            with self._client.responses.create(**kwargs, stream=True) as stream:
                self._active_stream = stream
                for event in stream:
                    kind = str(getattr(event, "type", ""))
                    index = int(getattr(event, "output_index", 0) or 0)

                    if kind == "response.output_item.added":
                        item = getattr(event, "item", None)
                        item_type = str(getattr(item, "type", "") or "")
                        if item_type == "reasoning":
                            # 每个 reasoning 项自成一段：不清零的话，上一项遗留的待分隔标记会被
                            # 下一项的首个增量吃掉，凭空插进一个空行。
                            saw_delta = False
                            pending_break = False
                            yield StreamEvent(type="thinking_start", content_index=index)
                        elif item_type == "message":
                            yield StreamEvent(type="text_start", content_index=index)
                        elif item_type == "function_call":
                            json_buffers[index] = str(getattr(item, "arguments", "") or "")
                            call_ids[index] = str(getattr(item, "call_id", "") or "")
                            yield StreamEvent(type="toolcall_start", content_index=index)

                    elif kind in _THINKING_DELTA_EVENTS:
                        delta = str(getattr(event, "delta", "") or "")
                        if delta:
                            if pending_break:
                                pending_break = False
                                yield StreamEvent(
                                    type="thinking_delta", content_index=index, delta="\n\n"
                                )
                            saw_delta = True
                            yield StreamEvent(type="thinking_delta", content_index=index, delta=delta)

                    elif kind == "response.reasoning_summary_part.done":
                        # 把段落分隔符延后到下一段真正开始时再发：这样流式文本恰好等于
                        # "\n\n".join(各段)，既不会多出尾分隔符，也不会与 thinking_end 的文本不一致。
                        if saw_delta:
                            pending_break = True

                    elif kind in _TEXT_DELTA_EVENTS:
                        delta = str(getattr(event, "delta", "") or "")
                        if delta:
                            yield StreamEvent(type="text_delta", content_index=index, delta=delta)

                    elif kind == "response.function_call_arguments.delta":
                        fragment = str(getattr(event, "delta", "") or "")
                        if fragment:
                            json_buffers[index] = json_buffers.get(index, "") + fragment
                            yield StreamEvent(type="toolcall_delta", content_index=index, delta=fragment)

                    elif kind == "response.function_call_arguments.done":
                        # 权威参数以 done 为准；只把新增后缀当作增量补发，避免重复。
                        authoritative = getattr(event, "arguments", None)
                        if not isinstance(authoritative, str):
                            authoritative = None
                        previous = json_buffers.get(index, "")
                        if authoritative is not None:
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
                        if item_type == "reasoning":
                            text = _reasoning_text(item)
                            blocks[index] = ThinkingBlock(thinking=text)
                            yield StreamEvent(type="thinking_end", content_index=index, text=text)
                        elif item_type == "message":
                            text = _message_text(item)
                            blocks[index] = TextBlock(text=text)
                            yield StreamEvent(type="text_end", content_index=index, text=text)
                        elif item_type == "function_call":
                            name = str(getattr(item, "name", "") or "")
                            buffered = json_buffers.pop(index, None)
                            has_done_arguments = index in arguments_done
                            done_raw = arguments_done.pop(index, None)
                            has_final_arguments = (hasattr(item, "arguments")
                                                   and getattr(item, "arguments") is not None)
                            final_raw = getattr(item, "arguments", None)
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
                            if arguments is None:
                                broken.append(name or str(getattr(item, "call_id", "") or ""))
                                arguments = {}
                            call = ToolCallBlock(
                                id=call_ids.get(index) or str(getattr(item, "call_id", "") or ""),
                                name=name,
                                arguments=arguments,
                            )
                            blocks[index] = call
                            yield StreamEvent(type="toolcall_end", content_index=index, tool_call=call)

                    elif kind in ("response.completed", "response.incomplete"):
                        terminal = getattr(event, "response", None)

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
                        error_info = openai_error_info(error, source="stream_error")
                        self._last_error_retryable = error_info is None and _looks_transient(code, f"{error_type} {message}")
                        yield StreamEvent(
                            type="error", reason="error", error=self._redact(f"接口错误 {code}：{message}"),
                            error_info=error_info,
                        )
                        return

                    elif kind == "error":
                        code = str(getattr(event, "code", "") or "unknown")
                        message = str(getattr(event, "message", "") or "")
                        error_info = openai_error_info(event, source="stream_error")
                        self._last_error_retryable = error_info is None and _looks_transient(code, message)
                        yield StreamEvent(
                            type="error", reason="error", error=self._redact(f"接口错误 {code}：{message}"),
                            error_info=error_info,
                        )
                        return

                # 终态响应由 response.completed / response.incomplete 事件记录，见上面的分支；
                # 原始事件流没有 get_final_response()。

        except openai.APIStatusError as exc:
            error_info = openai_error_info(exc.body, source="http_error", status_code=exc.status_code)
            self._last_error_retryable = error_info is None and exc.status_code in _RETRYABLE_STATUS
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
            yield StreamEvent(type="error", reason="error", error=self._redact(f"连接失败：{exc}"))
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
                error=self._redact(f"流处理异常（{type(exc).__name__}）：{exc}"),
            )
            return

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
            yield StreamEvent(type="error", reason="error", error=error_message)
            return

        message = AssistantMessage(
            blocks=tuple(ordered),  # type: ignore[arg-type]
            stop_reason=stop_reason,  # type: ignore[arg-type]
            usage=_usage_from_response(terminal),
        )
        yield StreamEvent(type="done", reason=stop_reason, message=message)


def _reasoning_text(item: object) -> str:
    """把 reasoning 项的 summary/content 拼成一段文本。"""
    parts: list[str] = []
    summary = getattr(item, "summary", None) or []
    for part in summary:
        text = str(getattr(part, "text", "") or "")
        if text:
            parts.append(text)
    if not parts:
        for part in getattr(item, "content", None) or []:
            text = str(getattr(part, "text", "") or "")
            if text:
                parts.append(text)
    return "\n\n".join(parts)


def _message_text(item: object) -> str:
    """把 message 项的 output_text / refusal 片段拼起来。"""
    parts: list[str] = []
    for part in getattr(item, "content", None) or []:
        text = getattr(part, "text", None)
        if text is None:
            text = getattr(part, "refusal", None)
        if text:
            parts.append(str(text))
    return "".join(parts)


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
    except (TypeError, ValueError):
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
