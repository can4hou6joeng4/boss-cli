"""Bridge cancellable async SDK streams to the harness's synchronous provider API."""
from __future__ import annotations

import asyncio
import queue
import threading
from collections.abc import Awaitable, Callable, Iterator
from typing import Generic, TypeVar

T = TypeVar("T")
_END = object()
_MAX_BUFFERED_EVENTS = 64
_CLEANUP_JOIN_SECONDS = 1.0


class StreamDeadlineExceeded(TimeoutError):
    pass


class StreamAborted(Exception):
    pass


class AsyncStreamPump(Generic[T], Iterator[T]):
    """Run one async transport attempt while preserving the synchronous event API."""

    def __init__(self, producer: Callable[[Callable[[T], Awaitable[None]]], Awaitable[None]],
                 *, timeout: float, name: str) -> None:
        self._producer = producer
        self._timeout = timeout
        self._events: queue.Queue[object] = queue.Queue(maxsize=_MAX_BUFFERED_EVENTS + 1)
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task | None = None
        self._cancel_requested = False
        self._task_cancel_sent = False
        self._deadline_expired = False
        self._finished = False
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)
        self._thread.start()

    async def _publish(self, event: T) -> None:
        while True:
            with self._lock:
                if self._finished:
                    raise asyncio.CancelledError
                if self._events.qsize() < _MAX_BUFFERED_EVENTS:
                    try:
                        self._events.put_nowait(event)
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
        try:
            loop.run_until_complete(task)
        except asyncio.CancelledError:
            self._finish(StreamAborted())
        finally:
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            finally:
                loop.close()
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
        return value  # type: ignore[return-value]
