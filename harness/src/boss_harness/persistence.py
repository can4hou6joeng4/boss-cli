"""SQLite projection index; JSONL rollout and event journals remain rebuildable sources.

Schema version 1 separates thread metadata, turn metadata and ordered transport events.
Each operation owns its SQLite connection, so worker threads never share a cursor or
an uncommitted transaction. WAL readers do not block the single serialized writer.
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from boss_harness.private_files import ensure_private_file_support, open_private_file, restrict_private_file


SCHEMA_VERSION = 1


class PersistenceIndex:
    def __init__(self, path: Path) -> None:
        self.path = path
        ensure_private_file_support()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._restrict_sidecars()
        try:
            descriptor = open_private_file(self.path, os.O_RDWR | os.O_EXCL)
        except FileExistsError:
            restrict_private_file(self.path)
        else:
            os.close(descriptor)
        with self.connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("BEGIN IMMEDIATE")
            self._restrict_sidecars()
            try:
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                if version > SCHEMA_VERSION:
                    raise ValueError("会话索引版本较新，请使用兼容的应用版本")
                if version < 1:
                    for statement in (
                        """CREATE TABLE threads (
                            id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE,
                            rollout_path TEXT NOT NULL, title TEXT NOT NULL,
                            project_id TEXT, archived INTEGER NOT NULL DEFAULT 0,
                            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                            last_turn_id TEXT, metadata_json TEXT NOT NULL,
                            indexed_size INTEGER NOT NULL, indexed_mtime_ns INTEGER NOT NULL
                        )""",
                        "CREATE INDEX threads_listing ON threads(archived, updated_at DESC, id DESC)",
                        "CREATE INDEX threads_project ON threads(project_id, archived, updated_at DESC, id DESC)",
                        """CREATE TABLE turns (
                            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                            turn_id TEXT NOT NULL, status TEXT NOT NULL,
                            first_ordinal INTEGER NOT NULL, last_ordinal INTEGER NOT NULL,
                            metadata_json TEXT NOT NULL,
                            PRIMARY KEY(thread_id, turn_id)
                        )""",
                        "CREATE INDEX turns_listing ON turns(thread_id, first_ordinal, turn_id)",
                        """CREATE TABLE events (
                            cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                            event_id TEXT NOT NULL UNIQUE, method TEXT NOT NULL,
                            thread_id TEXT, params_json TEXT NOT NULL
                        )""",
                        "CREATE INDEX events_thread ON events(thread_id, cursor)",
                        "CREATE TABLE checkpoints (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
                    ):
                        connection.execute(statement)
                    connection.execute("PRAGMA user_version=1")
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA synchronous=FULL")
        try:
            yield connection
        finally:
            connection.close()

    def _restrict_sidecars(self) -> None:
        for path in (self.path.with_name(self.path.name + "-wal"),
                     self.path.with_name(self.path.name + "-shm")):
            try:
                restrict_private_file(path)
            except FileNotFoundError:
                pass

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._restrict_sidecars()
            try:
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
