"""Durable sessions: append-only JSONL rollouts with a rebuildable SQLite index.

The transport's ordered event journal is separate from model-visible history.
Forks copy a complete, settled rollout prefix and never replay tool side effects.
Pi reference: 5ba1cbaf3d96d204d847c84ce235c62dae23e0fd, SessionManager.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import stat
import threading
import time
import uuid
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from boss_harness.persistence import PersistenceIndex, SCHEMA_VERSION
from boss_harness.private_files import ensure_private_directory, open_private_file, restrict_private_file
from boss_harness.models.capabilities import REASONING_EFFORTS

_THREAD_ID = re.compile(r"[a-f0-9]{12}\Z")
_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
_EVENT_ID = re.compile(r"[a-f0-9]{32}\Z")
_ATTACHMENT_DIGEST = re.compile(r"[a-f0-9]{64}\Z")
_ATTACHMENT_TEMP = re.compile(r"tmp-[a-f0-9]{32}\Z")
_DELETE_INTENT = re.compile(r"\.delete-([a-f0-9]{12})\.json\Z")
_TERMINAL = frozenset({"completed", "interrupted", "blocked", "error"})
_TASK_PHASES = frozenset({"admission", "prepare", "model_request", "tool_execution", "finish"})
_EVENT_READ_CHUNK_BYTES = 64 * 1024
# Event records are persisted from the same bounded JSON-RPC payloads as the
# transport.  Keep one explicit line limit so a damaged append-only log cannot
# make a cold index rebuild allocate without bound.
MAX_EVENT_LINE_BYTES = 8 * 1024 * 1024
MAX_ITEM_REVISION_ALIASES = 4_096
MAX_ITEM_REVISION_RECORDS = 4_096
MAX_ITEM_REVISION_ALIAS_BYTES = 64 * 1024
# Canonical results have a separate budget from their bounded transport
# projection.  Validate the final JSON spelling before publishing a record;
# raw CLI bytes and decoded/re-encoded JSON need not have the same size.
MAX_SESSION_LINE_BYTES = 32 * 1024 * 1024
MAX_SESSION_HEADER_BYTES = 8 * 1024 * 1024
# Recovery metadata is tiny in normal operation.  Keep a separate whole-file
# bound so a forged delete marker or repair manifest cannot be materialised
# before its JSON shape is checked.
MAX_DELETE_INTENT_BYTES = 1024 * 1024
MAX_REPAIR_MANIFEST_BYTES = 1024 * 1024


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def approval_parameters_digest(arguments: dict[str, Any]) -> str:
    if type(arguments) is not dict:
        raise ValueError("审批参数必须是对象")
    try:
        encoded = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"),
                             sort_keys=True, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError):
        raise ValueError("审批参数无法规范化") from None
    return hashlib.sha256(encoded).hexdigest()


class ApprovalDecisionError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _encode_session_line(value: dict, *, maximum: int = MAX_SESSION_LINE_BYTES,
                         label: str = "会话日志") -> bytes:
    encoded = _json(value).encode("utf-8")
    if len(encoded) > maximum:
        raise ValueError(f"{label}单行超过大小限制")
    return encoded + b"\n"


def _iter_bounded_raw_lines_from_handle(handle, *, maximum: int, label: str = "JSONL",
                                        universal_newlines: bool = False,
                                        byte_limit: int | None = None):
    """Yield raw JSONL records from an already pinned handle with a line bound."""
    if byte_limit is not None and (type(byte_limit) is not int or byte_limit < 0):
        raise ValueError("JSONL 快照长度无效")
    pending = bytearray()
    remaining = byte_limit
    while True:
        if remaining is None:
            chunk = handle.read(_EVENT_READ_CHUNK_BYTES)
            eof = not chunk
        elif remaining == 0:
            chunk = b""
            eof = True
        else:
            chunk = handle.read(min(_EVENT_READ_CHUNK_BYTES, remaining))
            if not chunk:
                raise ValueError(f"{label}快照读取不完整")
            remaining -= len(chunk)
            eof = remaining == 0
        if chunk:
            pending.extend(chunk)
        while True:
            newline = pending.find(b"\n")
            carriage = pending.find(b"\r") if universal_newlines else -1
            if carriage >= 0 and (newline < 0 or carriage < newline):
                if carriage + 1 == len(pending) and not eof:
                    break
                separator_end = (carriage + 2 if carriage + 1 < len(pending)
                                 and pending[carriage + 1] == 10 else carriage + 1)
                line = bytes(pending[:carriage])
                del pending[:separator_end]
            elif newline >= 0:
                line = bytes(pending[:newline])
                del pending[:newline + 1]
            else:
                if len(pending) > maximum:
                    raise ValueError(f"{label}单行超过大小限制")
                break
            if len(line) > maximum:
                raise ValueError(f"{label}单行超过大小限制")
            yield line
        if eof:
            break
    if pending:
        if len(pending) > maximum:
            raise ValueError(f"{label}单行超过大小限制")
        yield bytes(pending)


def _iter_bounded_raw_lines(path: Path, *, maximum: int, label: str = "JSONL",
                            universal_newlines: bool = False):
    with path.open("rb") as handle:
        yield from _iter_bounded_raw_lines_from_handle(
            handle, maximum=maximum, label=label, universal_newlines=universal_newlines)


def _reject_json_constant(_: str) -> None:
    raise ValueError


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def _finite_json_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError
    return parsed


def _validate_json_unicode(value: Any) -> None:
    pending = [value]
    while pending:
        current = pending.pop()
        if isinstance(current, str):
            try:
                current.encode("utf-8")
            except UnicodeEncodeError:
                raise ValueError from None
        elif isinstance(current, dict):
            pending.extend(current.keys())
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current)


def _decode_jsonl_object(line: str | bytes, *, label: str, line_number: int) -> dict:
    try:
        text = line.decode("utf-8") if isinstance(line, bytes) else line
        record = json.loads(text, object_pairs_hook=_unique_json_object,
                            parse_constant=_reject_json_constant, parse_float=_finite_json_float)
        _validate_json_unicode(record)
    except (ValueError, RecursionError):
        raise ValueError(f"{label}第 {line_number} 行损坏，读取已停止") from None
    if not isinstance(record, dict):
        raise ValueError(f"{label}第 {line_number} 行格式无效，读取已停止")
    return record


def _decode_session_record(line: str | bytes, *, line_number: int) -> dict | None:
    record = _decode_jsonl_object(line, label="会话日志", line_number=line_number)
    if record.get("type") == "session":
        if line_number == 1:
            return None
        raise ValueError(f"会话日志第 {line_number} 行出现重复会话头，读取已停止")
    parent_id = record.get("parentId")
    if (not isinstance(record.get("type"), str) or not isinstance(record.get("id"), str)
            or not isinstance(record.get("timestamp"), str)
            or (parent_id is not None and not isinstance(parent_id, str))):
        raise ValueError(f"会话日志第 {line_number} 行格式无效，读取已停止")
    payload = record.get("payload")
    if not isinstance(payload, dict):
        raise ValueError(f"会话日志第 {line_number} 行格式无效，读取已停止")
    return record


def _iter_bounded_lines(path: Path, *, maximum: int, label: str = "JSONL",
                        universal_newlines: bool = False):
    """Yield decoded JSONL lines without materialising the complete file."""
    for line_number, raw_line in enumerate(_iter_bounded_raw_lines(
            path, maximum=maximum, label=label, universal_newlines=universal_newlines), start=1):
        try:
            yield raw_line.decode("utf-8")
        except UnicodeDecodeError:
            raise ValueError(f"{label}第 {line_number} 行不是有效 UTF-8，读取已停止") from None


def _read_bounded_file(path: Path, *, maximum: int, label: str) -> bytes:
    descriptor = open_private_file(path, os.O_RDONLY)
    with os.fdopen(descriptor, "rb") as handle:
        data = handle.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError(f"{label}超过大小限制")
    return data


class SessionEntriesSnapshot:
    """A rewindable, size-pinned view of one append-only session prefix."""

    def __init__(self, source: io.BufferedReader, size: int) -> None:
        self._source = source
        self._size = size

    def __enter__(self) -> SessionEntriesSnapshot:
        if self._source.closed:
            raise ValueError("会话快照已关闭")
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._source.close()

    def __iter__(self):
        if self._source.closed:
            raise ValueError("会话快照已关闭")
        self._source.seek(0)
        for line_number, raw_line in enumerate(_iter_bounded_raw_lines_from_handle(
                self._source, maximum=MAX_SESSION_LINE_BYTES, label="会话日志",
                universal_newlines=True, byte_limit=self._size), start=1):
            if not raw_line.strip():
                continue
            data = _decode_session_record(raw_line, line_number=line_number)
            if data is not None:
                yield data


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    descriptor = open_private_file(path, os.O_RDONLY)
    with os.fdopen(descriptor, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


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


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


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


class SessionAppendRollbackError(OSError):
    """An append failed and its partial file state could not be rolled back safely."""

    def __init__(self) -> None:
        self.outcome = "unknown"
        super().__init__("会话日志追加失败且无法确认已回滚；状态可能需要人工检查")


class ThreadNotFound(ValueError):
    pass


class ItemLookupError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


class SessionStore:
    def __init__(self, root: Path, *, attachments_root: Path | None = None) -> None:
        self.root = Path(root).resolve()
        ensure_private_directory(self.root.parent)
        ensure_private_directory(self.root)
        self.attachments_root = Path(attachments_root or self.root.parent / "attachments").absolute()
        self._lock = threading.RLock()
        self.database_path = self.root.parent / "state.sqlite3"
        self.events_path = self.root.parent / "events.jsonl"
        for path in (self.database_path.with_name(self.database_path.name + "-wal"),
                     self.database_path.with_name(self.database_path.name + "-shm"), self.events_path,
                     *self.root.glob("*.jsonl"), *self.root.glob(".*.tmp"),
                     *self.root.glob(".delete-*.json"),
                     *self.root.parent.glob(".events.jsonl.delete-*.tmp")):
            try:
                path.lstat()
            except FileNotFoundError:
                continue
            restrict_private_file(path)
        self._index = PersistenceIndex(self.database_path)
        self._recover_deletions()
        self._refresh_threads()
        self._sync_events()

    def close(self) -> None:
        """Connections are operation-scoped; retained for explicit owner cleanup."""

    def path_for(self, thread_id: str) -> Path:
        if not isinstance(thread_id, str) or not _THREAD_ID.fullmatch(thread_id):
            raise ValueError("threadId 格式无效")
        return self.root / f"{thread_id}.jsonl"

    def _delete_intent_path(self, thread_id: str) -> Path:
        self.path_for(thread_id)
        return self.root / f".delete-{thread_id}.json"

    def has_pending_deletion(self, thread_id: str) -> bool:
        return self._delete_intent_path(thread_id).exists()

    def _read_delete_intent(self, path: Path) -> dict[str, Any]:
        match = _DELETE_INTENT.fullmatch(path.name)
        if match is None:
            raise ValueError("会话删除标记名称无效")
        try:
            raw = _read_bounded_file(path, maximum=MAX_DELETE_INTENT_BYTES, label="会话删除标记")
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise ValueError("会话删除标记损坏；状态恢复已停止") from None
        thread_id = match.group(1)
        if (not isinstance(value, dict) or set(value) != {"version", "threadId", "attachmentDigests", "eventId"}
                or value.get("version") != 1 or value.get("threadId") != thread_id
                or not isinstance(value.get("attachmentDigests"), list)
                or any(not isinstance(item, str) or not _ATTACHMENT_DIGEST.fullmatch(item)
                       for item in value["attachmentDigests"])
                or not isinstance(value.get("eventId"), str)
                or not _EVENT_ID.fullmatch(value["eventId"])):
            raise ValueError("会话删除标记损坏；状态恢复已停止")
        value["attachmentDigests"] = sorted(set(value["attachmentDigests"]))
        return value

    def _pending_deletion_ids(self) -> set[str]:
        pending: set[str] = set()
        for path in self.root.glob(".delete-*.json"):
            intent = self._read_delete_intent(path)
            pending.add(intent["threadId"])
        return pending

    def _write_delete_intent(self, thread_id: str, entries: list[dict]) -> dict[str, Any]:
        path = self._delete_intent_path(thread_id)
        if path.exists():
            return self._read_delete_intent(path)
        digests = sorted({entry.get("payload", {}).get("digest") for entry in entries
                          if entry.get("type") == "attachment"
                          and isinstance(entry.get("payload", {}).get("digest"), str)
                          and _ATTACHMENT_DIGEST.fullmatch(entry["payload"]["digest"])})
        intent = {"version": 1, "threadId": thread_id,
                  "attachmentDigests": digests, "eventId": uuid.uuid4().hex}
        temporary = self.root / f".delete-{thread_id}.{uuid.uuid4().hex}.tmp"
        descriptor = open_private_file(temporary, os.O_WRONLY | os.O_EXCL)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write((_json(intent) + "\n").encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())
            os.link(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        _fsync_directory(self.root)
        return intent

    def _recover_deletions(self) -> None:
        for path in sorted(self.root.glob(".delete-*.json")):
            intent = self._read_delete_intent(path)
            self._finish_deletion(intent)

    def require_thread(self, thread_id: str) -> dict:
        path = self.path_for(thread_id)
        with self._lock:
            if self._delete_intent_path(thread_id).exists():
                raise ValueError("会话正在删除，暂不可读取")
            try:
                with closing(_iter_bounded_lines(path, maximum=MAX_SESSION_HEADER_BYTES,
                             label="会话头", universal_newlines=True)) as lines:
                    header = _decode_jsonl_object(next(lines), label="会话头", line_number=1)
            except FileNotFoundError:
                raise ValueError("会话不存在") from None
            except ValueError as exc:
                if "第 1 行" in str(exc):
                    raise
                raise ValueError("会话头损坏，请保留原文件后恢复") from None
            except (IndexError, StopIteration):
                raise ValueError("会话头损坏，请保留原文件后恢复") from None
            if header.get("type") != "session" or header.get("id") != thread_id:
                raise ValueError("会话头第 1 行格式无效")
            return header

    @staticmethod
    def _append_line(path: Path, value: dict) -> None:
        encoded = _encode_session_line(value)
        descriptor = open_private_file(path, os.O_RDWR | os.O_APPEND)
        try:
            original = os.fstat(descriptor)
            visible = path.lstat()
            identity = (original.st_dev, original.st_ino, original.st_mode, original.st_uid,
                        original.st_gid, original.st_nlink)
            if (not stat.S_ISREG(original.st_mode) or original.st_nlink != 1
                    or (visible.st_dev, visible.st_ino) != identity[:2]):
                raise ValueError("会话日志不是稳定的私有单链接文件")
            start = original.st_size
            prefix = b""
            if start:
                os.lseek(descriptor, start - 1, os.SEEK_SET)
                last_byte = os.read(descriptor, 1)
                if len(last_byte) != 1:
                    raise OSError("会话日志末尾读取不完整")
                if last_byte != b"\n":
                    prefix = b"\n"
            suffix = prefix + encoded
            written = 0
            try:
                os.lseek(descriptor, 0, os.SEEK_END)
                while written < len(suffix):
                    count = os.write(descriptor, suffix[written:])
                    if count <= 0:
                        raise OSError("会话日志追加未取得进展")
                    written += count
                os.fsync(descriptor)
            except BaseException as append_error:
                try:
                    current = os.fstat(descriptor)
                    visible = path.lstat()
                    current_identity = (current.st_dev, current.st_ino, current.st_mode,
                                        current.st_uid, current.st_gid, current.st_nlink)
                    if (current_identity != identity or (visible.st_dev, visible.st_ino) != identity[:2]
                            or current.st_size != start + written):
                        raise OSError("会话日志身份或长度已变化")
                    os.lseek(descriptor, start, os.SEEK_SET)
                    remaining = written
                    appended = bytearray()
                    while remaining:
                        chunk = os.read(descriptor, min(remaining, _EVENT_READ_CHUNK_BYTES))
                        if not chunk:
                            raise OSError("会话日志追加后缀读取不完整")
                        appended.extend(chunk)
                        remaining -= len(chunk)
                    if appended != suffix[:written]:
                        raise OSError("会话日志追加后缀与本次写入不一致")
                    os.ftruncate(descriptor, start)
                    os.fsync(descriptor)
                    rolled_back = os.fstat(descriptor)
                    visible = path.lstat()
                    rolled_identity = (rolled_back.st_dev, rolled_back.st_ino, rolled_back.st_mode,
                                       rolled_back.st_uid, rolled_back.st_gid, rolled_back.st_nlink)
                    if (rolled_identity != identity or rolled_back.st_size != start
                            or (visible.st_dev, visible.st_ino) != identity[:2]):
                        raise OSError("会话日志回滚结果无法确认")
                except BaseException:
                    raise SessionAppendRollbackError from append_error
                raise
        finally:
            try:
                os.close(descriptor)
            except OSError:
                # Successful fsync is the durability boundary; close errors do not undo it.
                pass

    def _write_new(self, header: dict, entries: list[dict] | None = None) -> dict:
        path = self.path_for(header["id"])
        encoded = b"".join([
            _encode_session_line(header, maximum=MAX_SESSION_HEADER_BYTES, label="会话头"),
            *(_encode_session_line(entry) for entry in entries or []),
        ])
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        with self._lock, self._index.transaction() as connection:
            # Publish a complete rollout only after fsync. Hard-link creation is
            # atomic and refuses to overwrite an existing thread on an ID collision.
            try:
                descriptor = open_private_file(temporary, os.O_WRONLY | os.O_EXCL)
                with os.fdopen(descriptor, "wb") as handle:
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
            self._index_thread(thread_id, connection)
            self._append_line(self.path_for(thread_id), entry.to_dict())
            self._index_thread(thread_id, connection)
        return entry

    def append_attachment(self, thread_id: str, entry: Entry, publish: Callable[[], None]) -> Entry:
        """Publish an attachment and its durable reference under the shared writer lock."""
        payload = entry.payload or {}
        if entry.type != "attachment" or not _ATTACHMENT_DIGEST.fullmatch(str(payload.get("digest", ""))):
            raise ValueError("附件记录格式无效")
        if not callable(publish):
            raise ValueError("附件发布器无效")
        with self._lock, self._index.transaction() as connection:
            # Reject damaged history before publishing content or appending a reference.
            with self.open_entries_snapshot(thread_id) as entries:
                for _entry in entries:
                    pass
            publish()
            _fsync_directory(self.attachments_root)
            self._append_line(self.path_for(thread_id), entry.to_dict())
            self._index_thread(thread_id, connection)
        return entry

    def cleanup_unreferenced_attachments(self, digests: list[str]) -> None:
        """Serialize failed-publication cleanup with attachment adds and deletion."""
        with self._lock, self._index.transaction():
            self._purge_unreferenced_attachments(digests)

    def cleanup_attachment_temporaries(self) -> None:
        """Remove only private temp names left by interrupted attachment publication."""
        with self._lock, self._index.transaction():
            try:
                directory_stat = self.attachments_root.lstat()
            except FileNotFoundError:
                return
            current_uid = getattr(os, "getuid", lambda: -1)()
            if not stat.S_ISDIR(directory_stat.st_mode) or directory_stat.st_uid != current_uid:
                raise ValueError("附件目录不可信，临时文件清理已暂停")
            changed = False
            try:
                entries = os.scandir(self.attachments_root)
            except OSError:
                raise ValueError("附件目录不可读取，临时文件清理已暂停") from None
            with entries:
                for entry in entries:
                    if _ATTACHMENT_TEMP.fullmatch(entry.name) is None:
                        continue
                    path = self.attachments_root / entry.name
                    try:
                        original = path.lstat()
                    except OSError:
                        raise ValueError("附件临时文件发生变化，清理已暂停") from None
                    if (not stat.S_ISREG(original.st_mode) or original.st_uid != current_uid
                            or original.st_nlink != 1):
                        raise ValueError("附件临时文件不可信，清理已暂停")
                    restrict_private_file(path)
                    path.unlink()
                    changed = True
            if changed:
                _fsync_directory(self.attachments_root)

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
            try:
                for line_number, line in enumerate(_iter_bounded_lines(
                        path, maximum=MAX_SESSION_LINE_BYTES, label="会话日志",
                        universal_newlines=True), start=1):
                    if not line.strip():
                        continue
                    current = _decode_session_record(line, line_number=line_number)
                    if current is None:
                        continue
                    if current.get("id") == entry.id:
                        if current != expected:
                            return "conflict"
                        found = True
            except ValueError as exc:
                raise ToolRevisionPersistenceError("invalid") from exc
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
                self._index_thread(thread_id, connection)
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
                    encoded = _encode_session_line(entry.to_dict())
                    candidate_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.checkpoint.tmp")
                    descriptor = open_private_file(candidate_path, os.O_WRONLY | os.O_EXCL)
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
                        os.fchmod(target.fileno(), 0o600)
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
            out: list[dict] = []
            for line_number, line in enumerate(_iter_bounded_lines(
                    self.path_for(thread_id), maximum=MAX_SESSION_LINE_BYTES,
                    label="会话日志", universal_newlines=True), start=1):
                if not line.strip():
                    continue
                data = _decode_session_record(line, line_number=line_number)
                if data is not None:
                    out.append(data)
            return out

    def open_entries_snapshot(self, thread_id: str) -> SessionEntriesSnapshot:
        """Pin a readable session prefix without holding the writer lock while scanning."""
        with self._lock:
            self.require_thread(thread_id)
            source = self.path_for(thread_id).open("rb")
            try:
                size = os.fstat(source.fileno()).st_size
                return SessionEntriesSnapshot(source, size)
            except BaseException:
                source.close()
                raise

    def open_snapshot_source(self, thread_id: str) -> tuple[io.BufferedReader, int, str]:
        """Pin one rollout inode and cursor while session writers are excluded."""
        with self._lock:
            self.require_thread(thread_id)
            with self._index.connection() as connection:
                event_checkpoint = connection.execute(
                    "SELECT value FROM checkpoints WHERE name='events'").fetchone()
                if self.events_path.exists():
                    stat_result = self.events_path.stat()
                    fingerprint = f"{stat_result.st_size}:{stat_result.st_mtime_ns}"
                    if event_checkpoint is None or event_checkpoint["value"] != fingerprint:
                        raise ValueError("事件索引与日志不同步，请重试冻结快照")
                elif event_checkpoint is not None:
                    raise ValueError("事件索引与日志不同步，请重试冻结快照")
                cursor = str(connection.execute(
                    "SELECT COALESCE(MAX(cursor),0) FROM events").fetchone()[0])
            source = self.path_for(thread_id).open("rb")
            try:
                size = os.fstat(source.fileno()).st_size
                return source, size, cursor
            except BaseException:
                source.close()
                raise

    def snapshot_projection(self, thread_id: str, *, include_turns: bool = True,
                            max_turn_bytes: int = 1024 * 1024
                            ) -> tuple[dict, list[dict], bool]:
        """Read indexed metadata at the caller's cut; skipped turns are not budgeted."""
        with self._lock:
            if self._delete_intent_path(thread_id).exists():
                raise ValueError("会话正在删除，暂不可读取")
            with self._index.connection() as connection:
                thread = connection.execute(
                    "SELECT metadata_json,indexed_size,indexed_mtime_ns FROM threads WHERE id=?",
                    (thread_id,)).fetchone()
                if thread is None:
                    raise ValueError("会话不存在")
                stat_result = self.path_for(thread_id).stat()
                if (thread["indexed_size"], thread["indexed_mtime_ns"]
                        ) != (stat_result.st_size, stat_result.st_mtime_ns):
                    raise ValueError("会话索引与日志不同步，请重试冻结快照")
                turns = []
                if not include_turns:
                    return json.loads(thread["metadata_json"]), turns, False
                rows = connection.execute("""SELECT metadata_json FROM turns
                    WHERE thread_id=? ORDER BY first_ordinal,turn_id LIMIT 50""", (thread_id,))
                turn_bytes = 0
                for row in rows:
                    turn_bytes += len(row["metadata_json"].encode("utf-8"))
                    if turn_bytes > max_turn_bytes:
                        return json.loads(thread["metadata_json"]), turns, True
                    turns.append(json.loads(row["metadata_json"]))
            return json.loads(thread["metadata_json"]), turns, False

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

    def read_item(self, thread_id: str, item_id: str) -> dict | None:
        """Project one logical item while retaining only its live revision aliases."""
        if not isinstance(item_id, str) or not item_id or len(item_id) > 128:
            raise ValueError("itemId 格式无效")
        aliases: set[str] = set()
        alias_bytes = 0
        revision_records = 0
        selected: dict | None = None
        with self.open_entries_snapshot(thread_id) as entries:
            for entry in entries:
                if entry.get("type") != "item":
                    continue
                payload = dict(entry.get("payload") or {})
                entry_id = str(entry.get("id") or "")
                target_id = str(payload.get("revises") or "")
                if (not target_id and payload.get("kind") == "toolCall"
                        and payload.get("status") != "running"):
                    parent_id = str(entry.get("parentId") or "")
                    if (selected is not None and parent_id in aliases
                            and selected.get("kind") == "toolCall"):
                        target_id = parent_id

                if target_id in aliases:
                    if entry_id == item_id:
                        raise ItemLookupError("INVALID_RESULT_REFERENCE", "结果条目身份存在冲突")
                    revision_records += 1
                    if revision_records > MAX_ITEM_REVISION_RECORDS:
                        raise ItemLookupError("RESULT_HISTORY_LIMIT", "工具结果修订历史超过读取上限")
                    if len(entry_id) > 128:
                        raise ItemLookupError("RESULT_HISTORY_LIMIT", "工具结果修订别名超过长度上限")
                    if entry_id not in aliases and len(aliases) >= MAX_ITEM_REVISION_ALIASES:
                        raise ItemLookupError("RESULT_HISTORY_LIMIT", "工具结果修订历史超过读取上限")
                    if entry_id not in aliases:
                        alias_bytes += len(entry_id.encode("utf-8"))
                        if alias_bytes > MAX_ITEM_REVISION_ALIAS_BYTES:
                            raise ItemLookupError("RESULT_HISTORY_LIMIT", "工具结果修订别名超过大小上限")
                    aliases.add(entry_id)
                    if "kind" in payload:
                        selected["kind"] = payload["kind"]
                    if "result" in payload:
                        selected["result"] = payload["result"]
                    continue

                if entry_id == item_id:
                    if selected is not None or target_id or (
                            payload.get("kind") == "toolCall" and payload.get("status") != "running"
                            and entry.get("parentId")):
                        raise ItemLookupError("INVALID_RESULT_REFERENCE", "结果条目身份存在冲突")
                    selected = {"id": item_id, "threadId": thread_id}
                    for key in ("kind", "result"):
                        if key in payload:
                            selected[key] = payload[key]
                    aliases.add(entry_id)
                    alias_bytes = len(entry_id.encode("utf-8"))
                else:
                    if entry_id in aliases:
                        aliases.remove(entry_id)
                        alias_bytes -= len(entry_id.encode("utf-8"))
        return selected

    @staticmethod
    def _valid_approval_item(item: dict, *, pending_only: bool) -> bool:
        approval = item.get("approval")
        arguments = item.get("toolArguments")
        decision = approval.get("decision") if isinstance(approval, dict) else None
        if (item.get("kind") != "toolCall" or not isinstance(approval, dict)
                or (decision is not None and (not isinstance(decision, str)
                    or decision not in {"approve", "deny", "expired"}))
                or not isinstance(approval.get("approvalId"), str)
                or not _EVENT_ID.fullmatch(approval["approvalId"])
                or not isinstance(approval.get("toolName"), str)
                or approval.get("toolName") != item.get("toolName")
                or not isinstance(item.get("turnId"), str)
                or not _IDENTIFIER.fullmatch(item["turnId"])
                or type(arguments) is not dict or approval.get("params") != arguments):
            return False
        status, execution_state = item.get("status"), item.get("executionState")
        if not isinstance(status, str) or not isinstance(execution_state, str):
            return False
        if pending_only or decision is None:
            if status != "running" or execution_state != "pending_approval":
                return False
        elif decision == "approve":
            if (not isinstance(status, str) or status not in {"running", "failed", "completed"}
                    or not isinstance(execution_state, str)
                    or execution_state not in {
                        "approved", "executing", "completed", "not_executed", "outcome_unknown"
                    }):
                return False
        elif decision == "deny":
            if status not in {"running", "failed"} or execution_state != "not_approved":
                return False
        elif status not in {"running", "failed"} or execution_state != "not_executed":
            return False
        deadline = approval.get("deadline")
        try:
            deadline_valid = (type(deadline) in {int, float} and math.isfinite(float(deadline))
                              and deadline > 0)
        except (OverflowError, TypeError, ValueError):
            deadline_valid = False
        if not deadline_valid:
            return False
        description = approval.get("description")
        if not isinstance(description, str) or len(description) > 1_000:
            return False
        try:
            digest = approval_parameters_digest(arguments)
        except ValueError:
            return False
        return approval.get("paramsDigest") == digest

    def pending_approvals(self, thread_id: str | None = None, *, limit: int = 100) -> list[dict]:
        _limit(limit, maximum=200)
        if thread_id is not None:
            self.path_for(thread_id)
        with self._lock:
            if thread_id is not None:
                self.require_thread(thread_id)
            pending_deletions = sorted(self._pending_deletion_ids())
            if len(pending_deletions) > 800:
                return []
            query = """SELECT a.approval_id,a.thread_id,a.turn_id,a.item_id,a.tool_name,
                       a.deadline,a.params_digest FROM approvals a
                       JOIN threads t ON t.id=a.thread_id
                       JOIN turns r ON r.thread_id=a.thread_id AND r.turn_id=a.turn_id
                       WHERE a.decision IS NULL AND a.status='running'
                         AND a.execution_state='pending_approval' AND a.deadline>?
                         AND t.archived=0 AND r.status IN ('running','interrupted')"""
            parameters: list[Any] = [time.time()]
            if thread_id is not None:
                query += " AND a.thread_id=?"
                parameters.append(thread_id)
            if pending_deletions:
                query += " AND a.thread_id NOT IN (" + ",".join("?" for _ in pending_deletions) + ")"
                parameters.extend(pending_deletions)
            query += " ORDER BY t.updated_at DESC,a.thread_id DESC,a.item_id DESC LIMIT ?"
            parameters.append(limit)
            with self._index.connection() as connection:
                rows = connection.execute(query, parameters).fetchall()
            return [{"approvalId": row["approval_id"], "threadId": row["thread_id"],
                     "turnId": row["turn_id"], "itemId": row["item_id"],
                     "toolName": row["tool_name"],
                     "summary": f"需要你批准后才会执行：{row['tool_name']}",
                     "deadline": row["deadline"], "paramsDigest": row["params_digest"]}
                    for row in rows]

    def _append_approval_decision(self, thread_id: str, item: dict, decision: str,
                                  *, live_owner: bool) -> dict:
        approval = {**item["approval"], "decision": decision, "decidedAt": _now()}
        payload = {key: value for key, value in item.items() if key not in {"id", "threadId"}}
        payload.update(revises=item["id"], approval=approval)
        if live_owner:
            payload["executionState"] = "approved" if decision == "approve" else "not_approved"
        else:
            payload.update(status="failed")
            if decision == "approve":
                payload.update(executionState="not_executed", errorCode="SESSION_INTERRUPTED",
                               resultSummary="审批已记录，但原回合已经中断；工具未执行。若仍需执行，请发起新回合并重新审批。",
                               recoveryAction="明确发起新回合；旧审批不会触发工具执行。")
            elif decision == "deny":
                payload.update(executionState="not_approved", errorCode="NOT_APPROVED",
                               resultSummary="用户在恢复会话后拒绝了该操作。", recoveryAction=None)
            else:
                payload.update(executionState="not_executed", errorCode="APPROVAL_EXPIRED",
                               resultSummary="审批已过期；工具未执行。", recoveryAction=None)
        self.append(thread_id, Entry(type="item", parent_id=self.last_entry_id(thread_id), payload=payload))
        return {"approval": approval, "executionState": payload["executionState"],
                "status": payload.get("status", item.get("status")),
                "threadId": thread_id, "turnId": item.get("turnId"), "itemId": item["id"],
                "toolName": item["toolName"], "decision": decision,
                "executed": (True if payload["executionState"] == "completed" else
                             False if payload["executionState"] in {"not_executed", "not_approved"} else None),
                "changed": True, "errorCode": payload.get("errorCode"),
                "resultSummary": payload.get("resultSummary"),
                "recoveryAction": payload.get("recoveryAction")}

    def decide_approval(self, approval_id: str, approved: bool, *, live_owner: bool = False,
                        expire_only: bool = False) -> dict | None:
        if not isinstance(approval_id, str) or not _EVENT_ID.fullmatch(approval_id):
            raise ApprovalDecisionError("APPROVAL_INVALID", "approvalId 格式无效")
        if (type(approved) is not bool or type(live_owner) is not bool or type(expire_only) is not bool
                or (expire_only and live_owner)):
            raise ApprovalDecisionError("APPROVAL_INVALID", "审批裁决参数无效")
        requested = "approve" if approved else "deny"
        with self._lock:
            with self._index.connection() as connection:
                rows = connection.execute("SELECT thread_id,item_id FROM approvals WHERE approval_id=?",
                                          (approval_id,)).fetchall()
            if len(rows) != 1:
                code = "APPROVAL_NOT_FOUND" if not rows else "APPROVAL_AMBIGUOUS"
                message = "审批不存在或所属会话已删除" if not rows else "审批记录重复，已拒绝裁决"
                raise ApprovalDecisionError(code, message)
            thread_id, item_id = rows[0]["thread_id"], rows[0]["item_id"]
            if thread_id in self._pending_deletion_ids():
                raise ApprovalDecisionError("APPROVAL_NOT_FOUND", "审批所属会话已删除")
            thread = self.get_thread(thread_id)
            entries = self.read_entries(thread_id)
            item = next((value for value in self._project_items(thread_id, entries)
                         if value["id"] == item_id), None)
            item_approval = item.get("approval") if item is not None else None
            if item is None or not isinstance(item_approval, dict) or item_approval.get("approvalId") != approval_id:
                raise ApprovalDecisionError("APPROVAL_INVALID", "审批索引与会话记录不一致")
            approval = item.get("approval")
            if not self._valid_approval_item(item, pending_only=False):
                raise ApprovalDecisionError("APPROVAL_INVALID", "审批记录无效，已拒绝裁决")
            existing = approval.get("decision")
            if existing is not None:
                if expire_only:
                    return None
                if existing != requested:
                    raise ApprovalDecisionError("APPROVAL_CONFLICT", "该审批已经按相反决策处理")
                return {"approval": approval, "executionState": item.get("executionState"),
                        "status": item.get("status"), "threadId": thread["id"],
                        "turnId": item.get("turnId"), "itemId": item["id"],
                        "toolName": item.get("toolName"), "decision": existing,
                        "executed": (True if item.get("executionState") == "completed" else
                                     False if item.get("executionState") in {"not_executed", "not_approved"} else None),
                        "changed": False, "errorCode": item.get("errorCode"),
                        "resultSummary": item.get("resultSummary"),
                        "recoveryAction": item.get("recoveryAction")}
            if thread.get("archived"):
                raise ApprovalDecisionError("APPROVAL_CLOSED", "已归档会话中的审批不能裁决")
            if not self._valid_approval_item(item, pending_only=True):
                raise ApprovalDecisionError("APPROVAL_INVALID", "审批参数摘要或调用状态无效，已拒绝裁决")
            now = time.time()
            if expire_only and approval["deadline"] > now:
                return None
            if approval["deadline"] <= now:
                return self._append_approval_decision(thread["id"], item, "expired", live_owner=False)
            turn_id = item.get("turnId")
            turn = next((turn for turn in self._turns(entries, thread["id"])
                         if turn.get("turnId") == turn_id), None)
            if turn is None:
                raise ApprovalDecisionError("APPROVAL_INVALID", "审批所属回合不存在")
            if live_owner:
                if turn.get("status") != "running":
                    raise ApprovalDecisionError("APPROVAL_CLOSED", "审批所属回合已经结束")
            elif turn.get("status") != "interrupted":
                code = "APPROVAL_BUSY" if turn.get("status") == "running" else "APPROVAL_CLOSED"
                message = "审批仍由活动回合持有" if code == "APPROVAL_BUSY" else "审批所属回合状态不支持恢复裁决"
                raise ApprovalDecisionError(code, message)
            return self._append_approval_decision(thread["id"], item, requested, live_owner=live_owner)

    def expired_pending_approvals(self, *, limit: int = 32) -> list[str]:
        _limit(limit, maximum=128)
        now = time.time()
        with self._lock, self._index.connection() as connection:
            pending_deletions = sorted(self._pending_deletion_ids())
            if len(pending_deletions) > 800:
                return []
            exclusion = ""
            parameters: list[Any] = [now]
            if pending_deletions:
                exclusion = " AND a.thread_id NOT IN (" + ",".join("?" for _ in pending_deletions) + ")"
                parameters.extend(pending_deletions)
            parameters.append(limit)
            rows = connection.execute("""SELECT a.approval_id FROM approvals a
                JOIN threads t ON t.id=a.thread_id
                JOIN turns r ON r.thread_id=a.thread_id AND r.turn_id=a.turn_id
                WHERE a.decision IS NULL AND a.status='running'
                  AND a.execution_state='pending_approval' AND a.deadline<=?
                  AND t.archived=0 AND r.status='interrupted'""" + exclusion +
                " ORDER BY a.deadline,a.thread_id,a.item_id LIMIT ?", parameters).fetchall()
        return [row["approval_id"] for row in rows]

    def next_recoverable_approval_deadline(self) -> float | None:
        with self._lock, self._index.connection() as connection:
            pending_deletions = sorted(self._pending_deletion_ids())
            if len(pending_deletions) > 800:
                return None
            exclusion = ""
            parameters: list[Any] = []
            if pending_deletions:
                exclusion = " AND a.thread_id NOT IN (" + ",".join("?" for _ in pending_deletions) + ")"
                parameters.extend(pending_deletions)
            row = connection.execute("""SELECT MIN(a.deadline) FROM approvals a
                JOIN threads t ON t.id=a.thread_id
                JOIN turns r ON r.thread_id=a.thread_id AND r.turn_id=a.turn_id
                WHERE a.decision IS NULL AND a.status='running'
                  AND a.execution_state='pending_approval' AND t.archived=0
                  AND r.status='interrupted'""" + exclusion, parameters).fetchone()
        return row[0] if row and row[0] is not None else None

    def expire_approval(self, approval_id: str) -> dict | None:
        try:
            return self.decide_approval(approval_id, False, expire_only=True)
        except ApprovalDecisionError as exc:
            if exc.code in {"APPROVAL_NOT_FOUND", "APPROVAL_CLOSED"}:
                return None
            raise

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
            if entry.get("type") == "task_phase":
                payload = entry.get("payload")
                if not isinstance(payload, dict):
                    continue
                task_id = payload.get("taskId")
                turn = turns.get(task_id) if isinstance(task_id, str) else None
                phase, status = payload.get("phase"), payload.get("status")
                attempt, restart_limit = payload.get("attempt"), payload.get("restartLimit")
                if (payload.get("ownerKind") == "turn" and turn is not None
                        and isinstance(phase, str) and phase in _TASK_PHASES
                        and isinstance(status, str) and status in _TERMINAL | {"running"}
                        and type(attempt) is int and 1 <= attempt <= 1_000
                        and type(restart_limit) is int and 0 <= restart_limit <= 32):
                    turn.update(taskPhase=phase, taskPhaseStatus=status, taskAttempt=attempt,
                                taskRestartLimit=restart_limit)
                    if (isinstance(payload.get("recoveryReason"), str)
                            and len(payload["recoveryReason"]) <= 256):
                        turn["taskRecoveryReason"] = payload["recoveryReason"]
                    if (isinstance(payload.get("resumePolicy"), str)
                            and payload["resumePolicy"] in {"manual", "closed"}):
                        turn["taskResumePolicy"] = payload["resumePolicy"]
                continue
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
        connection.execute("DELETE FROM approvals WHERE thread_id=?", (thread_id,))
        for item in self._project_items(thread_id, entries):
            if not self._valid_approval_item(item, pending_only=False):
                continue
            approval = item["approval"]
            connection.execute("""INSERT INTO approvals
                (approval_id,thread_id,item_id,turn_id,tool_name,deadline,params_digest,
                 decision,status,execution_state) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (approval["approvalId"], thread_id, item["id"], item["turnId"], item["toolName"],
                 float(approval["deadline"]), approval["paramsDigest"], approval.get("decision"),
                 item["status"], item["executionState"]))

    def _sync_thread(self, thread_id: str) -> None:
        with self._lock, self._index.transaction() as connection:
            self._index_thread(thread_id, connection)

    def _refresh_threads(self) -> None:
        with self._lock, self._index.transaction() as connection:
            known: set[str] = set()
            for path in sorted(self.root.glob("*.jsonl")):
                if not _THREAD_ID.fullmatch(path.stem):
                    continue
                known.add(path.stem)
                indexed = connection.execute("SELECT 1 FROM threads WHERE id=?", (path.stem,)).fetchone()
                try:
                    self._index_thread(path.stem, connection)
                except (OSError, ValueError) as exc:
                    if indexed is None:
                        raise ValueError(f"会话日志 {path.name} 无法读取，索引恢复已停止") from exc
                    # Preserve the last listing projection; session reads report the damaged line.
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
        with self._lock:
            thread = self.get_thread(thread_id)
            if not thread["archived"]:
                entries = self.read_entries(thread_id)
                for item in self._project_items(thread_id, entries):
                    approval = item.get("approval")
                    if (item.get("executionState") == "pending_approval"
                            and isinstance(approval, dict) and not approval.get("decision")):
                        self._append_approval_decision(thread_id, item, "expired", live_owner=False)
                self.append(thread_id, Entry(type="thread_info", parent_id=self.last_entry_id(thread_id),
                                             payload={"archived": True}))
            return self.get_thread(thread_id)

    def unarchive_thread(self, thread_id: str) -> dict:
        if self.get_thread(thread_id)["archived"]:
            self.append(thread_id, Entry(type="thread_info", parent_id=self.last_entry_id(thread_id), payload={"archived": False}))
        return self.get_thread(thread_id)

    archive = archive_thread
    unarchive = unarchive_thread

    def delete_thread(self, thread_id: str, *, _on_committed: Callable[[], None] | None = None) -> dict:
        """Permanently remove a rollout and its private event/attachment data."""
        if _on_committed is not None and not callable(_on_committed):
            raise ValueError("会话删除提交回调必须可调用")
        with self._lock:
            intent_path = self._delete_intent_path(thread_id)
            if intent_path.exists():
                intent = self._read_delete_intent(intent_path)
            else:
                prior = None
                with self._index.transaction() as connection:
                    try:
                        self.require_thread(thread_id)
                    except ValueError:
                        if self.path_for(thread_id).exists():
                            raise
                        prior = self._previous_deletion_event(connection, thread_id)
                        if prior is None:
                            raise ThreadNotFound("会话不存在") from None
                    if prior is None:
                        entries = self.read_entries(thread_id)
                        intent = self._write_delete_intent(thread_id, entries)
                        connection.execute("UPDATE checkpoints SET value='' WHERE name='events'")
                if prior is not None:
                    if _on_committed is not None:
                        _on_committed()
                    return prior
            return self._finish_deletion(intent, _on_committed=_on_committed)

    @staticmethod
    def _previous_deletion_event(connection: sqlite3.Connection, thread_id: str) -> dict | None:
        for row in connection.execute("SELECT method,params_json FROM events WHERE method='thread/deleted'"):
            params = json.loads(row["params_json"])
            if params.get("deletedThreadId") == thread_id:
                return {"method": row["method"], "params": params}
        return None

    def _finish_deletion(self, intent: dict[str, Any], *,
                         _on_committed: Callable[[], None] | None = None) -> dict:
        thread_id = intent["threadId"]
        with self._lock, self._index.transaction() as connection:
            connection.execute("PRAGMA secure_delete=ON")
            self._index_events(connection)
            event = self._rewrite_events_for_deletion(connection, intent)
            self._remove_thread_files(thread_id)
            self._purge_unreferenced_attachments(intent["attachmentDigests"])
            self._purge_repair_backups(thread_id)
            connection.execute("DELETE FROM events")
            connection.execute("DELETE FROM checkpoints WHERE name='events'")
            self._index_events(connection)
            connection.execute("DELETE FROM threads WHERE id=?", (thread_id,))
        if _on_committed is not None:
            _on_committed()
        self._checkpoint_and_truncate_wal()
        intent_path = self._delete_intent_path(thread_id)
        if intent_path.exists():
            restrict_private_file(intent_path)
            intent_path.unlink()
            _fsync_directory(self.root)
        return event

    def _remove_private_temporaries(self, paths: list[Path], target: Path) -> None:
        current_uid = getattr(os, "getuid", lambda: -1)()
        for path in paths:
            try:
                original = path.lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(original.st_mode) or original.st_uid != current_uid:
                raise ValueError("会话删除遇到非私有普通文件，清理已暂停")
            if original.st_nlink == 2:
                try:
                    target_stat = target.lstat()
                except FileNotFoundError:
                    target_stat = None
                if (target_stat is None or not stat.S_ISREG(target_stat.st_mode)
                        or target_stat.st_uid != current_uid or target_stat.st_nlink != 2
                        or (original.st_dev, original.st_ino) != (target_stat.st_dev, target_stat.st_ino)):
                    raise ValueError("会话删除遇到无法确认的硬链接临时文件，清理已暂停")
            elif original.st_nlink != 1:
                raise ValueError("会话删除遇到非私有普通文件，清理已暂停")
            restrict_private_file(path)
            path.unlink()
        if paths:
            _fsync_directory(paths[0].parent)

    def _remove_thread_files(self, thread_id: str) -> None:
        session_path = self.path_for(thread_id)
        self._remove_private_temporaries(list(self.root.glob(f".{thread_id}.jsonl.*.tmp")), session_path)
        self._remove_private_temporaries(list(self.root.glob(f".delete-{thread_id}.*.tmp")),
                                         self._delete_intent_path(thread_id))
        self._remove_private_temporaries(
            list(self.root.parent.glob(f".events.jsonl.delete-{thread_id}.*.tmp")), self.events_path)

        try:
            original = session_path.lstat()
        except FileNotFoundError:
            return
        current_uid = getattr(os, "getuid", lambda: -1)()
        if (not stat.S_ISREG(original.st_mode) or original.st_nlink != 1 or original.st_uid != current_uid):
            raise ValueError("会话删除遇到非私有普通文件，清理已暂停")
        restrict_private_file(session_path)
        session_path.unlink()
        _fsync_directory(self.root)

    @staticmethod
    def _event_high_water(connection: sqlite3.Connection) -> int:
        maximum = int(connection.execute("SELECT COALESCE(MAX(cursor),0) FROM events").fetchone()[0])
        try:
            sequence = connection.execute("SELECT seq FROM sqlite_sequence WHERE name='events'").fetchone()
        except sqlite3.OperationalError:
            sequence = None
        return max(maximum, int(sequence[0]) if sequence else 0)

    def _rewrite_events_for_deletion(self, connection: sqlite3.Connection,
                                     intent: dict[str, Any]) -> dict:
        thread_id = intent["threadId"]
        target = self.events_path
        try:
            original = target.lstat()
        except FileNotFoundError:
            original = None
        source_signature = None
        source_handle = None
        if original is not None:
            if not stat.S_ISREG(original.st_mode) or original.st_nlink != 1:
                raise ValueError("事件日志不是普通私有文件，清理已暂停")
            restrict_private_file(target)
            descriptor = open_private_file(target, os.O_RDONLY)
            source_handle = os.fdopen(descriptor, "rb")
            opened = os.fstat(descriptor)
            source_signature = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns,
                                opened.st_ctime_ns, opened.st_mode, opened.st_uid, opened.st_gid,
                                opened.st_nlink)
            visible = target.lstat()
            if (visible.st_dev, visible.st_ino) != (opened.st_dev, opened.st_ino):
                source_handle.close()
                raise ValueError("事件日志在删除期间变化，清理已暂停")

        temporary = target.with_name(f".events.jsonl.delete-{thread_id}.{uuid.uuid4().hex}.tmp")
        descriptor = open_private_file(temporary, os.O_WRONLY | os.O_EXCL)
        event: dict | None = None
        event_count = 0
        maximum_cursor = self._event_high_water(connection)
        seen_cursors: set[int] = set()
        seen_event_ids: set[str] = set()
        last_byte = b"\n"
        try:
            with os.fdopen(descriptor, "wb") as output:
                if source_handle is not None:
                    for line_number, raw_line in enumerate(_iter_bounded_raw_lines_from_handle(
                            source_handle, maximum=MAX_EVENT_LINE_BYTES, label="事件日志"), start=1):
                        if not raw_line.strip():
                            output.write(raw_line + b"\n")
                            last_byte = b"\n"
                            continue
                        try:
                            record = _decode_jsonl_object(
                                raw_line, label="事件日志", line_number=line_number)
                        except ValueError as exc:
                            raise ValueError(f"事件日志损坏，无法安全删除会话：{exc}") from None
                        if not isinstance(record, dict):
                            raise ValueError("事件日志格式无效，无法安全删除会话")
                        method = record.get("method")
                        timestamp = record.get("timestamp")
                        if (record.get("type") != "event"
                                or not isinstance(timestamp, str)
                                or not isinstance(method, str) or not method or len(method) > 256
                                or any(ord(char) < 32 for char in method)
                                or not isinstance(record.get("params"), dict)):
                            raise ValueError("事件日志格式无效，无法安全删除会话")
                        params = record["params"]
                        cursor = _event_cursor(params.get("eventCursor"))
                        event_id = params.get("eventId")
                        if cursor < 1 or not isinstance(event_id, str) or not _EVENT_ID.fullmatch(event_id):
                            raise ValueError("事件日志游标无效，无法安全删除会话")
                        if cursor in seen_cursors:
                            raise ValueError("事件日志存在重复游标，无法安全删除会话")
                        if event_id in seen_event_ids:
                            raise ValueError("事件日志存在重复事件 ID，无法安全删除会话")
                        seen_cursors.add(cursor)
                        seen_event_ids.add(event_id)
                        event_thread_id = params.get("threadId")
                        if event_thread_id is not None:
                            if not isinstance(event_thread_id, str):
                                raise ValueError("事件日志会话 ID 无效，无法安全删除会话")
                            try:
                                self.path_for(event_thread_id)
                            except ValueError:
                                raise ValueError("事件日志会话 ID 无效，无法安全删除会话") from None
                        maximum_cursor = max(maximum_cursor, cursor)
                        if event_id == intent["eventId"]:
                            event_count += 1
                            if (record["method"] != "thread/deleted"
                                    or params.get("deletedThreadId") != thread_id
                                    or "threadId" in params):
                                raise ValueError("会话删除事件与恢复标记冲突")
                            event = {"method": record["method"], "params": params}
                            output.write(raw_line + b"\n")
                            last_byte = b"\n"
                        elif params.get("threadId") != thread_id:
                            output.write(raw_line + b"\n")
                            last_byte = b"\n"
                if event_count > 1:
                    raise ValueError("事件日志含重复的会话删除事件")
                if event is None:
                    if maximum_cursor >= 2**63 - 1:
                        raise ValueError("事件游标已耗尽，无法完成会话删除")
                    params = {"deletedThreadId": thread_id, "eventId": intent["eventId"],
                              "eventCursor": str(maximum_cursor + 1)}
                    event = {"method": "thread/deleted", "params": params}
                    if last_byte != b"\n":
                        output.write(b"\n")
                    output.write((_json({"type": "event", "timestamp": _now(), **event}) + "\n").encode("utf-8"))
                output.flush()
                os.fsync(output.fileno())
            if source_handle is not None:
                opened = os.fstat(source_handle.fileno())
                current_signature = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns,
                                     opened.st_ctime_ns, opened.st_mode, opened.st_uid, opened.st_gid,
                                     opened.st_nlink)
                if current_signature != source_signature:
                    raise ValueError("事件日志在删除期间变化，清理已暂停")
                visible = target.lstat()
                if (visible.st_dev, visible.st_ino) != source_signature[:2]:
                    raise ValueError("事件日志在删除期间变化，清理已暂停")
            if original is None:
                os.link(temporary, target)
                temporary.unlink()
            else:
                os.replace(temporary, target)
            _fsync_directory(target.parent)
        finally:
            if source_handle is not None:
                source_handle.close()
            temporary.unlink(missing_ok=True)
        if event is None:
            raise RuntimeError("删除事件未能生成")
        return event

    def _purge_unreferenced_attachments(self, digests: list[str]) -> None:
        candidates = set(digests)
        if not candidates:
            return
        try:
            directory_stat = self.attachments_root.lstat()
        except FileNotFoundError:
            return
        current_uid = getattr(os, "getuid", lambda: -1)()
        if not stat.S_ISDIR(directory_stat.st_mode) or directory_stat.st_uid != current_uid:
            raise ValueError("附件目录不可信，清理已暂停")
        referenced: set[str] = set()
        for session_path in self.root.glob("*.jsonl"):
            if session_path.stem in self._pending_deletion_ids():
                continue
            original = session_path.lstat()
            if not stat.S_ISREG(original.st_mode) or original.st_uid != current_uid or original.st_nlink != 1:
                raise ValueError("会话文件不可信，无法确认共享附件引用")
            restrict_private_file(session_path)
            try:
                self.require_thread(session_path.stem)
                for line_number, line in enumerate(_iter_bounded_lines(
                        session_path, maximum=MAX_SESSION_LINE_BYTES,
                        label="会话日志", universal_newlines=True), start=1):
                    if not line.strip():
                        continue
                    entry = _decode_session_record(line, line_number=line_number)
                    if (entry is not None and entry.get("type") == "attachment"
                            and isinstance(entry.get("payload"), dict)):
                        digest = entry["payload"].get("digest")
                        if isinstance(digest, str) and _ATTACHMENT_DIGEST.fullmatch(digest):
                            referenced.add(digest)
            except ValueError:
                raise ValueError("会话记录损坏，无法确认共享附件引用") from None
        changed = False
        for digest in candidates - referenced:
            path = self.attachments_root / digest
            try:
                original = path.lstat()
            except FileNotFoundError:
                continue
            if (not stat.S_ISREG(original.st_mode) or original.st_uid != current_uid
                    or original.st_nlink != 1):
                raise ValueError("附件文件不可信，清理已暂停")
            restrict_private_file(path)
            path.unlink()
            changed = True
        if changed:
            _fsync_directory(self.attachments_root)

    def _purge_repair_backups(self, thread_id: str) -> None:
        repair_root = self.root.parent / "repairs"
        try:
            root_stat = repair_root.lstat()
        except FileNotFoundError:
            return
        current_uid = getattr(os, "getuid", lambda: -1)()
        if not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_uid != current_uid:
            raise ValueError("修复备份目录不可信，清理已暂停")
        for database_path in sorted(repair_root.rglob("state.sqlite3")):
            original = database_path.lstat()
            if (not stat.S_ISREG(original.st_mode) or original.st_uid != current_uid
                    or original.st_nlink != 1):
                raise ValueError("修复备份不是私有普通文件，清理已暂停")
            restrict_private_file(database_path)
            backup = sqlite3.connect(database_path, timeout=10, isolation_level=None)
            try:
                backup.execute("PRAGMA busy_timeout=10000")
                backup.execute("PRAGMA foreign_keys=ON")
                backup.execute("PRAGMA synchronous=FULL")
                backup.execute("PRAGMA secure_delete=ON")
                version = int(backup.execute("PRAGMA user_version").fetchone()[0])
                if version > SCHEMA_VERSION:
                    raise ValueError("修复备份包含较新索引，无法安全删除会话")
                tables = {row[0] for row in backup.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
                backup.execute("BEGIN IMMEDIATE")
                try:
                    if "events" in tables:
                        backup.execute("DELETE FROM events WHERE thread_id=?", (thread_id,))
                    if "turns" in tables:
                        backup.execute("DELETE FROM turns WHERE thread_id=?", (thread_id,))
                    if "threads" in tables:
                        backup.execute("DELETE FROM threads WHERE id=?", (thread_id,))
                    backup.commit()
                except BaseException:
                    backup.rollback()
                    raise
                backup.execute("VACUUM")
                result = backup.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                if result and result[0] != 0:
                    raise OSError("修复备份 WAL 尚未收敛")
            finally:
                backup.close()
            backup_directory = database_path.parent
            for sidecar in (database_path.with_name(database_path.name + "-wal"),
                            database_path.with_name(database_path.name + "-shm")):
                try:
                    sidecar_stat = sidecar.lstat()
                except FileNotFoundError:
                    continue
                if (not stat.S_ISREG(sidecar_stat.st_mode) or sidecar_stat.st_uid != current_uid
                        or sidecar_stat.st_nlink != 1):
                    raise ValueError("修复备份 sidecar 不可信，清理已暂停")
                restrict_private_file(sidecar)
                sidecar.unlink()
            _fsync_directory(backup_directory)
            manifest_path = backup_directory / "manifest.json"
            if manifest_path.exists():
                restrict_private_file(manifest_path)
                try:
                    manifest = json.loads(_read_bounded_file(
                        manifest_path, maximum=MAX_REPAIR_MANIFEST_BYTES,
                        label="修复备份清单").decode("utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
                    raise ValueError("修复备份清单损坏，清理已暂停") from None
                if not isinstance(manifest, list) or any(not isinstance(item, dict) for item in manifest):
                    raise ValueError("修复备份清单格式无效，清理已暂停")
                updated = []
                for item in manifest:
                    if item.get("name") in {"state.sqlite3-wal", "state.sqlite3-shm"}:
                        continue
                    if item.get("name") == "state.sqlite3":
                        item = {**item, "bytes": database_path.stat().st_size,
                                "sha256": _sha256_file(database_path)}
                    updated.append(item)
                temporary = manifest_path.with_name(f".manifest.{uuid.uuid4().hex}.tmp")
                descriptor = open_private_file(temporary, os.O_WRONLY | os.O_EXCL)
                try:
                    with os.fdopen(descriptor, "wb") as output:
                        output.write((json.dumps(updated, indent=2) + "\n").encode("utf-8"))
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary, manifest_path)
                finally:
                    temporary.unlink(missing_ok=True)
                _fsync_directory(backup_directory)

    def _checkpoint_and_truncate_wal(self) -> None:
        with self._index.connection() as connection:
            result = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if result and result[0] != 0:
            raise OSError("会话索引 WAL 尚未收敛；删除会在下次启动时继续")

    def list_threads(self, *, include_archived: bool = False) -> list[dict]:
        with self._lock:
            self._refresh_threads()
            pending = self._pending_deletion_ids()
            with self._index.connection() as connection:
                rows = connection.execute("SELECT metadata_json FROM threads" +
                    ("" if include_archived else " WHERE archived=0") + " ORDER BY updated_at DESC,id DESC").fetchall()
        return [thread for row in rows if (thread := json.loads(row["metadata_json"]))["id"] not in pending]

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
        with self._lock:
            self._refresh_threads()
            pending = sorted(self._pending_deletion_ids())
            if pending:
                query += " AND id NOT IN (" + ",".join("?" for _ in pending) + ")"
                parameters.extend(pending)
            query += " ORDER BY updated_at DESC,id DESC LIMIT ?"
            parameters.append(limit + 1)
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

    def record_task_phase(self, thread_id: str, task_id: str, phase: str, status: str, *,
                          attempt: int = 1, restart_limit: int = 0,
                          recovery_reason: str | None = None,
                          resume_policy: str | None = None) -> None:
        """Persist a bounded turn phase checkpoint without replaying its side effects.

        A phase is an observation of local ownership, not permission to retry a
        provider or tool operation.  Recovery may therefore close a running
        phase as interrupted/manual-review while preserving the append-only
        transcript and the existing external-effect fence.
        """
        _identifier(task_id, "taskId")
        if not isinstance(phase, str) or phase not in _TASK_PHASES:
            raise ValueError("任务阶段无效")
        if not isinstance(status, str) or status not in _TERMINAL | {"running"}:
            raise ValueError("任务阶段状态无效")
        if type(attempt) is not int or not 1 <= attempt <= 1_000:
            raise ValueError("任务阶段 attempt 必须是 1 到 1000 之间的整数")
        if type(restart_limit) is not int or not 0 <= restart_limit <= 32:
            raise ValueError("任务阶段 restartLimit 必须是 0 到 32 之间的整数")
        for name, value in (("recoveryReason", recovery_reason), ("resumePolicy", resume_policy)):
            if value is not None and (not isinstance(value, str) or not value or len(value) > 256):
                raise ValueError(f"{name} 格式无效")
        if recovery_reason not in {None, "processExit", "terminalStateRecovered"}:
            raise ValueError("recoveryReason 无效")
        if resume_policy not in {None, "manual", "closed"}:
            raise ValueError("resumePolicy 无效")
        payload: dict[str, Any] = {"taskId": task_id, "ownerKind": "turn", "phase": phase,
                                   "status": status, "attempt": attempt,
                                   "restartLimit": restart_limit}
        if recovery_reason is not None:
            payload["recoveryReason"] = recovery_reason
        if resume_policy is not None:
            payload["resumePolicy"] = resume_policy
        self.append(thread_id, Entry(type="task_phase", parent_id=self.last_entry_id(thread_id),
                                     payload=payload))

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
            turn_positions = {turn["turnId"]: position for position, turn in enumerate(turns)}
            selected_position = turn_positions[selected["turnId"]]

            def checkpoint_in_branch(entry: dict) -> bool:
                payload = entry.get("payload")
                through_turn_id = payload.get("throughTurnId") if isinstance(payload, dict) else None
                position = turn_positions.get(through_turn_id) if isinstance(through_turn_id, str) else None
                return position is not None and position <= selected_position

            prefix = [entry for entry in entries[:cutoff + 1]
                      if entry.get("type") != "context_checkpoint" or checkpoint_in_branch(entry)]
            included_turns = {entry["payload"]["turnId"] for entry in prefix
                              if entry.get("type") == "turn" and "turnId" in entry["payload"]}
            owners = self._item_owners(entries)
            # Recovery may append a revision after later settled turns. Include only
            # corrections owned by the selected prefix, never those unrelated turns.
            for entry in entries[cutoff + 1:]:
                if ((entry.get("type") == "item" and owners.get(entry["id"]) in included_turns)
                        or (entry.get("type") == "turn" and entry["payload"].get("turnId") in included_turns)
                        or (entry.get("type") == "context_edit"
                            and owners.get(entry["payload"].get("targetItemId")) in included_turns)
                        or (entry.get("type") == "context_checkpoint" and checkpoint_in_branch(entry))):
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
                if entry["type"] in {"thread_info", "queue", "task_phase"}:
                    continue
                if (entry["type"] == "context_edit"
                        and owners.get(entry["payload"].get("targetItemId")) not in included_turns):
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
            entries = self.read_entries(thread_id)
            turns = self._turns(entries, thread_id)
            turns_by_id = {turn["turnId"]: turn for turn in turns}
            latest_phases: dict[str, dict[str, Any]] = {}
            for entry in entries:
                if entry.get("type") != "task_phase" or not isinstance(entry.get("payload"), dict):
                    continue
                payload = entry["payload"]
                task_id, phase = payload.get("taskId"), payload.get("phase")
                if (payload.get("ownerKind") == "turn" and isinstance(task_id, str)
                        and _IDENTIFIER.fullmatch(task_id)
                        and isinstance(phase, str) and phase in _TASK_PHASES):
                    latest_phases[task_id] = payload
            for task_id, phase in latest_phases.items():
                turn = turns_by_id.get(task_id)
                if turn is None:
                    continue
                if turn.get("status") in _TERMINAL:
                    status = turn["status"]
                    reason = "terminalStateRecovered"
                    policy = "closed"
                else:
                    status = "interrupted"
                    reason = "processExit"
                    policy = "manual"
                if (phase.get("phase") == "finish" and phase.get("status") == status
                        and (phase.get("resumePolicy") == policy or policy == "closed")):
                    continue
                attempt = phase.get("attempt", 1)
                if type(attempt) is not int or not 1 <= attempt <= 1_000:
                    attempt = 1
                restart_limit = phase.get("restartLimit", 0)
                if type(restart_limit) is not int or not 0 <= restart_limit <= 32:
                    restart_limit = 0
                phase_was_running = phase.get("status") == "running"
                if phase_was_running:
                    self.record_task_phase(
                        thread_id, task_id, phase["phase"], status,
                        attempt=attempt, restart_limit=restart_limit,
                        recovery_reason=reason, resume_policy=policy,
                    )
                if phase.get("phase") != "finish" or not phase_was_running:
                    self.record_task_phase(thread_id, task_id, "finish", status,
                                           attempt=attempt, restart_limit=restart_limit,
                                           recovery_reason=reason, resume_policy=policy)
            turn_by_item = self._item_owners(entries)
            items = self._project_items(thread_id, entries)
            recovered_turns: set[str] = set()
            for item in items:
                approval = item.get("approval")
                pending_approval = isinstance(approval, dict) and not approval.get("decision")
                if item.get("status") != "running" and not pending_approval:
                    continue
                if (pending_approval and self._valid_approval_item(item, pending_only=True)
                        and approval["deadline"] > time.time()):
                    continue
                payload = {key: value for key, value in item.items() if key not in {"id", "threadId"}}
                payload.update(status="failed", revises=item["id"])
                if pending_approval:
                    payload["approval"] = {**approval, "decision": "expired", "decidedAt": _now()}
                if item.get("kind") == "toolCall":
                    payload.update(errorCode="SESSION_INTERRUPTED", resultSummary="上次进程在操作收尾前退出，结果不确定；先核对平台状态，不要直接重试。")
                    phase = item.get("executionState")
                    payload["executionState"] = "not_executed" if phase in {
                        "queued", "pending_approval", "approved", "not_approved"} else "outcome_unknown"
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
        pending = self._pending_deletion_ids()
        if pending:
            connection.execute("PRAGMA secure_delete=ON")
        for thread_id in pending:
            connection.execute("DELETE FROM events WHERE thread_id=?", (thread_id,))
        if not self.events_path.exists():
            connection.execute("PRAGMA secure_delete=ON")
            connection.execute("DELETE FROM events")
            connection.execute("DELETE FROM checkpoints WHERE name='events'")
            return
        stat = self.events_path.stat()
        fingerprint = f"{stat.st_size}:{stat.st_mtime_ns}"
        checkpoint = connection.execute("SELECT value FROM checkpoints WHERE name='events'").fetchone()
        if checkpoint and checkpoint["value"] == fingerprint:
            return
        connection.execute("PRAGMA secure_delete=ON")
        connection.execute("DELETE FROM events")
        for line_number, line in enumerate(_iter_bounded_lines(
                self.events_path, maximum=MAX_EVENT_LINE_BYTES, label="事件日志"), start=1):
            if not line.strip():
                continue
            record = _decode_jsonl_object(line, label="事件日志", line_number=line_number)
            params = record.get("params")
            method = record.get("method")
            if (record.get("type") != "event" or not isinstance(record.get("timestamp"), str)
                    or not isinstance(params, dict) or not isinstance(method, str) or not method
                    or len(method) > 256 or any(ord(char) < 32 for char in method)):
                raise ValueError(f"事件日志第 {line_number} 行格式无效，读取已停止")
            event_id = params.get("eventId")
            try:
                cursor = _event_cursor(params.get("eventCursor"))
            except ValueError:
                raise ValueError(f"事件日志第 {line_number} 行游标无效，读取已停止") from None
            thread_id = params.get("threadId")
            if (not isinstance(event_id, str) or not _EVENT_ID.fullmatch(event_id) or cursor < 1
                    or (thread_id is not None and not isinstance(thread_id, str))):
                raise ValueError(f"事件日志第 {line_number} 行格式无效，读取已停止")
            if thread_id is not None:
                try:
                    self.path_for(thread_id)
                except ValueError:
                    raise ValueError(f"事件日志第 {line_number} 行 threadId 无效，读取已停止") from None
            previous = connection.execute("SELECT event_id FROM events WHERE cursor=?", (cursor,)).fetchone()
            if previous and previous["event_id"] != event_id:
                raise ValueError("事件日志存在重复游标，请保留原文件后恢复")
            try:
                connection.execute("""INSERT INTO events(cursor,event_id,method,thread_id,params_json)
                    VALUES(?,?,?,?,?)""", (cursor, event_id, method, thread_id, _json(params)))
            except sqlite3.IntegrityError:
                raise ValueError(f"事件日志第 {line_number} 行包含重复 eventId，读取已停止") from None
        for thread_id in pending:
            connection.execute("DELETE FROM events WHERE thread_id=?", (thread_id,))
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
        _json(payload)
        with self._lock, self._index.transaction() as connection:
            if thread_id is not None:
                self.require_thread(thread_id)
            self._index_events(connection)
            event_id = uuid.uuid4().hex
            inserted = connection.execute("INSERT INTO events(event_id,method,thread_id,params_json) VALUES(?,?,?,'{}')", (event_id, method, thread_id))
            payload.update(eventId=event_id, eventCursor=str(inserted.lastrowid))
            frame = {"method": method, "params": payload}
            record = {"type": "event", "timestamp": _now(), **frame}
            if len(_json(record).encode("utf-8")) > MAX_EVENT_LINE_BYTES:
                raise ValueError("事件日志单行超过大小限制")
            self._append_line(self.events_path, record)
            connection.execute("UPDATE events SET params_json=? WHERE cursor=?", (_json(payload), inserted.lastrowid))
            stat = self.events_path.stat()
            connection.execute("INSERT INTO checkpoints(name,value) VALUES('events',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", (f"{stat.st_size}:{stat.st_mtime_ns}",))
        return frame

    def events_after(self, cursor: str | None = None, thread_id: str | None = None, limit: int = 100,
                     methods: tuple[str, ...] | list[str] | None = None) -> dict:
        position = _event_cursor(cursor)
        _limit(limit, 1000)
        if thread_id is not None:
            self.require_thread(thread_id)
        if methods is not None and (not isinstance(methods, (tuple, list)) or not 1 <= len(methods) <= 16
                or any(not isinstance(method, str) or not method or len(method) > 256
                       or any(ord(char) < 32 for char in method) for method in methods)):
            raise ValueError("事件方法筛选无效")
        query = "SELECT cursor,method,params_json FROM events WHERE cursor>?"
        parameters: list[Any] = [position]
        if thread_id is not None:
            query += " AND thread_id=?"
            parameters.append(thread_id)
        if methods is not None:
            query += " AND method IN (" + ",".join("?" for _ in methods) + ")"
            parameters.extend(methods)
        query += " ORDER BY cursor LIMIT ?"
        parameters.append(limit + 1)
        with self._lock:
            pending = sorted(self._pending_deletion_ids()) if thread_id is None else []
            if pending:
                query = query.replace(" ORDER BY cursor LIMIT ?",
                    " AND (thread_id IS NULL OR thread_id NOT IN (" + ",".join("?" for _ in pending)
                    + ")) ORDER BY cursor LIMIT ?")
                parameters[-1:-1] = pending
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
