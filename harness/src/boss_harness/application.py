"""Application services compose transport, sessions, domain tools and runtimes.

Independent implementation of the observed host/app-server boundary. No target
bundle code is imported. Runtime ownership, authorization and durable projections
are explicit; the CLI is only a composition root.
"""
from __future__ import annotations

import base64
import binascii
from dataclasses import replace
import json
import math
import os
from pathlib import Path
import re
import threading
import time
import uuid
from typing import Any, Callable

from boss_harness import __version__
from boss_harness.agent import TurnRunner
from boss_harness.context import ContextService
from boss_harness.connections import ConnectionChecks
from boss_harness.models import ModelConfig, Provider
from boss_harness.models.capabilities import ModelCatalog
from boss_harness.models.types import ModelRequest, UserMessage
from boss_harness.ownership import StateDirectoryOwner
from boss_harness.resources import AttachmentStore, SkillCatalog, ToolRegistry
from boss_harness.rpc import JsonRpcServer, RpcError
from boss_harness.runtime import RuntimeManager, TurnQueue
from boss_harness.session import Entry, SessionStore
from boss_harness.tool_results import MAX_PAGE_BYTES, project_item, read_result_chunk, wire_size
from boss_harness.tools import BossCliTool, should_pause
from boss_harness.tools.commands import offline_reply
from boss_harness.tools.recruitment import SYSTEM_PROMPT

PROTOCOL_VERSION = "0.2.0"
DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300.0


def _approval_timeout() -> float:
    try:
        value = float(os.environ.get("BOSS_HARNESS_APPROVAL_TIMEOUT") or DEFAULT_APPROVAL_TIMEOUT_SECONDS)
    except ValueError:
        return DEFAULT_APPROVAL_TIMEOUT_SECONDS
    return value if math.isfinite(value) and value > 0 else DEFAULT_APPROVAL_TIMEOUT_SECONDS


def _text(params: dict | None, key: str, *, maximum: int = 100_000) -> str:
    value = (params or {}).get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{key} 必须是非空字符串（最多 {maximum} 字符）")
    return value


class EventHub:
    """Persist before publishing; a snapshot and its cursor share one ordering lock."""
    def __init__(self, server: JsonRpcServer, sessions: SessionStore) -> None:
        self.server, self.sessions = server, sessions
        self.lock = threading.RLock()
        self.live: dict[str, dict[str, dict]] = {}

    def emit(self, method: str, params: dict | None = None, *, publish: bool = True) -> dict:
        with self.lock:
            event = self.sessions.append_event(method, params or {})
            payload = event["params"]
            thread_id, item_id = payload.get("threadId"), payload.get("itemId")
            if thread_id and item_id:
                current = self.live.setdefault(thread_id, {})
                if method in {"agentMessage/delta", "agentThinking/delta"}:
                    item = current.setdefault(item_id, {"text": "", "thinking": ""})
                    key = "text" if method == "agentMessage/delta" else "thinking"
                    item[key] += payload.get("delta", "")
                elif method == "item/completed":
                    current.pop(item_id, None)
            if publish:
                try:
                    self.server.notify(method, payload)
                except (ConnectionError, BrokenPipeError):
                    pass  # Durable state survives a disappearing observer.
            return event

    def items(self, thread_id: str) -> list[dict]:
        with self.lock:
            return [{**item, **(self.live.get(thread_id, {}).get(item["id"], {}) if item.get("status") == "running" else {})}
                    for item in self.sessions.read_items(thread_id)]


