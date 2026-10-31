"""模型层的类型契约。

形状取自 Pi 的 `packages/ai/src/types.ts`：内容块用判别式联合、停止原因是固定枚举、
流事件是一条固定协议（`start` 先于一切更新，以 `done` 或 `error` 终止）。
Python 没有联合类型，这里用带 `type` 判别字段的数据类表达同一契约。
"""
from __future__ import annotations

from dataclasses import dataclass, field
import threading
from typing import Any, Literal, Mapping

#: 与 Pi 的 StopReason 对齐（Pi 用 camelCase 的 toolUse，Python 侧用 snake_case）。
StopReason = Literal["stop", "length", "tool_use", "error", "aborted"]

#: Pi 的 AssistantMessageEvent 的 12 种事件。
EventType = Literal[
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "done",
    "error",
    "retry_start",
    "retry_end",
]


# ---------- 内容块 ----------


@dataclass(frozen=True)
class TextBlock:
    text: str


@dataclass(frozen=True)
class ThinkingBlock:
    thinking: str = ""
    signature: str | None = field(default=None, repr=False)
    redacted_data: str | None = field(default=None, repr=False)
    prefix_digest: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class ToolCallBlock:
    id: str
    name: str
    arguments: Mapping[str, Any] = field(default_factory=dict)


ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock


# ---------- 消息 ----------


@dataclass(frozen=True)
class UserMessage:
    text: str


@dataclass(frozen=True)
class AssistantMessage:
    blocks: tuple[ContentBlock, ...] = ()
    stop_reason: StopReason = "stop"
    usage: "Usage | None" = None

    def text(self) -> str:
        return "".join(block.text for block in self.blocks if isinstance(block, TextBlock))

    def tool_calls(self) -> tuple[ToolCallBlock, ...]:
        return tuple(block for block in self.blocks if isinstance(block, ToolCallBlock))


@dataclass(frozen=True)
class ToolResultItem:
    tool_call_id: str
    content: str
    is_error: bool = False


@dataclass(frozen=True)
class ToolResultsMessage:
    """一次请求里的全部工具结果，必须放在同一条 user 消息中回填。"""

    results: tuple[ToolResultItem, ...]


ChatMessage = UserMessage | AssistantMessage | ToolResultsMessage


# ---------- 用量与工具声明 ----------


DEFAULT_MODEL_TOOL_RESULT_BYTES = 20 * 1024
MIN_MODEL_TOOL_RESULT_BYTES = 8 * 1024
MAX_MODEL_TOOL_RESULT_BYTES = 1024 * 1024


@dataclass(frozen=True)
class Usage:
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    reasoning: int | None = None

    @property
    def total(self) -> int:
        return self.input + self.output


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: Mapping[str, Any]
    max_model_result_bytes: int = DEFAULT_MODEL_TOOL_RESULT_BYTES


# ---------- 请求与事件 ----------


RequestPurpose = Literal["turn", "compaction", "connection_check"]
TransportCause = Literal[
    "connect_timeout", "read_timeout", "write_timeout", "pool_timeout", "timeout",
    "dns_error", "tls_error", "connect_error", "read_error", "write_error",
    "protocol_error", "connection_error", "os_error", "unknown",
]


@dataclass(frozen=True)
class ModelTaskContext:
    """本地请求归属；不属于模型输入或供应商 HTTP metadata。

    身份来自发起请求的回合或摘要任务，缺失值表示未知，不能推断用户归属。
    ``request_index`` 从零开始；供应商内部传输重试沿用同一上下文。
    """

    purpose: RequestPurpose
    request_index: int
    thread_id: str | None = None
    turn_id: str | None = None
    job_id: str | None = None


DEFAULT_MODEL_RECOVERY_RETRIES = 8


