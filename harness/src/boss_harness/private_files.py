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
_ACL_EXTENDED_ALLOW = 1
_ACL_FIRST_ENTRY = 0
_ACL_NEXT_ENTRY = -1
_ACL_ENTRY_FILE_INHERIT = 1 << 5
_ACL_ENTRY_DIRECTORY_INHERIT = 1 << 6
_ACL_ENTRY_ONLY_INHERIT = 1 << 8
# Listing, traversal, mutation, or ACL-control rights can expose or replace state paths.
_ACL_DIRECTORY_PERMISSIONS = (0x00000002, 0x00000004, 0x00000008, 0x00000010,
                              0x00000020, 0x00000040, 0x00000080, 0x00000100,
                              0x00000200, 0x00000400, 0x00000800, 0x00001000,
                              0x00002000)


@lru_cache(maxsize=1)
def _macos_acl_api() -> tuple[Any, ...]:
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
    acl_get_fd_np = library.acl_get_fd_np
    acl_get_fd_np.argtypes = [ctypes.c_int, ctypes.c_uint32]
    acl_get_fd_np.restype = ctypes.c_void_p
    acl_get_entry = library.acl_get_entry
    acl_get_entry.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
    acl_get_entry.restype = ctypes.c_int
    acl_get_tag_type = library.acl_get_tag_type
    acl_get_tag_type.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
    acl_get_tag_type.restype = ctypes.c_int
    acl_get_permset = library.acl_get_permset
    acl_get_permset.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    acl_get_permset.restype = ctypes.c_int
    acl_get_perm = library.acl_get_perm_np
    acl_get_perm.argtypes = [ctypes.c_void_p, ctypes.c_int]
    acl_get_perm.restype = ctypes.c_int
    acl_get_flagset = library.acl_get_flagset_np
    acl_get_flagset.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    acl_get_flagset.restype = ctypes.c_int
    acl_get_flag = library.acl_get_flag_np
    acl_get_flag.argtypes = [ctypes.c_void_p, ctypes.c_int]
    acl_get_flag.restype = ctypes.c_int
    return (library, acl_init, acl_set_fd_np, acl_free, acl_get_fd_np, acl_get_entry,
            acl_get_tag_type, acl_get_permset, acl_get_perm, acl_get_flagset, acl_get_flag)


def _current_uid() -> int:
    getuid = getattr(os, "getuid", None)
    if getuid is None:
        raise OSError(errno.ENOTSUP, "当前平台不支持安全限制状态文件")
    return getuid()


