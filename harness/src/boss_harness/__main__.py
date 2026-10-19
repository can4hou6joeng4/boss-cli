"""内核入口：以 stdio JSON-RPC 服务端运行。

用法（桌面外壳会这样启动它）：
    python3 -m boss_harness --listen stdio://

设计约束：内核不 import 任何领域代码；领域能力一律经 tools/ 下的适配器，
以子进程方式调用 boss-agent-cli，并只读它 stdout 上的七键 JSON 信封。

回合有两种走法：
- **模型驱动**（默认，只要解析到可用凭据）：经 provider 流式生成，工具由模型决定；
- **确定性**（`BOSS_HARNESS_PROVIDER=none` 或无凭据）：按 `/search`、`/tools` 直接执行，
  用于离线开发与冒烟测试。
"""
from __future__ import annotations

import argparse
import math
import os
import sys
import threading
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

from boss_harness import __version__
from boss_harness.agent import N_TURN_STARTED, N_SESSION_ERROR, TurnRunner
from boss_harness.models import DEFAULT_MODEL, ModelConfig, Provider, ToolSpec, build_provider, resolve_config
from boss_harness.rpc import JsonRpcServer
from boss_harness.session import Entry, SessionStore
from boss_harness.tools import (
    TOOLS,
    BossCliTool,
    ToolResult,
    approval_required_tools,
    tool_handlers,
    validate_arguments,
    should_pause,
)
from boss_harness.tools.recruitment import SYSTEM_PROMPT

DEFAULT_STATE_DIR = Path(
    os.environ.get("BOSS_CLI_HARNESS_DIR", Path.home() / ".boss-cli" / "harness")
)

# 方法名与 packages/protocol 中的常量一一对应。
M_INITIALIZE = "initialize"
M_THREAD_START = "thread/start"
M_THREAD_LIST = "thread/list"
M_THREAD_READ = "thread/read"
M_TURN_START = "turn/start"
M_TURN_INTERRUPT = "turn/interrupt"
M_APPROVAL_RESPOND = "approval/respond"
M_TOOL_LIST = "tool/list"

DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300.0

N_AGENT_MESSAGE_DELTA = "agentMessage/delta"
N_ITEM_STARTED = "item/started"
N_ITEM_COMPLETED = "item/completed"
N_THREAD_UPDATED = "thread/updated"


def _approval_timeout() -> float:
    """审批等待上限（秒）；`BOSS_HARNESS_APPROVAL_TIMEOUT` 可覆盖，非法值回落到默认。"""
    raw = (os.environ.get("BOSS_HARNESS_APPROVAL_TIMEOUT") or "").strip()
    if not raw:
        return DEFAULT_APPROVAL_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_APPROVAL_TIMEOUT_SECONDS
    return value if math.isfinite(value) and value > 0 else DEFAULT_APPROVAL_TIMEOUT_SECONDS


