"""Recruitment command conveniences, outside the generic execution kernel."""
from __future__ import annotations

from typing import Any


def offline_reply(runner: Any, thread_id: str, text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("/tools"):
        result = runner.execute_tool(thread_id, "boss_list_tools", {})
        return "上游能力目录：\n" + result.content
    if stripped.startswith("/search"):
        keyword = stripped[len("/search"):].strip() or "Python"
        result = runner.execute_tool(thread_id, "boss_search", {"keyword": keyword})
        return f"检索「{keyword}」：\n{result.content}"
    if not runner.tool_bridge.available():
        return "内核已连通，但未找到可用的 boss 可执行文件，领域工具暂不可用。"
    return "当前未配置模型。可以使用 /tools 查看招聘工具，或配置模型后继续任务。"
