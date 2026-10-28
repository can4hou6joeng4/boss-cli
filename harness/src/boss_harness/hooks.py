"""Explicit, bounded lifecycle hooks for embedded kernel hosts.

The hook boundary is deliberately smaller than Pi's interactive extension
runtime.  Hosts may observe durable events, deny model requests, and deny a tool
call before the existing approval gate, but hooks cannot add tools, approve operations, or
rewrite persisted facts.  Hooks are injected by the embedding application;
this module never scans or imports files from a workspace.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
import inspect
import json
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
MAX_ACTIVE_HOOK_CALLBACKS = 16
HOOK_BUSY_DIAGNOSTIC_INTERVAL_SECONDS = 1.0
MAX_CONTEXT_STRING = 16_384
MAX_CONTEXT_KEYS = 64
MAX_CONTEXT_ITEMS = 128
MAX_CONTEXT_DEPTH = 6
# Leave room for the hook envelope around tool arguments (schema payloads cap at 1 MiB).
MAX_POLICY_CONTEXT_BYTES = 1_052_672
# Leave room for envelope fields/nesting beyond the bounded tool-argument JSON tree.
MAX_POLICY_CONTEXT_NODES = 32_784
MAX_POLICY_CONTEXT_DEPTH = 66
_HOOK_FAILED = object()
_HOOK_BUSY = object()
_HOOK_CONTEXT_TOO_LARGE = object()
_HOOK_CONTEXT_INVALID = object()
_HOOK_CANCELLED = object()
_HOOK_CLOSED = object()


class HookCancellationSignal:
    """Read-only view of the active turn's cooperative cancellation signal."""

    __slots__ = ("__event",)

    def __init__(self, event: threading.Event) -> None:
        self.__event = event

    @property
    def aborted(self) -> bool:
        return self.__event.is_set()

    def wait(self, timeout: float | None = None) -> bool:
        return self.__event.wait(timeout)


def _signal_mode(callback: Callable[..., Any]) -> str | None:
    try:
        parameters = inspect.signature(callback).parameters
    except (TypeError, ValueError):
        return None
    signal = parameters.get("signal")
    if signal is not None:
        if signal.kind == inspect.Parameter.POSITIONAL_ONLY:
            return "positional"
        if signal.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY):
            return "keyword"
        return None
    return "keyword" if any(item.kind == inspect.Parameter.VAR_KEYWORD for item in parameters.values()) else None


@dataclass(frozen=True)
class HookDecision:
    """A policy hook may only deny; approval remains a separate gate."""

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


class _PolicyContextError(ValueError):
    def __init__(self, code: str) -> None:
        self.code = code