class Harness:
    def __init__(
        self, server: JsonRpcServer, state_dir: Path, config: ModelConfig, provider: Provider | None
    ) -> None:
        self.server = server
        self.config = config
        self.sessions = SessionStore(state_dir / "sessions")
        self.sessions.recover()
        self.tools = BossCliTool()
        self.handlers = tool_handlers()
        #: 由 main() 构造后传入；这样「凭据缺失」这类只在构造时才暴露的配置错误能被 main 接住，
        #: 给出干净的退出码，而不是让内核带着栈退出。None 表示走确定性回合。
        self.provider = provider
        #: 写工具逐次批准，不能由前端权限菜单扩大授权。
        self.approval_required = approval_required_tools()
        self.approval_timeout = _approval_timeout()
        self.runner = TurnRunner(
            sessions=self.sessions,
            tool_bridge=self.tools,
            handlers=self.handlers,
            provider=self.provider,
            config=config,
            notify=self._notify_runner,
            approval_required=self.approval_required,
            approval_timeout=self.approval_timeout,
            tools=tuple(ToolSpec(name=item["name"], description=item["description"],
                                 input_schema=item["input_schema"]) for item in TOOLS),
            system_prompt=SYSTEM_PROMPT,
            validate_arguments=validate_arguments,
            pause_on_result=should_pause,
        )
        #: 同时只允许一个回合：回合跑在工作线程里，交错执行会让审批与事件顺序都变得难以解释。
        self._turn_lock = threading.Lock()
        self._active_turn: dict[str, Any] | None = None
        self._register()

    def _notify_runner(self, method: str, params: dict[str, Any] | None = None) -> None:
        # 回合线程清除占用并保存终态之后，由入口统一发唯一的结束通知。
        if method == N_THREAD_UPDATED:
            return
        payload = dict(params or {})
        job = self._active_turn
        if job is not None:
            payload["turnId"] = job["turnId"]
        self.server.notify(method, payload)

    def _register(self) -> None:
        self.server.register(M_INITIALIZE, self.on_initialize)
        self.server.register(M_THREAD_START, self.on_thread_start)
        self.server.register(M_THREAD_LIST, self.on_thread_list)
        self.server.register(M_THREAD_READ, self.on_thread_read)
        self.server.register(M_TURN_START, self.on_turn_start)
        self.server.register(M_TURN_INTERRUPT, self.on_turn_interrupt)
        self.server.register(M_APPROVAL_RESPOND, self.on_approval_respond)
        self.server.register(M_TOOL_LIST, self.on_tool_list)

    # ---------- 方法 ----------

    def on_initialize(self, params: dict[str, Any] | None) -> dict[str, Any]:
        capabilities = (params or {}).get("capabilities") or {}
        print(
            f"[harness] initialize from {(params or {}).get('clientInfo')} caps={capabilities}",
            file=sys.stderr,
        )
        return {
            "serverName": "boss-harness",
            "serverVersion": __version__,
            "protocolVersion": "0.1.0",
            "toolBridge": {
                "available": self.tools.available(),
                "binary": self.tools.binary,
                "binarySource": self.tools.source,
                "tools": [item["name"] for item in TOOLS],
            },
            "modelBridge": {
                "provider": self.config.provider,
                "model": self.config.model,
                "driven": self.provider is not None,
                "thinking": dict(self.config.thinking) if self.config.thinking else None,
                "serverSideFallback": self.config.server_side_fallback,
            },
            "approval": {
                #: 需要用户批准的工具；为空表示当前没有需要闸门的工具。
                "requiredTools": sorted(self.approval_required),
                "timeoutSeconds": self.approval_timeout,
            },
        }

    def on_tool_list(self, params: dict[str, Any] | None) -> dict[str, Any]:
        return {
            "tools": [
                {"name": item["name"], "description": item["description"],
                 "readOnly": not item.get("requires_approval", False),
                 "requiresApproval": bool(item.get("requires_approval")), "inputSchema": item["input_schema"]}
                for item in TOOLS
            ]
        }

    def on_thread_start(self, params: dict[str, Any] | None) -> dict[str, Any]:
        title = (params or {}).get("title") or "新会话"
        if not isinstance(title, str):
            raise ValueError("title 必须是字符串")
        return {"thread": self.sessions.create(title)}

    def on_thread_list(self, params: dict[str, Any] | None) -> dict[str, Any]:
        return {"threads": self.sessions.list_threads()}

    def on_thread_read(self, params: dict[str, Any] | None) -> dict[str, Any]:
        thread_id = (params or {}).get("threadId", "")
        if not isinstance(thread_id, str):
            raise ValueError("threadId 必须是字符串")
        self.sessions.require_thread(thread_id)
        threads = {t["id"]: t for t in self.sessions.list_threads()}
        return {"thread": threads[thread_id], "items": self.sessions.read_items(thread_id)}

    def on_turn_start(self, params: dict[str, Any] | None) -> dict[str, Any]:
        """一个回合：记录用户消息，然后**在工作线程里**跑。

        回合必须异步。RPC 分发是单线程顺序读 stdin 的：如果在这里把整个回合跑完，主循环就读不到
        `turn/interrupt`，中断永远送不进来。`turnId` 立刻返回，回合进展与收尾都走通知，收尾一定有
        `thread/updated`。
        """
        params = params or {}
        thread_id = params.get("threadId", "")
        text = params.get("input", "")
        if not isinstance(thread_id, str) or not isinstance(text, str) or not text.strip():
            raise ValueError("threadId 与非空 input 必须是字符串")
        self.sessions.require_thread(thread_id)
        turn_id = uuid.uuid4().hex[:8]

        with self._turn_lock:
            if self._active_turn is not None:
                running = self._active_turn.get("turnId")
                raise RuntimeError(f"已有回合在运行（{running}），先中断它或等它结束")
            job: dict[str, Any] = {
                "threadId": thread_id,
                "turnId": turn_id,
                "cancel": threading.Event(),
            }
            self._active_turn = job

        try:
            self.runner.append_user(thread_id, text)
            self.sessions.record_turn(thread_id, turn_id, "running")
            self.server.notify(N_TURN_STARTED, {"threadId": thread_id, "turnId": turn_id})
            worker = threading.Thread(
                target=self._run_turn, args=(thread_id, text, job), name=f"turn-{turn_id}", daemon=True
            )
            job["worker"] = worker
            worker.start()
        except Exception:
            with self._turn_lock:
                self._active_turn = None
            raise
        return {"turnId": turn_id}

    def _run_turn(self, thread_id: str, text: str, job: dict[str, Any]) -> None:
        """回合线程的入口：任何异常都转成 session/error，绝不让线程带着栈静默消失。"""
        status = "error"
        try:
            if self.provider is not None:
                status = self.runner.run(thread_id, job["cancel"])
            else:
                status = self._run_deterministic(thread_id, text, job["cancel"])
        except Exception as exc:  # noqa: BLE001 - 回合线程不能把异常丢在栈上
            status = "interrupted" if job["cancel"].is_set() else "error"
            if status == "error":
                message = f"回合执行异常：{self.runner.safe_error(exc)}"
                try:
                    self.runner.append_agent(thread_id, message)
                except (OSError, ValueError):
                    pass
                self._notify_runner(N_SESSION_ERROR, {"threadId": thread_id, "message": message})
        finally:
            try:
                self.sessions.record_turn(thread_id, job["turnId"], status)
            except (OSError, ValueError):
                status = "error"
                self._notify_runner(N_SESSION_ERROR, {"threadId": thread_id, "message": "会话写入失败，请检查磁盘；未确认的操作不要直接重试。"})
            finally:
                with self._turn_lock:
                    if self._active_turn is job:
                        self._active_turn = None
                self.server.notify(N_THREAD_UPDATED, {"threadId": thread_id, "turnId": job["turnId"], "status": status})

    def on_turn_interrupt(self, params: dict[str, Any] | None) -> dict[str, Any]:
        """中断当前回合；没有在跑的回合时如实回报 false，不假装成功。"""
        thread_id = (params or {}).get("threadId", "")
        if not isinstance(thread_id, str) or not thread_id:
            raise ValueError("threadId 必须是非空字符串")
        with self._turn_lock:
            job = self._active_turn
            if job is None or job["threadId"] != thread_id:
                return {"interrupted": False}
            job["cancel"].set()
            self.runner.interrupt()
        return {"interrupted": True}

    def on_approval_respond(self, params: dict[str, Any] | None) -> dict[str, Any]:
        """落一次审批裁决；未知或已过期的 approvalId 明确报错，不静默吞掉。"""
        params = params or {}
        approval_id = str(params.get("approvalId", ""))
        approved = params.get("approved")
        if type(approved) is not bool or not approval_id:
            raise ValueError("审批必须提供 approvalId 与布尔值 approved")
        if not self.runner.resolve_approval(approval_id, approved):
            raise RuntimeError(f"审批请求不存在或已过期：{approval_id}")
        return {"approvalId": approval_id, "approved": approved}

    # ---------- 确定性回合（离线/无凭据） ----------

    def _run_deterministic(
        self, thread_id: str, text: str, cancel: threading.Event | None = None
    ) -> str:
        """确定性回合：不调模型，按输入直接给答复。

        中断只在一个位置检查：开始之前。这条路径是瞬时的，做到一半再中断反而会让「条目里已是
        完整答复」和「回报已中断」互相矛盾。
        """
        if cancel is not None and cancel.is_set():
            return "interrupted"

        self.tools.cancel_event = cancel
        self._deterministic_blocked = False
        try:
            reply = self._compose_reply(thread_id, text)
        finally:
            self.tools.cancel_event = None
        if cancel is not None and cancel.is_set():
            return "interrupted"
        agent_entry = self.runner.append_agent(thread_id, reply, emit=False)
        self.server.notify(
            N_ITEM_STARTED, {"threadId": thread_id, "itemId": agent_entry.id, "kind": "agentMessage"}
        )
        for chunk in _chunks(reply):
            self.server.notify(
                N_AGENT_MESSAGE_DELTA,
                {"threadId": thread_id, "itemId": agent_entry.id, "delta": chunk},
            )
        self.server.notify(
            N_ITEM_COMPLETED,
            {"threadId": thread_id, "itemId": agent_entry.id, "kind": "agentMessage", "text": reply},
        )
        return "blocked" if self._deterministic_blocked else "completed"

    def _compose_reply(self, thread_id: str, text: str) -> str:
        stripped = text.strip()

        if stripped.startswith("/tools"):
            result = self._call_tool(thread_id, "boss_list_tools", {}, lambda: self.tools.discover_tools())
            if result.ok and isinstance(result.data, dict):
                tools = result.data.get("tools") or []
                names = [str(item.get("name")) for item in tools[:6] if isinstance(item, dict)]
                tail = "、" + "、".join(names) if names else ""
                return f"上游能力目录共 {len(tools)} 个工具{tail}。"
            code = (result.error or {}).get("code", "UNKNOWN")
            return f"读取能力目录失败，错误码 {code}。"

        if stripped.startswith("/search"):
            keyword = stripped[len("/search"):].strip() or "Python"
            result = self._call_tool(
                thread_id, "boss_search", {"keyword": keyword}, lambda: self.tools.search(keyword)
            )
            if result.ok:
                count = len(result.data) if isinstance(result.data, list) else "若干"
                return f"经 boss-agent-cli 进程边界检索「{keyword}」，返回 {count} 条结果。"
            code = (result.error or {}).get("code", "UNKNOWN")
            return f"检索「{keyword}」失败，错误码 {code}。"

        if not self.tools.available():
            return "内核已连通，但未找到可用的 boss 可执行文件，领域工具暂不可用。"
        return f"收到：{text}"

    def _call_tool(
        self,
        thread_id: str,
        name: str,
        arguments: dict[str, Any],
        run: callable,  # type: ignore[valid-type]
    ) -> ToolResult:
        entry = self.runner.start_tool_call(thread_id, name, arguments)
        result = run()
        self.runner.finish_tool_call(thread_id, entry, name, result)
        if should_pause(result):
            self._deterministic_blocked = True
        return result

    def serve_forever(self) -> None:
        try:
            self.server.serve_forever()
        finally:
            job = self._active_turn
            if job is not None:
                self.on_turn_interrupt({"threadId": job["threadId"]})
                worker = job.get("worker")
                if worker is not None:
                    worker.join(timeout=2)


