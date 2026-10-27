"""Durable sessions: append-only JSONL rollouts with a rebuildable SQLite index.

The transport's ordered event journal is separate from model-visible history.
Forks copy a complete, settled rollout prefix and never replay tool side effects.
Pi reference: 5ba1cbaf3d96d204d847c84ce235c62dae23e0fd, SessionManager.
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import re
import sqlite3
import stat
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from boss_harness.persistence import PersistenceIndex
from boss_harness.models.capabilities import REASONING_EFFORTS

_THREAD_ID = re.compile(r"[a-f0-9]{12}\Z")
_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
_EVENT_ID = re.compile(r"[a-f0-9]{32}\Z")
_TERMINAL = frozenset({"completed", "interrupted", "blocked", "error"})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _limit(value: int, maximum: int = 200) -> int:
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError(f"limit 必须是 1 到 {maximum} 之间的整数")
    return value


def _identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise ValueError(f"{label} 格式无效")
    return value


def _event_cursor(value: str | None) -> int:
    if value is None:
        return 0
    if (not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,18}", value)
            or int(value) > 2**63 - 1):
        raise ValueError("eventCursor 必须是有效的非负十进制字符串")
    return int(value)


def _page_cursor(kind: str, scope: dict, key: list) -> str:
    payload = _json({"kind": kind, "scope": scope, "key": key}).encode()
    return "p1_" + base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _read_page_cursor(cursor: str | None, kind: str, scope: dict) -> list | None:
    if cursor is None:
        return None
    if not isinstance(cursor, str) or not cursor.startswith("p1_") or len(cursor) > 4096:
        raise ValueError("分页游标无效")
    encoded = cursor[3:]
    try:
        raw = base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError, binascii.Error):
        raise ValueError("分页游标无效") from None
    if (not isinstance(payload, dict) or set(payload) != {"kind", "scope", "key"}
            or payload["kind"] != kind or payload["scope"] != scope
            or not isinstance(payload["key"], list)):
        raise ValueError("分页游标与查询范围不匹配")
    return payload["key"]


@dataclass
class Entry:
    type: str
    id: str = field(default_factory=_new_id)
    parent_id: str | None = None
    timestamp: str = field(default_factory=_now)
    payload: dict | None = None

    def to_dict(self) -> dict:
        data: dict = {"type": self.type, "id": self.id, "parentId": self.parent_id,
                      "timestamp": self.timestamp}
        if self.payload is not None:
            data["payload"] = self.payload
        return data


class CheckpointCommitUncertain(RuntimeError):
    """The checkpoint publication outcome could not be established."""

    code = "COMPACTION_COMMIT_UNCERTAIN"

    def __init__(self, checkpoint_id: str) -> None:
        self.checkpoint_id = checkpoint_id
        super().__init__(f"摘要检查点 {checkpoint_id} 的提交结果无法确认，可能已经生效；请先核对会话，避免自动重试。")


class CheckpointCommittedError(RuntimeError):
    """A published checkpoint must not be reported as an uncommitted failure."""

    code = "COMPACTION_COMMITTED_REFRESH_FAILED"

    def __init__(self, checkpoint_id: str) -> None:
        self.checkpoint_id = checkpoint_id
        super().__init__(f"摘要检查点 {checkpoint_id} 已经生效，但提交后的状态刷新失败；请重新读取会话，勿重复提交。")


class ToolRevisionPersistenceError(OSError):
    """A tool result revision could not be confirmed as durably present."""

    def __init__(self, outcome: str) -> None:
        self.outcome = outcome
        super().__init__("工具结果无法确认已持久化")


class SessionStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.database_path = self.root.parent / "state.sqlite3"
        self.events_path = self.root.parent / "events.jsonl"
        self._index = PersistenceIndex(self.database_path)
        self._refresh_threads()
        self._sync_events()

    def close(self) -> None:
        """Connections are operation-scoped; retained for explicit owner cleanup."""

    def path_for(self, thread_id: str) -> Path:
        if not isinstance(thread_id, str) or not _THREAD_ID.fullmatch(thread_id):
            raise ValueError("threadId 格式无效")
        return self.root / f"{thread_id}.jsonl"

    def require_thread(self, thread_id: str) -> dict:
        path = self.path_for(thread_id)
        with self._lock:
            try:
                with path.open(encoding="utf-8", errors="replace") as handle:
                    header = json.loads(handle.readline())
            except FileNotFoundError:
                raise ValueError("会话不存在") from None
            except (ValueError, IndexError):
                raise ValueError("会话头损坏，请保留原文件后恢复") from None
            if not isinstance(header, dict) or header.get("type") != "session" or header.get("id") != thread_id:
                raise ValueError("会话头无效")
            return header

    @staticmethod
    def _append_line(path: Path, value: dict) -> None:
        encoded = (_json(value) + "\n").encode("utf-8")
        with path.open("ab+") as handle:
            handle.seek(0, 2)
            if handle.tell():
                handle.seek(-1, 2)
                if handle.read(1) != b"\n":
                    handle.seek(0, 2)
                    handle.write(b"\n")
            handle.seek(0, 2)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())

    def _write_new(self, header: dict, entries: list[dict] | None = None) -> dict:
        path = self.path_for(header["id"])
        encoded = ("\n".join([_json(header), *(_json(entry) for entry in entries or [])]) + "\n").encode("utf-8")
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        with self._lock, self._index.transaction() as connection:
            # Publish a complete rollout only after fsync. Hard-link creation is
            # atomic and refuses to overwrite an existing thread on an ID collision.
            try:
                with temporary.open("xb") as handle:
                    handle.write(encoded)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.link(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
            self._index_thread(header["id"], connection)
        return self.get_thread(header["id"])

    def create(self, title: str = "新会话", **metadata: Any) -> dict:
        if not isinstance(title, str):
            raise ValueError("title 必须是字符串")
        changes = self._validate_changes(metadata)
        header = {"type": "session", "version": 2, "id": uuid.uuid4().hex[:12],
                  "sessionId": uuid.uuid4().hex, "title": title, "createdAt": _now(),
                  "archived": False, **changes}
        return self._write_new(header)

    def append(self, thread_id: str, entry: Entry) -> Entry:
        # SQLite's writer transaction also serializes JSONL appends across store instances.
        with self._lock, self._index.transaction() as connection:
            self.require_thread(thread_id)
            self._append_line(self.path_for(thread_id), entry.to_dict())
            self._index_thread(thread_id, connection)
        return entry

    def append_tool_revision(self, thread_id: str, entry: Entry) -> tuple[Entry, bool]:
        """Append a terminal tool revision, reconciling one ambiguous failure.

        The entry identity and payload are fixed before this method is called.
        A result that reached JSONL is fsynced and reused; a missing result gets
        at most one append retry. No handler or approval is replayed here.
        """
        payload = entry.payload or {}
        if (entry.type != "item" or payload.get("kind") != "toolCall"
                or not isinstance(payload.get("revises"), str)):
            raise ValueError("工具结果修订格式无效")
        path = self.path_for(thread_id)
        expected = entry.to_dict()
        outcome = "absent"
        last_error: Exception | None = None

        def inspect_and_sync() -> str:
            nonlocal outcome
            found = False
            with path.open("rb") as handle:
                for line in handle:
                    try:
                        current = json.loads(line)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        continue
                    if isinstance(current, dict) and current.get("id") == entry.id:
                        if current != expected:
                            return "conflict"
                        found = True
            if not found:
                return "absent"
            try:
                with path.open("r+b") as handle:
                    os.fsync(handle.fileno())
            except OSError:
                return "present_uncertain"
            return "durable"

        try:
            with self._lock, self._index.transaction() as connection:
                self.require_thread(thread_id)
                self._append_line(path, expected)
                self._index_thread(thread_id, connection)
            return entry, False
        except Exception as exc:
            last_error = exc

        for attempt in range(2):
            try:
                with self._lock, self._index.transaction() as connection:
                    self.require_thread(thread_id)
                    outcome = inspect_and_sync()
                    if outcome == "durable":
                        self._index_thread(thread_id, connection)
                        return entry, True
                    if outcome in {"conflict", "present_uncertain"}:
                        raise ToolRevisionPersistenceError(outcome)
                    if attempt == 0:
                        self._append_line(path, expected)
                        self._index_thread(thread_id, connection)
                        return entry, True
            except ToolRevisionPersistenceError:
                raise
            except Exception as exc:
                last_error = exc
                try:
                    with self._lock, self._index.transaction():
                        self.require_thread(thread_id)
                        outcome = inspect_and_sync()
                    if outcome == "durable":
                        return entry, True
                except Exception as reconcile_error:
                    last_error = reconcile_error
                    outcome = "uncertain"
                if outcome in {"conflict", "present_uncertain"}:
                    raise ToolRevisionPersistenceError(outcome) from exc
            if attempt == 1 or outcome != "absent":
                raise ToolRevisionPersistenceError(outcome) from last_error
        raise ToolRevisionPersistenceError(outcome) from last_error

    def append_checkpoint(self, thread_id: str, entry_factory: Callable[[], Entry], *,
                          on_committed: Callable[[], None] | None = None) -> Entry:
        """Publish a fully fsynced checkpoint copy on a local filesystem.

        The writer transaction covers source validation and publication across
        store instances. Replacement is the process-visible commit point; this
        does not add a directory-fsync or power-loss durability guarantee.
        """
        if not callable(entry_factory) or (on_committed is not None and not callable(on_committed)):
            raise ValueError("摘要提交回调必须可调用")
        temporary: Path | None = None
        entry: Entry | None = None
        committed = False
        try:
            with self._lock, self._index.transaction() as connection:
                path = self.path_for(thread_id)
                original = path.lstat()
                current_uid = getattr(os, "getuid", None)
                if (not stat.S_ISREG(original.st_mode) or original.st_nlink != 1
                        or current_uid is None or original.st_uid != current_uid()):
                    raise ValueError("摘要仅支持当前用户拥有的普通单链接会话文件")
                original_identity = (original.st_dev, original.st_ino)
                original_signature = (original.st_dev, original.st_ino, original.st_size,
                                      original.st_mtime_ns, original.st_ctime_ns,
                                      original.st_mode, original.st_uid, original.st_gid, original.st_nlink)
                with path.open("rb") as source:
                    opened = os.fstat(source.fileno())
                    opened_signature = (opened.st_dev, opened.st_ino, opened.st_size,
                                        opened.st_mtime_ns, opened.st_ctime_ns,
                                        opened.st_mode, opened.st_uid, opened.st_gid, opened.st_nlink)
                    if opened_signature != original_signature or not stat.S_ISREG(opened.st_mode):
                        raise ValueError("会话文件已变化，请重新读取摘要来源")
                    self.require_thread(thread_id)
                    # This callback must read/validate the final source without
                    # opening a second SQLite writer transaction.
                    entry = entry_factory()
                    if not isinstance(entry, Entry) or entry.type != "context_checkpoint":
                        raise ValueError("摘要提交必须构造 context_checkpoint 条目")
                    encoded = (_json(entry.to_dict()) + "\n").encode("utf-8")
                    candidate_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.checkpoint.tmp")
                    descriptor = os.open(candidate_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    temporary = candidate_path
                    with os.fdopen(descriptor, "wb") as target:
                        last_byte = b""
                        while chunk := source.read(1024 * 1024):
                            target.write(chunk)
                            last_byte = chunk[-1:]
                        if last_byte and last_byte != b"\n":
                            target.write(b"\n")
                        target.write(encoded)
                        target.flush()
                        os.fchown(target.fileno(), -1, original.st_gid)
                        os.fchmod(target.fileno(), stat.S_IMODE(original.st_mode))
                        os.fsync(target.fileno())
                        candidate = os.fstat(target.fileno())
                        candidate_identity = (candidate.st_dev, candidate.st_ino)
                    copied = os.fstat(source.fileno())
                    copied_signature = (copied.st_dev, copied.st_ino, copied.st_size,
                                        copied.st_mtime_ns, copied.st_ctime_ns,
                                        copied.st_mode, copied.st_uid, copied.st_gid, copied.st_nlink)
                    if copied_signature != original_signature:
                        raise ValueError("会话文件在摘要复制期间变化，请重新读取摘要来源")
                candidate_stat = temporary.lstat()
                candidate_signature = (candidate_stat.st_dev, candidate_stat.st_ino,
                                       candidate_stat.st_size, candidate_stat.st_mtime_ns,
                                       candidate_stat.st_ctime_ns, candidate_stat.st_mode,
                                       candidate_stat.st_uid, candidate_stat.st_gid, candidate_stat.st_nlink)
                expected_candidate_signature = (candidate_identity[0], candidate_identity[1],
                    candidate.st_size, candidate.st_mtime_ns, candidate.st_ctime_ns, candidate.st_mode,
                    candidate.st_uid, candidate.st_gid, candidate.st_nlink)
                if candidate_signature != expected_candidate_signature:
                    raise ValueError("已同步的摘要候选文件在发布前变化")
                visible_before_replace = path.lstat()
                visible_signature = (visible_before_replace.st_dev, visible_before_replace.st_ino,
                                     visible_before_replace.st_size, visible_before_replace.st_mtime_ns,
                                     visible_before_replace.st_ctime_ns, visible_before_replace.st_mode,
                                     visible_before_replace.st_uid, visible_before_replace.st_gid,
                                     visible_before_replace.st_nlink)
                if visible_signature != original_signature or not stat.S_ISREG(visible_before_replace.st_mode):
                    raise ValueError("会话文件在摘要发布前变化，请重新读取摘要来源")
                try:
                    os.replace(temporary, path)
                except Exception as exc:
                    try:
                        visible = path.lstat()
                    except OSError:
                        raise CheckpointCommitUncertain(entry.id) from exc
                    visible_identity = (visible.st_dev, visible.st_ino)
                    if visible_identity == original_identity:
                        raise
                    if visible_identity != candidate_identity or not stat.S_ISREG(visible.st_mode):
                        raise CheckpointCommitUncertain(entry.id) from exc
                    # This is identity with the already-fsynced inode, not a
                    # content readback pretending that a failed fsync succeeded.
                else:
                    try:
                        visible = path.lstat()
                    except OSError as exc:
                        raise CheckpointCommitUncertain(entry.id) from exc
                    if ((visible.st_dev, visible.st_ino) != candidate_identity
                            or not stat.S_ISREG(visible.st_mode)):
                        raise CheckpointCommitUncertain(entry.id)
                committed = True
                if on_committed is not None:
                    on_committed()
                self._index_thread(thread_id, connection)
            return entry
        except Exception as exc:
            if committed and entry is not None:
                raise CheckpointCommittedError(entry.id) from exc
            raise
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except Exception:
                    pass  # Cleanup cannot undo or obscure the publication result.

    def last_entry_id(self, thread_id: str) -> str | None:
        entries = self.read_entries(thread_id)
        return entries[-1]["id"] if entries else None

    def read_entries(self, thread_id: str) -> list[dict]:
        with self._lock:
            self.require_thread(thread_id)
            content = self.path_for(thread_id).read_text(encoding="utf-8", errors="replace")
        out: list[dict] = []
        for line in content.split("\n"):
            if not line.strip():
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (isinstance(data, dict) and data.get("type") != "session"
                    and isinstance(data.get("id"), str) and isinstance(data.get("payload"), dict)):
                out.append(data)
        return out

    def read(self, thread_id: str) -> list[dict]:
        """Read all rollout entries, including queue/context/approval extension records."""
        return self.read_entries(thread_id)

    @staticmethod
    def _project_items(thread_id: str, entries: list[dict]) -> list[dict]:
        """One logical item for each original ID; revisions retain all structured fields."""
        items: list[dict] = []
        index_by_id: dict[str, int] = {}
        for entry in entries:
            if entry.get("type") != "item":
                continue
            payload = dict(entry.get("payload") or {})
            entry_id = str(entry.get("id") or "")
            target_id = str(payload.get("revises") or "")
            if not target_id and payload.get("kind") == "toolCall" and payload.get("status") != "running":
                parent_id = str(entry.get("parentId") or "")
                if parent_id in index_by_id and items[index_by_id[parent_id]].get("kind") == "toolCall":
                    target_id = parent_id
            if target_id and target_id in index_by_id:
                slot = index_by_id[target_id]
                items[slot] = {**items[slot], **payload, "id": items[slot]["id"], "threadId": thread_id}
                index_by_id[entry_id] = slot
            else:
                index_by_id[entry_id] = len(items)
                items.append({**payload, "id": entry_id, "threadId": thread_id})
        return items

    def read_items(self, thread_id: str) -> list[dict]:
        return self._project_items(thread_id, self.read_entries(thread_id))

    @staticmethod
    def _item_owners(entries: list[dict]) -> dict[str, str | None]:
        """Resolve both explicit turn IDs and legacy user-before-turn/revision ordering."""
        owners: dict[str, str | None] = {}
        pending: list[str] = []
        seen_turns: set[str] = set()
        active: str | None = None
        for entry in entries:
            payload = entry["payload"]
            if entry.get("type") == "item":
                target = payload.get("revises")
                if not target and payload.get("kind") == "toolCall" and payload.get("status") != "running":
                    target = entry.get("parentId")
                explicit = payload.get("turnId")
                owner = explicit if isinstance(explicit, str) else owners.get(target) or active
                owners[entry["id"]] = owner
                if owner is None:
                    pending.append(entry["id"])
            elif entry.get("type") == "turn":
                turn_id = payload.get("turnId")
                if not isinstance(turn_id, str) or not _IDENTIFIER.fullmatch(turn_id):
                    continue
                if turn_id not in seen_turns:
                    for entry_id in pending:
                        owners[entry_id] = turn_id
                    pending.clear()
                    seen_turns.add(turn_id)
                if payload.get("status") == "running":
                    active = turn_id
                elif payload.get("status") in _TERMINAL and active == turn_id:
                    active = None
        return owners

    @staticmethod
    def _turns(entries: list[dict], thread_id: str) -> list[dict]:
        turns: dict[str, dict] = {}
        previous_end = -1
        for ordinal, entry in enumerate(entries):
            if entry.get("type") != "turn":
                continue
            payload = entry["payload"]
            turn_id = payload.get("turnId")
            if not isinstance(turn_id, str) or not _IDENTIFIER.fullmatch(turn_id):
                continue
            turn = turns.get(turn_id)
            if turn is None:
                turn = {"turnId": turn_id, "threadId": thread_id,
                        "startedAt": entry.get("timestamp", ""), "firstOrdinal": previous_end + 1}
                turns[turn_id] = turn
            first_ordinal = turn["firstOrdinal"]
            boundary_ordinal = turn.get("boundaryOrdinal")
            turn.update(payload)
            turn.update(threadId=thread_id, turnId=turn_id, firstOrdinal=first_ordinal,
                        lastOrdinal=ordinal, updatedAt=entry.get("timestamp", ""))
            if boundary_ordinal is not None:
                turn["boundaryOrdinal"] = boundary_ordinal
            if turn.get("status") in _TERMINAL:
                turn.setdefault("boundaryOrdinal", ordinal)
                turn.setdefault("completedAt", entry.get("timestamp", ""))
                previous_end = ordinal
        return list(turns.values())

    @staticmethod
    def _public_turn(turn: dict) -> dict:
        return {key: value for key, value in turn.items()
                if key not in {"firstOrdinal", "lastOrdinal", "boundaryOrdinal"}}

    def _index_thread(self, thread_id: str, connection: sqlite3.Connection) -> None:
        path = self.path_for(thread_id)
        header = self.require_thread(thread_id)
        stat = path.stat()
        previous = connection.execute(
            "SELECT indexed_size,indexed_mtime_ns FROM threads WHERE id=?", (thread_id,)
        ).fetchone()
        if previous and tuple(previous) == (stat.st_size, stat.st_mtime_ns):
            return
        entries = self.read_entries(thread_id)
        metadata = {key: value for key, value in header.items() if key not in {"type", "version"}}
        for entry in entries:
            if entry.get("type") == "thread_info":
                # Unknown existing fields are retained, and the raw header is never rewritten.
                metadata.update({key: value for key, value in entry["payload"].items()
                                 if key not in {"id", "sessionId", "createdAt"}})
        metadata.update(id=thread_id, sessionId=header.get("sessionId") or thread_id,
                        title=metadata.get("title", "未命名会话"),
                        createdAt=header.get("createdAt", ""),
                        updatedAt=datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                        archived=bool(metadata.get("archived", False)))
        turns = self._turns(entries, thread_id)
        metadata["lastTurn"] = self._public_turn(turns[-1]) if turns else None
        connection.execute("""INSERT INTO threads
            (id,session_id,rollout_path,title,project_id,archived,created_at,updated_at,
             last_turn_id,metadata_json,indexed_size,indexed_mtime_ns)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            session_id=excluded.session_id,rollout_path=excluded.rollout_path,title=excluded.title,
            project_id=excluded.project_id,archived=excluded.archived,created_at=excluded.created_at,
            updated_at=excluded.updated_at,last_turn_id=excluded.last_turn_id,
            metadata_json=excluded.metadata_json,indexed_size=excluded.indexed_size,
            indexed_mtime_ns=excluded.indexed_mtime_ns""",
            (thread_id, metadata["sessionId"], str(path), metadata["title"], metadata.get("projectId"),
             int(metadata["archived"]), metadata["createdAt"], metadata["updatedAt"],
             turns[-1]["turnId"] if turns else None, _json(metadata), stat.st_size, stat.st_mtime_ns))
        connection.execute("DELETE FROM turns WHERE thread_id=?", (thread_id,))
        for turn in turns:
            connection.execute("""INSERT INTO turns
                (thread_id,turn_id,status,first_ordinal,last_ordinal,metadata_json) VALUES(?,?,?,?,?,?)""",
                (thread_id, turn["turnId"], turn.get("status", "error"), turn["firstOrdinal"],
                 turn["lastOrdinal"], _json(self._public_turn(turn))))

    def _sync_thread(self, thread_id: str) -> None:
        with self._lock, self._index.transaction() as connection:
            self._index_thread(thread_id, connection)

    def _refresh_threads(self) -> None:
        with self._lock, self._index.transaction() as connection:
            known: set[str] = set()
            for path in sorted(self.root.glob("*.jsonl")):
                try:
                    self._index_thread(path.stem, connection)
                except (OSError, ValueError):
                    continue
                known.add(path.stem)
            for row in connection.execute("SELECT id,rollout_path FROM threads").fetchall():
                if Path(row["rollout_path"]).parent == self.root and row["id"] not in known:
                    connection.execute("DELETE FROM threads WHERE id=?", (row["id"],))

    def get_thread(self, thread_id: str) -> dict:
        self._sync_thread(thread_id)
        with self._index.connection() as connection:
            row = connection.execute("SELECT metadata_json FROM threads WHERE id=?", (thread_id,)).fetchone()
        if row is None:
            raise ValueError("会话不存在")
        return json.loads(row["metadata_json"])

    @staticmethod
    def _validate_changes(changes: dict) -> dict:
        changes = dict(changes)
        if "project_id" in changes:
            if "projectId" in changes:
                raise ValueError("projectId 不可重复提供")
            changes["projectId"] = changes.pop("project_id")
        if set(changes) - {"title", "projectId", "model", "cwd", "toolPolicy", "reasoningEffort"}:
            raise ValueError("会话元数据包含不支持的更新字段")
        for key, value in changes.items():
            if key == "toolPolicy" and (not isinstance(value, str) or value not in {"readOnly", "approval"}):
                raise ValueError("toolPolicy 必须是 readOnly 或 approval")
            if key == "reasoningEffort" and value is not None and value not in REASONING_EFFORTS:
                raise ValueError("reasoningEffort 档位无效")
            if key == "title" and not isinstance(value, str):
                raise ValueError("title 必须是字符串")
            if key in {"projectId", "cwd"} and value is not None and not isinstance(value, str):
                raise ValueError(f"{key} 必须是字符串或 null")
            if key == "model" and value is not None and not isinstance(value, (str, dict)):
                raise ValueError("model 必须是字符串、对象或 null")
        _json(changes)
        return changes

    def update_thread(self, thread_id: str, **changes: Any) -> dict:
        changes = self._validate_changes(changes)
        if changes:
            self.append(thread_id, Entry(type="thread_info", parent_id=self.last_entry_id(thread_id), payload=changes))
        return self.get_thread(thread_id)

    def archive_thread(self, thread_id: str) -> dict:
        if not self.get_thread(thread_id)["archived"]:
            self.append(thread_id, Entry(type="thread_info", parent_id=self.last_entry_id(thread_id), payload={"archived": True}))
        return self.get_thread(thread_id)

    def unarchive_thread(self, thread_id: str) -> dict:
        if self.get_thread(thread_id)["archived"]:
            self.append(thread_id, Entry(type="thread_info", parent_id=self.last_entry_id(thread_id), payload={"archived": False}))
        return self.get_thread(thread_id)

    archive = archive_thread
    unarchive = unarchive_thread

    def list_threads(self, *, include_archived: bool = False) -> list[dict]:
        self._refresh_threads()
        with self._index.connection() as connection:
            rows = connection.execute("SELECT metadata_json FROM threads" +
                ("" if include_archived else " WHERE archived=0") + " ORDER BY updated_at DESC,id DESC").fetchall()
        return [json.loads(row["metadata_json"]) for row in rows]

    def list_threads_page(self, *, cursor: str | None = None, limit: int = 50,
                          archived: bool = False, project_id: str | None = None) -> dict:
        _limit(limit)
        if type(archived) is not bool or (project_id is not None and not isinstance(project_id, str)):
            raise ValueError("会话筛选参数无效")
        scope = {"archived": archived, "projectId": project_id}
        key = _read_page_cursor(cursor, "threads", scope)
        parameters: list[Any] = [int(archived)]
        query = "SELECT * FROM threads WHERE archived=?"
        if project_id is not None:
            query += " AND project_id=?"
            parameters.append(project_id)
        if key is not None:
            if len(key) != 2 or not isinstance(key[0], str) or not isinstance(key[1], str) or not _THREAD_ID.fullmatch(key[1]):
                raise ValueError("会话分页游标无效")
            try:
                datetime.fromisoformat(key[0])
            except ValueError:
                raise ValueError("会话分页游标无效") from None
            query += " AND (updated_at<? OR (updated_at=? AND id<?))"
            parameters.extend([key[0], key[0], key[1]])
        query += " ORDER BY updated_at DESC,id DESC LIMIT ?"
        parameters.append(limit + 1)
        self._refresh_threads()
        with self._index.connection() as connection:
            rows = connection.execute(query, parameters).fetchall()
        page = rows[:limit]
        next_cursor = (_page_cursor("threads", scope, [page[-1]["updated_at"], page[-1]["id"]])
                       if len(rows) > limit else None)
        return {"threads": [json.loads(row["metadata_json"]) for row in page], "nextCursor": next_cursor}

    def record_turn(self, thread_id: str, turn_id: str, status: str, **fields: Any) -> None:
        _identifier(turn_id, "turnId")
        if not isinstance(status, str) or status not in _TERMINAL | {"running"}:
            raise ValueError("回合状态无效")
        if set(fields) & {"turnId", "status", "threadId", "firstOrdinal", "lastOrdinal", "boundaryOrdinal"}:
            raise ValueError("回合身份与状态不可重复提供")
        self.append(thread_id, Entry(type="turn", parent_id=self.last_entry_id(thread_id),
                    payload={**fields, "turnId": turn_id, "status": status}))

    def last_turn(self, thread_id: str) -> dict | None:
        return self.get_thread(thread_id).get("lastTurn")

    def get_turn(self, thread_id: str, turn_id: str) -> dict:
        _identifier(turn_id, "turnId")
        self._sync_thread(thread_id)
        with self._index.connection() as connection:
            row = connection.execute("SELECT * FROM turns WHERE thread_id=? AND turn_id=?", (thread_id, turn_id)).fetchone()
        if row is None:
            raise ValueError("回合不存在")
        rollout = self.read_entries(thread_id)
        owners = self._item_owners(rollout)
        entries = [entry for entry in rollout if owners.get(entry["id"]) == turn_id]
        return {**json.loads(row["metadata_json"]), "items": self._project_items(thread_id, entries)}

    def list_turns(self, thread_id: str, *, cursor: str | None = None, limit: int = 50) -> dict:
        _limit(limit)
        self.path_for(thread_id)
        scope = {"threadId": thread_id}
        key = _read_page_cursor(cursor, "turns", scope)
        query = "SELECT * FROM turns WHERE thread_id=?"
        parameters: list[Any] = [thread_id]
        if key is not None:
            if len(key) != 2 or type(key[0]) is not int or key[0] < 0:
                raise ValueError("回合分页游标无效")
            _identifier(key[1], "turnId")
            query += " AND (first_ordinal>? OR (first_ordinal=? AND turn_id>?))"
            parameters.extend([key[0], key[0], key[1]])
        query += " ORDER BY first_ordinal,turn_id LIMIT ?"
        parameters.append(limit + 1)
        self._sync_thread(thread_id)
        with self._index.connection() as connection:
            rows = connection.execute(query, parameters).fetchall()
        page = rows[:limit]
        next_cursor = (_page_cursor("turns", scope, [page[-1]["first_ordinal"], page[-1]["turn_id"]])
                       if len(rows) > limit else None)
        return {"turns": [json.loads(row["metadata_json"]) for row in page], "nextCursor": next_cursor}

    def fork_thread(self, thread_id: str, *, turn_id: str | None = None, title: str | None = None) -> dict:
        with self._lock:
            source = self.get_thread(thread_id)
            entries = self.read_entries(thread_id)
            turns = self._turns(entries, thread_id)
            if turn_id is None:
                selected = turns[-1] if turns else None
            else:
                _identifier(turn_id, "turnId")
                selected = next((turn for turn in turns if turn["turnId"] == turn_id), None)
            if selected is None or selected.get("status") not in _TERMINAL:
                raise ValueError("仅可从已经结束的回合创建分支")
            cutoff = selected.get("boundaryOrdinal", selected["lastOrdinal"])
            prefix = entries[:cutoff + 1]
            included_turns = {entry["payload"]["turnId"] for entry in prefix
                              if entry.get("type") == "turn" and "turnId" in entry["payload"]}
            owners = self._item_owners(entries)
            # Recovery may append a revision after later settled turns. Include only
            # corrections owned by the selected prefix, never those unrelated turns.
            for entry in entries[cutoff + 1:]:
                if ((entry.get("type") == "item" and owners.get(entry["id"]) in included_turns)
                        or (entry.get("type") == "turn" and entry["payload"].get("turnId") in included_turns)):
                    prefix.append(entry)
            projected = self._project_items(thread_id, prefix)
            for item in projected:
                approval = item.get("approval") or {}
                if item.get("status") == "running" or (approval and not approval.get("decision")):
                    raise ValueError("回合中仍有未收尾条目或审批，不能创建分支")
            batches = {item["toolBatchId"] for item in projected if item.get("toolBatchId")}
            included_items = {item["id"] for item in projected}
            if any(item.get("toolBatchId") in batches and item["id"] not in included_items
                   for item in self._project_items(thread_id, entries)):
                raise ValueError("分支边界会拆开工具批次")
            header = {key: value for key, value in source.items()
                      if key not in {"id", "sessionId", "createdAt", "updatedAt", "lastTurn"}}
            header.update(type="session", version=2, id=uuid.uuid4().hex[:12],
                          sessionId=uuid.uuid4().hex, createdAt=_now(), archived=False,
                          forkedFromId=thread_id, forkedFromTurnId=selected["turnId"])
            if title is not None:
                if not isinstance(title, str):
                    raise ValueError("title 必须是字符串")
                header["title"] = title
            copied: list[dict] = []
            copied_ids: set[str] = set()
            for entry in json.loads(_json(prefix)):
                # Queue state belongs to one thread, not its transcript forks.
                if entry["type"] in {"thread_info", "queue"}:
                    continue
                if entry.get("parentId") not in copied_ids:
                    entry["parentId"] = copied[-1]["id"] if copied else None
                if entry["payload"].get("threadId") == thread_id:
                    entry["payload"]["threadId"] = header["id"]
                copied.append(entry)
                copied_ids.add(entry["id"])
            return self._write_new(header, copied)

    def recover(self) -> None:
        """Finalize abandoned work, including archived sessions; never execute a tool."""
        for thread in self.list_threads(include_archived=True):
            thread_id = thread["id"]
            turns = self._turns(self.read_entries(thread_id), thread_id)
            turn_by_item = {item["id"]: turn["turnId"] for turn in turns
                            for item in self.get_turn(thread_id, turn["turnId"])["items"]}
            recovered_turns: set[str] = set()
            for item in self.read_items(thread_id):
                approval = item.get("approval")
                if item.get("status") != "running" and not (approval and not approval.get("decision")):
                    continue
                payload = {key: value for key, value in item.items() if key not in {"id", "threadId"}}
                payload.update(status="failed", revises=item["id"])
                if approval and not approval.get("decision"):
                    payload["approval"] = {**approval, "decision": "expired"}
                if item.get("kind") == "toolCall":
                    payload.update(errorCode="SESSION_INTERRUPTED", resultSummary="上次进程在操作收尾前退出，结果不确定；先核对平台状态，不要直接重试。")
                    phase = item.get("executionState")
                    payload["executionState"] = "not_executed" if phase in {"queued", "pending_approval", "approved"} else "outcome_unknown"
                    if payload["executionState"] == "not_executed":
                        payload["resultSummary"] = "上次进程在工具执行前退出，该操作未执行；旧审批已经失效。"
                self.append(thread_id, Entry(type="item", parent_id=self.last_entry_id(thread_id), payload=payload))
                affected_turn = item.get("turnId") or turn_by_item.get(item["id"])
                if affected_turn:
                    recovered_turns.add(affected_turn)
            for turn in turns:
                if turn.get("status") == "running" or turn["turnId"] in recovered_turns:
                    self.record_turn(thread_id, turn["turnId"], "interrupted", recoveryReason="processExit")

    def _sync_events(self) -> None:
        with self._lock, self._index.transaction() as connection:
            self._index_events(connection)

    def _index_events(self, connection: sqlite3.Connection) -> None:
        if not self.events_path.exists():
            return
        stat = self.events_path.stat()
        fingerprint = f"{stat.st_size}:{stat.st_mtime_ns}"
        checkpoint = connection.execute("SELECT value FROM checkpoints WHERE name='events'").fetchone()
        if checkpoint and checkpoint["value"] == fingerprint:
            return
        for line in self.events_path.read_text(encoding="utf-8", errors="replace").split("\n"):
            try:
                record = json.loads(line)
                if not isinstance(record, dict) or not isinstance(record.get("params"), dict):
                    continue
                params = record["params"]
                event_id = params.get("eventId")
                cursor = _event_cursor(params.get("eventCursor"))
                method = record.get("method")
                thread_id = params.get("threadId")
                if (not isinstance(event_id, str) or not _EVENT_ID.fullmatch(event_id) or cursor < 1
                        or not isinstance(method, str) or not method):
                    continue
                if thread_id is not None:
                    self.path_for(thread_id)
                previous = connection.execute("SELECT event_id FROM events WHERE cursor=?", (cursor,)).fetchone()
                if previous and previous["event_id"] != event_id:
                    raise ValueError("事件日志存在重复游标，请保留原文件后恢复")
                connection.execute("""INSERT INTO events(cursor,event_id,method,thread_id,params_json)
                    VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING""",
                    (cursor, event_id, method, thread_id, _json(params)))
            except (json.JSONDecodeError, TypeError):
                continue
        connection.execute("INSERT INTO checkpoints(name,value) VALUES('events',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", (fingerprint,))

    def append_event(self, method: str, params: dict[str, Any] | None = None) -> dict:
        if (not isinstance(method, str) or not method or len(method) > 256
                or any(ord(char) < 32 for char in method)):
            raise ValueError("事件方法名无效")
        if params is not None and not isinstance(params, dict):
            raise ValueError("事件参数必须是对象")
        payload = dict(params or {})
        if {"eventId", "eventCursor"} & set(payload):
            raise ValueError("eventId 与 eventCursor 由存储层生成")
        thread_id = payload.get("threadId")
        if thread_id is not None:
            self.require_thread(thread_id)
        _json(payload)
        with self._lock, self._index.transaction() as connection:
            self._index_events(connection)
            event_id = uuid.uuid4().hex
            inserted = connection.execute("INSERT INTO events(event_id,method,thread_id,params_json) VALUES(?,?,?,'{}')", (event_id, method, thread_id))
            payload.update(eventId=event_id, eventCursor=str(inserted.lastrowid))
            frame = {"method": method, "params": payload}
            self._append_line(self.events_path, {"type": "event", "timestamp": _now(), **frame})
            connection.execute("UPDATE events SET params_json=? WHERE cursor=?", (_json(payload), inserted.lastrowid))
            stat = self.events_path.stat()
            connection.execute("INSERT INTO checkpoints(name,value) VALUES('events',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", (f"{stat.st_size}:{stat.st_mtime_ns}",))
        return frame

    def events_after(self, cursor: str | None = None, thread_id: str | None = None, limit: int = 100) -> dict:
        position = _event_cursor(cursor)
        _limit(limit, 1000)
        if thread_id is not None:
            self.require_thread(thread_id)
        query = "SELECT cursor,method,params_json FROM events WHERE cursor>?"
        parameters: list[Any] = [position]
        if thread_id is not None:
            query += " AND thread_id=?"
            parameters.append(thread_id)
        query += " ORDER BY cursor LIMIT ?"
        parameters.append(limit + 1)
        self._sync_events()
        with self._index.connection() as connection:
            rows = connection.execute(query, parameters).fetchall()
        page = rows[:limit]
        return {"events": [{"method": row["method"], "params": json.loads(row["params_json"])} for row in page],
                "nextCursor": str(page[-1]["cursor"]) if page else str(position), "hasMore": len(rows) > limit}

    def latest_event_cursor(self) -> str:
        self._sync_events()
        with self._index.connection() as connection:
            maximum = connection.execute("SELECT COALESCE(MAX(cursor),0) FROM events").fetchone()[0]
        return str(maximum)