def freeze_policy_context(value: Mapping[str, Any]) -> Mapping[str, Any]:
    """Copy complete JSON policy input or reject it; never pass a partial view."""
    size = 0
    nodes = 0
    active: set[int] = set()

    def account(amount: int) -> None:
        nonlocal size
        size += amount
        if size > MAX_POLICY_CONTEXT_BYTES:
            raise _PolicyContextError("HOOK_CONTEXT_TOO_LARGE")

    def account_json_string(text: str) -> None:
        # Count compact ensure_ascii=False JSON bytes without allocating an escaped copy.
        account(2)
        for character in text:
            codepoint = ord(character)
            if character in ('"', "\\", "\b", "\t", "\n", "\f", "\r"):
                amount = 2
            elif codepoint < 0x20:
                amount = 6
            elif 0xD800 <= codepoint <= 0xDFFF:
                raise _PolicyContextError("HOOK_CONTEXT_INVALID")
            elif codepoint <= 0x7F:
                amount = 1
            elif codepoint <= 0x7FF:
                amount = 2
            elif codepoint <= 0xFFFF:
                amount = 3
            else:
                amount = 4
            account(amount)

    def copy(item: Any, depth: int = 0) -> Any:
        nonlocal nodes
        nodes += 1
        if depth > MAX_POLICY_CONTEXT_DEPTH or nodes > MAX_POLICY_CONTEXT_NODES:
            raise _PolicyContextError("HOOK_CONTEXT_TOO_LARGE")
        if type(item) is str:
            account_json_string(item)
            return item
        if item is None or type(item) is bool:
            account(4 if item is None or item else 5)
            return item
        if type(item) is int:
            try:
                account(len(str(item)))
            except ValueError:
                raise _PolicyContextError("HOOK_CONTEXT_TOO_LARGE") from None
            return item
        if type(item) is float:
            if not math.isfinite(item):
                raise _PolicyContextError("HOOK_CONTEXT_INVALID")
            account(len(json.dumps(item, allow_nan=False)))
            return item
        if type(item) is dict or type(item) is list:
            marker = id(item)
            if marker in active:
                raise _PolicyContextError("HOOK_CONTEXT_INVALID")
            active.add(marker)
            try:
                is_object = type(item) is dict
                account(2)
                if is_object:
                    result: dict[str, Any] = {}
                    for index, (key, child) in enumerate(item.items()):
                        if type(key) is not str:
                            raise _PolicyContextError("HOOK_CONTEXT_INVALID")
                        account_json_string(key)
                        account(1 + bool(index))
                        result[key] = copy(child, depth + 1)
                    return result
                result = []
                for index, child in enumerate(item):
                    if index:
                        account(1)
                    result.append(copy(child, depth + 1))
                return result
            finally:
                active.remove(marker)
        raise _PolicyContextError("HOOK_CONTEXT_INVALID")

    if not isinstance(value, Mapping):
        raise _PolicyContextError("HOOK_CONTEXT_INVALID")
    copied = copy(value)

    def freeze(item: Any) -> Any:
        if isinstance(item, dict):
            return MappingProxyType({key: freeze(child) for key, child in item.items()})
        if isinstance(item, list):
            return tuple(freeze(child) for child in item)
        return item

    return freeze(copied)


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
        New callbacks may also declare a ``signal`` keyword parameter to
        cooperatively stop when the turn is cancelled; one-argument callbacks
        remain supported.
    ``before_request(context) -> HookDecision | None``
        Deny a model request after the complete request budget is prepared and
        before the provider is called. ``purpose`` distinguishes business turns,
        summary fragments and connection checks. A denial terminates that work
        without authorizing a retry or a context-recovery request.
    ``close()``
        Release host resources after all kernel workers have stopped.

    Event observations use a bounded, ordered queue and never run under the
    event/RPC locks. Policy checks run in daemon threads with a bounded join.
    A timed out callback may finish later, but cannot hold a kernel lock; its
    late return is ignored and never changes a turn result.
    At most ``MAX_ACTIVE_HOOK_CALLBACKS`` callbacks may be in flight at once.
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
            if not any(callable(getattr(hook, name, None)) for name in
                       ("on_event", "before_tool_call", "before_request", "close")):
                raise ValueError("生命周期 hook 至少提供 on_event、before_tool_call、before_request 或 close")
        self._hooks = values
        self.timeout = float(timeout)
        self._error_sink = error_sink
        self._lock = threading.Condition(threading.RLock())
        self._active = 0
        self._closing = False
        self._closed = False
        self._dropped_events = 0
        self._busy_events = 0
        self._last_busy_diagnostic = 0.0
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
                *, event: str | None = None, deadline: float | None = None,
                cancel_event: threading.Event | None = None,
                signal: HookCancellationSignal | None = None) -> Any:
        callback = getattr(hook, method, None)
        if not callable(callback):
            return None
        policy = method in {"before_tool_call", "before_request"}
        if cancel_event is not None and cancel_event.is_set():
            return _HOOK_CANCELLED
        with self._lock:
            if policy and (self._closing or self._closed):
                return _HOOK_CLOSED
        try:
            callback_context = (freeze_policy_context(context or {}) if method in {"before_tool_call", "before_request"}
                               else freeze_context(context or {}) if method == "on_event" else None)
        except _PolicyContextError as exc:
            subject = "模型请求" if method == "before_request" else "工具"
            message = (f"策略 hook 输入超过内核上限；{subject}已拒绝"
                       if exc.code == "HOOK_CONTEXT_TOO_LARGE"
                       else f"策略 hook 输入不是受支持的 JSON；{subject}已拒绝")
            self._failure(hook, method, event, exc.code, message)
            return _HOOK_CONTEXT_TOO_LARGE if exc.code == "HOOK_CONTEXT_TOO_LARGE" else _HOOK_CONTEXT_INVALID
        if cancel_event is not None and cancel_event.is_set():
            return _HOOK_CANCELLED
        timeout = self.timeout
        if deadline is not None:
            timeout = min(timeout, max(0.0, deadline - time.monotonic()))
        if timeout <= 0:
            self._failure(hook, method, event, "HOOK_TIMEOUT", "生命周期 hook 未能在关闭期限内开始", timed_out=True)
            return _HOOK_FAILED
        result: list[Any] = []
        error: list[BaseException] = []
        finished = threading.Event()
        signal_mode = (_signal_mode(callback)
                       if method in {"before_tool_call", "before_request"} and signal is not None else None)

        def run() -> None:
            try:
                if cancel_event is not None and cancel_event.is_set():
                    return
                if method == "close":
                    result.append(callback())
                elif signal_mode == "positional":
                    result.append(callback(callback_context, signal))
                elif signal_mode == "keyword":
                    result.append(callback(callback_context, signal=signal))
                else:
                    result.append(callback(callback_context))
            except BaseException as exc:  # Hook code is trusted but isolated from the kernel.
                error.append(exc)
            finally:
                with self._lock:
                    self._active -= 1
                    self._lock.notify_all()
                finished.set()

        thread = threading.Thread(target=run, name=f"boss-hook-{method}", daemon=True)
        start_error: Exception | None = None
        with self._lock:
            if self._closed or (self._closing and method in {"before_tool_call", "before_request"}):
                return _HOOK_CLOSED if policy else None
            if self._active >= MAX_ACTIVE_HOOK_CALLBACKS:
                if method == "on_event":
                    self._busy_events += 1
                busy = True
            else:
                busy = False
                self._active += 1
                try:
                    thread.start()
                except Exception as exc:
                    start_error = exc
                    self._active -= 1
                    self._lock.notify_all()
        if busy:
            if method != "on_event":
                self._failure(hook, method, event, "HOOK_BUSY", "生命周期 hook 在途回调已达到内核上限")
            return _HOOK_BUSY
        if start_error is not None:
            self._failure(hook, method, event, "HOOK_START_FAILED", str(start_error))
            return _HOOK_FAILED
        end = time.monotonic() + timeout
        while not finished.is_set():
            if cancel_event is not None and cancel_event.is_set():
                return _HOOK_CANCELLED
            remaining = end - time.monotonic()
            if remaining <= 0:
                if cancel_event is not None and cancel_event.is_set():
                    return _HOOK_CANCELLED
                self._failure(hook, method, event, "HOOK_TIMEOUT", "生命周期 hook 超时", timed_out=True)
                return _HOOK_FAILED
            finished.wait(min(0.025, remaining))
        if cancel_event is not None and cancel_event.is_set():
            return _HOOK_CANCELLED
        with self._lock:
            if policy and (self._closing or self._closed):
                return _HOOK_CLOSED
        if error:
            self._failure(hook, method, event, "HOOK_ERROR", str(error[0]))
            return _HOOK_FAILED
        return result[0] if result else None

    @staticmethod
    def _event_projection(method: str, params: Mapping[str, Any] | None) -> dict[str, Any]:
        visible = {"threadId", "turnId", "itemId", "queueId", "jobId", "status", "code",
                   "reason", "origin", "kind", "toolName", "model", "provider", "effort",
                   "state", "aborted", "active", "eventCursor", "eventId", "recoveryAction",
                   "outputObserved", "requestRejected"}
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

    def _report_busy_events(self, *, force: bool = False) -> None:
        with self._lock:
            now = time.monotonic()
            if not self._busy_events or (
                not force and now - self._last_busy_diagnostic < HOOK_BUSY_DIAGNOSTIC_INTERVAL_SECONDS
            ):
                return
            count, self._busy_events = self._busy_events, 0
            self._last_busy_diagnostic = now
            hook = next((item for item in self._hooks if callable(getattr(item, "on_event", None))), self)
        self._failure(hook, "on_event", None, "HOOK_BUSY",
                      f"生命周期观察 hook 达到在途回调上限；累计跳过 {count} 个观察回调")

    def _drain_events(self) -> None:
        while True:
            with self._lock:
                closing = self._closing
            if closing and self._event_queue.empty():
                self._report_dropped_events()
                self._report_busy_events(force=True)
                return
            try:
                record = self._event_queue.get(timeout=0.05)
            except queue.Empty:
                if self._event_queue.empty():
                    self._report_dropped_events()
                    self._report_busy_events()
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

    def before_tool_call(self, context: Mapping[str, Any], *,
                         cancel_event: threading.Event | None = None) -> HookDecision | None:
        if not self._hooks:
            return None
        event = "toolCall/before"
        signal = HookCancellationSignal(cancel_event) if cancel_event is not None else None
        for hook in self._hooks:
            if not callable(getattr(hook, "before_tool_call", None)):
                continue
            result = self._invoke(
                hook,
                "before_tool_call",
                {"phase": "before_tool_call", **dict(context)},
                event=event,
                cancel_event=cancel_event,
                signal=signal,
            )
            if result is _HOOK_CANCELLED:
                return None
            if result is _HOOK_CLOSED:
                return HookDecision(False, "HOOK_CLOSED", "内核策略 hook 正在关闭或已关闭；工具调用已暂停")
            if result is _HOOK_CONTEXT_TOO_LARGE:
                return HookDecision(False, "HOOK_CONTEXT_TOO_LARGE", "策略输入超过内核上限；为保证策略检查完整，工具调用已暂停")
            if result is _HOOK_CONTEXT_INVALID:
                return HookDecision(False, "HOOK_CONTEXT_INVALID", "策略输入不是受支持的 JSON；为保证策略检查完整，工具调用已暂停")
            if result is _HOOK_BUSY:
                return HookDecision(False, "HOOK_BUSY", "内核策略 hook 已达到在途回调上限；工具调用已暂停")
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

    def before_request(self, context: Mapping[str, Any], *,
                       cancel_event: threading.Event | None = None) -> HookDecision | None:
        """Run a fail-closed policy check before one provider request."""
        if not self._hooks:
            return None
        event = "modelRequest/before"
        signal = HookCancellationSignal(cancel_event) if cancel_event is not None else None
        for hook in self._hooks:
            if not callable(getattr(hook, "before_request", None)):
                continue
            result = self._invoke(
                hook,
                "before_request",
                {"phase": "before_request", **dict(context)},
                event=event,
                cancel_event=cancel_event,
                signal=signal,
            )
            if result is _HOOK_CANCELLED:
                return None
            if result is _HOOK_CLOSED:
                return HookDecision(False, "HOOK_CLOSED", "内核策略 hook 正在关闭或已关闭；模型请求已拒绝")
            if result is _HOOK_CONTEXT_TOO_LARGE:
                return HookDecision(False, "HOOK_CONTEXT_TOO_LARGE", "策略输入超过内核上限；模型请求已拒绝")
            if result is _HOOK_CONTEXT_INVALID:
                return HookDecision(False, "HOOK_CONTEXT_INVALID", "策略输入不是受支持的 JSON；模型请求已拒绝")
            if result is _HOOK_BUSY:
                return HookDecision(False, "HOOK_BUSY", "内核策略 hook 已达到在途回调上限；模型请求已拒绝")
            if result is _HOOK_FAILED:
                return HookDecision(False, "HOOK_ERROR", "内核策略 hook 未能完成；模型请求已拒绝")
            if result is None:
                continue
            if not isinstance(result, HookDecision):
                self._failure(hook, "before_request", event, "HOOK_RESULT_INVALID",
                              "before_request 必须返回 HookDecision 或 None")
                return HookDecision(False, "HOOK_RESULT_INVALID", "内核策略 hook 返回了无效结果；模型请求已拒绝")
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
