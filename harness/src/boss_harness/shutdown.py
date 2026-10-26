"""Tracked best-effort aborts and one shared graceful-shutdown wait budget.

Pi d5b3de22d0e24a3e9c38a9410d3329b099717283 separates abort() from
waitForIdle(); the caller retains ownership through hooks and final events.
The two-second policy belongs to this harness, not to the provider transport.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterable


class TrackedAbort:
    def __init__(self, provider: object, on_done: Callable[[], None], *, name: str,
                 callback: Callable[[], None] | None = None) -> None:
        self.provider = provider
        self.on_done = on_done
        self.name = name
        self.callback = callback
        self.done = threading.Event()
        self.worker: threading.Thread | None = None
        self._lock = threading.Lock()
        self._finish_lock = threading.Lock()
        self._started = False
        self._finished = False

    def _run(self) -> None:
        try:
            if self.callback is not None:
                self.callback()
            else:
                abort = getattr(self.provider, "request_abort", None)
                if callable(abort):
                    abort()
        except Exception:
            pass
        finally:
            self._finish()

    def _finish(self) -> None:
        with self._finish_lock:
            if self._finished:
                return
            self._finished = True
        self.done.set()
        try:
            self.on_done()
        except Exception:
            pass

    def start(self) -> None:
        failed = False
        with self._lock:
            if self._started:
                return
            self._started = True
            try:
                worker = threading.Thread(target=self._run, daemon=True, name=self.name)
                self.worker = worker
                worker.start()
            except Exception:
                # A wrapped start may raise after launching the worker. Keep its
                # ownership record if it has an ident; _finish is idempotent.
                if "worker" not in locals() or worker.ident is None:
                    self.worker = None
                    failed = True
        if failed:
            # Never replace failed dispatch with an unbounded inline abort hook.
            # on_done only retires bookkeeping and can safely run here.
            self._finish()


def join_until(workers: Iterable[threading.Thread | None], deadline: float) -> None:
    seen: set[int] = set()
    for worker in workers:
        if (worker is None or worker is threading.current_thread() or worker.ident is None
                or id(worker) in seen):
            continue
        seen.add(id(worker))
        worker.join(max(0, deadline - time.monotonic()))
