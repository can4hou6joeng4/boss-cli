"""Bridge cancellable async SDK streams to the harness's synchronous provider API."""
from __future__ import annotations

import asyncio
import queue
import sys
import threading
from collections.abc import Awaitable, Callable, Iterator
from typing import Generic, TypeVar

from boss_harness.models.output_budget import OutputBudgetExceeded

T = TypeVar("T")
_END = object()
_MAX_BUFFERED_EVENTS = 64
_MAX_BUFFERED_BYTES = 4 * 1024 * 1024
_MAX_EVENT_BYTES = 2 * 1024 * 1024
_MAX_EVENT_NODES = 32768
# A cancelled SDK coroutine that will not finish must not create unbounded threads.
_MAX_ACTIVE_PUMPS = 8
_CLEANUP_JOIN_SECONDS = 1.0
_ACTIVE_PUMPS = threading.BoundedSemaphore(_MAX_ACTIVE_PUMPS)


class _QueuedEvent(Generic[T]):
    __slots__ = ("value", "size")

    def __init__(self, value: T, size: int) -> None:
        self.value = value
        self.size = size


def _text_size(value: str, limit: int) -> int:
    total = 0
    for start in range(0, len(value), 4096):
        total += len(value[start:start + 4096].encode("utf-8", errors="replace"))
        if total > limit:
            return limit + 1
    return total


def _event_size(value: object, limit: int, *, seen: set[int] | None = None,
                nodes: list[int] | None = None, depth: int = 0) -> int:
    if limit < 0:
        return 1
    if depth > 32:
        return limit + 1
    if nodes is None:
        nodes = [0]
    nodes[0] += 1
    if nodes[0] > _MAX_EVENT_NODES:
        return limit + 1
    if value is None or type(value) in (bool, int, float):
        return sys.getsizeof(value)
    if isinstance(value, str):
        return _text_size(value, limit)
    if isinstance(value, bytes):
        return len(value)
    if seen is None:
        seen = set()
    identity = id(value)
    if identity in seen:
        return 0
    seen.add(identity)

    if isinstance(value, dict):
        total = 64
        for key, item in value.items():
            total += 16
            total += _event_size(key, limit - total, seen=seen, nodes=nodes, depth=depth + 1)
            total += _event_size(item, limit - total, seen=seen, nodes=nodes, depth=depth + 1)
            if total > limit:
                return limit + 1
        return total
    if isinstance(value, (list, tuple, set, frozenset)):
        total = 64
        for item in value:
            total += 16 + _event_size(item, limit - total, seen=seen, nodes=nodes,
                                       depth=depth + 1)
            if total > limit:
                return limit + 1
        return total

    attributes = getattr(value, "__dict__", None)
    if isinstance(attributes, dict):
        total = _event_size(attributes, limit, seen=seen, nodes=nodes, depth=depth + 1)
        # SDK Pydantic models retain unrecognized JSON fields outside __dict__.
        for slot in ("__pydantic_extra__", "__pydantic_private__", "__pydantic_fields_set__"):
            retained = getattr(value, slot, None)
            if retained is not None:
                total += _event_size(retained, limit - total, seen=seen, nodes=nodes,
                                     depth=depth + 1)
                if total > limit:
                    return limit + 1
        return total
    return 128


class StreamDeadlineExceeded(TimeoutError):
    pass


class StreamAborted(Exception):
    pass


class StreamPumpCapacityExceeded(RuntimeError):
    pass


