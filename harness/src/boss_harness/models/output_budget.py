"""Wire-byte limits for retained model text, thinking and tool arguments."""
from __future__ import annotations

import json
import math
from collections.abc import Hashable, Iterable, Iterator

MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024
MAX_RESPONSE_TOOL_ARGUMENT_BYTES = 1024 * 1024
MAX_RESPONSE_TEXT_BYTES = 1024 * 1024


class OutputBudgetExceeded(ValueError):
    def __init__(self, scope: str) -> None:
        super().__init__(scope)
        self.scope = scope


def utf8_size_at_most(value: str, remaining: int, *, scope: str = "工具参数超过本地字节上限") -> int:
    """Return UTF-8 size if it fits, rejecting before encoding an oversized value."""
    if len(value) > remaining:
        raise OutputBudgetExceeded(scope)
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError:
        raise ValueError("模型输出包含非法 Unicode") from None
    if size > remaining:
        raise OutputBudgetExceeded(scope)
    return size


class ToolArgumentBudget:
    def __init__(self) -> None:
        self._response_bytes = 0
        self._tool_bytes: dict[int, int] = {}

    def account(self, index: int, value: str) -> None:
        current = self._tool_bytes.get(index, 0)
        delta = utf8_size_at_most(value, MAX_TOOL_ARGUMENT_BYTES - current)
        if delta > MAX_RESPONSE_TOOL_ARGUMENT_BYTES - self._response_bytes:
            raise OutputBudgetExceeded("本轮工具参数超过总字节上限")
        self._tool_bytes[index] = current + delta
        self._response_bytes += delta

    def snapshot(self, index: int, value: dict[str, object]) -> str:
        """Bound decoded initial input before allocating its compact JSON encoding."""
        remaining = min(MAX_TOOL_ARGUMENT_BYTES - self._tool_bytes.get(index, 0),
                        MAX_RESPONSE_TOOL_ARGUMENT_BYTES - self._response_bytes)
        nodes = 0

        def account(amount: int) -> None:
            nonlocal remaining
            remaining -= amount
            if remaining < 0:
                raise OutputBudgetExceeded("工具参数超过本地字节上限")

        def string(text: str) -> None:
            account(2)
            if len(text) > remaining:
                raise OutputBudgetExceeded("工具参数超过本地字节上限")
            for character in text:
                code = ord(character)
                if character in ('"', "\\", "\b", "\t", "\n", "\f", "\r"):
                    account(2)
                elif code < 0x20:
                    account(6)
                elif 0xD800 <= code <= 0xDFFF:
                    raise ValueError("工具参数包含非法 Unicode")
                else:
                    account(1 if code <= 0x7F else 2 if code <= 0x7FF else 3 if code <= 0xFFFF else 4)

        def visit(item: object, depth: int = 0) -> None:
            nonlocal nodes
            nodes += 1
            if depth > 64 or nodes > 32768:
                raise ValueError("工具参数结构超过本地上限")
            if type(item) is str:
                string(item)
            elif item is None or type(item) is bool:
                account(4 if item is None or item else 5)
            elif type(item) is int:
                if item.bit_length() > max(remaining, 0) * 4:
                    raise OutputBudgetExceeded("工具参数超过本地字节上限")
                account(len(str(item)))
            elif type(item) is float and math.isfinite(item):
                account(len(json.dumps(item)))
            elif type(item) is dict:
                account(2)
                for offset, (key, child) in enumerate(item.items()):
                    if type(key) is not str:
                        raise ValueError("工具参数对象键不是文本")
                    account(1 + bool(offset))
                    string(key)
                    visit(child, depth + 1)
            elif type(item) is list:
                account(2)
                for offset, child in enumerate(item):
                    account(bool(offset))
                    visit(child, depth + 1)
            else:
                raise ValueError("工具参数不是 JSON 值")

        visit(value)
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        self.account(index, encoded)
        return encoded

    def reconcile(self, index: int, authoritative: str) -> None:
        """Bound each snapshot and retain its per-tool byte high-water mark."""
        current = self._tool_bytes.get(index, 0)
        size = utf8_size_at_most(authoritative, MAX_TOOL_ARGUMENT_BYTES)
        if size > MAX_RESPONSE_TOOL_ARGUMENT_BYTES - (self._response_bytes - current):
            raise OutputBudgetExceeded("本轮工具参数超过总字节上限")
        self._response_bytes += max(0, size - current)
        self._tool_bytes[index] = max(current, size)


