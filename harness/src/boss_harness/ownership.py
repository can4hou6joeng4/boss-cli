"""Exclusive runtime ownership precedes recovery or index maintenance."""
from __future__ import annotations

import errno
import fcntl
import os
from pathlib import Path


class StateDirectoryOwner:
    def __init__(self, root: Path) -> None:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._fd: int | None = None
        self._fd = os.open(root / ".owner.lock", os.O_RDWR | os.O_CREAT, 0o600)
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
