"""会话存储：append-only 的 JSONL，每条 entry 带 id 与 parentId。

形状取自 Pi 的 SessionManager：树用父指针表示，当前分支由 leaf 决定。
首版只做线性追加，分支与压缩留待后续。
"""
from __future__ import annotations

import json
import re
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


@dataclass
class Entry:
    type: str
    id: str = field(default_factory=_new_id)
    parent_id: str | None = None
    timestamp: str = field(default_factory=_now)
    payload: dict | None = None

    def to_dict(self) -> dict:
        data: dict = {
            "type": self.type,
            "id": self.id,
            "parentId": self.parent_id,
            "timestamp": self.timestamp,
        }
        if self.payload is not None:
            data["payload"] = self.payload
        return data


class SessionStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def path_for(self, thread_id: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{12}", thread_id):
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

    def create(self, title: str = "新会话") -> dict:
        thread_id = uuid.uuid4().hex[:12]
        header = {"type": "session", "id": thread_id, "title": title, "createdAt": _now()}
        self.path_for(thread_id).write_text(
            json.dumps(header, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        return {"id": thread_id, "title": title, "createdAt": header["createdAt"], "updatedAt": _now()}

    def append(self, thread_id: str, entry: Entry) -> Entry:
        with self._lock:
            self.require_thread(thread_id)
            path = self.path_for(thread_id)
            # 崩溃可能留下半行；保留原片段但隔开它，后续记录仍可正常读取。
            with path.open("rb+") as handle:
                handle.seek(0, 2)
                if handle.tell():
                    handle.seek(-1, 2)
                    if handle.read(1) != b"\n":
                        handle.seek(0, 2)
                        handle.write(b"\n")
                handle.seek(0, 2)
                handle.write((json.dumps(entry.to_dict(), ensure_ascii=False) + "\n").encode("utf-8"))
        return entry

    def last_entry_id(self, thread_id: str) -> str | None:
        entries = self.read_entries(thread_id)
        return entries[-1]["id"] if entries else None

    def read_entries(self, thread_id: str) -> list[dict]:
        with self._lock:
            self.require_thread(thread_id)
            content = self.path_for(thread_id).read_text(encoding="utf-8", errors="replace")
        out: list[dict] = []
        for line in content.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (isinstance(data, dict) and data.get("type") != "session"
                    and isinstance(data.get("id"), str) and isinstance(data.get("payload"), dict)):
                out.append(data)
        return out

    def read_items(self, thread_id: str) -> list[dict]:
        """读取并合并会话中的逻辑条目（对照 Pi 的 buildSessionProjection）。

        JSONL 底层保持 append-only：流式消息和工具调用在开始时写一条初态条目，收尾时写一条带
        `revises`（或同源 `parentId`）的终态条目。这里把修正条目原地合并到目标条目上，使
        `thread/read` 与 `history()` 只看到每条逻辑条目的最终状态，不会出现重复消息或悬空卡片。
        """
        items: list[dict] = []
        index_by_id: dict[str, int] = {}
        for entry in self.read_entries(thread_id):
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
                items.append({"id": entry_id, "threadId": thread_id, **payload})
        return items

    def record_turn(self, thread_id: str, turn_id: str, status: str) -> None:
        self.append(thread_id, Entry(type="turn", parent_id=self.last_entry_id(thread_id),
                                     payload={"turnId": turn_id, "status": status}))

    def last_turn(self, thread_id: str) -> dict | None:
        turns = [entry["payload"] for entry in self.read_entries(thread_id) if entry.get("type") == "turn"]
        return turns[-1] if turns else None

    def recover(self) -> None:
        """只收尾上次进程留下的状态，绝不重放工具或复用审批。"""
        for thread in self.list_threads():
            thread_id = thread["id"]
            for item in self.read_items(thread_id):
                approval = item.get("approval")
                if item.get("status") != "running" and not (approval and not approval.get("decision")):
                    continue
                payload = {key: value for key, value in item.items() if key not in ("id", "threadId")}
                payload.update(status="failed", revises=item["id"])
                if approval and not approval.get("decision"):
                    payload["approval"] = {**approval, "decision": "expired"}
                if item.get("kind") == "toolCall":
                    payload.update(errorCode="SESSION_INTERRUPTED", resultSummary="上次进程在操作收尾前退出，结果不确定；先核对平台状态，不要直接重试。")
                self.append(thread_id, Entry(type="item", parent_id=self.last_entry_id(thread_id), payload=payload))
            turn = self.last_turn(thread_id)
            if turn and turn.get("status") == "running":
                self.record_turn(thread_id, turn["turnId"], "interrupted")

    def list_threads(self) -> list[dict]:
        items: list[dict] = []
        for path in sorted(self.root.glob("*.jsonl")):
            try:
                header = self.require_thread(path.stem)
            except (OSError, ValueError):
                continue
            if header.get("type") != "session":
                continue
            items.append(
                {
                    "id": header.get("id", path.stem),
                    "title": header.get("title", "未命名会话"),
                    "createdAt": header.get("createdAt", ""),
                    "updatedAt": datetime.fromtimestamp(
                        path.stat().st_mtime, tz=timezone.utc
                    ).isoformat(),
                    "lastTurn": self.last_turn(path.stem),
                }
            )
        items.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
        return items
