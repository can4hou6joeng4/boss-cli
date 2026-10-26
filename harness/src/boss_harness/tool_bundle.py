"""显式、不可变的进程内工具组合；不扫描或加载扩展目录。

职责参考 Pi commit d5b3de22d0e24a3e9c38a9410d3329b099717283（MIT）的
coding-agent sdk/customTools、extensions/loader 和 agent-session 工具允许清单。
这里独立实现定义快照并拒绝重复名，不复制其扩展运行时或名称覆盖机制。
回调由嵌入方显式提供；此契约冻结路由和声明，不隔离回调的宿主权限。
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any

from boss_harness.models.types import ToolSpec
from boss_harness.tool_schema import canonical_schema, validated_arguments
from boss_harness.toolkit import ToolResult


ToolHandler = Callable[[Any, dict[str, Any]], ToolResult]
ArgumentValidator = Callable[[dict[str, Any]], None]
_DEFINITION_ERROR = "工具定义无效"
_BUNDLE_ERROR = "工具组合定义无效"
_ARGUMENT_ERROR = "工具参数不符合已注册的 schema"


@dataclass(frozen=True, init=False)
class ToolDefinition:
    name: str
    description: str
    handler: ToolHandler = field(repr=False)
    requires_approval: bool
    validate_arguments: ArgumentValidator | None = field(default=None, repr=False)
    _schema_json: str = field(default="", repr=False)

    def __init__(self, name: str, description: str, input_schema: Mapping[str, Any],
                 handler: ToolHandler, requires_approval: bool,
                 validate_arguments: ArgumentValidator | None = None) -> None:
        if (not isinstance(name, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name) is None
                or not isinstance(description, str) or not description.strip()
                or not callable(handler) or type(requires_approval) is not bool
                or (validate_arguments is not None and not callable(validate_arguments))):
            raise ValueError(_DEFINITION_ERROR)
        schema_json = canonical_schema(input_schema)
        for key, value in (("name", name), ("description", description), ("handler", handler),
                           ("requires_approval", requires_approval), ("validate_arguments", validate_arguments),
                           ("_schema_json", schema_json)):
            object.__setattr__(self, key, value)

    @property
    def input_schema(self) -> dict[str, Any]:
        return json.loads(self._schema_json)

    def spec(self) -> ToolSpec:
        return ToolSpec(name=self.name, description=self.description, input_schema=self.input_schema)

    def validate(self, arguments: dict[str, Any]) -> None:
        copied = validated_arguments(self._schema_json, arguments)
        if self.validate_arguments is not None:
            try:
                if self.validate_arguments(copied) is not None:
                    raise ValueError
            except Exception:
                raise ValueError(_ARGUMENT_ERROR) from None


def _definitions(tools: tuple[ToolDefinition, ...]) -> tuple[ToolDefinition, ...]:
    if type(tools) is not tuple or any(not isinstance(tool, ToolDefinition) for tool in tools):
        raise ValueError(_BUNDLE_ERROR)
    if len({tool.name for tool in tools}) != len(tools):
        raise ValueError("工具组合包含重复名称")
    return tools


@dataclass(frozen=True)
class ToolBundle:
    id: str
    tools: tuple[ToolDefinition, ...]
    system_prompt: str
    pause_on_result: Callable[[ToolResult], bool] = field(repr=False)
    describe_bridge: Callable[[Any], dict[str, Any]] = field(repr=False)
    offline_reply: Callable[[Any, str, str], str] | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if (not isinstance(self.id, str) or not self.id or len(self.id) > 128
                or any(char.isspace() for char in self.id) or not isinstance(self.system_prompt, str)
                or not callable(self.pause_on_result) or not callable(self.describe_bridge)
                or (self.offline_reply is not None and not callable(self.offline_reply))):
            raise ValueError(_BUNDLE_ERROR)
        _definitions(self.tools)


@dataclass(frozen=True, init=False)
class ToolRegistry:
    definitions: tuple[ToolDefinition, ...]
    handlers: Mapping[str, ToolHandler] = field(repr=False)
    approval_required: frozenset[str]
    _by_name: Mapping[str, ToolDefinition] = field(repr=False)

    def __init__(self, definitions: tuple[ToolDefinition, ...]) -> None:
        definitions = _definitions(definitions)
        object.__setattr__(self, "definitions", definitions)
        object.__setattr__(self, "_by_name", MappingProxyType({tool.name: tool for tool in definitions}))
        object.__setattr__(self, "handlers", MappingProxyType({tool.name: tool.handler for tool in definitions}))
        object.__setattr__(self, "approval_required", frozenset(tool.name for tool in definitions if tool.requires_approval))

    def allowed_names(self, read_only: bool = False) -> frozenset[str]:
        if type(read_only) is not bool:
            raise ValueError("只读工具投影标记无效")
        return frozenset(tool.name for tool in self.definitions if not read_only or not tool.requires_approval)

    def specs(self, read_only: bool = False) -> tuple[ToolSpec, ...]:
        allowed = self.allowed_names(read_only)
        return tuple(tool.spec() for tool in self.definitions if tool.name in allowed)

    def describe(self, read_only: bool = False) -> list[dict[str, Any]]:
        allowed = self.allowed_names(read_only)
        return [{"name": tool.name, "description": tool.description, "inputSchema": tool.input_schema,
                 "readOnly": not tool.requires_approval, "requiresApproval": tool.requires_approval}
                for tool in self.definitions if tool.name in allowed]

    def validate(self, name: str, arguments: dict[str, Any]) -> None:
        if not isinstance(name, str) or name not in self._by_name:
            raise ValueError("工具不在注册表中")
        self._by_name[name].validate(arguments)
