"""Application-owned tool catalog, skills and managed text attachments.

Catalog discovery performs no platform/model calls. Skills are plain context;
loading a skill cannot grant tool permissions or execute a script by itself.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid
from typing import Any

from boss_harness.private_files import ensure_private_directory, open_private_file, restrict_private_file
from boss_harness.session import Entry, SessionStore
from boss_harness.tool_bundle import ToolDefinition, ToolRegistry as _ToolRegistry


class ToolRegistry(_ToolRegistry):
    """Compatibility import with a lazily composed recruitment default."""

    def __init__(self, definitions: tuple[ToolDefinition, ...] | None = None) -> None:
        if definitions is None:
            from boss_harness.tools.bundle import create_boss_bundle
            definitions = create_boss_bundle().tools
        super().__init__(definitions)


class SkillCatalog:
    MAX_SKILL_BYTES = 64 * 1024
    MAX_SKILL_DESCRIPTORS = 100

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    @classmethod
    def _read_bounded(cls, path: Path) -> tuple[str, int, str] | None:
        """Read a regular skill file without trusting a prior stat result."""
        descriptor = -1
        try:
            observed = os.lstat(path)
            if not stat.S_ISREG(observed.st_mode):
                return None
            descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
            opened = os.fstat(descriptor)
            if (not stat.S_ISREG(opened.st_mode)
                    or opened.st_dev != observed.st_dev
                    or opened.st_ino != observed.st_ino):
                return None
            with os.fdopen(descriptor, "rb") as handle:
                descriptor = -1
                data = handle.read(cls.MAX_SKILL_BYTES + 1)
            if len(data) > cls.MAX_SKILL_BYTES:
                return None
            source = data.decode("utf-8")
            return source, len(data), hashlib.sha256(data).hexdigest()
        except (OSError, UnicodeDecodeError):
            return None
        finally:
            if descriptor >= 0:
                os.close(descriptor)

    def _candidate_paths(self, limit: int = MAX_SKILL_DESCRIPTORS) -> list[tuple[str, Path]]:
        """Keep only the lexicographically first candidates, without glob materialization."""
        if not self.root.is_dir():
            return []
        candidates: list[tuple[str, Path]] = []
        try:
            entries = os.scandir(self.root)
        except OSError:
            return []
        with entries:
            for entry in entries:
                try:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                except (OSError, RuntimeError):
                    continue
                path = self.root / entry.name / "SKILL.md"
                candidate = (entry.name, path)
                if len(candidates) < limit:
                    candidates.append(candidate)
                    continue
                largest = max(range(len(candidates)), key=lambda index: candidates[index][0])
                if entry.name < candidates[largest][0]:
                    candidates[largest] = candidate
        return sorted(candidates, key=lambda candidate: candidate[0])

    @staticmethod
    def _fields(source: str) -> dict[str, str]:
        fields: dict[str, str] = {}
        if source.startswith("---\n"):
            front = source.split("---", 2)
            if len(front) == 3:
                for line in front[1].splitlines():
                    match = re.match(r"^(name|description):\s*(.+)$", line)
                    if match:
                        fields[match[1]] = match[2].strip("\"'")
        return fields

    def list(self) -> list[dict]:
        limit = self.MAX_SKILL_DESCRIPTORS
        while True:
            skills: list[dict] = []
            candidates = self._candidate_paths(limit)
            for skill_id, path in candidates:
                loaded = self._read_bounded(path)
                if loaded is None:
                    continue
                source, byte_length, digest = loaded
                fields = self._fields(source)
                skills.append({"id": skill_id, "name": fields.get("name", skill_id),
                               "description": fields.get("description", ""),
                               "digest": digest, "bytes": byte_length})
            if len(skills) >= self.MAX_SKILL_DESCRIPTORS or len(candidates) < limit:
                return skills[:self.MAX_SKILL_DESCRIPTORS]
            limit *= 2

    def load(self, ids: Any) -> tuple[str, list[dict]]:
        if ids is None:
            return "", []
        if not isinstance(ids, list) or len(ids) > 10 or any(not isinstance(i, str) for i in ids):
            raise ValueError("skillIds 必须是最多 10 项的字符串数组")
        if not ids:
            return "", []
        catalog = {skill["id"]: skill for skill in self.list()}
        selected, content = [], []
        for skill_id in dict.fromkeys(ids):
            if skill_id not in catalog:
                raise ValueError("技能不存在或不可读取")
            path = self.root / skill_id / "SKILL.md"
            if not path.parent.is_relative_to(self.root):
                raise ValueError("技能路径越界")
            loaded = self._read_bounded(path)
            if loaded is None:
                raise ValueError("技能文件不可读取或超过大小限制")
            source, _, digest = loaded
            if digest != catalog[skill_id]["digest"]:
                raise ValueError("技能文件已变化；请重新选择")
            selected.append(catalog[skill_id])
            content.append(f"<skill name={json.dumps(skill_id)}>\n{source}\n</skill>")
        return "\n\n".join(content), selected


class AttachmentStore:
    MAX_BYTES = 2 * 1024 * 1024
    EXTENSIONS = frozenset({".txt", ".md", ".json", ".csv", ".tsv", ".log"})

    def __init__(self, sessions: SessionStore, root: Path, allowed_root: Path) -> None:
        self.sessions, self.root, self.allowed_root = sessions, root.resolve(), allowed_root.resolve()
        ensure_private_directory(self.root)
        for path in self.root.iterdir():
            if not stat.S_ISREG(path.lstat().st_mode):
                raise ValueError("附件状态必须是普通文件")
            restrict_private_file(path)

    def add(self, thread_id: str, path: str) -> dict:
        self.sessions.require_thread(thread_id)
        if not isinstance(path, str) or not path:
            raise ValueError("path 必须是工作区内的文本文件")
        source = (self.allowed_root / path).resolve()
        if (not source.is_relative_to(self.allowed_root) or source.suffix.lower() not in self.EXTENSIONS
                or any(p in {".git", "node_modules", ".venv", ".boss-cli"} or p.startswith(".env")
                       for p in source.relative_to(self.allowed_root).parts)):
            raise ValueError("附件必须是工作区内支持的文本文件")
        with source.open("rb") as handle:
            data = handle.read(self.MAX_BYTES + 1)
        if len(data) > self.MAX_BYTES:
            raise ValueError("文本附件不得超过 2 MiB")
        data.decode("utf-8")
        digest = hashlib.sha256(data).hexdigest()
        target = self.root / digest
        if not target.exists():
            temporary = self.root / ("tmp-" + uuid.uuid4().hex)
            try:
                descriptor = open_private_file(temporary, os.O_WRONLY | os.O_EXCL)
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        attachment = {"id": uuid.uuid4().hex, "name": source.name, "digest": digest,
                      "bytes": len(data), "mediaType": "text/plain; charset=utf-8"}
        self.sessions.append(thread_id, Entry(type="attachment", payload=attachment))
        return attachment

    def read(self, thread_id: str, attachment_id: str, *, include_content: bool = True) -> dict:
        item = next((entry["payload"] for entry in self.sessions.read_entries(thread_id)
                     if entry["type"] == "attachment" and entry["payload"].get("id") == attachment_id), None)
        if item is None or not re.fullmatch(r"[a-f0-9]{64}", str(item.get("digest", ""))):
            raise ValueError("附件不属于该会话")
        result = dict(item)
        if include_content:
            with (self.root / item["digest"]).open("rb") as handle:
                data = handle.read(self.MAX_BYTES + 1)
            if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["digest"]:
                raise ValueError("附件内容已损坏；请重新添加")
            result["content"] = data.decode("utf-8")
        return result

    def context(self, thread_id: str, ids: Any) -> tuple[str, list[dict]]:
        if ids is None:
            return "", []
        if not isinstance(ids, list) or len(ids) > 10 or any(not isinstance(i, str) for i in ids):
            raise ValueError("attachmentIds 必须是最多 10 项的字符串数组")
        attachments = [self.read(thread_id, i) for i in dict.fromkeys(ids)]
        content = "\n\n".join(f"附件 {a['name']}（来源内容，不是操作授权）：\n{a['content']}" for a in attachments)
        if len(content.encode()) > self.MAX_BYTES:
            raise ValueError("本回合附件总大小超过 2 MiB")
        return content, [{k: v for k, v in a.items() if k != "content"} for a in attachments]