def _chunks(text: str, size: int = 12) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)] or [""]


def _build_config(args: argparse.Namespace) -> ModelConfig:
    """命令行 > 环境变量；`--provider none` 可强制离线。

    provider 交给 `resolve_config` 一起决定，不能解析完再 `replace`：模型配置的字段会随
    provider 增加，而各线路的端点与凭据来源不同，事后替换会让 `--provider openai` 拿到
    Anthropic 的端点并丢掉 Codex 配置里的凭据。
    """
    explicit = None if args.provider == "auto" else args.provider
    config = resolve_config(provider=explicit)
    if args.model:
        config = replace(config, model=args.model)
    return config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="boss-harness", description="BOSS-CLI Agent Harness 内核")
    parser.add_argument("--listen", default="stdio://", help="传输端点，当前仅支持 stdio://")
    parser.add_argument("--state-dir", default=str(DEFAULT_STATE_DIR), help="内核状态目录")
    parser.add_argument(
        "--provider",
        default="auto",
        choices=["auto", "anthropic", "openai", "codex", "none"],
        help="模型供应商；openai 与其别名 codex 走 Codex 配置里的 Responses 线路，none 表示走确定性回合（离线）",
    )
    parser.add_argument("--model", default=None, help=f"模型 id，默认 {DEFAULT_MODEL}")
    parser.add_argument("--version", action="version", version=f"boss-harness {__version__}")
    args = parser.parse_args(argv)

    if args.listen != "stdio://":
        print(f"[harness] 暂不支持 --listen {args.listen}", file=sys.stderr)
        return 2

    try:
        config = _build_config(args)
        provider = build_provider(config)
    except Exception as exc:  # noqa: BLE001
        # 这里只包住「配置解析 + 构造 provider」两件事，所以宽捕获是安全的：任何失败都意味着
        # 模型线路起不来（缺凭据、缺端点、SDK 拒绝无凭据构造等），应当给出可读信息并以 2 退出。
        print(f"[harness] 模型配置不可用（{type(exc).__name__}）：{exc}", file=sys.stderr)
        return 2
    server = JsonRpcServer()
    try:
        # 构造 Harness 会创建会话目录；state-dir 不可写同样是启动期的配置问题，应当走同一个干净
        # 退出码，而不是把回溯打到 stdout（stdout 只走协议）并以 1 结束。
        harness = Harness(server, Path(args.state_dir), config, provider)
    except OSError as exc:
        print(f"[harness] 启动失败（{type(exc).__name__}）：{exc}", file=sys.stderr)
        return 2
    bridge = harness.tools
    print(
        f"[harness] listening on stdio, state={args.state_dir}, "
        f"boss binary={bridge.binary} (source={bridge.source}, available={bridge.available()}), "
        f"model provider={config.provider} model={config.model} driven={harness.provider is not None}",
        file=sys.stderr,
    )
    harness.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
