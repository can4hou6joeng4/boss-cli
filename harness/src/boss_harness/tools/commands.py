"""Recruitment command conveniences, outside the generic execution kernel."""
from __future__ import annotations

from typing import Any

_READ_ONLY_COMMANDS: dict[str, tuple[str, str]] = {
    "/tools": ("boss_list_tools", "上游能力目录"),
    "/status": ("boss_status", "账号与连接健康度"),
    "/stats": ("boss_stats", "招聘与转化漏斗"),
    "/recommend": ("boss_recommend", "职位推荐"),
    "/jobs": ("boss_hr_jobs", "已发布职位"),
    "/chat": ("boss_chat", "沟通消息"),
    "/candidates": ("boss_hr_candidates", "候选人搜索"),
}


def _parse_command(stripped: str) -> tuple[str, str]:
    parts = stripped.split(maxsplit=1)
    if not parts:
        return "", ""
    return parts[0], parts[1].strip() if len(parts) > 1 else ""


def offline_reply(runner: Any, thread_id: str, text: str) -> str:
    command, argument = _parse_command(text.strip())
    if command == "/search":
        keyword = argument or "Python"
        result = runner.execute_tool(thread_id, "boss_search", {"keyword": keyword})
        return f"检索「{keyword}」：\n{result.content}"
    entry = _READ_ONLY_COMMANDS.get(command)
    if entry is not None:
        tool_name, title = entry
        arguments: dict[str, Any] = {"query": argument} if command == "/candidates" and argument else {}
        result = runner.execute_tool(thread_id, tool_name, arguments)
        return f"{title}：\n{result.content}"
    if not runner.tool_bridge.available():
        return "内核已连通，但未找到可用的 boss 可执行文件，领域工具暂不可用。"
    return "当前未配置模型。可以使用 /tools、/status、/stats 等只读指令，或配置模型后继续任务。"
