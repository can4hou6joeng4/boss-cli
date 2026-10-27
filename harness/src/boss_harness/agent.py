"""模型驱动的回合执行器。

职责：把「一条用户输入」变成「一串协议事件 + 落库条目」。
- 历史重建：从会话条目还原 ChatMessage（含工具调用与其结果）；
- 工具回路：模型要调工具就执行、回填结果，再让模型继续，最多 MAX_TOOL_ROUNDS 次模型请求；
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
from dataclasses import asdict, dataclass, field, replace
from typing import Any

from boss_harness.context import ContextBudgetExceeded
from boss_harness.compaction import ContextCompactionFailed
from boss_harness.hooks import LifecycleHooks
from boss_harness.models import (
    AssistantMessage,
    ToolCallBlock,
    ToolResultItem,
    ToolResultsMessage,
    ToolSpec,
    UserMessage,
)
from boss_harness.models.provider import ModelConfig, Provider
from boss_harness.models.output_budget import OutputBudgetExceeded, ResponseTextBudget, utf8_chunks
from boss_harness.models.secret import redact_secrets
from boss_harness.models.types import ChatMessage, ModelRequest, ModelErrorInfo, TextBlock, ThinkingBlock
from boss_harness.session import Entry, SessionStore, ToolRevisionPersistenceError
from boss_harness.toolkit import ToolResult, snapshot_result
from boss_harness.tool_results import project_error, project_item

MAX_TOOL_ROUNDS = 6

#: 审批的默认等待上限（秒）。超时按未批准处理：无法安全判定时必须 fail closed。
DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300.0

#: 协议事件名（与 packages/protocol 的 ServerNotifications 对应）。
N_TURN_STARTED = "turn/started"
N_AGENT_MESSAGE_DELTA = "agentMessage/delta"
N_AGENT_THINKING_DELTA = "agentThinking/delta"
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


@dataclass
class _ApprovalWait:
    """一次待决定的审批。`event` 负责唤醒等待方，`decision` 是用户的裁决。"""

    event: threading.Event = field(default_factory=threading.Event)
    decision: str | None = None
    deadline: float = float("inf")


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
        validate_arguments: Callable[[str, dict[str, Any]], None] | None = None,
        pause_on_result: Callable[[ToolResult], bool] | None = None,
        history_provider: Callable[[str], tuple[ChatMessage, ...]] | None = None,
        context_check: Callable[[list[ChatMessage], str], None] | None = None,
        drain_steering: Callable[[], list[UserMessage]] | None = None,
        stage_steering: Callable[[], tuple[list[UserMessage], Callable[[], None]]] | None = None,
        request_preparer: Callable[[ModelRequest], tuple[ModelRequest, dict[str, Any]]] | None = None,
        recover_context: Callable[[ModelRequest], ModelRequest | None] | None = None,
        lifecycle_hooks: LifecycleHooks | None = None,
        persistence_fence: Callable[[str], None] | None = None,
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
        self.context_abort: Callable[[], None] | None = None
        self.last_stream_error: ModelErrorInfo | None = None
        self.last_stream_recoverable = False
        self.last_stream_output_observed = False
        self.preparing_request_index: int | None = None

    @property
    def tool_names(self) -> list[str]:
        return [tool.name for tool in self._tools]

    def tool_specs(self) -> tuple[ToolSpec, ...]:
        return self._tools

    # ---------- 中断与审批 ----------

    def interrupt(self) -> None:
        """请求取消当前回合。会在下一个取消点生效，并顺带打断卡住的流。"""
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

    def resolve_approval(self, approval_id: str, approved: bool) -> bool:
        """落下一次审批裁决；返回 False 表示这个 id 不认得（已过期或不存在）。"""
        with self._approval_lock:
            wait = self._pending_approvals.get(approval_id)
            if (wait is None or wait.decision is not None or self.cancelled()
                    or time.monotonic() >= wait.deadline):
                return False
            wait.decision = "approve" if approved else "deny"
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
            if self.cancelled():
                return "expired"
            remaining = wait.deadline - time.monotonic()
            if remaining <= 0:
                return "expired"
            if wait.event.wait(min(0.2, remaining)):
                return wait.decision or "deny"

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
        if approval is not None and phase in {"approved", "not_approved"}:
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
            "modelResult": model_result(result, source=source),
        }
        if approval is not None:
            payload["approval"] = approval
        revision = Entry(type="item", parent_id=self.sessions.last_entry_id(thread_id), payload=payload)
        _, recovered = self.sessions.append_tool_revision(thread_id, revision)
        # The model and rollout keep the complete result. Observers get a bounded
        # projection and a content-addressed route to retrieve an omitted body.
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
        batch_id: str | None = None,
    ) -> ToolResultItem:
        """执行一个工具：审批闸门 -> 落库 + 发事件 -> 返回给模型的结果块。

        闸门对应 Pi 的 `beforeToolCall`（它可以阻断一次调用）：被拒绝的调用不执行，
        而是以 `is_error` 的工具结果回填给模型，让模型知道没被批准，而不是静默跳过。
        """
        approval: dict[str, Any] | None = None
        invalid: ToolResult | None = None
        try:
            if self.validate_arguments is not None:
                self.validate_arguments(name, arguments)
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
                "consequential": True,
                "deadline": time.time() + self.approval_timeout,
            }
            with self._approval_lock:
                self._pending_approvals[approval["approvalId"]] = _ApprovalWait(
                    deadline=time.monotonic() + self.approval_timeout)

        entry = self.start_tool_call(thread_id, name, arguments, call_id, approval, batch_id)

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
                self._pending_approvals.pop(approval["approvalId"], None)
            approval["decision"] = decision
            # Persist consent before any side effect. A restart never consumes it again.
            self._tool_phase(thread_id, entry, "approved" if decision == "approve" else "not_approved", approval)
            if decision != "approve":
                message = "用户拒绝了这个操作" if decision == "deny" else "审批超时，按未批准处理"
                denied = ToolResult(
                    ok=False, command=name, error={"code": "NOT_APPROVED", "message": message}
                )
                self.finish_tool_call(thread_id, entry, name, denied, call_id, approval)
                return ToolResultItem(
                    tool_call_id=call_id or entry.id,
                    content=model_result(denied, source=tool_source(thread_id, entry, name)),
                    is_error=True,
                )

        handler = self.handlers.get(name)
        dispatched = False
        dispatch_persistence_failed = False
        if self.cancelled():
            cancelled_before_dispatch = True
            result = ToolResult(ok=False, command=name, error={"code": "CANCELLED", "message": "操作已取消，未执行工具"})
        elif invalid is not None:
            cancelled_before_dispatch = False
            result = invalid
        elif handler is None:
            cancelled_before_dispatch = False
            result = ToolResult(ok=False, command=name, error={"code": "NOT_SUPPORTED", "message": f"未知工具 {name}"})
        else:
            cancelled_before_dispatch = False
            try:
                self._tool_phase(thread_id, entry, "executing", approval)
                dispatched = True
                result = snapshot_result(handler(self.tool_bridge, arguments))
            except Exception as exc:
                if dispatched:
                    result = ToolResult(ok=False, command=name, error={"code": "TOOL_ERROR", "message": self.safe_error(exc)})
                else:
                    dispatch_persistence_failed = True
                    result = ToolResult(ok=False, command=name, error={
                        "code": "SESSION_PERSISTENCE_ERROR",
                        "message": "执行状态未能持久化，工具未派发；请检查会话状态后再继续",
                    })
                    self._blocked = result
        pause = False
        if not result.ok and self.pause_on_result is not None:
            try:
                pause = self.pause_on_result(snapshot_result(result))
                if type(pause) is not bool:
                    raise ValueError
            except Exception:
                result = ToolResult(ok=False, command=name, error={"code": "TOOL_ERROR", "message": "工具暂停策略回调失败"})
                pause = True
        if policy_denied:
            self._blocked = result
        if not result.ok and (pause
                              or (name in self.approval_required and (result.error or {}).get("code") not in {"INVALID_PARAM", "CANCELLED"})):
            self._blocked = result
        unknown = (dispatched and name in self.approval_required and not result.ok
                   and (result.error or {}).get("code") in {
                       "CANCELLED", "TOOL_TIMEOUT", "TOOL_ERROR", "CLI_ERROR", "CLI_CONTRACT_ERROR", "CLI_OUTPUT_LIMIT", "INVALID_ENVELOPE",
                       "GREET_RESULT_UNKNOWN", "ACTION_UNCONFIRMED"})
        try:
            recovered_persistence = self.finish_tool_call(thread_id, entry, name, result, call_id, approval,
                "not_executed" if policy_denied or dispatch_persistence_failed or cancelled_before_dispatch
                else "outcome_unknown" if unknown else None)
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
                content=model_result(result, source=tool_source(thread_id, entry, name)), is_error=not result.ok)
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
                    content=model_result(uncertain, source=tool_source(thread_id, entry, name)), is_error=True)
            try:
                self.finish_tool_call(thread_id, entry, name, uncertain, call_id, approval,
                                      "outcome_unknown")
            except ToolCompletionNotificationError:
                pass
            except ToolRevisionPersistenceError:
                if self.persistence_fence is not None:
                    self.persistence_fence(thread_id)
            return ToolResultItem(tool_call_id=call_id or entry.id,
                content=model_result(uncertain, source=tool_source(thread_id, entry, name)), is_error=True)
        return ToolResultItem(
            tool_call_id=call_id or entry.id,
            content=model_result(result, source=tool_source(thread_id, entry, name)),
            is_error=not result.ok,
        )

    # ---------- 历史重建 ----------

    def history(self, thread_id: str) -> tuple[ChatMessage, ...]:
        """从条目还原模型可见的历史。

        工具调用按「assistant(tool_use) + user(tool_result)」成对回放；
        `status=running` 的条目说明该轮未收尾，跳过。
        """
        if self.history_provider is not None:
            return self.history_provider(thread_id)
        messages: list[ChatMessage] = []
        pending: list[tuple[str, dict[str, Any]]] = []
        pending_batch: str | None = None

        def flush_tools() -> None:
            if not pending:
                return
            messages.append(AssistantMessage(blocks=tuple(
                ToolCallBlock(id=call_id, name=info["name"], arguments=info["arguments"])
                for call_id, info in pending)))
            messages.append(ToolResultsMessage(results=tuple(
                ToolResultItem(tool_call_id=call_id, content=info["summary"], is_error=info["is_error"])
                for call_id, info in pending)))
            pending.clear()

        for payload in self.sessions.read_items(thread_id):
            kind = payload.get("kind")
            batch = payload.get("toolBatchId")
            if kind != "toolCall" or (pending and batch != pending_batch):
                flush_tools()
            if kind == "userMessage":
                messages.append(UserMessage(text=str(payload.get("text", ""))))
            elif kind == "agentMessage":
                text = str(payload.get("text", ""))
                if text and payload.get("status") != "running":
                    messages.append(AssistantMessage(blocks=(TextBlock(text=text),)))
            elif kind == "toolCall" and payload.get("status") != "running":
                pending_batch = batch
                call_id = str(payload.get("toolCallId") or payload.get("id"))
                pending.append(
                    (
                        call_id,
                        {
                            "name": str(payload.get("toolName", "")),
                            "arguments": dict(payload.get("toolArguments") or {}),
                            "summary": str(payload.get("modelResult") or payload.get("resultSummary", "")),
                            "is_error": payload.get("status") == "failed",
                        },
                    )
                )

        flush_tools()
        return tuple(messages)

    # ---------- 运行 ----------

    def run(self, thread_id: str, cancel: threading.Event | None = None) -> str:
        """跑一个回合，结束时发 thread/updated。

        `turn/started` 由入口负责发出（它才知道 turnId），这里只管回合本身。
        `cancel` 由调用方提供：同一个取消信号也要能被确定性的回合路径使用。
        返回值是这一轮的收尾状态：`completed` / `interrupted` / `blocked` / `error`。
        """
        if self.provider is None:
            raise RuntimeError("run() 需要已配置的 provider；无 provider 时请走确定性路径")

        self._cancel = cancel or threading.Event()
        self.tool_bridge.cancel_event = self._cancel
        self._blocked = None
        self.last_preparation = None

        try:
            messages = list(self.history(thread_id))
            specs = self.tool_specs()
            pending_steering: tuple[list[UserMessage], Callable[[], None]] | None = None
            overflow_retried = False
            for _round in range(MAX_TOOL_ROUNDS):
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
                )
                if self.request_preparer is not None:
                    try:
                        before = request
                        self.preparing_request_index = _round
                        request, budget = self.request_preparer(request)
                        messages = list(request.messages)
                        # A summary can take long enough for new steering to arrive.
                        # Catch up once, before consuming either batch or calling a model.
                        commits = [staged[1]] if staged is not None else []
                        if request.messages != before.messages and self.stage_steering is not None:
                            catch_up, commit = self.stage_steering()
                            if catch_up:
                                messages.extend(catch_up)
                                request = replace(request, messages=tuple(messages))
                                request, budget = self.request_preparer(request)
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
                    self._record_preparation(thread_id, request, budget)
                if self.cancelled():
                    return "interrupted"
                if self.request_preparer is not None:
                    for commit in commits:
                        commit()
                elif staged is not None:
                    staged[1]()
                assistant, error, interrupted = self._stream_round(thread_id, request)

                if interrupted:
                    return "interrupted"

                if error is not None:
                    if (self.last_stream_recoverable and self.recover_context is not None and
                            not overflow_retried and _round + 1 < MAX_TOOL_ROUNDS):
                        overflow_retried = True
                        try:
                            replacement = self.recover_context(request)
                        except ContextCompactionFailed as exc:
                            return self._context_failed(thread_id, exc)
                        if self.cancelled():
                            return "interrupted"
                        if replacement is not None:
                            messages = list(replacement.messages)
                            continue
                    self.append_agent(thread_id, f"模型调用失败：{error}")
                    details = {"threadId": thread_id, "message": error,
                               "outputObserved": self.last_stream_output_observed}
                    if self.last_stream_error is not None:
                        details["errorInfo"] = self.last_stream_error.event_payload()
                        if self.last_stream_error.code is not None:
                            details.update(code=self.last_stream_error.code,
                                           recoveryAttempted=overflow_retried)
                    self.notify(N_SESSION_ERROR, details)
                    return "error"

                if assistant is None:
                    break

                calls = assistant.tool_calls()
                if assistant.stop_reason == "length":
                    code = "MODEL_OUTPUT_TRUNCATED"
                    recovery = "请检查请求并调整输出上限后，明确发起新回合；不会自动重试。"
                    self._skip_calls(thread_id, calls, uuid.uuid4().hex[:12], error={
                        "code": code,
                        "message": "模型输出达到长度上限，工具参数可能不完整，该工具未执行",
                        "recovery_action": recovery,
                    })
                    message = "模型输出达到长度上限，本回合未正常完成；本次响应中的工具均未执行。\n\n恢复提示：" + recovery
                    self.append_agent(thread_id, message)
                    self.notify(N_SESSION_ERROR, {"threadId": thread_id, "code": code, "message": message})
                    return "error"
                if not calls:
                    # Only deliver steering when another model request can consume it.
                    if self.stage_steering is not None and _round + 1 < MAX_TOOL_ROUNDS:
                        pending_steering = self.stage_steering()
                        if pending_steering[0]:
                            messages.append(assistant)
                            continue
                    steering = (self.drain_steering() if self.drain_steering is not None
                                and self.stage_steering is None and _round + 1 < MAX_TOOL_ROUNDS else [])
                    if steering:
                        messages.append(assistant)
                        messages.extend(steering)
                        continue
                    return "completed"

                messages.append(assistant)
                results: list[ToolResultItem] = []
                batch_id = uuid.uuid4().hex[:12]
                for index, call in enumerate(calls):
                    if self.cancelled():
                        self._skip_calls(thread_id, calls[index:], batch_id)
                        return "interrupted"
                    results.append(
                        self.execute_tool(thread_id, call.name, dict(call.arguments), call.id, batch_id)
                    )
                    if self._blocked is not None:
                        self._skip_calls(thread_id, calls[index + 1:], batch_id)
                        result = self._blocked
                        code = (result.error or {}).get("code", "UNKNOWN")
                        recovery = (result.error or {}).get("recovery_action") or "请核对操作结果，处理后再明确发起下一步；不要自动重试。"
                        self.append_agent(thread_id, f"操作已暂停（{code}）：{summarize_result(result)}\n\n恢复提示：{recovery}")
                        return "blocked"
                    if self.cancelled():
                        self._skip_calls(thread_id, calls[index + 1:], batch_id)
                        return "interrupted"
                messages.append(ToolResultsMessage(results=tuple(results)))

            message = (f"已达到模型调用上限（{MAX_TOOL_ROUNDS} 次请求），本回合已暂停。"
                       "已执行的工具结果已保留；请核对后明确发起新回合，不会自动继续或重试。")
            self.append_agent(thread_id, message)
            self.notify(N_SESSION_ERROR, {"threadId": thread_id, "code": "TURN_ROUND_LIMIT", "message": message})
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

    def _record_preparation(self, thread_id: str, request: ModelRequest, budget: dict[str, Any]) -> None:
        snapshot = {**budget, "provider": self.config.provider, "turnId": self.turn_id}
        self.sessions.append(thread_id, Entry(type="context_budget", payload=snapshot))
        self.last_preparation = (request, snapshot)

    def _skip_calls(self, thread_id: str, calls: tuple[ToolCallBlock, ...], batch_id: str,
                    *, error: dict[str, Any] | None = None) -> None:
        for call in calls:
            entry = self.start_tool_call(thread_id, call.name, dict(call.arguments), call.id, batch_id=batch_id)
            result = ToolResult(ok=False, command=call.name, error=error or {
                "code": "NOT_EXECUTED", "message": "回合中断或平台暂停，该工具未执行"})
            self.finish_tool_call(thread_id, entry, call.name, result, call.id, execution_state="not_executed")

    def _stream_round(
        self, thread_id: str, request: ModelRequest
    ) -> tuple[AssistantMessage | None, str | None, bool]:
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
            self.sessions.append(thread_id, Entry(type="item",
                parent_id=self.sessions.last_entry_id(thread_id), payload=payload))
            self.notify(N_ITEM_COMPLETED, {"threadId": thread_id, "itemId": entry.id, **payload})

        return assistant, error, interrupted


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


def model_result(result: ToolResult, *, source: dict | None = None) -> str:
    """Keep the structured envelope for context; the UI summary is a separate field."""
    return json.dumps({"ok": result.ok, "command": result.command, "data": result.data,
                       "pagination": result.pagination, "error": result.error, "hints": result.hints,
                       **({"source": source} if source else {})}, ensure_ascii=False, allow_nan=False)