def ensure_private_file_support() -> int:
    uid = _current_uid()
    if (sys.platform not in {"darwin", "linux"} or not hasattr(os, "fchmod")
            or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY")):
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
        _, acl_init, acl_set_fd_np, acl_free, *_ = _macos_acl_api()
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


def _has_directory_allow_acl(descriptor: int, *, reject_file_inherit: bool = False) -> bool:
    if sys.platform != "darwin":
        return False
    (_, _, _, acl_free, acl_get_fd_np, acl_get_entry, acl_get_tag_type,
     acl_get_permset, acl_get_perm, acl_get_flagset, acl_get_flag) = _macos_acl_api()
    ctypes.set_errno(0)
    acl = acl_get_fd_np(descriptor, _ACL_TYPE_EXTENDED)
    if not acl:
        error = ctypes.get_errno()
        if error in {errno.ENOENT, getattr(errno, "ENODATA", -1), getattr(errno, "ENOATTR", -1)}:
            return False
        raise OSError(error or errno.EIO, "无法检查状态目录 ACL")
    try:
        entry = ctypes.c_void_p()
        entry_id = _ACL_FIRST_ENTRY
        while True:
            ctypes.set_errno(0)
            if acl_get_entry(acl, entry_id, ctypes.byref(entry)) != 0:
                error = ctypes.get_errno()
                if error == errno.EINVAL:
                    return False
                raise OSError(error or errno.EIO, "无法读取状态目录 ACL")
            tag = ctypes.c_int()
            if acl_get_tag_type(entry, ctypes.byref(tag)) != 0:
                raise OSError(ctypes.get_errno() or errno.EIO, "无法读取状态目录 ACL")
            if tag.value == _ACL_EXTENDED_ALLOW:
                flags = ctypes.c_void_p()
                if acl_get_flagset(entry, ctypes.byref(flags)) != 0:
                    raise OSError(ctypes.get_errno() or errno.EIO, "无法读取状态目录 ACL")
                only_inherit = acl_get_flag(flags, _ACL_ENTRY_ONLY_INHERIT)
                file_inherit = acl_get_flag(flags, _ACL_ENTRY_FILE_INHERIT)
                directory_inherit = acl_get_flag(flags, _ACL_ENTRY_DIRECTORY_INHERIT)
                if only_inherit < 0 or file_inherit < 0 or directory_inherit < 0:
                    raise OSError(ctypes.get_errno() or errno.EIO, "无法读取状态目录 ACL")
                if directory_inherit:
                    return True
                if reject_file_inherit and file_inherit:
                    return True
                if not only_inherit:
                    permissions = ctypes.c_void_p()
                    if acl_get_permset(entry, ctypes.byref(permissions)) != 0:
                        raise OSError(ctypes.get_errno() or errno.EIO, "无法读取状态目录 ACL")
                    for permission in _ACL_DIRECTORY_PERMISSIONS:
                        allowed = acl_get_perm(permissions, permission)
                        if allowed < 0:
                            raise OSError(ctypes.get_errno() or errno.EIO, "无法读取状态目录 ACL")
                        if allowed:
                            return True
            entry_id = _ACL_NEXT_ENTRY
    finally:
        acl_free(acl)


def ensure_private_directory(path: Path, mode: int = 0o700) -> None:
    uid = ensure_private_file_support()
    directory = Path(path).expanduser().resolve()
    if not directory.parts[1:]:
        raise ValueError("状态目录不能是文件系统根目录")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(directory.anchor, flags)
    try:
        for index, component in enumerate(directory.parts[1:]):
            parent = os.fstat(descriptor)
            if ((parent.st_mode & 0o022 and not parent.st_mode & stat.S_ISVTX)
                    or _has_directory_allow_acl(descriptor)):
                raise ValueError("状态目录的父目录允许其他用户修改")
            created = False
            try:
                child = os.open(component, flags, dir_fd=descriptor)
            except FileNotFoundError:
                try:
                    os.mkdir(component, mode, dir_fd=descriptor)
                    created = True
                except FileExistsError:
                    pass
                child = os.open(component, flags, dir_fd=descriptor)
            try:
                opened = os.fstat(child)
                current = os.stat(component, dir_fd=descriptor, follow_symlinks=False)
                if (not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) !=
                        (current.st_dev, current.st_ino)):
                    raise ValueError("状态目录必须是普通目录")
                if created:
                    if opened.st_uid != uid:
                        raise ValueError("状态目录必须由当前用户拥有")
                    _clear_extended_acl(child)
                    os.fchmod(child, mode)
                    if os.listdir(child):
                        raise ValueError("新建状态目录在初始化前已被修改")
                if index == len(directory.parts[1:]) - 1:
                    if opened.st_uid != uid:
                        raise ValueError("状态目录必须由当前用户拥有")
                    if opened.st_mode & 0o022:
                        raise ValueError("状态目录允许其他用户写入")
                externally_searchable = bool(opened.st_mode & 0o055)
                if _has_directory_allow_acl(child, reject_file_inherit=externally_searchable):
                    raise ValueError("状态目录 ACL 允许其他用户访问")
            except BaseException:
                os.close(child)
                raise
            os.close(descriptor)
            descriptor = child
    finally:
        os.close(descriptor)


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