class AsyncStreamPump(Generic[T], Iterator[T]):
    """Run one async transport attempt while preserving the synchronous event API."""

    def __init__(self, producer: Callable[[Callable[[T], Awaitable[None]]], Awaitable[None]],
                 *, timeout: float, name: str) -> None:
        self._producer = producer
        self._timeout = timeout
        self._events: queue.Queue[object] = queue.Queue(maxsize=_MAX_BUFFERED_EVENTS + 1)
        self._buffered_bytes = 0
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task | None = None
        self._cancel_requested = False
        self._task_cancel_sent = False
        self._deadline_expired = False
        self._finished = False
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)
        if not _ACTIVE_PUMPS.acquire(blocking=False):
            raise StreamPumpCapacityExceeded("模型流后台清理容量已满")
        try:
            self._thread.start()
        except BaseException:
            _ACTIVE_PUMPS.release()
            raise

    async def _publish(self, event: T) -> None:
        size = _event_size(event, _MAX_EVENT_BYTES)
        if size > _MAX_EVENT_BYTES:
            raise OutputBudgetExceeded("模型流事件超过本地缓冲字节上限")
        while True:
            with self._lock:
                if self._finished:
                    raise asyncio.CancelledError
                if (self._events.qsize() < _MAX_BUFFERED_EVENTS
                        and self._buffered_bytes + size <= _MAX_BUFFERED_BYTES):
                    try:
                        self._events.put_nowait(_QueuedEvent(event, size))
                        self._buffered_bytes += size
                        return
                    except queue.Full:
                        pass
            await asyncio.sleep(0.001)

    def _expire_deadline(self) -> None:
        with self._lock:
            if self._finished:
                return
            aborted = self._cancel_requested
            self._deadline_expired = not aborted
            self._finished = True
            self._discard_pending_events()
            self._events.put_nowait(StreamAborted() if aborted else StreamDeadlineExceeded())
            task = self._task
            cancel_task = task is not None and not task.done() and not self._task_cancel_sent
            if cancel_task:
                self._task_cancel_sent = True
        if cancel_task and task is not None:
            task.cancel()

    def _discard_pending_events(self) -> None:
        while True:
            try:
                self._events.get_nowait()
            except queue.Empty:
                self._buffered_bytes = 0
                return

    def _finish(self, value: object) -> None:
        with self._lock:
            if self._finished:
                return
            self._finished = True
            self._events.put_nowait(value)

    async def _execute(self) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.call_later(self._timeout, self._expire_deadline)
        try:
            await self._producer(self._publish)
        except asyncio.CancelledError:
            terminal = StreamDeadlineExceeded() if self._deadline_expired else StreamAborted()
            self._finish(terminal)
        except BaseException as exc:
            self._finish(exc)
        else:
            self._finish(StreamDeadlineExceeded() if self._deadline_expired else _END)
        finally:
            deadline.cancel()

    def _run(self) -> None:
        loop: asyncio.AbstractEventLoop | None = None
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            task = loop.create_task(self._execute())
            with self._lock:
                self._loop = loop
                self._task = task
                cancel = self._cancel_requested and not self._task_cancel_sent
                if cancel:
                    self._task_cancel_sent = True
            if cancel:
                loop.call_soon(task.cancel)
            loop.run_until_complete(task)
        except asyncio.CancelledError:
            self._finish(StreamAborted())
        except BaseException as exc:
            self._finish(exc)
        finally:
            try:
                if loop is not None:
                    loop.run_until_complete(loop.shutdown_asyncgens())
            finally:
                try:
                    if loop is not None:
                        loop.close()
                finally:
                    _ACTIVE_PUMPS.release()
                    self._done.set()

    def cancel(self) -> None:
        with self._lock:
            if self._finished:
                return
            self._cancel_requested = True
            self._finished = True
            self._discard_pending_events()
            self._events.put_nowait(StreamAborted())
            loop, task = self._loop, self._task
            cancel_task = task is not None and not task.done() and not self._task_cancel_sent
            if cancel_task:
                self._task_cancel_sent = True
        if loop is not None and task is not None and cancel_task and not self._done.is_set():
            loop.call_soon_threadsafe(task.cancel)

    def close(self) -> None:
        self.cancel()
        if threading.current_thread() is not self._thread:
            self._thread.join(timeout=_CLEANUP_JOIN_SECONDS)

    def __enter__(self) -> AsyncStreamPump[T]:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def __iter__(self) -> AsyncStreamPump[T]:
        return self

    def __next__(self) -> T:
        value = self._events.get()
        if value is _END:
            raise StopIteration
        if isinstance(value, BaseException):
            raise value
        if not isinstance(value, _QueuedEvent):
            raise RuntimeError("模型流队列中出现无效事件")
        with self._lock:
            self._buffered_bytes = max(0, self._buffered_bytes - value.size)
        return value.value

    @property
    def worker_done(self) -> bool:
        return self._done.is_set()
