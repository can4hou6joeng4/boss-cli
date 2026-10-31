"""Private, bounded disk-backed projections used by frozen session snapshots."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from typing import BinaryIO
import uuid

from boss_harness.private_files import ensure_private_directory, open_private_file, restrict_private_file
from boss_harness.rpc import RpcError
from boss_harness.session import MAX_SESSION_LINE_BYTES, _decode_session_record

MAX_SNAPSHOT_RECORD_BYTES = MAX_SESSION_LINE_BYTES
MAX_SNAPSHOT_SOURCE_BYTES = 1024 * 1024 * 1024
MAX_SNAPSHOT_ITEM_BYTES = 128 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024
MAX_SNAPSHOT_CACHE_BYTES = 512 * 1024 * 1024
MAX_SNAPSHOTS = 16
SNAPSHOT_TTL_SECONDS = 120
MAX_STALE_SNAPSHOTS = 64
_CONTEXT_EDIT_MAX_CHARS = 32_000
_CONTEXT_EDIT_MAX_BYTES = 128 * 1024


def snapshot_leaf_changed(snapshot_id: str) -> RpcError:
    """Stable, recognizable error for a branch snapshot whose leaf moved after it was frozen."""
    return RpcError(-32011, "会话分支指针已变化，该分支快照已失效；请重新 thread/resume snapshot=true view=branch",
                    {"code": "SNAPSHOT_LEAF_CHANGED", "snapshotId": snapshot_id,
                     "recoveryMethod": "thread/resume", "view": "branch", "snapshot": True})


def snapshot_view_mismatch(snapshot_id: str, view: str) -> RpcError:
    return RpcError(-32011, "快照视图与读取视图不一致；分支快照只能用 view=branch 分页，日志快照不能用 view=branch",
                    {"code": "SNAPSHOT_VIEW_MISMATCH", "snapshotId": snapshot_id, "snapshotView": view})


def read_source_entries(source: BinaryIO, size: int) -> list[dict]:
    """Decode a pinned rollout prefix once (branch projection needs the whole prefix), then rewind."""
    if size > MAX_SNAPSHOT_SOURCE_BYTES:
        raise ValueError("会话文件超过冻结快照读取上限")
    source.seek(0)
    entries: list[dict] = []
    try:
        for line_number, raw in enumerate(_lines(source, size), start=1):
            if not raw.strip():
                continue
            entry = _decode_session_record(raw, line_number=line_number)
            if entry is not None:
                entries.append(entry)
    finally:
        source.seek(0)
    return entries


class SnapshotBuild:
    __slots__ = ("thread_id", "invalidated", "released")

    def __init__(self, thread_id: str) -> None:
        self.thread_id = thread_id
        self.invalidated = False
        self.released = False


def _lines(source: BinaryIO, size: int):
    remaining = size
    pending = bytearray()
    skip_lf = False
    while remaining:
        chunk = source.read(min(64 * 1024, remaining))
        if not chunk:
            break
        remaining -= len(chunk)
        start = 0
        for index, value in enumerate(chunk):
            if skip_lf:
                skip_lf = False
                if value == 10:
                    start = index + 1
                    continue
            if value not in (10, 13):
                continue
            pending.extend(chunk[start:index])
            if len(pending) > MAX_SNAPSHOT_RECORD_BYTES:
                raise ValueError("会话记录超过冻结快照读取上限")
            yield bytes(pending)
            pending.clear()
            start = index + 1
            skip_lf = value == 13 and index == len(chunk) - 1
        pending.extend(chunk[start:])
        if len(pending) > MAX_SNAPSHOT_RECORD_BYTES:
            raise ValueError("会话记录超过冻结快照读取上限")
    if pending:
        yield bytes(pending)


class SnapshotBuilder:
    def __init__(self, path: Path, thread_id: str, snapshot_id: str) -> None:
        self.path = path
        self.thread_id = thread_id
        self.snapshot_id = snapshot_id
        descriptor = open_private_file(path, os.O_RDWR | os.O_EXCL)
        os.close(descriptor)
        self.connection = sqlite3.connect(path, isolation_level=None)
        self.connection.execute("PRAGMA journal_mode=OFF")
        self.connection.execute("PRAGMA synchronous=OFF")
        self.connection.execute("PRAGMA cache_size=-256")
        self.connection.execute("PRAGMA temp_store=FILE")
        page_size = self.connection.execute("PRAGMA page_size").fetchone()[0]
        max_pages = MAX_SNAPSHOT_BYTES // page_size
        actual_max_pages = self.connection.execute(f"PRAGMA max_page_count={max_pages}").fetchone()[0]
        if actual_max_pages > max_pages:
            self.connection.close()
            _remove_snapshot_files(path)
            raise ValueError("无法为冻结快照设置磁盘预算")
        self.connection.execute("CREATE TABLE items (ordinal INTEGER PRIMARY KEY, item_id TEXT NOT NULL, payload TEXT NOT NULL)")
        self.connection.execute("CREATE INDEX items_by_id ON items(item_id)")
        self.connection.execute("CREATE TABLE aliases (alias TEXT PRIMARY KEY, ordinal INTEGER NOT NULL)")
        self.connection.execute("CREATE TABLE edits (item_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, excluded INTEGER NOT NULL)")
        self.connection.execute("CREATE TABLE queue_items (queue_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, payload TEXT NOT NULL)")
        self.connection.execute("CREATE INDEX queue_items_order ON queue_items(ordinal)")
        self.count = 0
        self.item_bytes = 0
        self.queue_count = 0

    def _alias(self, item_id: str) -> int | None:
        row = self.connection.execute("SELECT ordinal FROM aliases WHERE alias=?", (item_id,)).fetchone()
        return int(row[0]) if row else None

    def _read_item(self, ordinal: int) -> dict:
        row = self.connection.execute("SELECT payload FROM items WHERE ordinal=?", (ordinal,)).fetchone()
        if row is None:
            raise ValueError("冻结快照索引不一致")
        return json.loads(row[0])

    def _write_item(self, ordinal: int, item: dict, *, is_new: bool, previous_size: int = 0) -> None:
        encoded = json.dumps(item, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        size = len(encoded.encode("utf-8"))
        self.item_bytes += size - previous_size
        if self.item_bytes > MAX_SNAPSHOT_ITEM_BYTES:
            raise ValueError("冻结会话超过快照条目存储上限")
        if is_new:
            self.connection.execute("INSERT INTO items(ordinal,item_id,payload) VALUES(?,?,?)",
                                     (ordinal, item["id"], encoded))
            self.count += 1
        else:
            self.connection.execute("UPDATE items SET payload=? WHERE ordinal=?", (encoded, ordinal))

    def _entry(self, entry: dict) -> None:
        entry_type = entry.get("type")
        entry_id = str(entry.get("id") or "")
        payload = entry.get("payload")
        if entry_type == "item":
            if not isinstance(payload, dict):
                return
            target_id = str(payload.get("revises") or "")
            if not target_id and payload.get("kind") == "toolCall" and payload.get("status") != "running":
                parent_id = str(entry.get("parentId") or "")
                parent_ordinal = self._alias(parent_id) if parent_id else None
                if parent_ordinal is not None and self._read_item(parent_ordinal).get("kind") == "toolCall":
                    target_id = parent_id
            ordinal = self._alias(target_id) if target_id else None
            if ordinal is not None:
                current = self._read_item(ordinal)
                previous_size = len(json.dumps(current, ensure_ascii=False, allow_nan=False,
                                                separators=(",", ":")).encode("utf-8"))
                merged = {**current, **payload, "id": current["id"], "threadId": self.thread_id}
                self._write_item(ordinal, merged, is_new=False, previous_size=previous_size)
            else:
                ordinal = self.count
                merged = {**payload, "id": entry_id, "threadId": self.thread_id}
                self._write_item(ordinal, merged, is_new=True)
            self.connection.execute("INSERT INTO aliases(alias,ordinal) VALUES(?,?) "
                                    "ON CONFLICT(alias) DO UPDATE SET ordinal=excluded.ordinal",
                                    (entry_id, ordinal))
        elif entry_type == "context_edit":
            if (not isinstance(payload, dict) or set(payload) != {"targetItemId", "replacementText"}
                    or not isinstance(payload.get("targetItemId"), str)
                    or self._alias(payload["targetItemId"]) is None):
                raise ValueError("会话上下文编辑记录无效；已停止生成模型上下文")
            replacement = payload["replacementText"]
            if (replacement is not None and not isinstance(replacement, str)):
                raise ValueError("会话上下文编辑记录无效；已停止生成模型上下文")
            if (isinstance(replacement, str) and
                    (not replacement.strip() or len(replacement) > _CONTEXT_EDIT_MAX_CHARS
                     or len(replacement.encode("utf-8")) > _CONTEXT_EDIT_MAX_BYTES)):
                raise ValueError("会话上下文编辑记录无效；已停止生成模型上下文")
            self.connection.execute("INSERT INTO edits(item_id,entry_id,excluded) VALUES(?,?,?) "
                                    "ON CONFLICT(item_id) DO UPDATE SET entry_id=excluded.entry_id,excluded=excluded.excluded",
                                    (payload["targetItemId"], entry_id, int(replacement is None)))
        elif entry_type == "queue":
            queue_id = payload.get("id")
            if not isinstance(queue_id, str):
                raise ValueError("会话队列记录无效")
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            ordinal = self.queue_count
            self.queue_count += 1
            self.connection.execute("""INSERT INTO queue_items(queue_id,ordinal,payload)
                VALUES(?,?,?) ON CONFLICT(queue_id) DO UPDATE SET payload=excluded.payload""",
                (queue_id, ordinal, encoded))

    def build(self, source: BinaryIO, size: int, live: dict[str, dict], cancelled,
              keep_ids: frozenset[str] | None = None) -> int:
        try:
            if size > MAX_SNAPSHOT_SOURCE_BYTES:
                raise ValueError("会话文件超过冻结快照读取上限")
            self.connection.execute("BEGIN IMMEDIATE")
            line_count = 0
            for raw in _lines(source, size):
                line_count += 1
                if line_count % 128 == 0 and cancelled():
                    raise ValueError("会话快照已因删除或关闭而取消")
                if not raw.strip():
                    continue
                entry = _decode_session_record(raw, line_number=line_count)
                if entry is None:
                    continue
                if keep_ids is not None and entry.get("id") not in keep_ids:
                    # Branch view: records outside the frozen leaf projection never enter the snapshot.
                    continue
                self._entry(entry)
                pages = self.connection.execute("PRAGMA page_count").fetchone()[0]
                page_size = self.connection.execute("PRAGMA page_size").fetchone()[0]
                if pages * page_size > MAX_SNAPSHOT_BYTES:
                    raise ValueError("冻结会话超过快照磁盘预算")
            for item_id, delta in live.items():
                ordinal = self._alias(item_id)
                if ordinal is None or not isinstance(delta, dict):
                    continue
                item = self._read_item(ordinal)
                if item.get("status") == "running":
                    previous_size = len(json.dumps(item, ensure_ascii=False, allow_nan=False,
                                                   separators=(",", ":")).encode("utf-8"))
                    self._write_item(ordinal, {**item, **delta}, is_new=False, previous_size=previous_size)
            dangling_edit = self.connection.execute("""SELECT edits.item_id FROM edits
                LEFT JOIN items ON items.item_id=edits.item_id WHERE items.item_id IS NULL LIMIT 1""").fetchone()
            if dangling_edit is not None:
                raise ValueError("会话上下文编辑引用了不存在的条目；已停止生成模型上下文")
            self.connection.commit()
            self.connection.close()
            self.connection = None
            restrict_private_file(self.path)
            size_on_disk = self.path.stat().st_size
            if size_on_disk > MAX_SNAPSHOT_BYTES:
                raise ValueError("冻结会话超过快照磁盘预算")
            return size_on_disk
        except BaseException:
            if self.connection is not None:
                self.connection.close()
                self.connection = None
            _remove_snapshot_files(self.path)
            raise


def _remove_snapshot_files(path: Path) -> None:
    for suffix in ("", "-journal", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)


class SnapshotStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root).absolute() / "resume-snapshots"
        ensure_private_directory(self.root)
        for path in self.root.iterdir():
            if path.name.endswith((".sqlite", ".building", ".sqlite-journal", ".building-journal",
                                   ".sqlite-wal", ".building-wal", ".sqlite-shm", ".building-shm")):
                if path.is_file():
                    restrict_private_file(path)
                    path.unlink(missing_ok=True)
        self._lock = threading.RLock()
        self._snapshots: dict[str, tuple[str, Path, float, int, int]] = {}
        # snapshotId -> (view, leaf record id frozen with it); "log" snapshots ignore the leaf.
        self._bindings: dict[str, tuple[str, str | None]] = {}
        # Latest leaf record id announced per thread since start, and bounded tombstones of
        # branch snapshots invalidated by a leaf move (snapshotId -> (threadId, expiry)).
        self._current_leaf: dict[str, str | None] = {}
        self._stale: dict[str, tuple[str, float]] = {}
        self._active_builds = 0
        self._builds_by_thread: dict[str, set[SnapshotBuild]] = {}
        self._closed = False

    def begin_build(self, thread_id: str) -> SnapshotBuild:
        with self._lock:
            if self._closed:
                raise ValueError("冻结快照存储已关闭")
            if self._active_builds >= 2:
                raise ValueError("冻结快照构建已达到并发上限，请稍后重试")
            build = SnapshotBuild(thread_id)
            self._builds_by_thread.setdefault(thread_id, set()).add(build)
            self._active_builds += 1
            return build

    def cancel_build(self, build: SnapshotBuild) -> None:
        with self._lock:
            self._release_build_locked(build)

    def _release_build_locked(self, build: SnapshotBuild) -> None:
        if build.released:
            return
        build.released = True
        builds = self._builds_by_thread.get(build.thread_id)
        if builds is not None:
            builds.discard(build)
            if not builds:
                self._builds_by_thread.pop(build.thread_id, None)
        self._active_builds -= 1

    def _prune_locked(self, now: float) -> None:
        for key in [key for key, value in self._stale.items() if value[1] <= now]:
            self._stale.pop(key, None)
        expired = [key for key, value in self._snapshots.items() if value[2] <= now]
        for key in expired:
            _, path, _, _, _ = self._snapshots.pop(key)
            self._bindings.pop(key, None)
            _remove_snapshot_files(path)
        while len(self._snapshots) > MAX_SNAPSHOTS or sum(value[4] for value in self._snapshots.values()) > MAX_SNAPSHOT_CACHE_BYTES:
            key = next(iter(self._snapshots))
            _, path, _, _, _ = self._snapshots.pop(key)
            self._bindings.pop(key, None)
            _remove_snapshot_files(path)

    def create(self, build: SnapshotBuild, snapshot_id: str, source: BinaryIO, size: int,
               live: dict[str, dict], *, keep_ids: frozenset[str] | None = None,
               view: str = "log", leaf_entry_id: str | None = None) -> tuple[int, int]:
        if build.released:
            raise ValueError("冻结快照构建已结束")
        thread_id = build.thread_id
        building = self.root / f".{snapshot_id}.{uuid.uuid4().hex}.building"
        final = self.root / f"{snapshot_id}.sqlite"
        try:
            with self._lock:
                if self._closed or build.invalidated or build.released:
                    raise ValueError("会话快照已因删除或关闭而取消")
            builder = SnapshotBuilder(building, thread_id, snapshot_id)
            builder.build(source, size, live, lambda: self._build_cancelled(build), keep_ids)
            count = builder.count
            os.replace(building, final)
            restrict_private_file(final)
            disk_size = final.stat().st_size
            if disk_size > MAX_SNAPSHOT_BYTES:
                raise ValueError("冻结会话超过快照磁盘预算")
            with self._lock:
                if self._closed or build.invalidated or build.released:
                    raise ValueError("会话快照已因删除或关闭而取消")
                if (view == "branch" and thread_id in self._current_leaf
                        and self._current_leaf[thread_id] != leaf_entry_id):
                    raise snapshot_leaf_changed(snapshot_id)
                self._prune_locked(time.monotonic())
                while self._snapshots and (
                        len(self._snapshots) >= MAX_SNAPSHOTS
                        or sum(value[4] for value in self._snapshots.values()) + disk_size > MAX_SNAPSHOT_CACHE_BYTES):
                    key = next(iter(self._snapshots))
                    _, path, _, _, _ = self._snapshots.pop(key)
                    self._bindings.pop(key, None)
                    path.unlink(missing_ok=True)
                self._snapshots[snapshot_id] = (thread_id, final, time.monotonic() + SNAPSHOT_TTL_SECONDS,
                                                count, disk_size)
                self._bindings[snapshot_id] = (view, leaf_entry_id)
            return count, disk_size
        except BaseException:
            _remove_snapshot_files(building)
            _remove_snapshot_files(final)
            raise
        finally:
            with self._lock:
                self._release_build_locked(build)

    def _build_cancelled(self, build: SnapshotBuild) -> bool:
        with self._lock:
            return self._closed or build.invalidated or build.released

    def metadata(self, snapshot_id: str, thread_id: str) -> tuple[Path, int]:
        with self._lock:
            self._prune_locked(time.monotonic())
            value = self._snapshots.get(snapshot_id)
            if value is None or value[0] != thread_id:
                raise ValueError("会话快照已过期；请重新 resume")
            return value[1], value[3]

    def page(self, snapshot_id: str, thread_id: str, offset: int, limit: int,
             max_payload_bytes: int = 2 * 1024 * 1024, *,
             view: str = "log") -> tuple[list[tuple[dict, dict | None]], int]:
        with self._lock:
            path, count = self._metadata_locked(snapshot_id, thread_id)
            bound_view = self._bindings.get(snapshot_id, ("log", None))[0]
            if bound_view != view:
                raise snapshot_view_mismatch(snapshot_id, bound_view)
            if offset > count:
                raise ValueError("条目分页游标超出结果范围")
            connection = sqlite3.connect(path)
            try:
                connection.execute("PRAGMA cache_size=-256")
                rows = connection.execute("""SELECT items.payload,edits.entry_id,edits.excluded
                    FROM items LEFT JOIN edits ON edits.item_id=items.item_id
                    WHERE items.ordinal>=? ORDER BY items.ordinal LIMIT ?""", (offset, limit))
                result = []
                payload_bytes = 0
                for row in rows:
                    payload_bytes += len(row[0].encode("utf-8"))
                    if result and payload_bytes > max_payload_bytes:
                        break
                    result.append((json.loads(row[0]), {"entryId": row[1], "excluded": bool(row[2])}
                                   if row[1] is not None else None))
            finally:
                connection.close()
            return result, count

    def item(self, snapshot_id: str, thread_id: str, item_id: str) -> dict | None:
        with self._lock:
            path, _ = self._metadata_locked(snapshot_id, thread_id)
            connection = sqlite3.connect(path)
            try:
                connection.execute("PRAGMA cache_size=-256")
                row = connection.execute("SELECT payload FROM items WHERE item_id=?", (item_id,)).fetchone()
            finally:
                connection.close()
            return json.loads(row[0]) if row else None

    def edit_state(self, snapshot_id: str, thread_id: str, item_id: str) -> dict | None:
        with self._lock:
            path, _ = self._metadata_locked(snapshot_id, thread_id)
            connection = sqlite3.connect(path)
            try:
                row = connection.execute("SELECT entry_id,excluded FROM edits WHERE item_id=?", (item_id,)).fetchone()
            finally:
                connection.close()
            return {"entryId": row[0], "excluded": bool(row[1])} if row else None

    def queue(self, snapshot_id: str, thread_id: str,
              max_payload_bytes: int = 1024 * 1024) -> tuple[list[dict], bool]:
        with self._lock:
            path, _ = self._metadata_locked(snapshot_id, thread_id)
            connection = sqlite3.connect(path)
            try:
                connection.execute("PRAGMA cache_size=-256")
                rows = connection.execute(
                    "SELECT payload FROM queue_items ORDER BY ordinal")
                result = []
                payload_bytes = 0
                for row in rows:
                    payload_bytes += len(row[0].encode("utf-8"))
                    if payload_bytes > max_payload_bytes:
                        return result, True
                    result.append(json.loads(row[0]))
                return result, False
            finally:
                connection.close()

    def _metadata_locked(self, snapshot_id: str, thread_id: str) -> tuple[Path, int]:
        self._prune_locked(time.monotonic())
        stale = self._stale.get(snapshot_id)
        if stale is not None and stale[0] == thread_id:
            raise snapshot_leaf_changed(snapshot_id)
        value = self._snapshots.get(snapshot_id)
        if value is None or value[0] != thread_id:
            raise ValueError("会话快照已过期；请重新 resume")
        return value[1], value[3]

    def delete_snapshot(self, snapshot_id: str) -> None:
        with self._lock:
            value = self._snapshots.pop(snapshot_id, None)
            self._bindings.pop(snapshot_id, None)
            if value is not None:
                _remove_snapshot_files(value[1])

    def invalidate_branch(self, thread_id: str, leaf_entry_id: str | None) -> list[str]:
        """Record the thread's new leaf; branch snapshots frozen at another leaf become stale.

        Stale snapshots are removed from disk but keep a bounded tombstone until
        their TTL, so later pages and content reads fail with the same
        SNAPSHOT_LEAF_CHANGED code instead of a generic expiry.  In-flight branch
        builds compare against the recorded leaf when they register.
        """
        with self._lock:
            self._current_leaf[thread_id] = leaf_entry_id
            now = time.monotonic()
            stale = []
            for key, value in list(self._snapshots.items()):
                view, leaf = self._bindings.get(key, ("log", None))
                if value[0] != thread_id or view != "branch" or leaf == leaf_entry_id:
                    continue
                self._snapshots.pop(key, None)
                self._bindings.pop(key, None)
                _remove_snapshot_files(value[1])
                self._stale[key] = (thread_id, max(value[2], now + 1))
                stale.append(key)
            while len(self._stale) > MAX_STALE_SNAPSHOTS:
                self._stale.pop(next(iter(self._stale)))
            return stale

    def delete_thread(self, thread_id: str) -> None:
        with self._lock:
            for build in self._builds_by_thread.get(thread_id, ()):
                build.invalidated = True
            self._current_leaf.pop(thread_id, None)
            for key, value in list(self._stale.items()):
                if value[0] == thread_id:
                    self._stale.pop(key, None)
            for key, value in list(self._snapshots.items()):
                if value[0] == thread_id:
                    self._snapshots.pop(key, None)
                    self._bindings.pop(key, None)
                    _remove_snapshot_files(value[1])

    def close(self) -> None:
        with self._lock:
            self._closed = True
            for builds in self._builds_by_thread.values():
                for build in builds:
                    build.invalidated = True
            for _, path, _, _, _ in self._snapshots.values():
                _remove_snapshot_files(path)
            self._snapshots.clear()
            self._bindings.clear()
            self._stale.clear()
            for pattern in (".*.building", ".*.building-journal", ".*.building-wal", ".*.building-shm",
                            "*.sqlite", "*.sqlite-journal", "*.sqlite-wal", "*.sqlite-shm"):
                for path in self.root.glob(pattern):
                    path.unlink(missing_ok=True)
