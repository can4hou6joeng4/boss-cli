"""领域适配器与通用执行器共用的最小工具结果契约。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class ToolResult:
    ok: bool
    command: str
    data: Any = None
    error: dict | None = None
    hints: dict | None = None
    raw: str = ""
