"""Read-only projections for relationships already present in durable records."""
from __future__ import annotations

import re

_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
_AUTO_COMPACTION_REASONS = frozenset({"threshold", "budget", "overflow"})
_QUEUE_IDENTITY_FIELDS = ("kind", "input", "expectedTurnId", "clientUserMessageId")
_TERMINAL_TURNS = frozenset({"completed", "interrupted", "blocked", "error"})
_TASK_PHASES = frozenset({"admission", "prepare", "model_request", "tool_execution", "finish"})


def turn_snapshot(entries: list[dict], *, turn_ids: set[str] | None = None,
                  queue_ids: set[str] | None = None, limit: int = 257
                  ) -> tuple[list[dict], set[str], bool]:
    """Project bounded task facts, excluding turn transcript and model metadata."""
    turns: dict[str, dict] = {}
    phases: dict[str, dict] = {}
    duplicates: set[str] = set()
    overflow = False
    for entry in entries:
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if entry.get("type") == "turn":
            turn_id = payload.get("turnId")
            status = payload.get("status")
            if (not isinstance(turn_id, str) or not _IDENTIFIER.fullmatch(turn_id)
                    or status not in _TERMINAL_TURNS | {"running"}):
                continue
            if (turn_ids is not None and turn_id not in turn_ids
                    and (queue_ids is None or payload.get("queueId") not in queue_ids)):
                continue
            if turn_id not in turns and len(turns) >= limit:
                overflow = True
                continue
            turn = turns.setdefault(turn_id, {"turnId": turn_id})
            if (turn.get("status") in _TERMINAL_TURNS and status == "running"):
                duplicates.add(turn_id)
            if ("queueId" in payload and "queueId" in turn
                    and payload["queueId"] != turn["queueId"]):
                duplicates.add(turn_id)
            turn["status"] = status
            if "queueId" in payload:
                turn["queueId"] = payload["queueId"]
        elif entry.get("type") == "task_phase":
            task_id = payload.get("taskId")
            phase, status = payload.get("phase"), payload.get("status")
            attempt, restart_limit = payload.get("attempt"), payload.get("restartLimit")
            if (payload.get("ownerKind") == "turn" and isinstance(task_id, str)
                    and _IDENTIFIER.fullmatch(task_id) and isinstance(phase, str)
                    and phase in _TASK_PHASES and isinstance(status, str)
                    and status in _TERMINAL_TURNS | {"running"}
                    and (turn_ids is None or task_id in turn_ids) and type(attempt) is int
                    and 1 <= attempt <= 1_000 and type(restart_limit) is int
                    and 0 <= restart_limit <= 32):
                phases[task_id] = payload
    for task_id, phase in phases.items():
        turn = turns.get(task_id)
        if turn is None:
            continue
        turn.update(taskPhase=phase["phase"], taskPhaseStatus=phase["status"],
                    taskAttempt=phase["attempt"], taskRestartLimit=phase["restartLimit"])
        if isinstance(phase.get("recoveryReason"), str) and len(phase["recoveryReason"]) <= 256:
            turn["taskRecoveryReason"] = phase["recoveryReason"]
        expected_policy = "manual" if phase.get("status") == "interrupted" else "closed"
        if (phase.get("phase") == "finish" and phase.get("status") in _TERMINAL_TURNS
                and phase.get("resumePolicy") == expected_policy):
            turn["taskResumePolicy"] = phase["resumePolicy"]
    return list(turns.values()), duplicates, overflow


def queue_snapshot(entries: list[dict], *, queue_ids: set[str] | None = None,
                   target_turn_id: str | None = None, receipt_turn_id: str | None = None,
                   limit: int = 257
                   ) -> tuple[dict[str, dict], set[str], bool]:
    """Return a bounded latest queue projection for one queried task."""
    states: dict[str, dict] = {}
    conflicts: set[str] = set()
    overflow = False
    for entry in entries:
        if entry.get("type") != "queue":
            continue
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        queue_id = payload.get("id")
        if not isinstance(queue_id, str) or not _IDENTIFIER.fullmatch(queue_id):
            continue
        selected = queue_ids is None or queue_id in queue_ids
        selected = selected or (target_turn_id is not None and payload.get("kind") == "steering"
                                and payload.get("expectedTurnId") == target_turn_id)
        selected = selected or (receipt_turn_id is not None and payload.get("turnId") == receipt_turn_id)
        if not selected:
            continue
        if queue_id not in states and len(states) >= limit:
            overflow = True
            continue
        previous = states.get(queue_id)
        if previous is not None and any(previous.get(key) != payload.get(key)
                                        for key in _QUEUE_IDENTITY_FIELDS):
            conflicts.add(queue_id)
        states[queue_id] = dict(payload)
    return states, conflicts, overflow


