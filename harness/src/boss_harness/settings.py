"""Harness-local settings persisted next to sessions and snapshots.

The file is intentionally small and optional: a missing or malformed config must
never prevent the kernel from starting, so reads fall back to built-in defaults.
Writes are atomic and merge into the existing object to keep unrelated keys.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from boss_harness.compaction import verified_policy

CONFIG_FILE = "config.json"
AUTO_COMPACTION_FIELDS = ("enabled", "triggerPercent", "keepRecentTokens")
_MAX_CONFIG_BYTES = 256 * 1024


def _read_object(path: Path) -> dict | None:
    """Return the stored JSON object, or None when absent / unreadable / not an object."""
    try:
        if path.stat().st_size > _MAX_CONFIG_BYTES:
            return None
        raw = path.read_text(encoding="utf-8")
        value = json.loads(raw)
    except (OSError, UnicodeError, ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def load_auto_compaction(state_dir: Path) -> dict | None:
    """Valid persisted auto-compaction fields; invalid values are treated as absent."""
    stored = _read_object(state_dir / CONFIG_FILE)
    return verified_policy((stored or {}).get("autoCompaction"), AUTO_COMPACTION_FIELDS)


def save_auto_compaction(state_dir: Path, fields: dict) -> None:
    """Persist the three policy fields atomically, preserving unrelated keys.

    Refuses to overwrite a file that exists but cannot be read as an object:
    clobbering unknown settings would be worse than reporting the failure.
    """
    verified = verified_policy(fields, AUTO_COMPACTION_FIELDS)
    if verified is None or set(verified) != set(AUTO_COMPACTION_FIELDS):
        raise ValueError("自动压缩设置必须包含 enabled、triggerPercent、keepRecentTokens")
    path = state_dir / CONFIG_FILE
    if path.exists():
        current = _read_object(path)
        if current is None:
            raise ValueError("内核配置文件不可读或格式无效，未写入自动压缩设置")
    else:
        current = {}
    payload = json.dumps({**current, "autoCompaction": verified}, ensure_ascii=False, indent=2) + "\n"
    if len(payload.encode("utf-8")) > _MAX_CONFIG_BYTES:
        raise ValueError("内核配置文件超过大小上限，未写入自动压缩设置")
    state_dir.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".config-", suffix=".json", dir=state_dir)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
