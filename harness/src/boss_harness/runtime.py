"""Per-thread runtime ownership and durable steering/follow-up delivery.

The application owns consent and queues; a runner owns one turn. Restart never
replays an in-flight submission or an external effect with an unknown outcome.
"""
from __future__ import annotations

import threading
import time
import uuid
import re
from typing import Any, Callable

from boss_harness.rpc import RpcError
from boss_harness.request_identity import RequestIdentity, resolve_request
from boss_harness.session import Entry, SessionStore
from boss_harness.shutdown import TrackedAbort, join_until

MAX_PENDING_QUEUE_ITEMS = 128
MAX_PENDING_QUEUE_INPUT_BYTES = 4 * 1024 * 1024


class RuntimeManager:
    def __init__(self, *, capacity: int = 8) -> None:
        self.lock = threading.RLock()
        self.active: dict[str, dict[str, Any]] = {}
        # Keep model ownership through completion notifications and cleanup.
        # The application tracks follow-up storage tails separately.
        self.jobs: dict[str, dict[str, Any]] = {}
        self.capacity = capacity
        self.closed = False
        self.on_idle = None
        self._capacity_wake = threading.Event()
        self._capacity_callback: Callable[[], None] | None = None
        self._capacity_worker: threading.Thread | None = None
        self._capacity_worker_done = threading.Event()
        self._capacity_worker_done.set()

    def start_capacity_notifications(self, callback: Callable[[], None]) -> None:
        """Start one tracked wake worker before accepting application work."""
        with self.lock:
            if self.closed or self._capacity_worker is not None:
                raise RuntimeError("容量通知 worker 已启动或内核已关闭")
            self._capacity_callback = callback
            worker = threading.Thread(target=self._run_capacity_notifications,
                                      name="turn-capacity-wake", daemon=True)
            self._capacity_worker_done.clear()
            self._capacity_worker = worker
            try:
                worker.start()
            except Exception:
                if worker.ident is None:
                    self._capacity_worker = None
                    self._capacity_worker_done.set()
                    raise

    @property
    def capacity_notifications_stopped(self) -> bool:
        return self._capacity_worker_done.is_set()

    def _run_capacity_notifications(self) -> None:
        try:
            while True:
                self._capacity_wake.wait()
                self._capacity_wake.clear()
                with self.lock:
                    if self.closed:
                        return
                    callback = self._capacity_callback
                try:
                    if callback is not None:
                        callback()
                except Exception:
                    # Durable queue state remains authoritative after a failed
                    # wake; later ownership changes or explicit input may retry.
                    pass
        finally:
            self._capacity_worker_done.set()
            self._notify_idle()

    @property
    def owner_capacity(self) -> int:
        # Permit one batch of cleanup tails to overlap the active batch.
        return 2 * self.capacity

    def has_capacity(self) -> bool:
        with self.lock:
            return (not self.closed and len(self.active) < self.capacity
                    and len(self.jobs) < self.owner_capacity)

    def check_admission(self, thread_id: str) -> None:
        """Preflight resource bounds; reserve repeats this under the same lock."""
        with self.lock:
            if self.closed:
                raise RpcError(-32003, "内核正在关闭")
            if thread_id in self.active:
                raise RpcError(-32004, "该会话已有回合运行", {"turnId": self.active[thread_id]["turnId"]})
            if len(self.active) >= self.capacity:
                raise RpcError(-32005, "已达到并发会话上限",
                               {"code": "TURN_CONCURRENCY_LIMIT", "limit": self.capacity})
            if len(self.jobs) >= self.owner_capacity:
                raise RpcError(-32005, "仍在执行或收尾的回合已达到内核资源上限",
                               {"code": "TURN_OWNER_LIMIT", "limit": self.owner_capacity})

    def reserve(self, thread_id: str, text: str, runner: Any) -> dict:
        with self.lock:
            self.check_admission(thread_id)
            job = {"threadId": thread_id, "turnId": uuid.uuid4().hex, "input": text,
                   "cancel": threading.Event(), "runner": runner, "worker": None}
            self.active[thread_id] = job
            self.jobs[job["turnId"]] = job
            return job

    def release(self, job: dict) -> None:
        with self.lock:
            if self.active.get(job["threadId"]) is job:
                self.active.pop(job["threadId"])

    def finish(self, job: dict) -> None:
        with self.lock:
            job["_worker_done"] = True
            self._retire_locked(job)
        self._notify_idle()

    def _retire_locked(self, job: dict) -> bool:
        abort = job.get("_shutdown_abort")
        if job.get("_worker_done") and (abort is None or abort.done.is_set()):
            if self.jobs.get(job["turnId"]) is job:
                self.jobs.pop(job["turnId"], None)
                return True
        return False

    def _notify_idle(self) -> None:
        if self.on_idle is not None:
            self.on_idle()

    def _abort_done(self, job: dict) -> None:
        with self.lock:
            retired = self._retire_locked(job)
        # Abort start failure can call this inline in the cancelling thread.
        # Signal the prestarted worker; never dispatch unrelated work here.
        if retired:
            self._capacity_wake.set()
        self._notify_idle()

    def _claim_abort_locked(self, job: dict, *, interrupt: bool) -> TrackedAbort:
        if "_shutdown_abort" not in job:
            # Manual cancellation and shutdown share one claim. The application
            # captures summary providers separately, rather than consulting a
            # runner's mutable context_abort when this hook eventually runs.
            job["_shutdown_abort"] = TrackedAbort(job["runner"].provider,
                lambda job=job: self._abort_done(job), name="turn-abort",
                callback=job["runner"].interrupt if interrupt else None)
        return job["_shutdown_abort"]

    def prepare_interrupt(self, thread_id: str, expected_turn_id: str | None = None,
                          *, interrupt: bool = True) -> dict | None:
        """Cancel and claim ownership; dispatch only after all owner locks exit."""
        with self.lock:
            job = self.active.get(thread_id)
            if job is None:
                return None
            if expected_turn_id and expected_turn_id != job["turnId"]:
                raise RpcError(-32004, "回合已变化；请刷新后再中断")
            job["cancel"].set()
            self._claim_abort_locked(job, interrupt=interrupt)
            return job

    def interrupt(self, thread_id: str, expected_turn_id: str | None = None) -> bool:
        job = self.prepare_interrupt(thread_id, expected_turn_id)
        if job is None:
            return False
        job["_shutdown_abort"].start()
        return True

    def cancel_all(self, *, interrupt: bool = True) -> None:
        with self.lock:
            self.closed = True
            self._capacity_wake.set()
            for job in self.jobs.values():
                job["cancel"].set()
                self._claim_abort_locked(job, interrupt=interrupt)

    def request_stop_aborts(self) -> None:
        with self.lock:
            aborts = [job["_shutdown_abort"] for job in self.jobs.values() if "_shutdown_abort" in job]
        for abort in aborts:
            abort.start()

    def wait_for_stop(self, deadline: float) -> None:
        with self.lock:
            workers = [job.get("worker") for job in self.jobs.values()]
            workers.append(self._capacity_worker)
            workers.extend(job["_shutdown_abort"].worker for job in self.jobs.values()
                           if "_shutdown_abort" in job)
        join_until(workers, deadline)

    def stop(self, *, deadline: float | None = None) -> None:
        deadline = time.monotonic() + 2 if deadline is None else deadline
        self.cancel_all(interrupt=True)
        self.request_stop_aborts()
        self.wait_for_stop(deadline)


