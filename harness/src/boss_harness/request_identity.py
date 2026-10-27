"""Resolve one durable user request across direct and follow-up submission.

Pi d5b3de22 keeps pending messages separate from active-run ownership. This
harness independently reconciles its append-only request and queue receipts;
finding an old identity never resumes a model, tool, or approval.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re

from boss_harness.rpc import RpcError
from boss_harness.session import SessionStore


@dataclass(frozen=True)
class RequestIdentity:
    turn: dict | None = None
    user: dict | None = None
    queue: dict | None = None
    input_persisted: bool | None = None
    start_failed: bool = False

    def receipt(self) -> dict:
        if self.turn is None:
            raise ValueError("请求尚未关联回合")
        fields = {"turnId": self.turn["turnId"], "deduplicated": True,
                  "status": "paused" if self.start_failed or self.input_persisted is not True else "delivered"}
        if self.start_failed:
            fields.update(failureCode="TURN_START_FAILED", executionStarted=False)
        if self.input_persisted is not None:
            fields["inputPersisted"] = self.input_persisted
        return fields


def _reject(code: str, message: str) -> None:
    raise RpcError(-32004, message, {"code": code})


def resolve_request(sessions: SessionStore, thread_id: str, client_id: str | None, text: str,
                    *, queue_id: str | None = None) -> RequestIdentity:
    """Project all candidates from one snapshot; caller serializes admission.

    queue_id is an internal association, not an alternative public client ID.
    In particular an external ``queue-<id>`` string cannot claim a pending
    queue whose client ID was omitted.
    """
    if client_id is not None and (not isinstance(client_id, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", client_id)):
        raise ValueError("clientUserMessageId 格式无效")
    if client_id is None and queue_id is None:
        return RequestIdentity()
    entries = sessions.read_entries(thread_id)
    items = sessions._project_items(thread_id, entries)
    owners = sessions._item_owners(entries)
    turns = {turn["turnId"]: turn for turn in sessions._turns(entries, thread_id)}
    queues = {entry["payload"]["id"]: dict(entry["payload"]) for entry in entries
              if entry["type"] == "queue" and isinstance(entry["payload"].get("id"), str)}
    matched_queues = {key for key, item in queues.items()
                      if key == queue_id or (client_id is not None and item.get("clientUserMessageId") == client_id)}
    matched_users = [item for item in items if item.get("kind") == "userMessage"
                     and client_id is not None and item.get("clientUserMessageId") == client_id]
    matched_turns = {key for key, turn in turns.items()
                     if client_id is not None and turn.get("clientUserMessageId") == client_id}
    def original_user(item: dict) -> bool:
        return item.get("source") != "steering" and queues.get(item.get("queueId"), {}).get("kind") != "steering"
    # Persisted queueId/turnId links can connect older records missing a client
    # ID. Never derive such a link merely from a client ID's spelling or text.
    for _ in range(2):
        matched_queues.update(item["queueId"] for item in matched_users
                              if item.get("queueId") in queues)
        matched_queues.update(turns[key]["queueId"] for key in matched_turns
                              if key in turns and turns[key].get("queueId") in queues)
        matched_users = [item for item in items if item.get("kind") == "userMessage" and (
            (client_id is not None and item.get("clientUserMessageId") == client_id)
            or item.get("queueId") in matched_queues
            or (original_user(item) and (item.get("turnId") or owners.get(item["id"])) in matched_turns))]
        matched_turns.update(key for key, turn in turns.items() if turn.get("queueId") in matched_queues)
        matched_turns.update(item.get("turnId") or owners.get(item["id"]) for item in matched_users)
        matched_turns.update(queues[key]["turnId"] for key in matched_queues if queues[key].get("turnId"))
    if any(queues[key].get("kind") != "followUp" for key in matched_queues) or any(
            item.get("source") == "steering" for item in matched_users):
        _reject("CLIENT_REQUEST_CONFLICT", "请求编号已用于转向消息，不能改为直接或后续任务")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    known_input = bool(matched_queues or matched_users)
    for key in matched_queues:
        item = queues[key]
        if item.get("input") != text:
            _reject("CLIENT_REQUEST_CONFLICT", "clientUserMessageId 已用于不同输入")
        if client_id is not None and item.get("clientUserMessageId") not in {None, client_id}:
            _reject("CLIENT_REQUEST_CONFLICT", "请求编号与既有队列关联不一致")
    for item in matched_users:
        if client_id is not None and item.get("clientUserMessageId") not in {None, client_id}:
            _reject("CLIENT_REQUEST_CONFLICT", "请求编号与既有输入身份不一致")
        if item.get("originalInput", item.get("text")) != text:
            _reject("CLIENT_REQUEST_CONFLICT", "clientUserMessageId 已用于不同输入")
    for key in matched_turns:
        turn = turns.get(key)
        if turn is not None and client_id is not None and turn.get("clientUserMessageId") not in {None, client_id}:
            _reject("CLIENT_REQUEST_CONFLICT", "请求编号与既有回合身份不一致")
        if turn is not None and turn.get("requestInputDigest"):
            known_input = True
            if turn["requestInputDigest"] != digest:
                _reject("CLIENT_REQUEST_CONFLICT", "clientUserMessageId 已用于不同输入")
    if len(matched_turns) > 1 or len(matched_queues) > 1:
        _reject("CLIENT_REQUEST_AMBIGUOUS", "请求编号对应多条历史身份，请先核对会话")
    if len(matched_users) > 1:
        _reject("REQUEST_REQUIRES_REVIEW", "旧请求对应多条原始输入，请先核对会话")
    turn = turns.get(next(iter(matched_turns))) if matched_turns else None
    if matched_turns and (turn is None or not known_input):
        _reject("REQUEST_REQUIRES_REVIEW", "旧请求缺少可核对的回合或输入，请先核对会话")
    user = matched_users[0] if matched_users else None
    if user is not None and turn is None:
        _reject("REQUEST_REQUIRES_REVIEW", "旧输入缺少可核对的回合，请先核对会话")
    queue = queues[next(iter(matched_queues))] if matched_queues else None
    sources = [source for source in (turn, queue) if source is not None]
    persistence_facts = {source["inputPersisted"] for source in sources
                         if type(source.get("inputPersisted")) is bool}
    if user is not None:
        persistence_facts.add(True)
    start_failed = any(source.get("failureCode") == "TURN_START_FAILED"
                       and source.get("executionStarted") is False for source in sources)
    if len(persistence_facts) > 1 or (start_failed and turn is not None and turn.get("status") == "completed"):
        _reject("REQUEST_REQUIRES_REVIEW", "旧请求的持久事实不一致，请先核对会话")
    persisted = next(iter(persistence_facts)) if persistence_facts else None
    return RequestIdentity(turn=turn, user=user, queue=queue,
                           input_persisted=persisted, start_failed=start_failed)
