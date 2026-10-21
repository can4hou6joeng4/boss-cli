"""Per-thread runtime ownership and durable steering/follow-up delivery.

The application owns consent and queues; a runner owns one turn. Restart never
replays an in-flight submission or an external effect with an unknown outcome.
"""
from __future__ import annotations

import threading
import uuid
import re
from typing import Any

from boss_harness.rpc import RpcError
from boss_harness.session import Entry, SessionStore


class RuntimeManager:
    def __init__(self, *, capacity: int = 8) -> None:
        self.lock = threading.RLock()
        self.active: dict[str, dict[str, Any]] = {}
        # A turn releases its execution slot before publishing completion. Keep
        # ownership of its worker until event delivery and follow-up dispatch end.
        self.jobs: dict[str, dict[str, Any]] = {}
        self.capacity = capacity
        self.closed = False

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
            self.jobs.pop(job["turnId"], None)

    def interrupt(self, thread_id: str, expected_turn_id: str | None = None) -> bool:
        with self.lock:
            job = self.active.get(thread_id)
            if job is None:
                return False
            if expected_turn_id and expected_turn_id != job["turnId"]:
                raise RpcError(-32004, "回合已变化；请刷新后再中断")
            job["cancel"].set()
            # SDK abort may block briefly; it never shares a provider with other actors.
            job["runner"].interrupt()
            return True

    def stop(self) -> None:
        with self.lock:
            self.closed = True
            jobs = list(self.jobs.values())
        for job in jobs:
            job["cancel"].set()
            job["runner"].interrupt()
        for job in jobs:
            worker = job.get("worker")
            if worker and worker is not threading.current_thread():
                worker.join(timeout=2)


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
            delivered = {i.get("queueId") for i in self.sessions.read_items(thread_id)}
            with self.lock:
                for item in self.list(thread_id):
                    if item["status"] in {"queued", "delivering"}:
                        self.transition(thread_id, item["id"],
                                        "delivered" if item["id"] in delivered else "paused")
