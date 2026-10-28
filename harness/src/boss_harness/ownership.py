"""Exclusive runtime ownership precedes recovery or index maintenance."""
from __future__ import annotations

import errno
import fcntl
import os
from pathlib import Path

from boss_harness.private_files import ensure_private_directory, open_private_file


class StateDirectoryOwner:
    def __init__(self, root: Path) -> None:
        self.root = Path(root).resolve()
        ensure_private_directory(self.root)
        self._fd: int | None = None
        self._fd = open_private_file(self.root / ".owner.lock", os.O_RDWR)
        try:
            fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.close()
            raise OSError(errno.EWOULDBLOCK, "状态目录已由另一个内核使用；请先关闭该内核") from None
        except OSError:
            self.close()
            raise

    def close(self) -> None:
        fd, self._fd = getattr(self, "_fd", None), None
        if fd is not None:
            os.close(fd)

    def __del__(self) -> None:
        self.close()