class ApplicationService:
    def __init__(self, server: JsonRpcServer, state_dir: Path, config: ModelConfig,
                 provider: Provider | None, *, provider_factory: Callable[[ModelConfig], Provider | None] | None = None,
                 workspace: Path | None = None, model_catalog: ModelCatalog | None = None) -> None:
        self.server, self.config, self.provider = server, config, provider
        if type(config.max_tokens) is not int or config.max_tokens <= 0:
            raise ValueError("max_tokens 必须是正整数")
        self.model_catalog = model_catalog if model_catalog is not None else ModelCatalog.from_environment()
        self.provider_factory = provider_factory
        self.workspace = (workspace or Path.cwd()).resolve()
        self._owner = StateDirectoryOwner(state_dir)
        try:
            self.sessions = SessionStore(state_dir / "sessions")
            self.events = EventHub(server, self.sessions)
            self._restore_partial_streams()
            self.sessions.recover()
            self.queue = TurnQueue(self.sessions)
            self.queue.recover()
            self.runtimes = RuntimeManager()
            self.registry = ToolRegistry()
            self.context = ContextService(self.sessions)
            self.skills = SkillCatalog(self.workspace / ".boss-cli" / "skills")
            self.attachments = AttachmentStore(self.sessions, state_dir / "attachments", self.workspace)
            self.tools = BossCliTool()
            self.connections = ConnectionChecks(config, request_preparer=lambda request: self.context.prepare(
                request, self.model_catalog.resolve(config.provider, request.model))[0])
            self.handlers = self.registry.handlers
            self.approval_required = self.registry.approval_required
            self.approval_timeout = _approval_timeout()
            self.runner = self._new_runner(self.tools, provider, config)
            self._turn_lock = self.runtimes.lock  # Compatibility for embedded 0.1 users.
            self._state = "cold"
            self._protocol = "0.1.0"
            self._bidirectional = False
            self._server_approvals: dict[str, str] = {}
            self._snapshot_pages: dict[str, tuple[str, list[dict], float]] = {}
            self._register()
            server.before_dispatch = self._check_ready
        except Exception:
            self._owner.close()
            raise

    @property
    def _active_turn(self) -> dict | None:
        return next(iter(self.runtimes.active.values()), None)

    def _restore_partial_streams(self) -> None:
        for thread in self.sessions.list_threads(include_archived=True):
            pending = {i["id"]: i for i in self.sessions.read_items(thread["id"])
                       if i.get("kind") == "agentMessage" and i.get("status") == "running"}
            if not pending:
                continue
            accumulated = {key: {"text": "", "thinking": ""} for key in pending}
            cursor = "0"
            while True:
                page = self.sessions.events_after(cursor, thread["id"], limit=1000)
                for event in page["events"]:
                    params = event["params"]
                    item = accumulated.get(params.get("itemId"))
                    if item is not None and event["method"] in {"agentMessage/delta", "agentThinking/delta"}:
                        key = "text" if event["method"] == "agentMessage/delta" else "thinking"
                        item[key] += params.get("delta", "")
                cursor = page["nextCursor"]
                if not page["hasMore"]:
                    break
            for item_id, text in accumulated.items():
                if any(text.values()):
                    self.sessions.append(thread["id"], Entry(type="item", payload={
                        **pending[item_id], **text, "revises": item_id}))

    def _new_runner(self, bridge: BossCliTool, provider: Provider | None, config: ModelConfig) -> TurnRunner:
        return TurnRunner(sessions=self.sessions, tool_bridge=bridge, handlers=self.handlers,
            provider=provider, config=config, notify=lambda m, p=None: self.events.emit(m, p),
            approval_required=self.approval_required, approval_timeout=self.approval_timeout,
            tools=self.registry.specs(), system_prompt=SYSTEM_PROMPT,
            validate_arguments=self.registry.validate, pause_on_result=should_pause,
            history_provider=self.context.history,
            request_preparer=lambda request: self.context.prepare(request,
                self.model_catalog.resolve(config.provider, request.model)))

    def _register(self) -> None:
        methods = {
            "initialize": self.on_initialize, "initialized": self.on_initialized,
            "thread/start": self.on_thread_start, "thread/list": self.on_thread_list,
            "thread/read": self.on_thread_read, "thread/resume": self.on_thread_resume,
            "thread/fork": self.on_thread_fork, "thread/archive": self.on_thread_archive,
            "thread/unarchive": self.on_thread_unarchive, "thread/name/set": self.on_thread_name,
            "thread/turns/list": self.on_turn_list, "thread/items/list": self.on_items_list,
            "thread/item/result/read": self.on_tool_result_read,
            "turn/start": self.on_turn_start, "turn/interrupt": self.on_turn_interrupt,
            "turn/steer": self.on_turn_steer, "turn/read": self.on_turn_read,
            "approval/respond": self.on_approval_respond, "event/list": self.on_event_list,
            "queue/add": self.on_queue_add, "queue/list": self.on_queue_list,
            "queue/remove": self.on_queue_remove, "tool/list": self.on_tool_list,
            "model/list": self.on_model_list, "config/read": self.on_config_read,
            "connection/read": lambda p: self.connections.read(),
            "connection/check": lambda p: self.connections.start(_text(p, "target")),
            # Host-only login transport; never included in renderer/model allowlists.
            "platform/login/start": lambda p: self.connections.begin_login(),
            "platform/login/read": lambda p: self.connections.read_login(),
            "platform/login/complete": lambda p: self.connections.complete_login(p or {}),
            "platform/login/cancel": lambda p: self.connections.cancel_login(_text(p, "id")),
            "skills/list": lambda p: {"skills": self.skills.list()},
            "context/read": self.on_context_read,
            "context/compact": self.on_context_compact,
            "attachment/add": self.on_attachment_add, "attachment/read": self.on_attachment_read,
            "shutdown": self.on_shutdown,
        }
        for method, handler in methods.items():
            self.server.register(method, handler)

    def _check_ready(self, method: str) -> None:
        if method == "initialize" or method == "shutdown":
            return
        if method == "initialized" and self._state == "initializing":
            return
        if self._state != "ready":
            raise RpcError(-32002, "先完成 initialize → initialized 握手")

    def on_initialize(self, params: dict | None) -> dict:
        if self._state != "cold":
            raise RpcError(-32600, "连接已经初始化")
        params = params or {}
        info = params.get("clientInfo")
        if not isinstance(info, dict):
            raise ValueError("clientInfo 必须包含 name 和 version")
        _text(info, "name", maximum=200)
        _text(info, "version", maximum=100)
        protocol = params.get("protocolVersion", "0.1.0")
        if protocol not in {"0.1.0", PROTOCOL_VERSION}:
            raise RpcError(-32000, "协议版本不兼容", {"supported": ["0.1.0", PROTOCOL_VERSION]})
        capabilities = params.get("capabilities") or {}
        if not isinstance(capabilities, dict):
            raise ValueError("capabilities 必须是对象或 null")
        bidirectional = capabilities.get("bidirectionalRequests", False)
        opt_out = capabilities.get("optOutNotificationMethods", [])
        if type(bidirectional) is not bool or not isinstance(opt_out, list) or len(opt_out) > 128 or any(
                not isinstance(name, str) or len(name) > 200 for name in opt_out):
            raise ValueError("客户端能力声明无效")
        self._bidirectional = bidirectional and protocol == PROTOCOL_VERSION
        self._protocol = protocol
        self.server.opt_out_notifications = frozenset(opt_out)
        self._state = "initializing" if protocol == PROTOCOL_VERSION else "ready"
        return {"serverName": "boss-harness", "serverVersion": __version__, "protocolVersion": protocol,
            "capabilities": {"bidirectionalRequests": True, "eventReplay": True,
                             "pagination": True, "parallelThreads": True},
            "toolBridge": {"available": self.tools.available(), "binary": self.tools.binary,
                "binarySource": self.tools.source, "tools": self.runner.tool_names},
            "modelBridge": {"provider": self.config.provider, "model": self.config.model,
                "driven": self.provider is not None, "thinking": dict(self.config.thinking) if self.config.thinking else None,
                "serverSideFallback": self.config.server_side_fallback},
            "approval": {"requiredTools": sorted(self.approval_required), "timeoutSeconds": self.approval_timeout},
            "eventCursor": self.sessions.latest_event_cursor()}

    def on_initialized(self, params: dict | None) -> dict:
        if self._state != "initializing":
            raise RpcError(-32600, "连接不在初始化阶段")
        self._state = "ready"
        return {"ready": True}

    def on_tool_list(self, params: dict | None) -> dict:
        return {"tools": self.registry.describe()}

    def on_config_read(self, params: dict | None) -> dict:
        return {"protocolVersion": PROTOCOL_VERSION, "workspace": str(self.workspace),
                "provider": self.config.provider, "model": self.config.model,
                "maxOutputTokens": self.config.max_tokens, "parallelThreads": self.runtimes.capacity,
                "modelCapabilities": self.model_catalog.resolve(self.config.provider, self.config.model).describe(),
                "approvalPolicy": "each-consequential-call", "approvalTimeoutSeconds": self.approval_timeout}

    def on_model_list(self, params: dict | None) -> dict:
        return {"models": [{"id": self.config.model, "provider": self.config.provider,
                            "configured": True, "available": self.provider is not None,
                            "capabilities": self.model_catalog.resolve(self.config.provider, self.config.model).describe()}],
                "source": "local-config"}

    def on_thread_start(self, params: dict | None) -> dict:
        params = params or {}
        title = params.get("title", "新会话")
        if not isinstance(title, str) or len(title) > 500:
            raise ValueError("title 必须是最多 500 字符的字符串")
        policy = params.get("toolPolicy", "approval")
        if not isinstance(policy, str) or policy not in {"readOnly", "approval"}:
            raise ValueError("toolPolicy 必须是 readOnly 或 approval")
        thread = self.sessions.create(title, projectId=params.get("projectId"),
                                      model=params.get("model") or self.config.model, cwd=str(self.workspace), toolPolicy=policy)
        self.events.emit("thread/created", {"threadId": thread["id"], "thread": thread})
        return {"thread": thread}

    def on_thread_list(self, params: dict | None) -> dict:
        params = params or {}
        return self.sessions.list_threads_page(cursor=params.get("cursor"), limit=params.get("limit", 50),
                                               archived=params.get("archived", False), project_id=params.get("projectId"))

    def _snapshot(self, thread_id: str, *, exclude: bool = False, paged: bool = False) -> dict:
        with self.events.lock:
            thread = self.sessions.get_thread(thread_id)
            job = self.runtimes.active.get(thread_id)
            items = [] if exclude and not paged else [project_item(thread_id, item) for item in self.events.items(thread_id)]
            result = {"thread": thread, "items": [] if exclude or paged else items,
                    "turns": None if exclude else self.sessions.list_turns(thread_id)["turns"],
                    "activeTurnId": job["turnId"] if job else None,
                    "eventCursor": self.sessions.latest_event_cursor(), "queue": self.queue.list(thread_id)}
            if paged:
                self._snapshot_pages = {key: value for key, value in self._snapshot_pages.items()
                                        if value[2] > time.monotonic()}
                if len(self._snapshot_pages) >= 16:
                    self._snapshot_pages.pop(next(iter(self._snapshot_pages)))
                snapshot_id = uuid.uuid4().hex
                self._snapshot_pages[snapshot_id] = (thread_id, items, time.monotonic() + 120)
                result.update(snapshotId=snapshot_id, itemCount=len(items), items=[])
            self._check_response_budget(result)
            return result

    @staticmethod
    def _check_response_budget(result: dict) -> None:
        if wire_size(result) > MAX_PAGE_BYTES:
            raise RpcError(-32010, "会话响应过大，请用 thread/resume snapshot=true 后分页读取条目",
                           {"code": "RESPONSE_TOO_LARGE", "recoveryMethod": "thread/resume", "snapshot": True})

    def on_thread_read(self, params: dict | None) -> dict:
        return self._snapshot(_text(params, "threadId"), exclude=bool((params or {}).get("excludeTurns", False)),
                              paged=(params or {}).get("snapshot") is True)

    def on_thread_resume(self, params: dict | None) -> dict:
        return self.on_thread_read(params)

    def on_turn_read(self, params: dict | None) -> dict:
        thread_id = _text(params, "threadId")
        turn = self.sessions.get_turn(thread_id, _text(params, "turnId"))
        result = {"turn": {**turn, "items": [project_item(thread_id, item) for item in turn["items"]]}}
        self._check_response_budget(result)
        return result

    def on_turn_list(self, params: dict | None) -> dict:
        params = params or {}
        return self.sessions.list_turns(_text(params, "threadId"), cursor=params.get("cursor"), limit=params.get("limit", 50))

    def on_items_list(self, params: dict | None) -> dict:
        params = params or {}
        thread_id = _text(params, "threadId")
        limit = params.get("limit", 100)
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("limit 必须是 1 到 200 的整数")
        offset = 0
        snapshot_id = params.get("snapshotId")
        scope_id = thread_id + (":" + snapshot_id if isinstance(snapshot_id, str) else "")
        cursor = params.get("cursor")
        if cursor is not None:
            try:
                if not isinstance(cursor, str) or len(cursor) > 2048:
                    raise ValueError()
                scope, offset = json.loads(base64.b64decode(cursor.encode(), altchars=b"-_", validate=True))
                if scope != scope_id or type(offset) is not int or offset < 0:
                    raise ValueError()
            except (ValueError, TypeError, AttributeError, UnicodeDecodeError, binascii.Error):
                raise ValueError("条目分页游标无效") from None
        if snapshot_id is not None:
            snapshot = self._snapshot_pages.get(snapshot_id) if isinstance(snapshot_id, str) else None
            if snapshot is None or snapshot[0] != thread_id or snapshot[2] <= time.monotonic():
                raise ValueError("会话快照已过期；请重新 resume")
            items = snapshot[1]
        else:
            items = [project_item(thread_id, item) for item in self.events.items(thread_id)]
        if offset > len(items):
            raise ValueError("条目分页游标超出结果范围")
        page = []
        result = {"items": page, "nextCursor": None}
        for item in items[offset:offset + limit]:
            candidate = page + [item]
            next_offset = offset + len(candidate)
            next_cursor = (base64.urlsafe_b64encode(json.dumps([scope_id, next_offset]).encode()).decode()
                           if next_offset < len(items) else None)
            candidate_result = {"items": candidate, "nextCursor": next_cursor}
            if wire_size(candidate_result) > MAX_PAGE_BYTES:
                if not page:
                    raise RpcError(-32010, "单个条目超过读取预算，无法在此页传输；原始记录仍保留",
                                   {"code": "RESPONSE_TOO_LARGE", "itemId": item["id"]})
                break
            page, result = candidate, candidate_result
        return result

    def on_tool_result_read(self, params: dict | None) -> dict:
        params = params or {}
        if set(params) - {"threadId", "itemId", "sha256", "cursor", "limit"}:
            raise ValueError("工具结果读取包含未知参数；不接受文件路径或自由偏移")
        thread_id, item_id = _text(params, "threadId"), _text(params, "itemId", maximum=128)
        self.sessions.require_thread(thread_id)
        item = next((item for item in self.sessions.read_items(thread_id) if item["id"] == item_id), None)
        if item is None:
            raise ValueError("条目不属于该会话或不存在")
        return read_result_chunk(thread_id, item, sha256=_text(params, "sha256", maximum=64),
                                 cursor=params.get("cursor"), limit=params.get("limit", 16_384))

    def on_thread_fork(self, params: dict | None) -> dict:
        params = params or {}
        thread = self.sessions.fork_thread(_text(params, "threadId"), turn_id=params.get("turnId"), title=params.get("title"))
        self.queue.pause(thread["id"])
        self.events.emit("thread/created", {"threadId": thread["id"], "thread": thread})
        return {"thread": thread}

    def _idle(self, thread_id: str) -> None:
        if thread_id in self.runtimes.active:
            raise RpcError(-32004, "请先中断该会话的运行回合")

    def on_thread_archive(self, params: dict | None) -> dict:
        thread_id = _text(params, "threadId")
        with self.runtimes.lock:
            self._idle(thread_id)
            self.queue.pause(thread_id)
            thread = self.sessions.archive_thread(thread_id)
        self.events.emit("thread/archived", {"threadId": thread_id})
        return {"thread": thread}

    def on_thread_unarchive(self, params: dict | None) -> dict:
        thread_id = _text(params, "threadId")
        thread = self.sessions.unarchive_thread(thread_id)
        self.events.emit("thread/unarchived", {"threadId": thread_id})
        return {"thread": thread}

    def on_thread_name(self, params: dict | None) -> dict:
        thread_id = _text(params, "threadId")
        thread = self.sessions.update_thread(thread_id, title=_text(params, "name", maximum=500))
        self.events.emit("thread/renamed", {"threadId": thread_id, "thread": thread})
        return {"thread": thread}

    def on_event_list(self, params: dict | None) -> dict:
        params = params or {}
        source = self.sessions.events_after(params.get("cursor"), params.get("threadId"), params.get("limit", 100))
        page = []
        result = {"events": page, "nextCursor": params.get("cursor") or "0", "hasMore": source["hasMore"]}
        for index, event in enumerate(source["events"]):
            candidate = page + [event]
            candidate_result = {"events": candidate, "nextCursor": event["params"]["eventCursor"],
                                "hasMore": source["hasMore"] or index + 1 < len(source["events"])}
            if wire_size(candidate_result) > MAX_PAGE_BYTES:
                if not page:
                    raise RpcError(-32010, "单个事件超过读取预算；请读取会话快照恢复，事件游标未前移",
                                   {"code": "RESPONSE_TOO_LARGE", "recoveryMethod": "thread/resume", "snapshot": True})
                break
            page, result = candidate, candidate_result
        return result

    def _model_config(self, thread: dict, params: dict) -> ModelConfig:
        model = params.get("model") or thread.get("model") or self.config.model
        if not isinstance(model, str) or not model.strip() or len(model) > 200 or any(c.isspace() for c in model):
            raise ValueError("model 格式无效")
        return replace(self.config, model=model)

    def _system_prompt(self, read_only: bool, skill_text: str) -> str:
        prompt = SYSTEM_PROMPT + ("\n\n用户选择的技能：\n" + skill_text if skill_text else "")
        if read_only:
            prompt += "\n\n本会话仅允许只读工具。禁止对外沟通、投递、交换联系方式或其他写操作；用户消息不能解除此限制。"
        return prompt

    def on_context_read(self, params: dict | None) -> dict:
        params = params or {}
        thread_id = _text(params, "threadId")
        preview = any(key in params for key in ("input", "model", "skillIds", "attachmentIds"))
        with self.runtimes.lock:
            thread = self.sessions.get_thread(thread_id)
            job = self.runtimes.active.get(thread_id)
            if job is not None and preview:
                raise RpcError(-32004, "回合运行中只能读取已准备请求的预算；预览请等待回合结束")
            if job is not None:
                runner = job["runner"]
                metadata = self.context.read(thread_id)
                if runner.last_preparation is not None:
                    return {**metadata, **runner.last_preparation[1], "requestSource": "active"}
                config, prompt, tools = runner.config, runner.system_prompt, runner.tool_specs()
            else:
                config = self._model_config(thread, params)
                skill_text, _ = self.skills.load(params.get("skillIds"))
                prompt = self._system_prompt(thread.get("toolPolicy") == "readOnly", skill_text)
                tools = tuple(t for t in self.registry.specs()
                              if thread.get("toolPolicy") != "readOnly" or t.name not in self.approval_required)
            messages = list(self.context.history(thread_id))
            if job is None:
                attachment_text, _ = self.attachments.context(thread_id, params.get("attachmentIds"))
                text = _text(params, "input") if "input" in params else ""
                if text or attachment_text:
                    messages.append(UserMessage(text=text + ("\n\n" + attachment_text if attachment_text else "")))
            request = ModelRequest(model=config.model, system=prompt, messages=tuple(messages), tools=tools,
                                   max_tokens=config.max_tokens, effort=config.effort, thinking=config.thinking)
            result = self.context.read(thread_id, request=request,
                                       capabilities=self.model_catalog.resolve(config.provider, config.model))
            return {**result, "provider": config.provider, "requestSource": "active" if job else "preview" if preview else "default"}

    def on_context_compact(self, params: dict | None) -> dict:
        thread_id = _text(params, "threadId")
        with self.runtimes.lock:
            self._idle(thread_id)
            self.context.compact(thread_id, _text(params, "summary", maximum=32_000), _text(params, "throughTurnId"))
            result = self.on_context_read({"threadId": thread_id})
        self.events.emit("context/compacted", {"threadId": thread_id})
        return result

    def on_attachment_add(self, params: dict | None) -> dict:
        return {"attachment": self.attachments.add(_text(params, "threadId"), _text(params, "path", maximum=4096))}

    def on_attachment_read(self, params: dict | None) -> dict:
        return {"attachment": self.attachments.read(_text(params, "threadId"), _text(params, "attachmentId"))}

    def _runner_for(self, config: ModelConfig) -> TurnRunner:
        if self.provider_factory is not None:
            return self._new_runner(BossCliTool(), self.provider_factory(config), config)
        if not any(job["runner"] is self.runner for job in self.runtimes.active.values()):
            self.runner.provider, self.runner.config = self.provider, config
            return self.runner
        if self.provider is not None:
            raise RpcError(-32005, "嵌入方须提供独立 provider_factory 才能并发运行模型会话")
        return self._new_runner(BossCliTool(), None, config)

    def on_turn_start(self, params: dict | None, *, queue_item: dict | None = None) -> dict:
        params = params or {}
        thread_id, text = _text(params, "threadId"), _text(params, "input")
        client_id = params.get("clientUserMessageId")
        if client_id is not None and (not isinstance(client_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", client_id)):
            raise ValueError("clientUserMessageId 格式无效")
        with self.runtimes.lock:
            thread = self.sessions.get_thread(thread_id)
            if thread.get("archived"):
                raise ValueError("请先恢复归档会话")
            if client_id:
                previous = next((i for i in self.sessions.read_items(thread_id) if i.get("clientUserMessageId") == client_id), None)
                if previous:
                    if previous.get("originalInput", previous.get("text")) != text:
                        raise ValueError("clientUserMessageId 已用于不同输入")
                    return {"turnId": previous["turnId"], "deduplicated": True}
            config = self._model_config(thread, params)
            model = config.model
            skill_text, skills = self.skills.load(params.get("skillIds"))
            attachment_text, attachments = self.attachments.context(thread_id, params.get("attachmentIds"))
            runner = self._runner_for(config)
            runner.last_preparation = None
            read_only = thread.get("toolPolicy") == "readOnly"
            allowed = {t["name"] for t in self.registry.describe() if not read_only or t["readOnly"]}
            runner._tools = tuple(t for t in self.registry.specs() if t.name in allowed)
            def validate(name: str, arguments: dict) -> None:
                if read_only and name not in allowed:
                    raise ValueError("只读会话禁止此工具；请新建需要逐次审批的会话")
                self.registry.validate(name, arguments)
            runner.validate_arguments = validate
            job = self.runtimes.reserve(thread_id, text, runner)
            runner.turn_id = job["turnId"]
            runner._cancel = job["cancel"]
            runner.system_prompt = self._system_prompt(read_only, skill_text)
            runner.notify = lambda method, payload=None: self._notify_runner(job, method, payload)
            runner.stage_steering = lambda: self._stage_steering(job)
            job["clientUserMessageId"] = client_id
            try:
                self.sessions.record_turn(thread_id, job["turnId"], "running", model=model, provider=config.provider,
                                          skillIds=[s["id"] for s in skills], toolPolicy=thread.get("toolPolicy", "approval"))
                user = runner.append_user(thread_id, text + ("\n\n" + attachment_text if attachment_text else ""),
                                   originalInput=text, clientUserMessageId=client_id,
                                   queueId=queue_item["id"] if queue_item else None, attachments=attachments)
                if queue_item:
                    self.queue.transition(thread_id, queue_item["id"], "delivered")
                self.events.emit("turn/started", {"threadId": thread_id, "turnId": job["turnId"],
                                                 "clientUserMessageId": client_id})
                self.events.emit("item/completed", {"threadId": thread_id, "turnId": job["turnId"],
                    "itemId": user.id, "kind": "userMessage", "text": text,
                    "clientUserMessageId": client_id})
                worker = threading.Thread(target=self._run_turn, args=(job,), name=f"turn-{job['turnId'][:8]}", daemon=True)
                job["worker"] = worker
                worker.start()
            except Exception:
                self.sessions.record_turn(thread_id, job["turnId"], "error")
                self.runtimes.release(job)
                self.runtimes.finish(job)
                raise
        return {"turnId": job["turnId"], "clientUserMessageId": client_id}

    def _notify_runner(self, job: dict, method: str, params: dict | None = None) -> None:
        if method == "thread/updated":
            return
        payload = {**(params or {}), "threadId": job["threadId"], "turnId": job["turnId"]}
        if method == "toolCall/completed" and isinstance(payload.get("approval"), dict):
            request_id = self._server_approvals.pop(payload["approval"]["approvalId"], None)
            if request_id:
                self.server.cancel_request(request_id)
        if method != "approval/requested" or not self._bidirectional:
            self.events.emit(method, payload)
            return
        event = self.events.emit(method, payload, publish=False)
        request = self.server.request("item/tool/requestApproval", event["params"], timeout=self.approval_timeout)
        approval_id = payload["approvalId"]
        self._server_approvals[approval_id] = request.id
        def completed(future: Any) -> None:
            self._server_approvals.pop(approval_id, None)
            try:
                result = future.result()
                if not isinstance(result, dict) or type(result.get("approved")) is not bool:
                    raise ValueError("审批响应无效")
                job["runner"].resolve_approval(approval_id, result["approved"])
            except Exception:
                job["runner"].expire_approval(approval_id)
        request.future.add_done_callback(completed)

    def _run_turn(self, job: dict) -> None:
        try:
            self._execute_turn(job)
        finally:
            with self.runtimes.lock:
                self.runtimes.finish(job)
                if self.runtimes.closed and not self.runtimes.jobs:
                    self._owner.close()

    def _execute_turn(self, job: dict) -> None:
        thread_id, runner = job["threadId"], job["runner"]
        status = "error"
        try:
            status = runner.run(thread_id, job["cancel"]) if runner.provider is not None else self._run_deterministic(
                thread_id, job["input"], job["cancel"], runner=runner)
        except Exception as exc:
            status = "interrupted" if job["cancel"].is_set() else "error"
            if status == "error":
                message = runner.safe_error(exc)
                try:
                    runner.append_agent(thread_id, "回合执行失败：" + message)
                except (OSError, ValueError):
                    pass
                self._notify_runner(job, "session/error", {"message": message})
        finally:
            # Admission uses the same lock: no steering can be accepted after
            # the final queue sweep but before this turn releases ownership.
            with self.runtimes.lock:
                try:
                    self.sessions.record_turn(thread_id, job["turnId"], status)
                    if status != "completed":
                        self.queue.pause(thread_id)
                    else:
                        self.queue.pause(thread_id, kind="steering")
                except (OSError, ValueError):
                    status = "error"
                finally:
                    self.runtimes.release(job)
            self.events.emit("turn/completed", {"threadId": thread_id, "turnId": job["turnId"], "status": status})
            self.events.emit("thread/updated", {"threadId": thread_id, "turnId": job["turnId"], "status": status})
            if status == "completed":
                self._start_follow_up(thread_id)

    def _run_deterministic(self, thread_id: str, text: str, cancel: threading.Event | None = None,
                           *, runner: TurnRunner | None = None) -> str:
        runner = runner or self.runner
        if cancel is not None and cancel.is_set():
            return "interrupted"
        runner.tool_bridge.cancel_event = cancel
        runner._blocked = None
        try:
            reply = offline_reply(runner, thread_id, text)
            if cancel is not None and cancel.is_set():
                return "interrupted"
            runner.append_agent(thread_id, reply)
            return "blocked" if runner._blocked is not None else "completed"
        finally:
            runner.tool_bridge.cancel_event = None
            runner._cancel = None

    def on_turn_interrupt(self, params: dict | None) -> dict:
        return {"interrupted": self.runtimes.interrupt(_text(params, "threadId"), (params or {}).get("turnId"))}

    def on_approval_respond(self, params: dict | None) -> dict:
        approval_id = _text(params, "approvalId")
        approved = (params or {}).get("approved")
        if type(approved) is not bool:
            raise ValueError("approved 必须是布尔值")
        runners = [job["runner"] for job in tuple(self.runtimes.active.values())]
        if self.runner not in runners:
            runners.append(self.runner)
        if not any(runner.resolve_approval(approval_id, approved) for runner in runners):
            raise ValueError("审批不存在、已处理或已过期")
        request_id = self._server_approvals.pop(approval_id, None)
        if request_id:
            self.server.cancel_request(request_id)
        return {"approvalId": approval_id, "approved": approved}

    def _stage_steering(self, job: dict) -> tuple[list[UserMessage], Callable[[], None]]:
        items = []
        while True:
            item = self.queue.claim(job["threadId"], "steering", job["turnId"])
            if item is None:
                break
            items.append(item)
        def commit() -> None:
            for item in items:
                user = job["runner"].append_user(job["threadId"], item["input"], queueId=item["id"],
                    clientUserMessageId=item.get("clientUserMessageId"), source="steering")
                self.events.emit("item/completed", {"threadId": job["threadId"], "turnId": job["turnId"],
                    "itemId": user.id, "kind": "userMessage", "text": item["input"],
                    "clientUserMessageId": item.get("clientUserMessageId")})
                self.queue.transition(job["threadId"], item["id"], "delivered")
                self.events.emit("turn/steeringApplied", {"threadId": job["threadId"], "turnId": job["turnId"], "queueId": item["id"]})
        return [UserMessage(text=item["input"]) for item in items], commit

    def _drain_steering(self, job: dict) -> list[UserMessage]:
        messages, commit = self._stage_steering(job)
        commit()
        return messages

    def on_turn_steer(self, params: dict | None) -> dict:
        params = params or {}
        thread_id = _text(params, "threadId")
        with self.runtimes.lock:
            job = self.runtimes.active.get(thread_id)
            expected = _text(params, "expectedTurnId")
            if job is None or job["turnId"] != expected or job["cancel"].is_set():
                raise RpcError(-32004, "目标回合已经结束或发生变化")
            item = self.queue.add(thread_id, _text(params, "input"), kind="steering", turn_id=expected,
                                  client_id=params.get("clientUserMessageId"))
        self.events.emit("queue/updated", {"threadId": thread_id, "queueId": item["id"]})
        return {"accepted": True, "queueItem": item}

    def on_queue_add(self, params: dict | None) -> dict:
        params = params or {}
        thread_id = _text(params, "threadId")
        with self.runtimes.lock:
            self.sessions.require_thread(thread_id)
            item = self.queue.add(thread_id, _text(params, "input"), client_id=params.get("clientUserMessageId"))
        self.events.emit("queue/updated", {"threadId": thread_id, "queueId": item["id"]})
        self._start_follow_up(thread_id)
        return {"queueItem": item}

    def on_queue_list(self, params: dict | None) -> dict:
        return {"items": self.queue.list(_text(params, "threadId"))}

    def on_queue_remove(self, params: dict | None) -> dict:
        thread_id = _text(params, "threadId")
        with self.runtimes.lock:
            item = self.queue.transition(thread_id, _text(params, "queueId"), "cancelled")
        self.events.emit("queue/updated", {"threadId": thread_id, "queueId": item["id"]})
        return {"queueItem": item}

    def _start_follow_up(self, thread_id: str) -> None:
        with self.runtimes.lock:
            if self.runtimes.closed or thread_id in self.runtimes.active or self.sessions.get_thread(thread_id).get("archived"):
                return
            item = self.queue.claim(thread_id, "followUp")
            if item is None:
                return
            try:
                self.on_turn_start({"threadId": thread_id, "input": item["input"],
                                    "clientUserMessageId": item.get("clientUserMessageId") or "queue-" + item["id"]}, queue_item=item)
            except Exception:
                self.queue.transition(thread_id, item["id"], "paused")

    def on_shutdown(self, params: dict | None) -> dict:
        self.close()
        return {"stopped": True}

    def close(self) -> None:
        self._state = "stopped"
        self.connections.close()
        self.runtimes.stop()
        self.sessions.close()
        with self.runtimes.lock:
            if not self.runtimes.jobs:
                self._owner.close()

    def serve_forever(self) -> None:
        try:
            self.server.serve_forever()
        finally:
            self.close()
