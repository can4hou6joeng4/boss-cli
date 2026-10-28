"""Create or tighten owner-only state files without following symlinks."""
from __future__ import annotations

import ctypes
import errno
from functools import lru_cache
import os
from pathlib import Path
import stat
import sys
from typing import Any

_ACL_TYPE_EXTENDED = 0x00000100


@lru_cache(maxsize=1)
def _macos_acl_api() -> tuple[Any, Any, Any, Any]:
    library = ctypes.CDLL(None, use_errno=True)
    acl_init = library.acl_init
    acl_init.argtypes = [ctypes.c_int]
    acl_init.restype = ctypes.c_void_p
    acl_set_fd_np = library.acl_set_fd_np
    acl_set_fd_np.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    acl_set_fd_np.restype = ctypes.c_int
    acl_free = library.acl_free
    acl_free.argtypes = [ctypes.c_void_p]
    acl_free.restype = ctypes.c_int
    return library, acl_init, acl_set_fd_np, acl_free


def _current_uid() -> int:
    getuid = getattr(os, "getuid", None)
    if getuid is None:
        raise OSError(errno.ENOTSUP, "当前平台不支持安全限制状态文件")
    return getuid()


def ensure_private_file_support() -> int:
    uid = _current_uid()
    if not hasattr(os, "fchmod") or not hasattr(os, "O_NOFOLLOW"):
        raise OSError(errno.ENOTSUP, "当前平台不支持安全限制状态文件")
    if sys.platform == "darwin":
        try:
            _macos_acl_api()
        except (AttributeError, OSError) as error:
            raise OSError(errno.ENOTSUP, "无法确认 macOS 状态文件 ACL") from error
    return uid


def _clear_extended_acl(descriptor: int) -> None:
    if sys.platform != "darwin":
        return
    try:
        _, acl_init, acl_set_fd_np, acl_free = _macos_acl_api()
    except (AttributeError, OSError) as error:
        raise OSError(errno.ENOTSUP, "无法确认 macOS 状态文件 ACL") from error
    ctypes.set_errno(0)
    acl = acl_init(0)
    if not acl:
        raise OSError(ctypes.get_errno() or errno.EIO, "无法创建空状态文件 ACL")
    try:
        ctypes.set_errno(0)
        if acl_set_fd_np(descriptor, acl, _ACL_TYPE_EXTENDED) != 0:
            raise OSError(ctypes.get_errno() or errno.EIO, "无法移除状态文件 ACL")
    finally:
        acl_free(acl)


def open_private_file(path: Path, flags: int) -> int:
    """Open an owned regular file without following links and restrict its mode."""
    uid = ensure_private_file_support()
    descriptor = os.open(path, flags | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        opened = os.fstat(descriptor)
        current = path.lstat()
        if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != uid
                or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)):
            raise ValueError("状态文件必须是当前用户拥有的普通文件")
        _clear_extended_acl(descriptor)
        os.fchmod(descriptor, 0o600)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def restrict_private_file(path: Path) -> None:
    """Restrict an owned regular file, rejecting links and foreign owners."""
    uid = ensure_private_file_support()
    original = path.lstat()
    if not stat.S_ISREG(original.st_mode):
        raise ValueError("状态文件必须是普通文件")
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, os.O_RDONLY | nofollow)
    try:
        opened = os.fstat(descriptor)
        if (not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) !=
                (original.st_dev, original.st_ino) or opened.st_uid != uid):
            raise ValueError("状态文件必须是当前用户拥有的普通文件")
        _clear_extended_acl(descriptor)
        os.fchmod(descriptor, 0o600)
    finally:
        os.close(descriptor)
