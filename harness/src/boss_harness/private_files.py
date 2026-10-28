"""Create or tighten owner-only state files without following symlinks."""
from __future__ import annotations

import os
from pathlib import Path
import stat


def open_private_file(path: Path, flags: int) -> int:
    """Open an owned regular file without following links and restrict its mode."""
    descriptor = os.open(path, flags | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        opened = os.fstat(descriptor)
        current = path.lstat()
        getuid = getattr(os, "getuid", None)
        if (not stat.S_ISREG(opened.st_mode) or getuid is None or opened.st_uid != getuid()
                or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)):
            raise ValueError("状态文件必须是当前用户拥有的普通文件")
        os.fchmod(descriptor, 0o600)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def restrict_private_file(path: Path) -> None:
    """Restrict an owned regular file, rejecting links and foreign owners."""
    original = path.lstat()
    if not stat.S_ISREG(original.st_mode):
        raise ValueError("状态文件必须是普通文件")
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, os.O_RDONLY | nofollow)
    try:
        opened = os.fstat(descriptor)
        getuid = getattr(os, "getuid", None)
        if (not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) !=
                (original.st_dev, original.st_ino) or getuid is None or opened.st_uid != getuid()):
            raise ValueError("状态文件必须是当前用户拥有的普通文件")
        os.fchmod(descriptor, 0o600)
    finally:
        os.close(descriptor)