class TurnQueue:
    def __init__(self, sessions: SessionStore) -> None:
        self.sessions = sessions
        self.lock = threading.RLock()
        self._pending_pauses: dict[str, set[str | None]] = {}

    def list(self, thread_id: str) -> list[dict]:
        states: dict[str, dict] = {}
        for entry in self.sessions.read_entries(thread_id):
            if entry["type"] == "queue":
                states[entry["payload"]["id"]] = dict(entry["payload"])
        return list(states.values())

    def _save(self, thread_id: str, item: dict) -> dict:
        self.sessions.append(thread_id, Entry(type="queue", payload=item))
        return dict(item)

    @staticmethod
    def _pending_usage(items: list[dict]) -> tuple[int, int]:
        pending = [item for item in items if item.get("status") in {"queued", "delivering"}]
        total_bytes = sum(len(item["input"].encode("utf-8")) for item in pending)
        return len(pending), total_bytes

    def get(self, thread_id: str, queue_id: str) -> dict:
        with self.lock:
            item = next((q for q in self.list(thread_id) if q["id"] == queue_id), None)
            if item is None:
                raise ValueError("队列项不存在")
            return item

    def _fail_start(self, thread_id: str, queue_id: str, *, turn_id: str | None = None,
                    input_persisted: bool | None = None) -> dict:
        """Settle a proven unstarted delivery; callers hold runtime ownership.

        delivered means the input was persisted, not that its worker started.
        This restricted failure path never makes delivered generally resumable.
        """
        with self.lock:
            self.settle_pauses(thread_id)
            item = self.get(thread_id, queue_id)
            if item["status"] not in {"delivering", "paused"} and not (
                    item["status"] == "delivered" and turn_id is not None):
                return item
            failed = {**item, "status": "paused", "failureCode": "TURN_START_FAILED",
                      "executionStarted": False}
            if turn_id is not None:
                failed["turnId"] = turn_id
            if input_persisted is not None:
                failed["inputPersisted"] = input_persisted
            return item if failed == item else self._save(thread_id, failed)

    def defer_capacity(self, thread_id: str, queue_id: str) -> dict:
        """Return an unstarted follow-up to the durable queue after capacity backpressure."""
        with self.lock:
            self.settle_pauses(thread_id)
            item = self.get(thread_id, queue_id)
            if item["status"] != "delivering":
                return item
            deferred = {key: value for key, value in item.items()
                        if key not in {"turnId", "failureCode", "executionStarted", "inputPersisted"}}
            deferred["status"] = "queued"
            return self._save(thread_id, deferred)

    def _associate_request(self, thread_id: str, queue_id: str, identity: RequestIdentity) -> dict:
        """Append a receipt for an existing turn without resuming its request."""
        with self.lock:
            self.settle_pauses(thread_id)
            item = self.get(thread_id, queue_id)
            fields = identity.receipt()
            if item["status"] not in {"queued", "delivering"}:
                fields["status"] = item["status"]
            associated = {key: value for key, value in item.items()
                          if key not in {"failureCode", "executionStarted", "inputPersisted"}}
            associated.update(fields)
            return item if associated == item else self._save(thread_id, associated)

    def add(self, thread_id: str, text: str, *, kind: str = "followUp", turn_id: str | None = None,
            client_id: str | None = None) -> dict:
        if kind not in {"steering", "followUp"}:
            raise ValueError("kind 必须是 steering 或 followUp")
        if not isinstance(text, str) or not text.strip() or len(text) > 100_000:
            raise ValueError("队列 input 必须是 1 到 100000 字符")
        if client_id is not None and (not isinstance(client_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", client_id)):
            raise ValueError("clientUserMessageId 格式无效")
        with self.lock:
            self.settle_pauses(thread_id)
            items = self.list(thread_id)
            for item in items:
                if client_id and item.get("clientUserMessageId") == client_id:
                    if item["input"] != text or item["kind"] != kind:
                        raise ValueError("clientUserMessageId 已用于不同输入")
                    return item
            pending_items, pending_bytes = self._pending_usage(items)
            input_bytes = len(text.encode("utf-8"))
            if (pending_items >= MAX_PENDING_QUEUE_ITEMS
                    or pending_bytes + input_bytes > MAX_PENDING_QUEUE_INPUT_BYTES):
                raise RpcError(-32005, "会话待处理队列已达到内核资源上限",
                               {"code": "QUEUE_LIMIT", "maxItems": MAX_PENDING_QUEUE_ITEMS,
                                "maxInputBytes": MAX_PENDING_QUEUE_INPUT_BYTES})
            return self._save(thread_id, {"id": uuid.uuid4().hex, "kind": kind,
                "input": text, "status": "queued", "expectedTurnId": turn_id,
                "clientUserMessageId": client_id})

    def transition(self, thread_id: str, queue_id: str, status: str) -> dict:
        with self.lock:
            self.settle_pauses(thread_id)
            item = next((q for q in self.list(thread_id) if q["id"] == queue_id), None)
            if item is None:
                raise ValueError("队列项不存在")
            allowed = {"queued": {"delivering", "delivered", "paused", "cancelled"},
                       "delivering": {"delivered", "paused"}, "paused": {"cancelled"}}
            if status not in allowed.get(item["status"], set()):
                raise ValueError("队列项已投递或状态不允许此操作")
            return self._save(thread_id, {**item, "status": status})

    def claim(self, thread_id: str, kind: str, turn_id: str | None = None) -> dict | None:
        with self.lock:
            self.settle_pauses(thread_id)
            item = next((q for q in self.list(thread_id) if q["kind"] == kind and q["status"] == "queued"
                         and (kind != "steering" or q["expectedTurnId"] == turn_id)), None)
            return self.transition(thread_id, item["id"], "delivering") if item else None

    def pause(self, thread_id: str, *, kind: str | None = None) -> None:
        with self.lock:
            # Register responsibility before touching storage. A failed write
            # must not leave old work eligible for a later successful turn.
            self._pending_pauses.setdefault(thread_id, set()).add(kind)
            self.settle_pauses(thread_id)

    def settle_pauses(self, thread_id: str) -> None:
        """Finish earlier pauses before accepting or claiming more work.

        Reads remain read-only. New work can only be added after these scopes
        settle, so a delayed retry cannot accidentally pause a new request.
        """
        with self.lock:
            scopes = self._pending_pauses.get(thread_id)
            if not scopes:
                return
            for item in self.list(thread_id):
                if item["status"] in {"queued", "delivering"} and (None in scopes or item["kind"] in scopes):
                    self._save(thread_id, {**item, "status": "paused"})
            self._pending_pauses.pop(thread_id, None)

    def recover(self) -> None:
        for thread in self.sessions.list_threads(include_archived=True):
            thread_id = thread["id"]
            delivered = {item.get("queueId") for item in self.sessions.read_items(thread_id)
                         if item.get("kind") == "userMessage"}
            with self.lock:
                for item in self.list(thread_id):
                    if item["status"] in {"queued", "delivering"}:
                        if item["kind"] == "steering":
                            self.transition(thread_id, item["id"],
                                            "delivered" if item["id"] in delivered else "paused")
                            continue
                        try:
                            identity = resolve_request(self.sessions, thread_id,
                                item.get("clientUserMessageId"), item["input"], queue_id=item["id"])
                        except RpcError:
                            # Inconsistent history is paused, never replayed or
                            # described as a proven failure before execution.
                            self.transition(thread_id, item["id"], "paused")
                            continue
                        if identity.turn is not None:
                            self._associate_request(thread_id, item["id"], identity)
                        else:
                            self.transition(thread_id, item["id"], "paused")
