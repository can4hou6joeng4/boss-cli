"""Explicit recruitment composition over the existing boss-cli allowlist."""
from __future__ import annotations

from typing import Any

from boss_harness.tool_bundle import ToolBundle, ToolDefinition
from boss_harness.tools.boss_cli import (
    TOOLS, approval_required_tools, should_pause, tool_handlers, validate_arguments,
)
from boss_harness.tools.commands import offline_reply
from boss_harness.tools.recruitment import SYSTEM_PROMPT


def _describe_bridge(bridge: Any) -> dict[str, Any]:
    return {"available": bridge.available(), "binary": bridge.binary, "binarySource": bridge.source}


def create_boss_bundle() -> ToolBundle:
    """Snapshot the sole recruitment table without executing its tools."""
    handlers = tool_handlers()
    approval_required = approval_required_tools()
    definitions = tuple(
        ToolDefinition(
            name=spec["name"], description=spec["description"], input_schema=spec["input_schema"],
            handler=handlers[spec["name"]], requires_approval=spec["name"] in approval_required,
            validate_arguments=lambda arguments, name=spec["name"]: validate_arguments(name, arguments),
        )
        for spec in TOOLS
    )
    return ToolBundle(id="boss", tools=definitions, system_prompt=SYSTEM_PROMPT,
                      pause_on_result=should_pause, describe_bridge=_describe_bridge,
                      offline_reply=offline_reply)
