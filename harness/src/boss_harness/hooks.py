"""Explicit, bounded lifecycle hooks for embedded kernel hosts.

The hook boundary is deliberately smaller than Pi's interactive extension
runtime.  Hosts may observe durable events and deny a tool call before the
existing approval gate, but hooks cannot add tools, approve operations, or
rewrite persisted facts.  Hooks are injected by the embedding application;
this module never scans or imports files from a workspace.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
import math
import re
import queue
import threading
import time
from types import MappingProxyType
from typing import Any, Callable

from boss_harness.models.secret import redact_secrets


MAX_HOOK_TIMEOUT_SECONDS = 30.0
DEFAULT_HOOK_TIMEOUT_SECONDS = 0.25
MAX_PENDING_EVENTS = 256
MAX_CONTEXT_STRING = 16_384
MAX_CONTEXT_KEYS = 64
MAX_CONTEXT_ITEMS = 128
MAX_CONTEXT_DEPTH = 6
_HOOK_FAILED = object()


@dataclass(frozen=True)
class HookDecision:
    """A before-tool hook may only deny; approval remains a separate gate."""

    allow: bool
    code: str = "HOOK_DENIED"
    message: str = "工具调用被内核生命周期策略拒绝"

    def __post_init__(self) -> None:
        if type(self.allow) is not bool:
            raise ValueError("HookDecision.allow 必须是布尔值")
        if not isinstance(self.code, str) or re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", self.code) is None:
            raise ValueError("HookDecision.code 无效")
        if not isinstance(self.message, str) or not self.message or len(self.message) > 1_024:
            raise ValueError("HookDecision.message 无效")


def _safe_value(value: Any, *, depth: int = 0) -> Any:
    """Copy a bounded, read-only-safe view of hook context data."""
    if depth >= MAX_CONTEXT_DEPTH:
        return "<omitted:depth>"
    if isinstance(value, str):
        return redact_secrets(value[:MAX_CONTEXT_STRING])
    if value is None or isinstance(value, (bool, int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return "<omitted:number>"
        return value
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= MAX_CONTEXT_KEYS:
                result["<omitted:keys>"] = f"{len(value) - MAX_CONTEXT_KEYS} more"
                break
            if not isinstance(key, str):
                continue
            result[key[:128]] = _safe_value(item, depth=depth + 1)
        return result
    if isinstance(value, (list, tuple)):
        result = [_safe_value(item, depth=depth + 1) for item in value[:MAX_CONTEXT_ITEMS]]
        if len(value) > MAX_CONTEXT_ITEMS:
            result.append(f"<omitted:items:{len(value) - MAX_CONTEXT_ITEMS}>")
        return result
    return redact_secrets(str(value)[:MAX_CONTEXT_STRING])


def freeze_context(value: Mapping[str, Any]) -> Mapping[str, Any]:
    """Return a bounded copy; hooks must treat it as immutable by contract."""
    def freeze(item: Any) -> Any:
        if isinstance(item, dict):
            return MappingProxyType({key: freeze(value) for key, value in item.items()})
        if isinstance(item, list):
            return tuple(freeze(value) for value in item)
        return item

    return freeze(_safe_value(dict(value)))


@dataclass(frozen=True)
class HookFailure:
    hook: str
    phase: str
    event: str | None
    code: str
    message: str
    timed_out: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "hook": self.hook,
            "phase": self.phase,
            "event": self.event,
            "code": self.code,
            "message": self.message,
            "timedOut": self.timed_out,
        }


class LifecycleHooks:
    """Dispatch explicit host hooks without making them part of kernel state.

    Supported optional methods on each supplied object are:

    ``on_event(context)``
        Observe every durable event after it is persisted.
    ``before_tool_call(context) -> HookDecision | None``
        Deny a tool call before approval or handler dispatch.  Returning
        ``HookDecision(allow=True)`` is only an observation; it never bypasses
        the normal approval policy.
    ``close()``
        Release host resources after all kernel workers have stopped.

    Event observations use a bounded, ordered queue and never run under the
    event/RPC locks. Policy checks run in daemon threads with a bounded join.
    A timed out callback may finish later, but cannot hold a kernel lock; its
    late return is ignored and never changes a turn result.
    """

    def __init__(
        self,
        hooks: Iterable[Any] | None = None,
        *,
        timeout: float = DEFAULT_HOOK_TIMEOUT_SECONDS,
        error_sink: Callable[[HookFailure], None] | None = None,
    ) -> None:
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= MAX_HOOK_TIMEOUT_SECONDS:
            raise ValueError("hook timeout 必须大于 0 且不超过 30 秒")
        if hooks is None:
            values: tuple[Any, ...] = ()
        else:
            try:
                values = tuple(hooks)
            except TypeError:
                raise ValueError("lifecycle_hooks 必须是可迭代对象") from None
        for hook in values:
            if not any(callable(getattr(hook, name, None)) for name in ("on_event", "before_tool_call", "close")):
                raise ValueError("生命周期 hook 至少提供 on_event、before_tool_call 或 close")
        self._hooks = values
        self.timeout = float(timeout)
        self._error_sink = error_sink
        self._lock = threading.Condition(threading.RLock())
        self._active = 0
        self._closing = False
        self._closed = False
        self._dropped_events = 0
        self._event_queue: queue.Queue[tuple[str, dict[str, Any]] | None] = queue.Queue(MAX_PENDING_EVENTS)
        self._event_worker: threading.Thread | None = None
        if any(callable(getattr(hook, "on_event", None)) for hook in self._hooks):
            self._event_worker = threading.Thread(target=self._drain_events, name="boss-lifecycle-events", daemon=True)
            self._event_worker.start()

    @property
    def enabled(self) -> bool:
        return bool(self._hooks)

    @property
    def observes_events(self) -> bool:
        return self._event_worker is not None

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    def set_error_sink(self, sink: Callable[[HookFailure], None] | None) -> None:
        with self._lock:
            self._error_sink = sink

    @staticmethod
    def _name(hook: Any) -> str:
        return f"{type(hook).__module__}.{type(hook).__qualname__}"

    def _failure(self, hook: Any, phase: str, event: str | None, code: str, message: str,
                 *, timed_out: bool = False) -> None:
        failure = HookFailure(self._name(hook), phase, event, code, redact_secrets(message)[:1_024], timed_out)
        sink = None
        with self._lock:
            sink = self._error_sink
        if sink is not None:
            try:
                sink(failure)
            except Exception:
                # Diagnostics must never replace the primary kernel result.
                pass

    def _invoke(self, hook: Any, method: str, context: Mapping[str, Any] | None,
                *, event: str | None = None, deadline: float | None = None) -> Any:
        callback = getattr(hook, method, None)
        if not callable(callback):
            return None
        timeout = self.timeout
        if deadline is not None:
            timeout = min(timeout, max(0.0, deadline - time.monotonic()))
        if timeout <= 0:
            self._failure(hook, method, event, "HOOK_TIMEOUT", "生命周期 hook 未能在关闭期限内开始", timed_out=True)
            return _HOOK_FAILED
        with self._lock:
            if self._closed or (self._closing and method == "before_tool_call"):
                return None
            self._active += 1
        result: list[Any] = []
        error: list[BaseException] = []
        finished = threading.Event()

        def run() -> None:
            try:
                result.append(callback(freeze_context(context or {})) if method != "close" else callback())
            except BaseException as exc:  # Hook code is trusted but isolated from the kernel.
                error.append(exc)
            finally:
                with self._lock:
                    self._active -= 1
                    self._lock.notify_all()
                finished.set()

        thread = threading.Thread(target=run, name=f"boss-hook-{method}", daemon=True)
        try:
            thread.start()
        except Exception as exc:
            with self._lock:
                self._active -= 1
                self._lock.notify_all()
            self._failure(hook, method, event, "HOOK_START_FAILED", str(exc))
            return _HOOK_FAILED
        if not finished.wait(timeout):
            self._failure(hook, method, event, "HOOK_TIMEOUT", "生命周期 hook 超时", timed_out=True)
            return _HOOK_FAILED
        if error:
            self._failure(hook, method, event, "HOOK_ERROR", str(error[0]))
            return _HOOK_FAILED
        return result[0] if result else None

    @staticmethod
    def _event_projection(method: str, params: Mapping[str, Any] | None) -> dict[str, Any]:
        visible = {"threadId", "turnId", "itemId", "queueId", "jobId", "status", "code",
                   "reason", "origin", "kind", "toolName", "model", "provider", "effort",
                   "state", "aborted", "active", "eventCursor", "eventId", "recoveryAction"}
        source = dict(params or {})
        projected = {key: source[key] for key in visible if key in source}
        return {"phase": "event", "event": method, "params": _safe_value(projected)}

    def observe_event(self, method: str, params: Mapping[str, Any] | None) -> None:
        if self._event_worker is None:
            return
        with self._lock:
            if self._closing or self._closed:
                return
            try:
                self._event_queue.put_nowait((method, self._event_projection(method, params)))
            except queue.Full:
                self._dropped_events += 1

    def _report_dropped_events(self) -> None:
        with self._lock:
            count, self._dropped_events = self._dropped_events, 0
            hook = next((item for item in self._hooks if callable(getattr(item, "on_event", None))), self)
        if count:
            self._failure(hook, "on_event", None, "HOOK_EVENT_DROPPED",
                          f"生命周期事件队列已满；累计丢弃 {count} 个观察事件")

    def _drain_events(self) -> None:
        while True:
            with self._lock:
                closing = self._closing
            if closing and self._event_queue.empty():
                self._report_dropped_events()
                return
            try:
                record = self._event_queue.get(timeout=0.05)
            except queue.Empty:
                if self._event_queue.empty():
                    self._report_dropped_events()
                continue
            try:
                if record is None:
                    return
                method, context = record
                for hook in self._hooks:
                    self._invoke(hook, "on_event", context, event=method)
            finally:
                self._event_queue.task_done()
                with self._lock:
                    self._lock.notify_all()

    def before_tool_call(self, context: Mapping[str, Any]) -> HookDecision | None:
        if not self._hooks:
            return None
        event = "toolCall/before"
        for hook in self._hooks:
            if not callable(getattr(hook, "before_tool_call", None)):
                continue
            result = self._invoke(hook, "before_tool_call", {"phase": "before_tool_call", **dict(context)}, event=event)
            if result is _HOOK_FAILED:
                return HookDecision(False, "HOOK_ERROR", "内核策略 hook 未能完成；为避免执行未核对的工具，当前回合已暂停")
            if result is None:
                continue
            if not isinstance(result, HookDecision):
                self._failure(hook, "before_tool_call", event, "HOOK_RESULT_INVALID", "before_tool_call 必须返回 HookDecision 或 None")
                return HookDecision(False, "HOOK_RESULT_INVALID", "内核策略 hook 返回了无效结果；当前回合已暂停")
            if not result.allow:
                return result
        return None

    def close(self, deadline: float | None = None) -> None:
        end = time.monotonic() + self.timeout if deadline is None else deadline
        with self._lock:
            if self._closed:
                return
            if self._closing:
                while not self._closed and time.monotonic() < end:
                    self._lock.wait(max(0.0, end - time.monotonic()))
                return
            self._closing = True
            while (self._active or not self._event_queue.empty()) and time.monotonic() < end:
                self._lock.wait(max(0.0, end - time.monotonic()))
            hooks = self._hooks
            active = self._active or not self._event_queue.empty()
            event_worker = self._event_worker
        if event_worker is not None:
            event_worker.join(max(0.0, end - time.monotonic()))
        with self._lock:
            active = bool(self._active or not self._event_queue.empty())
        if event_worker is not None:
            active = active or event_worker.is_alive()
        if active:
            for hook in hooks:
                self._failure(hook, "close", "kernel/shutdown", "HOOK_TIMEOUT", "生命周期 hook 未能在关闭期限内收尾", timed_out=True)
        else:
            for hook in hooks:
                self._invoke(hook, "close", None, event="kernel/shutdown", deadline=end)
        with self._lock:
            self._closed = True
            self._lock.notify_all()
