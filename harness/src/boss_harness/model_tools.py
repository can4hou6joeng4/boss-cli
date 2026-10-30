"""Read-only kernel tools that operate on durable Harness state."""
from __future__ import annotations

from typing import Any

from boss_harness.models.types import ToolSpec
from boss_harness.rpc import RpcError
from boss_harness.session import ItemLookupError, SessionStore
from boss_harness.tool_results import (
    MODEL_RESULT_READ_CHARS, read_result_text_chunk, result_text,
)
from boss_harness.tool_schema import canonical_schema, validated_arguments
from boss_harness.toolkit import ToolResult


MODEL_RESULT_READ_TOOL = "read_session_tool_result"
_RESULT_READ_SCHEMA = canonical_schema({
    "type": "object",
    "properties": {
        "itemId": {"type": "string", "minLength": 1, "maxLength": 128},
        "sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
        "cursor": {"type": "string", "maxLength": 2048},
        "limit": {"type": "integer", "minimum": 1, "maximum": MODEL_RESULT_READ_CHARS},
    },
    "required": ["itemId", "sha256"],
    "additionalProperties": False,
})
MODEL_RESULT_READ_SPEC = ToolSpec(
    name=MODEL_RESULT_READ_TOOL,
    description=("读取当前会话中大工具结果的精确 JSON 分段。仅使用结果中的 itemId 和 sha256；"
                 f"每次最多 {MODEL_RESULT_READ_CHARS} 个 Unicode 字符，使用 nextCursor 顺序续读。"
                 "预览不代表完整结果；此操作只读已保存记录，不调用招聘平台。"),
    input_schema={
        "type": "object",
        "properties": {
            "itemId": {"type": "string", "minLength": 1, "maxLength": 128},
            "sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
            "cursor": {"type": "string", "maxLength": 2048},
            "limit": {"type": "integer", "minimum": 1, "maximum": MODEL_RESULT_READ_CHARS},
        },
        "required": ["itemId", "sha256"],
        "additionalProperties": False,
    },
    max_model_result_bytes=64 * 1024,
)


def model_tool_specs(tools: tuple[ToolSpec, ...]) -> tuple[ToolSpec, ...]:
    if any(tool.name == MODEL_RESULT_READ_TOOL for tool in tools):
        raise ValueError("工具名称与 Harness 内核工具冲突")
    return (*tools, MODEL_RESULT_READ_SPEC)


def validate_model_result_read(arguments: dict[str, Any]) -> dict[str, Any]:
    return validated_arguments(_RESULT_READ_SCHEMA, arguments)


def read_model_tool_result(sessions: SessionStore, thread_id: str, arguments: dict[str, Any]) -> ToolResult:
    arguments = validate_model_result_read(arguments)
    item_id = arguments["itemId"]
    try:
        item = sessions.read_item(thread_id, item_id)
        if item is None:
            return ToolResult(ok=False, command=MODEL_RESULT_READ_TOOL,
                              error={"code": "INVALID_RESULT_REFERENCE", "message": "结果不存在或不属于当前会话"})
        if item.get("kind") != "toolCall" or not isinstance(item.get("result"), dict):
            raise ValueError("该条目没有可读取的完整工具结果")
        text = result_text(item["result"])
        chunk = read_result_text_chunk(thread_id, item_id, text, sha256=arguments["sha256"],
                                       cursor=arguments.get("cursor"),
                                       limit=arguments.get("limit", MODEL_RESULT_READ_CHARS))
    except ItemLookupError as exc:
        return ToolResult(ok=False, command=MODEL_RESULT_READ_TOOL,
                          error={"code": exc.code, "message": str(exc)})
    except RpcError as exc:
        code = exc.data.get("code") if isinstance(exc.data, dict) else None
        return ToolResult(ok=False, command=MODEL_RESULT_READ_TOOL,
                          error={"code": code if isinstance(code, str) else "RESULT_READ_FAILED",
                                 "message": str(exc)})
    except ValueError as exc:
        return ToolResult(ok=False, command=MODEL_RESULT_READ_TOOL,
                          error={"code": "INVALID_RESULT_REFERENCE", "message": str(exc)})
    return ToolResult(ok=True, command=MODEL_RESULT_READ_TOOL, data=chunk)