class _RecoveryReservation:
    def __init__(self, budget: "ModelRecoveryBudget") -> None:
        self._budget = budget
        self._active = True

    def commit(self) -> bool:
        with self._budget._lock:
            if not self._active:
                return False
            self._active = False
            self._budget._reserved -= 1
            return True

    def release(self) -> bool:
        with self._budget._lock:
            if not self._active:
                return False
            self._active = False
            self._budget._reserved -= 1
            self._budget._remaining += 1
            return True


class ModelRecoveryBudget:
    """Share a finite number of provider and agent recovery attempts.

    The object is runtime-only: it must never be written to session data or a
    provider request body. Reservations let cancellation during backoff return
    its slot without racing another request that shares the budget.
    """

    def __init__(self, retries: int = DEFAULT_MODEL_RECOVERY_RETRIES) -> None:
        if type(retries) is not int or not 0 <= retries <= 64:
            raise ValueError("模型恢复次数必须是 0 到 64 的整数")
        self._remaining = retries
        self._reserved = 0
        self._lock = threading.Lock()

    @property
    def remaining(self) -> int:
        with self._lock:
            return self._remaining

    def reserve_retry(self, cancel_event: threading.Event | None = None) -> _RecoveryReservation | None:
        if cancel_event is not None and cancel_event.is_set():
            return None
        with self._lock:
            if ((cancel_event is not None and cancel_event.is_set()) or self._remaining <= 0):
                return None
            self._remaining -= 1
            self._reserved += 1
            return _RecoveryReservation(self)

    def consume_retry(self, cancel_event: threading.Event | None = None) -> bool:
        reservation = self.reserve_retry(cancel_event)
        return reservation.commit() if reservation is not None else False


@dataclass(frozen=True)
class ModelRequest:
    model: str
    system: str
    messages: tuple[ChatMessage, ...]
    tools: tuple[ToolSpec, ...] = ()
    max_tokens: int = 64000
    effort: str | None = None
    thinking: Mapping[str, Any] | None = None
    task_context: ModelTaskContext | None = None
    recovery_budget: ModelRecoveryBudget | None = field(default=None, repr=False, compare=False)


@dataclass(frozen=True)
class ModelErrorInfo:
    """来自供应商终态错误的有限诊断信息，不包含原始响应或凭据。

    ``code`` 仅表示 Harness 已确认的语义分类；状态码、provider code 和
    ``retryable`` 不能单独授权执行内核重试或恢复。
    """

    provider: Literal["openai", "anthropic"]
    source: Literal["http_error", "stream_error", "transport_error"]
    code: Literal["CONTEXT_OVERFLOW"] | None = None
    provider_code: str | None = None
    status_code: int | None = None
    retryable: bool | None = None
    transport_cause: TransportCause | None = None
    transport_code: str | None = None

    def event_payload(self) -> dict[str, Any]:
        """Return the camelCase public notification shape, omitting unknown facts."""
        payload: dict[str, Any] = {"provider": self.provider, "source": self.source}
        if self.code is not None:
            payload["code"] = self.code
        if self.provider_code is not None:
            payload["providerCode"] = self.provider_code
        if self.status_code is not None:
            payload["statusCode"] = self.status_code
        if self.retryable is not None:
            payload["retryable"] = self.retryable
        if self.transport_cause is not None:
            payload["transportCause"] = self.transport_cause
        if self.transport_code is not None:
            payload["transportCode"] = self.transport_code
        return payload


@dataclass(frozen=True)
class StreamEvent:
    """一条流事件；字段按 `type` 取用，其余为空。"""

    type: EventType
    content_index: int = 0
    delta: str = ""
    text: str = ""
    tool_call: ToolCallBlock | None = None
    reason: str = ""
    message: AssistantMessage | None = None
    error: str = ""
    error_info: ModelErrorInfo | None = None
    #: retry_start：即将发起的第几次尝试、总尝试上限与退避毫秒；retry_end：最后一次重试序号。
    attempt: int = 0
    max_attempts: int = 0
    delay_ms: int = 0
