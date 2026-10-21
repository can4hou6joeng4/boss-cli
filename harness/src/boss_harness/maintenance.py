"""Explicit, reversible index repair; rollouts and events are never rewritten."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import uuid

from boss_harness.ownership import StateDirectoryOwner
from boss_harness.session import SessionStore


def repair_index(root: Path) -> dict:
    root = root.resolve()
    owner = StateDirectoryOwner(root)
    backup = root / "repairs" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    names = ("state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm")
    moved: list[str] = []
    rebuilding = False
    try:
        backup.mkdir(parents=True, mode=0o700)
        manifest = []
        for name in names:
            source = root / name
            if source.exists():
                manifest.append({"name": name, "bytes": source.stat().st_size,
                                 "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
                os.replace(source, backup / name)
                moved.append(name)
        (backup / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        rebuilding = True
        store = SessionStore(root / "sessions")
        count = len(store.list_threads(include_archived=True))
        cursor = store.latest_event_cursor()
        store.close()
        return {"repaired": True, "backupPath": str(backup), "threads": count, "eventCursor": cursor}
    except Exception:
        # Keep the failed candidate as well as the original database set.
        if rebuilding:
            failed = backup / "failed-candidate"
            failed.mkdir(exist_ok=True)
            for name in names:
                source = root / name
                if source.exists():
                    os.replace(source, failed / name)
        for name in moved:
            os.replace(backup / name, root / name)
        raise
    finally:
        owner.close()
