"""模型层的类型契约。

形状取自 Pi 的 `packages/ai/src/types.ts`：内容块用判别式联合、停止原因是固定枚举、
流事件是一条固定协议（`start` 先于一切更新，以 `done` 或 `error` 终止）。
Python 没有联合类型，这里用带 `type` 判别字段的数据类表达同一契约。
"""
from __future__ import annotations

from dataclasses import dataclass, field
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
]


# ---------- 内容块 ----------


@dataclass(frozen=True)
class TextBlock:
    text: str


@dataclass(frozen=True)
class ThinkingBlock:
    thinking: str = ""


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


# ---------- 请求与事件 ----------


@dataclass(frozen=True)
class ModelRequest:
    model: str
    system: str
    messages: tuple[ChatMessage, ...]
    tools: tuple[ToolSpec, ...] = ()
    max_tokens: int = 64000
    effort: str | None = None
    thinking: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class ModelErrorInfo:
    """供应商已确认的错误分类；不包含原始响应、请求或凭据。

    分类只说明当前请求失败的原因，是否允许恢复由执行内核判断。
    """

    code: Literal["CONTEXT_OVERFLOW"]
    provider: Literal["openai", "anthropic"]
    source: Literal["http_error", "stream_error"]
    provider_code: str | None = None
    status_code: int | None = None


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