def user_message_refs(entries: list[dict], queue_ids: set[str], *, per_queue_limit: int = 2,
                      revision_id_limit: int = 1_024
                      ) -> tuple[list[dict], set[str], set[str]]:
    """Project bounded identity facts for relevant user messages, never their text."""
    refs: list[dict] = []
    roots: dict[str, int] = {}
    counts: dict[str, int] = {}
    duplicates: set[str] = set()
    conflicts: set[str] = set()
    fields = ("kind", "queueId", "turnId", "source")
    active_turn: str | None = None
    pending: list[int] = []
    first_turn_seen = False
    for entry in entries:
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if entry.get("type") == "turn":
            turn_id = payload.get("turnId")
            if not isinstance(turn_id, str) or not _IDENTIFIER.fullmatch(turn_id):
                continue
            if not first_turn_seen:
                first_turn_seen = True
                for index in pending:
                    refs[index]["inferredTurnId"] = turn_id
                pending.clear()
            if payload.get("status") == "running":
                active_turn = turn_id
            elif payload.get("status") in _TERMINAL_TURNS and active_turn == turn_id:
                active_turn = None
            continue
        if entry.get("type") != "item":
            continue
        item_id = entry.get("id")
        if not isinstance(item_id, str):
            continue
        target_id = payload.get("revises")
        root = roots.get(target_id) if isinstance(target_id, str) else None
        if root is None and payload.get("kind") == "userMessage":
            queue_id = payload.get("queueId")
            if queue_id not in queue_ids:
                continue
            counts[queue_id] = counts.get(queue_id, 0) + 1
            if counts[queue_id] > 1:
                duplicates.add(queue_id)
            if counts[queue_id] > per_queue_limit:
                continue
            root = len(refs)
            explicit_turn_id = payload.get("turnId")
            refs.append({**{key: payload[key] for key in fields if key in payload},
                         "id": item_id, "inferredTurnId": explicit_turn_id
                         if isinstance(explicit_turn_id, str) else active_turn,
                         "revisionOverflow": False})
            if len(roots) < revision_id_limit:
                roots[item_id] = root
            else:
                refs[root]["revisionOverflow"] = True
                conflicts.add(queue_id)
            if not isinstance(explicit_turn_id, str) and active_turn is None and not first_turn_seen:
                pending.append(root)
        elif root is not None:
            reference = refs[root]
            previous_queue_id = reference.get("queueId")
            if previous_queue_id not in queue_ids:
                continue
            if len(roots) >= revision_id_limit and item_id not in roots:
                reference["revisionOverflow"] = True
                conflicts.add(previous_queue_id)
                continue
            roots[item_id] = root
            for key in fields:
                if key in payload:
                    if key == "queueId" and payload[key] != previous_queue_id:
                        conflicts.add(previous_queue_id)
                        if payload[key] in queue_ids:
                            conflicts.add(payload[key])
                    reference[key] = payload[key]
        if root is not None and item_id not in roots and len(roots) < revision_id_limit:
            roots.setdefault(item_id, root)
    return refs, duplicates, conflicts