class ResponseTextBudget:
    """Bound text and thinking together before provider or session accumulation."""
    def __init__(self) -> None:
        self._response_bytes = 0
        self._item_bytes: dict[Hashable, int] = {}

    @staticmethod
    def size(value: str, remaining: int = MAX_RESPONSE_TEXT_BYTES) -> int:
        return utf8_size_at_most(value, remaining,
            scope="模型文本与思考输出超过本地 UTF-8 字节上限")

    def account(self, index: Hashable, fragment: str) -> None:
        size = self.size(fragment, MAX_RESPONSE_TEXT_BYTES - self._response_bytes)
        self._response_bytes += size
        self._item_bytes[index] = self._item_bytes.get(index, 0) + size

    def reconcile(self, index: Hashable, authoritative: str) -> None:
        self.reconcile_size(index, self.size(authoritative))

    def reconcile_parts(self, index: Hashable, parts: list[str], *, separator: str = "") -> str:
        size = 0
        separator_bytes = self.size(separator)
        for offset, part in enumerate(parts):
            if offset:
                size += separator_bytes
            size += self.size(part, MAX_RESPONSE_TEXT_BYTES - size)
        self.reconcile_size(index, size)
        return separator.join(parts)

    def reconcile_size(self, index: Hashable, size: int) -> None:
        self.ensure_size(index, size)
        current = self._item_bytes.get(index, 0)
        self._response_bytes += max(0, size - current)
        self._item_bytes[index] = max(current, size)

    def ensure_size(self, index: Hashable, size: int) -> None:
        """Check an authoritative assembled size before retaining another part."""
        current = self._item_bytes.get(index, 0)
        delta = max(0, size - current)
        if delta > MAX_RESPONSE_TEXT_BYTES - self._response_bytes:
            raise OutputBudgetExceeded("模型文本与思考输出超过本地 UTF-8 字节上限")

    def reconcile_response(self, parts: Iterable[str]) -> None:
        """Check a complete response without assuming provider indexes survive compaction."""
        size = 0
        for part in parts:
            size += self.size(part, MAX_RESPONSE_TEXT_BYTES - size)
        self._response_bytes = max(self._response_bytes, size)


def bounded_error(prefix: str, detail: str, *, maximum: int = 512) -> str:
    """Keep provider diagnostics bounded without splitting a UTF-8 character."""
    if len(prefix) + len(detail) <= maximum:
        value = prefix + detail
        try:
            if len(value.encode("utf-8")) <= maximum:
                return value
        except UnicodeEncodeError:
            pass
    suffix = "…"
    out: list[str] = []
    size = 0
    for part in (prefix, detail):
        for char in part:
            if 0xD800 <= ord(char) <= 0xDFFF:
                char = "\ufffd"
            char_size = len(char.encode("utf-8"))
            if size + char_size > maximum - len(suffix.encode("utf-8")):
                return "".join(out) + suffix
            out.append(char)
            size += char_size
    return "".join(out)


def utf8_chunks(value: str, maximum: int = 32 * 1024) -> Iterator[str]:
    """Yield code-point-aligned pieces bounded by raw UTF-8 bytes."""
    if maximum < 4:
        raise ValueError("UTF-8 分块上限至少为 4 字节")
    parts: list[str] = []
    size = 0
    for char in value:
        width = len(char.encode("utf-8"))
        if parts and size + width > maximum:
            yield "".join(parts)
            parts, size = [], 0
        parts.append(char)
        size += width
    if parts:
        yield "".join(parts)
