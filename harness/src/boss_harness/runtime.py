"""Per-thread runtime ownership and durable steering/follow-up delivery.

The application owns consent and queues; a runner owns one turn. Restart never
replays an in-flight submission or an external effect with an unknown outcome.
"""
from __future__ import annotations

import threading
import time
import uuid
import re
from typing import Any

from boss_harness.rpc import RpcError
from boss_harness.request_identity import RequestIdentity, resolve_request
from boss_harness.session import Entry, SessionStore
from boss_harness.shutdown import TrackedAbort, join_until


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

    def reserve(self, thread_id: str, text: str, runner: Any) -> dict:
        with self.lock:
            if self.closed:
                raise RpcError(-32003, "内核正在关闭")
            if thread_id in self.active:
                raise RpcError(-32004, "该会话已有回合运行", {"turnId": self.active[thread_id]["turnId"]})
            if len(self.active) >= self.capacity:
                raise RpcError(-32005, "已达到并发会话上限")
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

    def _retire_locked(self, job: dict) -> None:
        abort = job.get("_shutdown_abort")
        if job.get("_worker_done") and (abort is None or abort.done.is_set()):
            if self.jobs.get(job["turnId"]) is job:
                self.jobs.pop(job["turnId"], None)

    def _notify_idle(self) -> None:
        if self.on_idle is not None:
            self.on_idle()

    def _abort_done(self, job: dict) -> None:
        with self.lock:
            self._retire_locked(job)
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

    def list(self, thread_id: str) -> list[dict]:
        states: dict[str, dict] = {}
        for entry in self.sessions.read_entries(thread_id):
            if entry["type"] == "queue":
                states[entry["payload"]["id"]] = dict(entry["payload"])
        return list(states.values())

    def _save(self, thread_id: str, item: dict) -> dict:
        self.sessions.append(thread_id, Entry(type="queue", payload=item))
        return dict(item)

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

    def _associate_request(self, thread_id: str, queue_id: str, identity: RequestIdentity) -> dict:
        """Append a receipt for an existing turn without resuming its request."""
        with self.lock:
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
            for item in self.list(thread_id):
                if client_id and item.get("clientUserMessageId") == client_id:
                    if item["input"] != text or item["kind"] != kind:
                        raise ValueError("clientUserMessageId 已用于不同输入")
                    return item
            return self._save(thread_id, {"id": uuid.uuid4().hex, "kind": kind,
                "input": text, "status": "queued", "expectedTurnId": turn_id,
                "clientUserMessageId": client_id})

    def transition(self, thread_id: str, queue_id: str, status: str) -> dict:
        with self.lock:
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
            item = next((q for q in self.list(thread_id) if q["kind"] == kind and q["status"] == "queued"
                         and (kind != "steering" or q["expectedTurnId"] == turn_id)), None)
            return self.transition(thread_id, item["id"], "delivering") if item else None

    def pause(self, thread_id: str, *, kind: str | None = None) -> None:
        with self.lock:
            for item in self.list(thread_id):
                if item["status"] in {"queued", "delivering"} and (kind is None or item["kind"] == kind):
                    self.transition(thread_id, item["id"], "paused")

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