def resolve_queue_relation(queue: dict, turns: list[dict], user_items: list[dict],
                           *, duplicate_turns: set[str] | None = None,
                           identity_conflict: bool = False,
                           duplicate_user_message: bool = False,
                           revision_conflict: bool = False) -> dict:
    """Resolve a queue's delivery/steering edge without trusting receipt IDs alone."""
    queue_id = queue.get("id")
    kind = queue.get("kind")
    duplicate_turns = duplicate_turns or set()
    turn_map = {turn["turnId"]: turn for turn in turns if isinstance(turn.get("turnId"), str)}
    turn_links = {turn["turnId"] for turn in turns if turn.get("queueId") == queue_id}
    normal_user_links: set[str] = set()
    steering_user_links: set[str] = set()
    conflicting_item = False

    for item in user_items:
        if item.get("kind") != "userMessage" or item.get("queueId") != queue_id:
            continue
        explicit = item.get("turnId")
        inferred = item.get("inferredTurnId")
        if explicit is not None and (not isinstance(explicit, str) or not _IDENTIFIER.fullmatch(explicit)):
            conflicting_item = True
            continue
        if isinstance(explicit, str) and isinstance(inferred, str) and explicit != inferred:
            conflicting_item = True
            continue
        owner = explicit if isinstance(explicit, str) else inferred
        if not isinstance(owner, str) or not _IDENTIFIER.fullmatch(owner):
            conflicting_item = True
            continue
        (steering_user_links if item.get("source") == "steering" else normal_user_links).add(owner)

    receipt_turn = queue.get("turnId")
    if receipt_turn is not None and (not isinstance(receipt_turn, str)
                                     or not _IDENTIFIER.fullmatch(receipt_turn)):
        return {"ownership": "conflict", "turnId": None, "relation": None, "candidates": set()}

    candidates = turn_links | normal_user_links | steering_user_links
    if receipt_turn is not None:
        candidates.add(receipt_turn)
    if (identity_conflict or conflicting_item or duplicate_user_message or revision_conflict
            or len(turn_links | normal_user_links | steering_user_links) > 1):
        return {"ownership": "conflict", "turnId": None, "relation": None, "candidates": candidates}
    if candidates & duplicate_turns:
        return {"ownership": "conflict", "turnId": None, "relation": None, "candidates": candidates}

    if kind == "followUp":
        if steering_user_links:
            return {"ownership": "conflict", "turnId": None, "relation": None, "candidates": candidates}
        if len(turn_links) == 1 and turn_links == normal_user_links:
            turn_id = next(iter(turn_links))
            if turn_id not in turn_map or (receipt_turn is not None and receipt_turn != turn_id):
                return {"ownership": "conflict", "turnId": None, "relation": None,
                        "candidates": candidates}
            return {"ownership": "resolved", "turnId": turn_id,
                    "relation": "delivered_as", "candidates": candidates}
        if turn_links or normal_user_links or receipt_turn is not None:
            return {"ownership": "unresolved", "turnId": None, "relation": None,
                    "candidates": candidates}
        ownership = "unassigned" if queue.get("status") in {"queued", "delivering"} else "root"
        return {"ownership": ownership, "turnId": None, "relation": None, "candidates": candidates}

    if kind == "steering":
        if turn_links or normal_user_links:
            return {"ownership": "conflict", "turnId": None, "relation": None, "candidates": candidates}
        target = queue.get("expectedTurnId")
        if not isinstance(target, str) or not _IDENTIFIER.fullmatch(target) or target not in turn_map:
            return {"ownership": "unresolved", "turnId": None, "relation": None, "candidates": candidates}
        if (steering_user_links and steering_user_links != {target}) or (
                receipt_turn is not None and receipt_turn != target):
            return {"ownership": "conflict", "turnId": None, "relation": None,
                    "candidates": candidates | {target}}
        if queue.get("status") == "delivered" and steering_user_links != {target}:
            return {"ownership": "unresolved", "turnId": None, "relation": None,
                    "candidates": candidates | {target}}
        return {"ownership": "resolved", "turnId": target,
                "relation": "targets", "candidates": candidates | {target}}

    return {"ownership": "conflict", "turnId": None, "relation": None, "candidates": candidates}


def resolve_compaction_relation(job: dict, thread_id: str, turns: list[dict], *,
                                checkpoint_turn_id: str | None = None,
                                duplicate_turns: set[str] | None = None) -> dict:
    """Resolve only automatic-summary ownership; source turn is never an owner."""
    if job.get("threadId") != thread_id:
        return {"ownership": "conflict", "turnId": None}
    turn_id, reason = job.get("turnId"), job.get("reason")
    if turn_id is None and reason is None:
        if checkpoint_turn_id is not None:
            return {"ownership": "conflict", "turnId": None}
        return {"ownership": "independent", "turnId": None}
    if (not isinstance(turn_id, str) or not _IDENTIFIER.fullmatch(turn_id)
            or reason not in _AUTO_COMPACTION_REASONS):
        return {"ownership": "unresolved", "turnId": None}
    if checkpoint_turn_id is not None and checkpoint_turn_id != turn_id:
        return {"ownership": "conflict", "turnId": None}
    if turn_id in (duplicate_turns or set()):
        return {"ownership": "conflict", "turnId": None}
    matches = [turn for turn in turns if turn.get("turnId") == turn_id]
    if len(matches) != 1:
        return {"ownership": "unresolved", "turnId": None}
    return {"ownership": "resolved", "turnId": turn_id}


def recovery_policy(kind: str, status: str, *, runtime_owned: bool,
                    persisted_policy: str | None = None) -> str:
    if runtime_owned:
        return "process_owned"
    if (kind == "turn" and persisted_policy == "manual" and status == "interrupted"):
        return "manual_review"
    if (kind == "turn" and persisted_policy == "closed" and status in _TERMINAL_TURNS - {"interrupted"}):
        return persisted_policy
    if kind == "turn":
        if status == "interrupted" or status == "running":
            return "manual_review"
        return "closed"
    if kind == "queue":
        if status == "queued":
            return "queue_pending"
        if status in {"delivering", "paused"}:
            return "manual_review"
        return "closed"
    if status == "completed":
        return "closed"
    if status in {"running", "failed", "cancelled"}:
        return "manual_review"
    return "manual_review"
