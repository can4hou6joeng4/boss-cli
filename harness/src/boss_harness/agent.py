"""模型驱动的回合执行器。

职责：把「一条用户输入」变成「一串协议事件 + 落库条目」。
- 历史重建：从会话条目还原 ChatMessage（含工具调用与其结果）；
- 工具回路：模型要调工具就执行、回填结果，再让模型继续，最多 max_model_requests 次模型请求；
- 审批闸门：标记为需要批准的工具，在执行前先向用户要批准，拿不到就 fail closed；
- 中断：回合可被外部取消，取消点落在每次取流事件之前与每个工具调用之前。

边界：本模块不直接 import 任何领域代码，工具执行一律经注册表拿到的回调。
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from typing import Any

from boss_harness.context import ContextBudgetExceeded, messages_from_items
from boss_harness.compaction import ContextCompactionFailed
from boss_harness.hooks import LifecycleHooks
from boss_harness.request_policy import ModelRequestRejected, check_model_request, record_model_rejection
from boss_harness.models import (
    AssistantMessage,
    ToolCallBlock,
    ToolResultItem,
    ToolResultsMessage,
    ToolSpec,
    UserMessage,
)
from boss_harness.models.provider import ModelConfig, Provider
from boss_harness.models.continuation import (
    ANTHROPIC_CONTINUATION_FIELD,
    anthropic_continuation,
)
from boss_harness.models.output_budget import OutputBudgetExceeded, ResponseTextBudget, utf8_chunks
from boss_harness.models.errors import transport_diagnostic
from boss_harness.models.secret import redact_secrets
from boss_harness.models.types import (
    DEFAULT_MODEL_TOOL_RESULT_BYTES, ChatMessage, ModelRequest, ModelErrorInfo, ModelRecoveryBudget,
    TextBlock, ThinkingBlock,
)
from boss_harness.model_tools import (
    MODEL_RESULT_READ_SPEC, MODEL_RESULT_READ_TOOL, model_tool_specs,
    read_model_tool_result, validate_model_result_read,
)
from boss_harness.session import (MAX_TOOL_BATCH_CALLS, Entry, SessionStore, ToolRevisionPersistenceError,
                                  approval_parameters_digest)
from boss_harness.toolkit import ToolResult, snapshot_result
from boss_harness.tool_results import (
    model_result_content, model_result_for_item, project_error, project_item,
)
from boss_harness.turn_limits import DEFAULT_MAX_MODEL_REQUESTS, model_request_limit

# Compatibility for embedded hosts importing the former fixed default.
MAX_TOOL_ROUNDS = DEFAULT_MAX_MODEL_REQUESTS

#: 审批的默认等待上限（秒）。超时按未批准处理：无法安全判定时必须 fail closed。
DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300.0

#: 协议事件名（与 packages/protocol 的 ServerNotifications 对应）。
N_TURN_STARTED = "turn/started"
N_AGENT_MESSAGE_DELTA = "agentMessage/delta"
N_AGENT_THINKING_DELTA = "agentThinking/delta"
N_MODEL_RETRY_STARTED = "model/retryStarted"
N_MODEL_RETRY_ENDED = "model/retryEnded"
N_ITEM_STARTED = "item/started"
N_ITEM_COMPLETED = "item/completed"
N_TOOL_CALL_STARTED = "toolCall/started"
N_TOOL_CALL_COMPLETED = "toolCall/completed"
N_APPROVAL_REQUESTED = "approval/requested"
N_THREAD_UPDATED = "thread/updated"
N_SESSION_ERROR = "session/error"

Notify = Callable[[str, dict[str, Any] | None], None]


class ToolCompletionNotificationError(RuntimeError):
    """The result is durable, but its observer notification failed."""


class _ParallelUnavailable(RuntimeError):
    """并行批次在任何调用落库或 handler 启动前即无法获得独立工具桥。"""


@dataclass
class _PreparedTool:
    """已在主线程完成校验、策略与 start 持久化、等待派发的一次工具调用。"""

    name: str
    arguments: dict[str, Any]
    call_id: str | None
    entry: Entry
    approval: dict[str, Any] | None
    invalid: ToolResult | None
    policy_denied: bool
    handler: Callable[[Any, dict[str, Any]], ToolResult] | None
    dispatched: bool = False
    dispatch_persistence_failed: bool = False
    cancelled_before_dispatch: bool = False


@dataclass
class _ApprovalWait:
    """一次待决定的审批。`event` 负责唤醒等待方，`decision` 是用户的裁决。"""

    event: threading.Event = field(default_factory=threading.Event)
    decision: str | None = None
    deadline: float = float("inf")
    decision_record: dict[str, Any] | None = None


class TurnRunner:
    def __init__(
        self,
        *,
        sessions: SessionStore,
        tool_bridge: Any,
        handlers: Mapping[str, Callable[[Any, dict[str, Any]], ToolResult]],
        provider: Provider | None,
        config: ModelConfig,
        notify: Notify,
        approval_required: frozenset[str] = frozenset(),
        approval_timeout: float = DEFAULT_APPROVAL_TIMEOUT_SECONDS,
        tools: tuple[ToolSpec, ...] = (),
        system_prompt: str = "根据用户任务调用已注册工具，尊重中断与审批裁决。",
        validate_arguments: Callable[[str, dict[str, Any]], dict[str, Any] | None] | None = None,
        pause_on_result: Callable[[ToolResult], bool] | None = None,
        history_provider: Callable[[str], tuple[ChatMessage, ...]] | None = None,
        context_check: Callable[[list[ChatMessage], str], None] | None = None,
        drain_steering: Callable[[], list[UserMessage]] | None = None,
        stage_steering: Callable[[], tuple[list[UserMessage], Callable[[], None]]] | None = None,
        request_preparer: Callable[[ModelRequest], tuple[ModelRequest, dict[str, Any]]] | None = None,
        recover_context: Callable[[ModelRequest], ModelRequest | None] | None = None,
        lifecycle_hooks: LifecycleHooks | None = None,
        persistence_fence: Callable[[str], None] | None = None,
        phase_recorder: Callable[[str, int], None] | None = None,
        dispatch_lock: Any | None = None,
        execution_modes: Mapping[str, str] | None = None,
        parallel_bridge_factory: Callable[[], Any] | None = None,
        parallel_bridge_close: Callable[[Any], None] | None = None,
        parallel_max_workers: int = 4,
        max_model_requests: int = DEFAULT_MAX_MODEL_REQUESTS,
    ) -> None:
        self.sessions = sessions
        self.tool_bridge = tool_bridge
        self.handlers = handlers
        self.provider = provider
        self.config = config
        self.notify = notify
        #: 需要用户批准的工具名。为空时闸门不介入，只读工具因此不受影响。
        self.approval_required = approval_required
        self._tools = tools
        model_tool_specs(tools)
        self._tool_result_limits = {tool.name: tool.max_model_result_bytes for tool in tools}
        self._tool_result_limits[MODEL_RESULT_READ_TOOL] = MODEL_RESULT_READ_SPEC.max_model_result_bytes
        self.system_prompt = system_prompt
        self.validate_arguments = validate_arguments
        self.pause_on_result = pause_on_result
        self.approval_timeout = approval_timeout
        self._pending_approvals: dict[str, _ApprovalWait] = {}
        self._approval_lock = threading.Lock()
        #: 当前回合的取消信号；由 run() 创建，interrupt() 置位。
        self._cancel: threading.Event | None = None
        self._blocked: ToolResult | None = None
        self.turn_id: str | None = None
        self.history_provider = history_provider
        self.context_check = context_check
        self.drain_steering = drain_steering
        self.stage_steering = stage_steering
        self.request_preparer = request_preparer
        self.last_preparation: tuple[ModelRequest, dict[str, Any]] | None = None
        self.recover_context = recover_context
        self.lifecycle_hooks = lifecycle_hooks
        self.persistence_fence = persistence_fence
        self.phase_recorder = phase_recorder
        # The application shares this lock with interrupt acceptance.
        self._dispatch_lock = dispatch_lock or threading.Lock()
        if execution_modes is not None and (
                not isinstance(execution_modes, Mapping)
                or any(type(key) is not str or type(mode) is not str or mode not in {"sequential", "parallel"}
                       for key, mode in execution_modes.items())):
            raise ValueError("工具执行模式映射无效")
        if type(parallel_max_workers) is not int or not 1 <= parallel_max_workers <= 8:
            raise ValueError("并行工具 worker 上限必须是 1 到 8")
        self._execution_modes = dict(execution_modes or {})
        self._parallel_bridge_factory = parallel_bridge_factory
        self._parallel_bridge_close = parallel_bridge_close or (lambda bridge: None)
        self._parallel_max_workers = parallel_max_workers
        self.context_abort: Callable[[], None] | None = None
        self.last_stream_error: ModelErrorInfo | None = None
        self.last_stream_recoverable = False
        self.last_stream_output_observed = False
        self.preparing_request_index: int | None = None
        self.max_model_requests = model_request_limit(max_model_requests)
        self.request_offset = 0

    @property
    def tool_names(self) -> list[str]:
        return [tool.name for tool in self._tools]

    def tool_specs(self) -> tuple[ToolSpec, ...]:
        return model_tool_specs(self._tools)

    def _tool_result_limit(self, name: str) -> int:
        value = self._tool_result_limits.get(name, DEFAULT_MODEL_TOOL_RESULT_BYTES)
        return value if type(value) is int else DEFAULT_MODEL_TOOL_RESULT_BYTES

    def _record_phase(self, phase: str, attempt: int) -> None:
        if self.phase_recorder is not None:
            self.phase_recorder(phase, attempt)

    # ---------- 中断与审批 ----------

    def interrupt(self) -> None:
        """请求取消当前回合。会在下一个取消点生效，并顺带打断卡住的流。"""
        with self._dispatch_lock:
            if self._cancel is not None:
                self._cancel.set()
        # 流卡住时下游的 for/next 不会返回，取消点也就轮不到；这里主动把连接关掉，
        # 让阻塞中的读取立刻抛错退出。provider 不实现这个方法时只依赖取消点。
        abort = getattr(self.provider, "request_abort", None)
        if callable(abort):
            abort()
        if self.context_abort is not None:
            self.context_abort()

    def cancelled(self) -> bool:
        return self._cancel is not None and self._cancel.is_set()

    def resolve_approval(self, approval_id: str, approved: bool,
                         persist: Callable[[], dict[str, Any]] | None = None) -> bool:
        """落下一次审批裁决；返回 False 表示这个 id 不认得（已过期或不存在）。"""
        with self._approval_lock:
            wait = self._pending_approvals.get(approval_id)
            if (wait is None or wait.decision is not None or self.cancelled()
                    or time.monotonic() >= wait.deadline):
                return False
            if persist is not None:
                wait.decision_record = persist()
            wait.decision = (wait.decision_record.get("decision") if wait.decision_record
                             else "approve" if approved else "deny")
            wait.event.set()
            return True

    def expire_approval(self, approval_id: str) -> None:
        with self._approval_lock:
            wait = self._pending_approvals.get(approval_id)
            if wait is not None and wait.decision is None:
                wait.decision = "expired"
                wait.event.set()

    def _await_approval(self, approval_id: str) -> str:
        """等一次审批；超时或回合被取消都返回未批准。"""
        wait = self._pending_approvals[approval_id]
        while True:
            with self._approval_lock:
                if wait.decision is not None:
                    return wait.decision
                if self.cancelled() or time.monotonic() >= wait.deadline:
                    wait.decision = "expired"
                    wait.event.set()
                    return "expired"
                remaining = wait.deadline - time.monotonic()
            wait.event.wait(min(0.2, remaining))

    def safe_error(self, error: object) -> str:
        secrets = (self.config.api_key.get(),) if self.config.api_key else ()
        return redact_secrets(str(error), extra=secrets)

    # ---------- 落库 ----------

    def append_user(self, thread_id: str, text: str, **metadata: Any) -> Entry:
        return self.sessions.append(
            thread_id,
            Entry(
                type="item",
                parent_id=self.sessions.last_entry_id(thread_id),
                payload={"kind": "userMessage", "text": text, "turnId": self.turn_id, **metadata},
            ),
        )

    def append_agent(self, thread_id: str, text: str, *, emit: bool = True) -> Entry:
        entry = self.sessions.append(
            thread_id,
            Entry(
                type="item",
                parent_id=self.sessions.last_entry_id(thread_id),
                payload={"kind": "agentMessage", "text": text, "turnId": self.turn_id},
            ),
        )
        if emit:
            self.notify(N_ITEM_COMPLETED, {"threadId": thread_id, "itemId": entry.id,
                                           "kind": "agentMessage", "text": text})
        return entry

    def start_tool_call(
        self,
        thread_id: str,
        name: str,
        arguments: dict[str, Any],
        call_id: str | None = None,
        approval: dict[str, Any] | None = None,
        batch_id: str | None = None,
        provider_continuation: dict[str, Any] | None = None,
        tool_batch_assistant_item_id: str | None = None,
    ) -> Entry:
        """记一条工具调用（running）。

        条目 id 只用于协议事件里的 itemId；**模型给出的调用 id** 另存为 `toolCallId`。
        回填结果必须用模型那个 id：assistant 消息里的 `tool_use` / `function_call` 带的是它，
        两者不一致时上游会直接拒绝（Anthropic 报 tool_use_id 找不到，Responses 报
        "No tool output found for function call ..."）。

        `approval` 会在等待裁决期间就落库，这样界面能立刻渲染出审批卡，而不是等裁决完才看到。
        """
        payload: dict[str, Any] = {
            "kind": "toolCall",
            "toolName": name,
            "toolArguments": arguments,
            "status": "running",
            "turnId": self.turn_id,
            "executionState": "pending_approval" if approval else "queued",
        }
        if call_id:
            payload["toolCallId"] = call_id
        if batch_id:
            payload["toolBatchId"] = batch_id
        if tool_batch_assistant_item_id is not None:
            payload["toolBatchAssistantItemId"] = tool_batch_assistant_item_id
        if provider_continuation is not None:
            payload[ANTHROPIC_CONTINUATION_FIELD] = provider_continuation
        if approval is not None:
            payload["approval"] = approval
        entry = self.sessions.append(
            thread_id,
            Entry(
                type="item",
                parent_id=self.sessions.last_entry_id(thread_id),
                payload=payload,
            ),
        )
        self.notify(
            N_ITEM_STARTED, {"threadId": thread_id, "itemId": entry.id, "kind": "toolCall", "toolName": name}
        )
        self.notify(
            N_TOOL_CALL_STARTED,
            {"threadId": thread_id, "itemId": entry.id, "toolName": name, "arguments": arguments},
        )
        return entry

    def _tool_phase(self, thread_id: str, entry: Entry, phase: str,
                    approval: dict | None = None) -> None:
        payload = {**(entry.payload or {}), "revises": entry.id, "executionState": phase}
        if approval is not None:
            payload["approval"] = dict(approval)
        self.sessions.append(thread_id, Entry(type="item", payload=payload))
        if approval is not None and phase in {"approved", "not_approved", "not_executed"}:
            self.notify("approval/decided", {"threadId": thread_id, "itemId": entry.id, "approval": dict(approval)})

    def finish_tool_call(
        self,
        thread_id: str,
        entry: Entry,
        name: str,
        result: ToolResult,
        call_id: str | None = None,
        approval: dict[str, Any] | None = None,
        execution_state: str | None = None,
    ) -> bool:
        status = "completed" if result.ok else "failed"
        arguments = dict((entry.payload or {}).get("toolArguments") or {})
        source = tool_source(thread_id, entry, name)
        payload: dict[str, Any] = {
            "kind": "toolCall",
            "toolName": name,
            "toolArguments": arguments,
            "status": status,
            "toolCallId": call_id or entry.id,
            "resultSummary": summarize_result(result),
            "revises": entry.id,
            "errorCode": (result.error or {}).get("code"),
            "recoveryAction": (result.error or {}).get("recovery_action"),
            "turnId": self.turn_id,
            "executionState": execution_state or status,
            "result": {"ok": result.ok, "command": result.command, "data": result.data,
                       "pagination": result.pagination, "error": result.error, "hints": result.hints},
            "source": source,
            "modelResultLimitBytes": self._tool_result_limit(name),
            "modelResult": model_result(result, source=source, item_id=entry.id,
                                         max_bytes=self._tool_result_limit(name)),
        }
        if approval is not None:
            payload["approval"] = approval
        revision = Entry(type="item", parent_id=self.sessions.last_entry_id(thread_id), payload=payload)
        _, recovered = self.sessions.append_tool_revision(thread_id, revision)
        if self.lifecycle_hooks is not None:
            self.lifecycle_hooks.after_tool_call({
                "threadId": thread_id,
                "turnId": self.turn_id,
                "itemId": entry.id,
                "toolCallId": call_id or entry.id,
                "toolName": name,
                "status": status,
                "executionState": payload["executionState"],
                "ok": result.ok,
                "errorCode": (result.error or {}).get("code"),
            }, payload["result"], cancel_event=self._cancel)
        # Keep canonical result data durable; model context uses its own bounded projection.
        # Observers get a separate bounded projection and content-addressed read route.
        try:
            transport = project_item(thread_id, {"id": entry.id, **payload})
            self.notify(
                N_TOOL_CALL_COMPLETED,
                {
                    "threadId": thread_id,
                    "itemId": entry.id,
                    "toolName": name,
                    "status": status,
                    "ok": result.ok,
                    "error": project_error(result.error),
                    "resultSummary": payload["resultSummary"],
                    **{key: transport[key] for key in ("result", "resultOmitted", "resultRef") if key in transport},
                    "source": source,
                    "approval": approval,
                },
            )
        except Exception as exc:
            raise ToolCompletionNotificationError from exc
        return recovered

    def execute_tool(
        self, thread_id: str, name: str, arguments: dict[str, Any], call_id: str | None = None,
        batch_id: str | None = None, provider_continuation: dict[str, Any] | None = None,
        tool_batch_assistant_item_id: str | None = None,
    ) -> ToolResultItem:
        """执行一个工具：审批闸门 -> 落库 + 发事件 -> 返回给模型的结果块。

        闸门对应 Pi 的 `beforeToolCall`（它可以阻断一次调用）：被拒绝的调用不执行，
        而是以 `is_error` 的工具结果回填给模型，让模型知道没被批准，而不是静默跳过。
        """
        prepared = self._prepare_tool(thread_id, name, arguments, call_id, batch_id, provider_continuation,
                                      tool_batch_assistant_item_id)
        if isinstance(prepared, ToolResultItem):
            return prepared
        result = self._begin_dispatch(thread_id, prepared)
        if result is None:
            result = self._call_handler(prepared, self.tool_bridge)
        return self._finish_tool(thread_id, prepared, result)

    def _prepare_tool(
        self, thread_id: str, name: str, arguments: dict[str, Any], call_id: str | None,
        batch_id: str | None, provider_continuation: dict[str, Any] | None,
        tool_batch_assistant_item_id: str | None = None,
    ) -> _PreparedTool | ToolResultItem:
        """校验、生命周期策略、审批与 start 持久化；只在回合主线程按模型顺序执行。"""
        approval: dict[str, Any] | None = None
        invalid: ToolResult | None = None
        try:
            if name == MODEL_RESULT_READ_TOOL:
                arguments = validate_model_result_read(arguments)
            elif self.validate_arguments is not None:
                normalized = self.validate_arguments(name, arguments)
                if normalized is not None:
                    if type(normalized) is not dict:
                        raise ValueError("工具参数校验器返回了无效结果")
                    arguments = normalized
        except ValueError as exc:
            invalid = ToolResult(ok=False, command=name, error={"code": "INVALID_PARAM", "message": str(exc)})
        policy_denied = False
        if invalid is None and self.lifecycle_hooks is not None:
            decision = self.lifecycle_hooks.before_tool_call({
                "threadId": thread_id,
                "turnId": self.turn_id,
                "toolCallId": call_id,
                "toolName": name,
                "arguments": arguments,
                "requiresApproval": name in self.approval_required,
            }, cancel_event=self._cancel)
            if self.cancelled():
                decision = None
            if decision is not None and not decision.allow:
                policy_denied = True
                invalid = ToolResult(ok=False, command=name, error={
                    "code": decision.code,
                    "message": self.safe_error(decision.message),
                    "recovery_action": "检查宿主生命周期策略后，明确发起新回合。",
                })
        if invalid is None and not self.cancelled() and name in self.approval_required:
            approval = {
                "approvalId": uuid.uuid4().hex,
                "toolName": name,
                "description": f"需要你批准后才会执行：{name}",
                "params": arguments,
                "paramsDigest": approval_parameters_digest(arguments),
                "consequential": True,
                "deadline": time.time() + self.approval_timeout,
            }
            with self._approval_lock:
                self._pending_approvals[approval["approvalId"]] = _ApprovalWait(
                    deadline=time.monotonic() + self.approval_timeout)

        entry = self.start_tool_call(thread_id, name, arguments, call_id, approval, batch_id,
                                     provider_continuation, tool_batch_assistant_item_id)

        if approval is not None:
            self.notify(
                N_APPROVAL_REQUESTED,
                {
                    "approvalId": approval["approvalId"],
                    "threadId": thread_id,
                    "itemId": entry.id,
                    "toolName": name,
                    "summary": approval["description"],
                    "params": arguments,
                    "consequential": True,
                    "deadline": approval["deadline"],
                },
            )
            decision = self._await_approval(approval["approvalId"])
            with self._approval_lock:
                wait = self._pending_approvals.pop(approval["approvalId"], None)
            approval["decision"] = decision
            if wait is not None and wait.decision_record is not None:
                approval.update(wait.decision_record["approval"])
            else:
                approval["decidedAt"] = datetime.now(timezone.utc).isoformat()
            # Persist consent before any side effect. A restart never consumes it again.
            decision_phase = ("approved" if decision == "approve" else
                              "not_approved" if decision == "deny" else "not_executed")
            self._tool_phase(thread_id, entry, decision_phase, approval)
            if decision != "approve":
                message = ("用户拒绝了这个操作" if decision == "deny" else
                           "审批已过期或等待已取消，工具未执行")
                error_code = "NOT_APPROVED" if decision == "deny" else (
                    "CANCELLED" if self.cancelled() else "APPROVAL_EXPIRED")
                execution_state = "not_approved" if decision == "deny" else "not_executed"
                denied = ToolResult(
                    ok=False, command=name, error={"code": error_code, "message": message}
                )
                self.finish_tool_call(thread_id, entry, name, denied, call_id, approval,
                                      execution_state)
                return ToolResultItem(
                    tool_call_id=call_id or entry.id,
                    content=model_result(denied, source=tool_source(thread_id, entry, name),
                                         item_id=entry.id, max_bytes=self._tool_result_limit(name)),
                    is_error=True,
                )

        handler = self.handlers.get(name)
        if name == MODEL_RESULT_READ_TOOL:
            handler = lambda _bridge, values: read_model_tool_result(self.sessions, thread_id, values)
        return _PreparedTool(name=name, arguments=arguments, call_id=call_id, entry=entry,
                             approval=approval, invalid=invalid, policy_denied=policy_denied,
                             handler=handler)

    def _begin_dispatch(self, thread_id: str, prepared: _PreparedTool) -> ToolResult | None:
        """在主线程写入 executing 阶段并确认可派发；返回 None 表示 handler 可以开始。"""
        name = prepared.name
        if self.cancelled():
            prepared.cancelled_before_dispatch = True
            return ToolResult(ok=False, command=name, error={"code": "CANCELLED", "message": "操作已取消，未执行工具"})
        if prepared.invalid is not None:
            return prepared.invalid
        if prepared.handler is None:
            return ToolResult(ok=False, command=name, error={"code": "NOT_SUPPORTED", "message": f"未知工具 {name}"})
        try:
            self._tool_phase(thread_id, prepared.entry, "executing", prepared.approval)
            with self._dispatch_lock:
                prepared.cancelled_before_dispatch = self.cancelled()
                prepared.dispatched = not prepared.cancelled_before_dispatch
        except Exception:
            prepared.dispatch_persistence_failed = True
            result = ToolResult(ok=False, command=name, error={
                "code": "SESSION_PERSISTENCE_ERROR",
                "message": "执行状态未能持久化，工具未派发；请检查会话状态后再继续",
            })
            self._blocked = result
            return result
        if prepared.cancelled_before_dispatch:
            return ToolResult(ok=False, command=name, error={"code": "CANCELLED", "message": "操作已取消，未执行工具"})
        return None

    def _call_handler(self, prepared: _PreparedTool, bridge: Any) -> ToolResult:
        """只调用 handler；可在并行 worker 中运行，不触碰会话持久化或回合状态。"""
        try:
            return snapshot_result(prepared.handler(bridge, prepared.arguments))
        except Exception as exc:
            return ToolResult(ok=False, command=prepared.name,
                              error={"code": "TOOL_ERROR", "message": self.safe_error(exc)})

    def _finish_tool(self, thread_id: str, prepared: _PreparedTool, result: ToolResult) -> ToolResultItem:
        """暂停判定、finish 持久化与通知；只在回合主线程按模型顺序执行。"""
        name, call_id, entry, approval = prepared.name, prepared.call_id, prepared.entry, prepared.approval
        dispatched = prepared.dispatched
        pause = False
        if not result.ok and name != MODEL_RESULT_READ_TOOL and self.pause_on_result is not None:
            try:
                pause = self.pause_on_result(snapshot_result(result))
                if type(pause) is not bool:
                    raise ValueError
            except Exception:
                result = ToolResult(ok=False, command=name, error={"code": "TOOL_ERROR", "message": "工具暂停策略回调失败"})
                pause = True
        if prepared.policy_denied:
            self._blocked = result
        if not result.ok and (pause
                              or (name in self.approval_required and (result.error or {}).get("code") not in {"INVALID_PARAM", "CANCELLED"})):
            self._blocked = result
        unknown = (dispatched and name in self.approval_required and not result.ok
                   and (result.error or {}).get("code") in {
                       "CANCELLED", "TOOL_TIMEOUT", "TOOL_ERROR", "CLI_ERROR", "CLI_CONTRACT_ERROR", "CLI_OUTPUT_LIMIT", "INVALID_ENVELOPE",
                       "GREET_RESULT_UNKNOWN", "ACTION_UNCONFIRMED"})
        execution_state = ("not_executed" if prepared.policy_denied or prepared.dispatch_persistence_failed
                           or prepared.cancelled_before_dispatch or prepared.invalid is not None
                           or prepared.handler is None
                           else "outcome_unknown" if unknown else None)
        try:
            recovered_persistence = self.finish_tool_call(thread_id, entry, name, result, call_id, approval,
                execution_state)
            if recovered_persistence:
                self._blocked = ToolResult(ok=False, command=name, error={
                    "code": "TOOL_RESULT_PERSISTENCE_RECOVERED",
                    "message": "工具结果已恢复写入；为避免继续使用不确定的回合状态，本回合已暂停。",
                    "recovery_action": "核对已保存的工具结果后，明确发起下一回合。",
                })
        except ToolCompletionNotificationError:
            self._blocked = ToolResult(ok=False, command=name, error={
                "code": "TOOL_RESULT_NOTIFICATION_FAILED",
                "message": "工具结果已保存，但完成通知失败；本回合已暂停以便重新读取会话状态。",
                "recovery_action": "刷新会话并核对已保存结果后，再明确发起下一步。",
            })
            return ToolResultItem(tool_call_id=call_id or entry.id,
                content=model_result(result, source=tool_source(thread_id, entry, name),
                                     item_id=entry.id, max_bytes=self._tool_result_limit(name)),
                is_error=not result.ok)
        except ToolRevisionPersistenceError as persistence_error:
            uncertain = ToolResult(ok=False, command=name, error={
                "code": "TOOL_RESULT_OUTCOME_UNKNOWN",
                "message": "工具已经派发，但结果无法确认已保存；请先核对外部状态，不要直接重试。",
                "recovery_action": "检查会话记录与平台状态后，再明确发起下一步。",
            })
            self._blocked = uncertain
            if persistence_error.outcome != "absent":
                if self.persistence_fence is not None:
                    self.persistence_fence(thread_id)
                return ToolResultItem(tool_call_id=call_id or entry.id,
                    content=model_result(uncertain, source=tool_source(thread_id, entry, name),
                                         max_bytes=self._tool_result_limit(name)), is_error=True)
            try:
                self.finish_tool_call(thread_id, entry, name, uncertain, call_id, approval,
                                      "outcome_unknown")
            except ToolCompletionNotificationError:
                pass
            except ToolRevisionPersistenceError:
                if self.persistence_fence is not None:
                    self.persistence_fence(thread_id)
            return ToolResultItem(tool_call_id=call_id or entry.id,
                content=model_result(uncertain, source=tool_source(thread_id, entry, name),
                                     max_bytes=self._tool_result_limit(name)), is_error=True)
        return ToolResultItem(
            tool_call_id=call_id or entry.id,
            content=model_result(result, source=tool_source(thread_id, entry, name),
                                 item_id=entry.id, max_bytes=self._tool_result_limit(name)),
            is_error=not result.ok,
        )

    def _parallel_batch_enabled(self, calls: tuple[ToolCallBlock, ...]) -> bool:
        """整批显式 parallel、均无审批且宿主能提供独立工具桥时才并发（任一 sequential 即整批串行）。"""
        if len(calls) < 2 or self._parallel_bridge_factory is None or self._parallel_max_workers < 2:
            return False
        return all(self._execution_modes.get(call.name) == "parallel"
                   and call.name not in self.approval_required and call.name in self.handlers
                   for call in calls)

    def _execute_parallel_batch(
        self, thread_id: str, calls: tuple[ToolCallBlock, ...], batch_id: str,
        provider_continuation: dict[str, Any] | None,
        assistant_item_id: str | None = None,
    ) -> list[ToolResultItem]:
        """按模型顺序 prepare，有界并发 handler，按模型顺序落 finish。

        在途 handler 不超过 worker 上限，工具桥按需创建并在批内复用，每个至多关闭一次。
        prepare 惰性进行：仅在有空闲槽位即将派发时才运行钩子并落 start；拒绝、暂停或取消
        后未 prepare 的调用与串行一致只经 `_skip_calls` 收尾；异常时先收尾已 prepare 的调用
        再传播。额外工具桥创建失败后本批不再重试。只有首个工具桥创建失败时抛出
        `_ParallelUnavailable`，此时尚无任何调用落库或启动。
        """
        bridges: list[Any] = []
        free: list[Any] = []

        def new_bridge() -> Any | None:
            try:
                bridge = self._parallel_bridge_factory()
            except Exception:
                return None
            if bridge is None or bridge is self.tool_bridge or any(bridge is known for known in bridges):
                return None
            try:
                bridge.cancel_event = self._cancel
            except Exception:
                try:
                    self._parallel_bridge_close(bridge)
                except Exception:
                    pass
                return None
            bridges.append(bridge)
            return bridge

        first = new_bridge()
        if first is None:
            raise _ParallelUnavailable("并行工具桥无法安全创建")
        free.append(first)
        bridge_failed = False
        try:
            results: list[ToolResultItem] = []
            limit = min(self._parallel_max_workers, len(calls))
            # 已 prepare 但尚未 finalize 的调用：index -> (prepared, future|None, bridge|None, early outcome|None)
            pending: dict[int, tuple[_PreparedTool | ToolResultItem, Future[ToolResult] | None, Any, ToolResult | None]] = {}
            next_index = 0
            stopped = False
            with ThreadPoolExecutor(max_workers=limit) as executor:
                try:
                    for index in range(len(calls)):
                        while (not stopped and next_index < len(calls)
                               and sum(1 for p in pending.values() if p[1] is not None) < limit):
                            if self._blocked is not None or self.cancelled():
                                stopped = True
                                break
                            if free:
                                bridge = free.pop()
                            elif bridge_failed:
                                break
                            else:
                                bridge = new_bridge()
                                if bridge is None:
                                    # 本批不再尝试新建工具桥，等待在途调用释放已有工具桥。
                                    bridge_failed = True
                                    break
                            call = calls[next_index]
                            try:
                                # 惰性按源顺序 prepare：仅在即将派发时运行钩子并落 start。
                                item = self._prepare_tool(thread_id, call.name, dict(call.arguments), call.id,
                                                          batch_id, provider_continuation if next_index == 0 else None,
                                                          assistant_item_id)
                            except BaseException:
                                free.append(bridge)
                                raise
                            if isinstance(item, ToolResultItem):
                                free.append(bridge)
                                pending[next_index] = (item, None, None, None)
                            elif item.policy_denied:
                                # 与串行一致：策略拒绝会暂停回合，其后的调用不再 prepare。
                                free.append(bridge)
                                pending[next_index] = (item, None, None, item.invalid)
                                stopped = True
                            else:
                                outcome = self._begin_dispatch(thread_id, item)
                                if outcome is None:
                                    pending[next_index] = (item, executor.submit(self._call_handler, item, bridge),
                                                           bridge, None)
                                else:
                                    free.append(bridge)
                                    pending[next_index] = (item, None, None, outcome)
                                    if self._blocked is not None:
                                        stopped = True
                            next_index += 1
                        if index >= next_index:
                            break
                        item, future, bridge, outcome = pending.pop(index)
                        if isinstance(item, ToolResultItem):
                            results.append(item)
                        else:
                            if future is not None:
                                outcome = future.result()
                                free.append(bridge)
                            results.append(self._finish_tool(thread_id, item, outcome))
                        if self._blocked is not None or self.cancelled():
                            stopped = True
                except BaseException:
                    # 异常前已 prepare 的调用：等待在途 handler 并按序收尾，不留孤儿 start，再原样传播。
                    for index in sorted(pending):
                        item, future, _bridge, outcome = pending.pop(index)
                        try:
                            if future is not None:
                                outcome = future.result()
                            if isinstance(item, _PreparedTool):
                                self._finish_tool(thread_id, item, outcome)
                        except Exception:
                            pass
                    raise
            if next_index < len(calls):
                # 与串行一致：拒绝 / 暂停 / 取消后未 prepare 的调用只经 `_skip_calls` 收尾。
                self._skip_calls(thread_id, calls[next_index:], batch_id,
                                 provider_continuation=provider_continuation if next_index == 0 else None,
                                 assistant_item_id=assistant_item_id)
            return results
        finally:
            for bridge in bridges:
                try:
                    bridge.cancel_event = None
                except Exception:
                    pass
                try:
                    self._parallel_bridge_close(bridge)
                except Exception:
                    pass

    # ---------- 历史重建 ----------

    def history(self, thread_id: str) -> tuple[ChatMessage, ...]:
        """从条目还原模型可见的历史。

        工具调用按「assistant(tool_use) + user(tool_result)」成对回放；
        `status=running` 的条目说明该轮未收尾，跳过。
        """
        if self.history_provider is not None:
            return self.history_provider(thread_id)
        return messages_from_items(self.sessions.read_items(thread_id))

    # ---------- 运行 ----------

    def run(self, thread_id: str, cancel: threading.Event | None = None) -> str:
        """跑一个回合，结束时发 thread/updated。

        `turn/started` 由入口负责发出（它才知道 turnId），这里只管回合本身。
        `cancel` 由调用方提供：同一个取消信号也要能被确定性的回合路径使用。
        返回值是这一轮的收尾状态：`completed` / `interrupted` / `blocked` / `error`。
        """
        if self.provider is None:
            raise RuntimeError("run() 需要已配置的 provider；无 provider 时请走确定性路径")
        max_model_requests = model_request_limit(self.max_model_requests)

        self._cancel = cancel or threading.Event()
        self.tool_bridge.cancel_event = self._cancel
        self._blocked = None
        self.last_preparation = None
        recovery_budget = ModelRecoveryBudget()

        try:
            messages = list(self.history(thread_id))
            specs = self.tool_specs()
            if type(self.request_offset) is not int or not 0 <= self.request_offset <= max_model_requests:
                raise ValueError("模型续接请求偏移超出配置上限")
            pending_steering: tuple[list[UserMessage], Callable[[], None]] | None = None
            overflow_retried = False
            for _round in range(self.request_offset, max_model_requests):
                if self.cancelled():
                    return "interrupted"

                staged = None
                if self.stage_steering is not None:
                    staged = pending_steering if pending_steering is not None else self.stage_steering()
                    pending_steering = None
                    messages.extend(staged[0])
                elif self.drain_steering is not None:
                    messages.extend(self.drain_steering())
                if self.context_check is not None:
                    self.context_check(messages, self.system_prompt)

                request = ModelRequest(
                    model=self.config.model,
                    system=self.system_prompt,
                    messages=tuple(messages),
                    tools=specs,
                    max_tokens=self.config.max_tokens,
                    effort=self.config.effort,
                    thinking=self.config.thinking,
                    recovery_budget=recovery_budget,
                )
                request_budget: dict[str, Any] = {}
                if self.request_preparer is not None:
                    try:
                        before = request
                        self.preparing_request_index = _round
                        request, request_budget = self.request_preparer(request)
                        messages = list(request.messages)
                        # A summary can take long enough for new steering to arrive.
                        # Catch up once, before consuming either batch or calling a model.
                        commits = [staged[1]] if staged is not None else []
                        if request.messages != before.messages and self.stage_steering is not None:
                            catch_up, commit = self.stage_steering()
                            if catch_up:
                                messages.extend(catch_up)
                                request = replace(request, messages=tuple(messages))
                                request, request_budget = self.request_preparer(request)
                                messages = list(request.messages)
                                commits.append(commit)
                    except ContextBudgetExceeded as exc:
                        self._record_preparation(thread_id, request, exc.budget)
                        if self.cancelled():
                            return "interrupted"
                        message = str(exc)
                        self.append_agent(thread_id, message)
                        self.notify(N_SESSION_ERROR, {"threadId": thread_id,
                            "code": "CONTEXT_BUDGET_EXCEEDED", "message": message})
                        return "blocked"
                    except ContextCompactionFailed as exc:
                        return self._context_failed(thread_id, exc)
                    except ModelRequestRejected as exc:
                        return self._request_rejected(thread_id, exc)
                    self._record_preparation(thread_id, request, request_budget)
                try:
                    request = check_model_request(self.lifecycle_hooks, self.config, request, request_budget,
                        purpose="turn", request_index=_round, cancel_event=self._cancel,
                        thread_id=thread_id, turn_id=self.turn_id, max_model_requests=max_model_requests)
                except ModelRequestRejected as exc:
                    return self._request_rejected(thread_id, exc)
                if self.cancelled():
                    return "interrupted"
                if self.request_preparer is not None:
                    for commit in commits:
                        commit()
                elif staged is not None:
                    staged[1]()
                self._record_phase("model_request", _round + 1)
                tool_batch_id = uuid.uuid4().hex[:12]
                assistant, error, interrupted, assistant_item_id = self._stream_round(
                    thread_id, request, tool_batch_id)

                if interrupted:
                    return "interrupted"

                if error is not None:
                    recovery_blocked = False
                    if (self.last_stream_recoverable and self.recover_context is not None and
                            not overflow_retried and _round + 1 < max_model_requests):
                        if recovery_budget.consume_retry(self._cancel):
                            overflow_retried = True
                            try:
                                replacement = self.recover_context(request)
                            except ContextCompactionFailed as exc:
                                return self._context_failed(thread_id, exc)
                            except ModelRequestRejected as exc:
                                return self._request_rejected(thread_id, exc)
                            if self.cancelled():
                                return "interrupted"
                            if replacement is not None:
                                messages = list(replacement.messages)
                                continue
                        else:
                            if self.cancelled():
                                return "interrupted"
                            recovery_blocked = True
                            error = f"{error}（共享模型恢复次数已用尽，未启动自动上下文恢复）"
                    self.append_agent(thread_id, f"模型调用失败：{error}")
                    details = {"threadId": thread_id, "message": error,
                               "outputObserved": self.last_stream_output_observed}
                    if self.last_stream_error is not None:
                        details["errorInfo"] = self.last_stream_error.event_payload()
                        if self.last_stream_error.code is not None:
                            details.update(code=self.last_stream_error.code,
                                           recoveryAttempted=overflow_retried,
                                           recoveryBlocked=recovery_blocked)
                    self.notify(N_SESSION_ERROR, details)
                    return "error"

                if assistant is None:
                    break

                calls = assistant.tool_calls()
                continuation = None
                if calls and self.config.provider == "anthropic":
                    try:
                        continuation = anthropic_continuation(assistant, assistant_item_id)
                    except ValueError:
                        message = "Anthropic 工具续接签名超过内核保存预算；本响应中的工具未执行。"
                        self.append_agent(thread_id, message)
                        self.notify(N_SESSION_ERROR, {
                            "threadId": thread_id,
                            "code": "PROVIDER_CONTINUATION_TOO_LARGE",
                            "message": message,
                        })
                        return "error"
                if assistant.stop_reason == "length":
                    code = "MODEL_OUTPUT_TRUNCATED"
                    recovery = "请检查请求并调整输出上限后，明确发起新回合；不会自动重试。"
                    self._skip_calls(thread_id, calls, tool_batch_id, error={
                        "code": code,
                        "message": "模型输出达到长度上限，工具参数可能不完整，该工具未执行",
                        "recovery_action": recovery,
                    }, provider_continuation=continuation, assistant_item_id=assistant_item_id)
                    message = "模型输出达到长度上限，本回合未正常完成；本次响应中的工具均未执行。\n\n恢复提示：" + recovery
                    self.append_agent(thread_id, message)
                    self.notify(N_SESSION_ERROR, {"threadId": thread_id, "code": code, "message": message})
                    return "error"
                if not calls:
                    # Only deliver steering when another model request can consume it.
                    if self.stage_steering is not None and _round + 1 < max_model_requests:
                        pending_steering = self.stage_steering()
                        if pending_steering[0]:
                            messages.append(assistant)
                            continue
                    steering = (self.drain_steering() if self.drain_steering is not None
                                and self.stage_steering is None and _round + 1 < max_model_requests else [])
                    if steering:
                        messages.append(assistant)
                        messages.extend(steering)
                        continue
                    return "completed"

                if len(calls) > MAX_TOOL_BATCH_CALLS:
                    self.append_agent(thread_id, "模型工具调用数量超过单批次持久化上限；本批操作均未执行。")
                    self.notify(N_SESSION_ERROR, {"threadId": thread_id,
                        "code": "TOOL_BATCH_LIMIT", "message": "模型工具调用数量超过单批次上限，本批操作均未执行。"})
                    return "error"

                request_fingerprint = (self.last_preparation[1].get("requestFingerprint")
                                       if self.last_preparation is not None else None)
                self.sessions.record_tool_batch(
                    thread_id, self.turn_id, tool_batch_id, [call.id for call in calls], "started",
                    assistant_item_id=assistant_item_id,
                    request_fingerprint=request_fingerprint if isinstance(request_fingerprint, str) else None)

                messages.append(assistant)
                results: list[ToolResultItem] = []
                batch_id = tool_batch_id
                self._record_phase("tool_execution", _round + 1)
                if self._parallel_batch_enabled(calls):
                    if self.cancelled():
                        self._skip_calls(thread_id, calls, batch_id, provider_continuation=continuation,
                                         assistant_item_id=assistant_item_id)
                        return "interrupted"
                    try:
                        results = self._execute_parallel_batch(thread_id, calls, batch_id, continuation,
                                                               assistant_item_id)
                    except _ParallelUnavailable:
                        # 首个独立工具桥不可用：尚无调用落库或启动，回到串行路径。
                        results = []
                    if results:
                        if self._blocked is not None:
                            result = self._blocked
                            code = (result.error or {}).get("code", "UNKNOWN")
                            recovery = (result.error or {}).get("recovery_action") or "请核对操作结果，处理后再明确发起下一步；不要自动重试。"
                            self.append_agent(thread_id, f"操作已暂停（{code}）：{summarize_result(result)}\n\n恢复提示：{recovery}")
                            return "blocked"
                        if self.cancelled():
                            # 仅当整批均已真实执行收尾（无 not_executed）时才记完成，供显式续接复用结果。
                            if len(results) == len(calls):
                                self.sessions.record_tool_batch(
                                    thread_id, self.turn_id, batch_id, [call.id for call in calls], "completed",
                                    assistant_item_id=assistant_item_id,
                                    request_fingerprint=request_fingerprint if isinstance(request_fingerprint, str) else None)
                            return "interrupted"
                if not results:
                    for index, call in enumerate(calls):
                        if self.cancelled():
                            self._skip_calls(thread_id, calls[index:], batch_id,
                                             provider_continuation=continuation if index == 0 else None,
                                             assistant_item_id=assistant_item_id)
                            return "interrupted"
                        results.append(
                            self.execute_tool(thread_id, call.name, dict(call.arguments), call.id, batch_id,
                                              continuation if index == 0 else None, assistant_item_id)
                        )
                        if self._blocked is not None:
                            self._skip_calls(thread_id, calls[index + 1:], batch_id,
                                             assistant_item_id=assistant_item_id)
                            result = self._blocked
                            code = (result.error or {}).get("code", "UNKNOWN")
                            recovery = (result.error or {}).get("recovery_action") or "请核对操作结果，处理后再明确发起下一步；不要自动重试。"
                            self.append_agent(thread_id, f"操作已暂停（{code}）：{summarize_result(result)}\n\n恢复提示：{recovery}")
                            return "blocked"
                        if self.cancelled():
                            if index + 1 < len(calls):
                                self._skip_calls(thread_id, calls[index + 1:], batch_id,
                                                 assistant_item_id=assistant_item_id)
                                return "interrupted"
                            self.sessions.record_tool_batch(
                                thread_id, self.turn_id, batch_id, [call.id for call in calls], "completed",
                                assistant_item_id=assistant_item_id,
                                request_fingerprint=request_fingerprint if isinstance(request_fingerprint, str) else None)
                            return "interrupted"
                self.sessions.record_tool_batch(
                    thread_id, self.turn_id, batch_id, [call.id for call in calls], "completed",
                    assistant_item_id=assistant_item_id,
                    request_fingerprint=request_fingerprint if isinstance(request_fingerprint, str) else None)
                messages.append(ToolResultsMessage(results=tuple(results)))

            message = (f"已达到模型调用上限（{max_model_requests} 次请求），本回合已暂停。"
                       "已执行的工具结果已保留；请核对后明确发起新回合，不会自动继续或重试。")
            self.append_agent(thread_id, message)
            self.notify(N_SESSION_ERROR, {"threadId": thread_id, "code": "TURN_ROUND_LIMIT", "message": message,
                                         "maxModelRequests": max_model_requests,
                                         "modelRequestCount": max_model_requests})
            return "blocked"
        finally:
            # 回合结束就丢弃本轮所有待决定审批，避免它们被后续回合误认领。
            with self._approval_lock:
                self._pending_approvals.clear()
            self._cancel = None
            self.tool_bridge.cancel_event = None
            self.notify(N_THREAD_UPDATED, {"threadId": thread_id})

    def _context_failed(self, thread_id: str, error: ContextCompactionFailed) -> str:
        if self.cancelled():
            return "interrupted"
        message = self.safe_error(error)
        self.append_agent(thread_id, message)
        self.notify(N_SESSION_ERROR, {"threadId": thread_id, "code": error.code, "message": message})
        return "blocked"

    def _request_rejected(self, thread_id: str, error: ModelRequestRejected) -> str:
        """Persist a terminal policy rejection without entering provider/recovery paths."""
        if self.cancelled():
            return "interrupted"
        message = self.safe_error(error)
        record_model_rejection(self.sessions, thread_id, error)
        self.append_agent(thread_id, f"模型请求已拒绝（{error.code}）：{message}")
        self.notify(N_SESSION_ERROR, {
            **error.context,
            "threadId": thread_id,
            "code": error.code,
            "message": message,
            "outputObserved": False,
            "requestRejected": True,
        })
        return "error"

    def _record_preparation(self, thread_id: str, request: ModelRequest, budget: dict[str, Any]) -> None:
        snapshot = {**budget, "provider": self.config.provider, "turnId": self.turn_id}
        self.sessions.append(thread_id, Entry(type="context_budget", payload=snapshot))
        self.last_preparation = (request, snapshot)

    def _skip_calls(self, thread_id: str, calls: tuple[ToolCallBlock, ...], batch_id: str,
                    *, error: dict[str, Any] | None = None,
                    provider_continuation: dict[str, Any] | None = None,
                    assistant_item_id: str | None = None) -> None:
        for index, call in enumerate(calls):
            entry = self.start_tool_call(thread_id, call.name, dict(call.arguments), call.id,
                batch_id=batch_id, provider_continuation=provider_continuation if index == 0 else None,
                tool_batch_assistant_item_id=assistant_item_id)
            result = ToolResult(ok=False, command=call.name, error=error or {
                "code": "NOT_EXECUTED", "message": "回合中断或平台暂停，该工具未执行"})
            self.finish_tool_call(thread_id, entry, call.name, result, call.id, execution_state="not_executed")

    def _stream_round(
        self, thread_id: str, request: ModelRequest, tool_batch_id: str
    ) -> tuple[AssistantMessage | None, str | None, bool, str | None]:
        """消费一轮事件流：文本增量实时发事件，返回 (最终消息, 错误说明, 是否被中断)。

        这里刻意不用 `for event in ...`：取消点必须落在**每次取事件之前**，所以手动推进迭代器，
        并在结束时关掉生成器。关掉这一下很关键——生成器里包着 HTTP 响应，中断时它会带着
        GeneratorExit 逐层退出，连接随之释放。
        """
        assert self.provider is not None
        entry: Entry | None = None
        chunks: list[str] = []
        thinking: list[str] = []
        text_blocks: dict[int, str] = {}
        thinking_blocks: dict[int, str] = {}
        output_budget = ResponseTextBudget()
        assistant: AssistantMessage | None = None
        interrupted = False
        error: str | None = None
        self.last_stream_error = None
        self.last_stream_recoverable = False
        self.last_stream_output_observed = False
        output_observed = False

        def ensure_entry() -> Entry:
            nonlocal entry
            if entry is None:
                entry = self.sessions.append(thread_id, Entry(type="item",
                    parent_id=self.sessions.last_entry_id(thread_id),
                    payload={"kind": "agentMessage", "text": "", "status": "running", "turnId": self.turn_id}))
                self.notify(N_ITEM_STARTED, {"threadId": thread_id, "itemId": entry.id, "kind": "agentMessage"})
            return entry

        stream = self.provider.stream(request)
        try:
            while True:
                if self.cancelled():
                    interrupted = True
                    break

                try:
                    event = next(stream)
                except StopIteration:
                    break

                if self.cancelled():
                    interrupted = True
                    break

                if event.type == "retry_start":
                    # 仅观测：不改变重试判定，也不写入会话条目；旧客户端可忽略或 opt-out。
                    self.notify(N_MODEL_RETRY_STARTED, {
                        "threadId": thread_id, "turnId": self.turn_id, "attempt": event.attempt,
                        "maxAttempts": event.max_attempts, "delayMs": event.delay_ms,
                        "errorMessage": event.error})
                    continue
                if event.type == "retry_end":
                    payload = {"threadId": thread_id, "turnId": self.turn_id, "attempt": event.attempt,
                               "success": event.reason == "success"}
                    if event.reason != "success":
                        payload["reason"] = "aborted" if event.reason == "aborted" else "error"
                        payload["finalError"] = event.error or "模型请求失败"
                    self.notify(N_MODEL_RETRY_ENDED, payload)
                    continue

                if event.type.startswith(("text_", "thinking_", "toolcall_")):
                    output_observed = True

                if event.type in ("thinking_start", "thinking_delta", "thinking_end"):
                    if event.delta:
                        try:
                            output_budget.account(("thinking", event.content_index), event.delta)
                        except OutputBudgetExceeded as exc:
                            error = str(exc)
                            break
                        thinking.append(event.delta)
                        thinking_blocks[event.content_index] = (
                            thinking_blocks.get(event.content_index, "") + event.delta
                        )
                        for delta in utf8_chunks(event.delta):
                            self.notify(N_AGENT_THINKING_DELTA, {
                                "threadId": thread_id, "itemId": ensure_entry().id, "delta": delta,
                            })
                    if event.type == "thinking_end":
                        try:
                            output_budget.reconcile(("thinking", event.content_index), event.text)
                        except OutputBudgetExceeded as exc:
                            error = str(exc)
                            break
                        previous = thinking_blocks.get(event.content_index, "")
                        thinking_blocks[event.content_index] = event.text
                        if not previous:
                            thinking.append(event.text)
                            for delta in utf8_chunks(event.text):
                                self.notify(N_AGENT_THINKING_DELTA, {
                                    "threadId": thread_id, "itemId": ensure_entry().id, "delta": delta,
                                })
                    continue
                if event.type == "text_delta":
                    try:
                        output_budget.account(("text", event.content_index), event.delta)
                    except OutputBudgetExceeded as exc:
                        error = str(exc)
                        break
                    chunks.append(event.delta)
                    text_blocks[event.content_index] = text_blocks.get(event.content_index, "") + event.delta
                    for delta in utf8_chunks(event.delta):
                        self.notify(N_AGENT_MESSAGE_DELTA, {
                            "threadId": thread_id, "itemId": ensure_entry().id, "delta": delta,
                        })
                elif event.type == "text_end":
                    try:
                        output_budget.reconcile(("text", event.content_index), event.text)
                    except OutputBudgetExceeded as exc:
                        error = str(exc)
                        break
                    previous = text_blocks.get(event.content_index, "")
                    text_blocks[event.content_index] = event.text
                    if not previous:
                        chunks.append(event.text)
                        for delta in utf8_chunks(event.text):
                            self.notify(N_AGENT_MESSAGE_DELTA, {
                                "threadId": thread_id, "itemId": ensure_entry().id, "delta": delta,
                            })
                elif event.type == "done":
                    candidate = event.message
                    try:
                        if candidate is not None:
                            final_parts = [
                                block.text if isinstance(block, TextBlock) else block.thinking
                                for block in candidate.blocks
                                if isinstance(block, (TextBlock, ThinkingBlock))
                            ]
                            if not any(isinstance(block, TextBlock) for block in candidate.blocks):
                                final_parts.extend(text_blocks.values())
                            if not any(isinstance(block, ThinkingBlock) for block in candidate.blocks):
                                final_parts.extend(thinking_blocks.values())
                            output_budget.reconcile_response(final_parts)
                    except OutputBudgetExceeded as exc:
                        error = str(exc)
                        break
                    assistant = candidate
                    output_observed = output_observed or bool(assistant and assistant.blocks)
                    if assistant is not None:
                        chunks = ([assistant.text()]
                                  if any(isinstance(block, TextBlock) for block in assistant.blocks)
                                  else [text_blocks[index] for index in sorted(text_blocks)])
                        thinking = ([block.thinking for block in assistant.blocks if isinstance(block, ThinkingBlock)]
                                    if any(isinstance(block, ThinkingBlock) for block in assistant.blocks)
                                    else [thinking_blocks[index] for index in sorted(thinking_blocks)])
                        if any(chunks) or any(thinking):
                            ensure_entry()
                    break
                elif event.type == "error":
                    error = self.safe_error(event.error or "未知错误")
                    info = getattr(event, "error_info", None)
                    if isinstance(info, ModelErrorInfo) and info.provider == self.config.provider:
                        self.last_stream_error = info
                        diagnostic = transport_diagnostic(info)
                        if diagnostic is not None:
                            error = f"{error}（传输诊断：{diagnostic}）"
                    break
        except Exception as exc:
            if self.cancelled():
                interrupted = True
            else:
                error = self.safe_error(exc)
        finally:
            close = getattr(stream, "close", None)
            if callable(close):
                try:
                    close()
                except Exception as exc:
                    if not self.cancelled():
                        error = self.safe_error(exc)
                        self.last_stream_error = None

        interrupted = interrupted or self.cancelled() or (assistant is not None and assistant.stop_reason == "aborted")
        if not interrupted and error is None and assistant is None:
            error = "模型流未返回完成事件，请重试"
        if assistant is not None and assistant.stop_reason == "error" and error is None:
            error = "模型返回失败状态"
        self.last_stream_recoverable = bool(
            not interrupted and error is not None and not output_observed and assistant is None and
            self.last_stream_error is not None and self.last_stream_error.code == "CONTEXT_OVERFLOW")
        self.last_stream_output_observed = output_observed
        if error is not None:
            self.sessions.append(thread_id, Entry(type="model_error", payload={
                "turnId": self.turn_id, "model": request.model, "provider": self.config.provider,
                "message": error, "errorInfo": asdict(self.last_stream_error) if self.last_stream_error else None,
                "outputObserved": output_observed, "contextRecoveryEligible": self.last_stream_recoverable}))
        if assistant is not None:
            usage_entry = {
                "turnId": self.turn_id, "model": request.model, "provider": self.config.provider,
                "stopReason": assistant.stop_reason,
                "usage": asdict(assistant.usage) if assistant.usage is not None else None,
                "eligible": (not interrupted and error is None and assistant.stop_reason not in {"aborted", "error"}
                             and assistant.usage is not None)}
            if self.last_preparation is not None:
                fingerprint = self.last_preparation[1].get("requestFingerprint")
                if isinstance(fingerprint, str):
                    usage_entry["requestFingerprint"] = fingerprint
                    usage_entry["messageCount"] = len(request.messages)
            self.sessions.append(thread_id, Entry(type="model_usage", payload=usage_entry))
        if entry is not None:
            if assistant is None:
                chunks = ["".join(text_blocks[index] for index in sorted(text_blocks))]
                thinking = ["".join(thinking_blocks[index] for index in sorted(thinking_blocks))]
            text = "".join(chunks)
            truncated = assistant is not None and assistant.stop_reason == "length"
            payload = {"kind": "agentMessage", "text": text, "thinking": "".join(thinking),
                       "revises": entry.id, "status": "failed" if interrupted or error or truncated else "completed",
                       "turnId": self.turn_id}
            if assistant is not None and assistant.tool_calls():
                payload["toolBatchId"] = tool_batch_id
            self.sessions.append(thread_id, Entry(type="item",
                parent_id=self.sessions.last_entry_id(thread_id), payload=payload))
            self.notify(N_ITEM_COMPLETED, {"threadId": thread_id, "itemId": entry.id, **payload})

        return assistant, error, interrupted, entry.id if entry is not None else None


def summarize_result(result: ToolResult, limit: int = 4000) -> str:
    """把工具结果压成一段可回填给模型、也可落库的文本。"""
    if result.ok:
        try:
            body = json.dumps(result.data, ensure_ascii=False)
        except TypeError:
            body = str(result.data)
        # Put page metadata before the potentially long data preview. A truncated
        # page must not look like the whole result set or hide an unknown total.
        page = "" if result.pagination is None else " pagination=" + json.dumps(result.pagination, ensure_ascii=False)
        return f"ok=true command={result.command}{page} data={body}"[:limit]
    code = (result.error or {}).get("code", "UNKNOWN")
    message = (result.error or {}).get("message", "")
    recovery = (result.error or {}).get("recovery_action") or ""
    return redact_secrets(f"ok=false command={result.command} code={code} message={message} recovery={recovery}")[:limit]


def tool_source(thread_id: str, entry: Entry, name: str) -> dict:
    return {"ref": f"tool:{thread_id}:{entry.id}", "tool": name, "queriedAt": entry.timestamp}


def model_result(result: ToolResult, *, source: dict | None = None, item_id: str | None = None,
                 max_bytes: int = DEFAULT_MODEL_TOOL_RESULT_BYTES) -> str:
    """Bound model-visible tool output while preserving the canonical result in session history."""
    payload = {"ok": result.ok, "command": result.command, "data": result.data,
               "pagination": result.pagination, "error": result.error, "hints": result.hints}
    return model_result_content(payload, item_id, source=source, max_bytes=max_bytes,
                                preview=summarize_result(result))
