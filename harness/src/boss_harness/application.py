"""Application services compose transport, sessions, domain tools and runtimes.

Independent implementation of the observed host/app-server boundary. No target
bundle code is imported. Runtime ownership, authorization and durable projections
are explicit; the CLI is only a composition root.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
from collections import deque
from dataclasses import asdict, replace
import json
import math
import os
from pathlib import Path
import re
import threading
import time
import uuid
import weakref
from typing import Any, Callable

from boss_harness import __version__
from boss_harness.agent import TurnRunner
from boss_harness.bridge_lifecycle import BridgeLifecycle
from boss_harness.context import ContextBudgetExceeded, ContextService, request_fingerprint
from boss_harness.connections import ConnectionChecks
from boss_harness.models import ModelConfig, Provider, resolve_config
from boss_harness.models.secret import redact_secrets
from boss_harness.models.capabilities import ModelCatalog
from boss_harness.models.types import AssistantMessage, ModelRequest, UserMessage
from boss_harness.ownership import StateDirectoryOwner
from boss_harness.resources import AttachmentStore, SkillCatalog, ToolRegistry
from boss_harness.request_identity import resolve_request
from boss_harness.rpc import JsonRpcServer, RpcError
from boss_harness.runtime import RuntimeManager, TurnQueue
from boss_harness.session import (CheckpointCommittedError, CheckpointCommitUncertain, Entry,
                                  SessionStore, ToolRevisionPersistenceError)
from boss_harness.tool_results import MAX_PAGE_BYTES, project_item, read_result_chunk, wire_size
from boss_harness.tool_bundle import ToolBundle
from boss_harness.summary import SUMMARY_MAX_REQUESTS, SummaryPlanner
from boss_harness.compaction import CompactionPolicy, ContextCompactionFailed
from boss_harness.context import NoCompactionSource
from boss_harness.shutdown import TrackedAbort, join_until
from boss_harness.hooks import HookFailure, LifecycleHooks
from boss_harness.item_content import read_item_content

PROTOCOL_VERSION = "0.2.0"
DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300.0
MAX_RETAINED_COMPACTION_JOBS = 64
MAX_COMPACTION_ERROR_CHARACTERS = 2_048


class _CompactionFailure(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class _CompactionCancelled(Exception):
    pass


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
    """Persist, publish, and enqueue observations in durable cursor order."""
    def __init__(self, server: JsonRpcServer, sessions: SessionStore, lifecycle_hooks: LifecycleHooks) -> None:
        self.server, self.sessions, self.lifecycle_hooks = server, sessions, lifecycle_hooks
        self.lock = threading.RLock()
        self.live: dict[str, dict[str, dict]] = {}

    def emit(self, method: str, params: dict | None = None, *, publish: bool = True,
             observe: bool = True) -> dict:
        with self.lock:
            notification = params or {}
            stored_params = notification
            if method == "item/completed" and notification.get("kind") == "agentMessage":
                stored_params = project_item(str(notification.get("threadId") or ""), {
                    "id": str(notification.get("itemId") or ""), **notification,
                })
                stored_params.pop("id", None)
            event = self.sessions.append_event(method, stored_params)
            payload = event["params"]
            live_payload = {**notification, "eventId": payload["eventId"],
                            "eventCursor": payload["eventCursor"]}
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
                    self.server.notify(method, live_payload)
                except (ConnectionError, BrokenPipeError):
                    pass  # Durable state survives a disappearing observer.
            if observe:
                # The bounded enqueue preserves cursor order; callbacks run on the hook worker.
                self.lifecycle_hooks.observe_event(method, payload)
        return event

    def items(self, thread_id: str) -> list[dict]:
        with self.lock:
            return [{**item, **(self.live.get(thread_id, {}).get(item["id"], {}) if item.get("status") == "running" else {})}
                    for item in self.sessions.read_items(thread_id)]


class ApplicationService:
    def __init__(self, server: JsonRpcServer, state_dir: Path, config: ModelConfig,
                 provider: Provider | None, *, provider_factory: Callable[[ModelConfig], Provider | None] | None = None,
                 workspace: Path | None = None, model_catalog: ModelCatalog | None = None,
                 tool_bundle: ToolBundle | None = None, bridge_factory: Callable[[], Any] | None = None,
                 compaction_policy: CompactionPolicy | None = None,
                 lifecycle_hooks: LifecycleHooks | tuple[Any, ...] | list[Any] | None = None,
                 hook_timeout: float = 0.25) -> None:
        self.server, self.config, self.provider = server, config, provider
        if type(config.max_tokens) is not int or config.max_tokens <= 0:
            raise ValueError("max_tokens 必须是正整数")
        self.model_catalog = model_catalog if model_catalog is not None else ModelCatalog.from_environment()
        self.compaction_policy = compaction_policy if compaction_policy is not None else CompactionPolicy.from_environment()
        if not isinstance(self.compaction_policy, CompactionPolicy):
            raise ValueError("compaction_policy 必须是 CompactionPolicy")
        self._business_services = tool_bundle is None
        if tool_bundle is None:
            from boss_harness.tools.bundle import create_boss_bundle
            tool_bundle = create_boss_bundle()
            if bridge_factory is None:
                from boss_harness.tools import BossCliTool
                bridge_factory = BossCliTool
        if not isinstance(tool_bundle, ToolBundle) or not callable(bridge_factory):
            raise ValueError("工具组合须提供有效 ToolBundle 和独立 bridge_factory")
        self.tool_bundle, self.bridge_factory = tool_bundle, bridge_factory
        self.registry = ToolRegistry(tool_bundle.tools)
        self.provider_factory = provider_factory
        self._model_configs = self._discover_model_configs()
        self.workspace = (workspace or Path.cwd()).resolve()
        if isinstance(lifecycle_hooks, LifecycleHooks):
            if hook_timeout != 0.25:
                raise ValueError("已构造 LifecycleHooks 时应在构造时设置 hook timeout")
            self.lifecycle_hooks = lifecycle_hooks
        else:
            self.lifecycle_hooks = LifecycleHooks(lifecycle_hooks, timeout=hook_timeout)
        self.bridge_lifecycle = BridgeLifecycle()
        self._base_bridge_close_claimed = False
        self._base_bridge_close_owner: int | None = None
        self._base_bridge_close_done = threading.Event()
        self._owner = StateDirectoryOwner(state_dir)
        try:
            self.sessions = SessionStore(state_dir / "sessions")
            self.events = EventHub(server, self.sessions, self.lifecycle_hooks)
            self.lifecycle_hooks.set_error_sink(self._record_hook_failure)
            self._restore_partial_streams()
            self.sessions.recover()
            self.queue = TurnQueue(self.sessions)
            self.queue.recover()
            self.runtimes = RuntimeManager()
            self._shutdown_preparing = 0
            # Queue dispatch can outlive provider ownership. Its worker still
            # owns the state directory until all follow-up bookkeeping ends.
            self._follow_up_workers: dict[str, threading.Thread] = {}
            self._follow_up_dispatches: dict[str, dict[str, Any]] = {}
            self._receipt_notices: dict[str, dict[str, Any]] = {}
            # Compaction jobs are independent of business turns and never own a
            # tool bridge. The per-thread index prevents a new turn from
            # changing the source while a summary is being generated.
            self._compaction_jobs: dict[str, dict[str, Any]] = {}
            self._compaction_by_thread: dict[str, str] = {}
            self._compaction_terminal_order: deque[str] = deque()
            self._compaction_terminal_ids: set[str] = set()
            self._bridge_refs: list[Any] = []
            self.context = ContextService(self.sessions)
            self.skills = SkillCatalog(self.workspace / ".boss-cli" / "skills")
            self.attachments = AttachmentStore(self.sessions, state_dir / "attachments", self.workspace)
            self.tools = self._new_bridge()
            self.connections = ConnectionChecks(config, request_preparer=lambda request: self.context.prepare(
                request, self.model_catalog.resolve(config.provider, request.model), provider=config.provider)[0],
                bridge_factory=self._new_bridge if self._business_services else None,
                browser_source_policy=getattr(self.tools, "browser_source_policy", None),
                bridge_lifecycle=self.bridge_lifecycle)
            self.connections.on_idle = self._close_application_resources_if_idle
            self.runtimes.on_idle = self._close_application_resources_if_idle
            self.handlers = self.registry.handlers
            self.approval_required = self.registry.approval_required
            self.approval_timeout = _approval_timeout()
            self.runner = self._new_runner(self.tools, provider, config)
            self._turn_lock = self.runtimes.lock  # Compatibility for embedded 0.1 users.
            self._tool_persistence_fences: set[str] = set()
            self._state = "cold"
            self._protocol = "0.1.0"
            self._bidirectional = False
            self._server_approvals: dict[str, str] = {}
            self._snapshot_pages: dict[str, tuple[str, list[dict], float, dict[str, dict[str, Any]]]] = {}
            self._register()
            server.before_dispatch = self._check_ready
        except Exception:
            if hasattr(self, "connections"):
                self.connections.close()
            if hasattr(self, "tools"):
                self.bridge_lifecycle.close(self.tools)
            self.lifecycle_hooks.close()
            if hasattr(self, "sessions"):
                self.sessions.close()
            self._owner.close()
            raise

    def _record_hook_failure(self, failure: HookFailure) -> None:
        events = getattr(self, "events", None)
        if events is None:
            return
        events.emit("kernel/hookError", failure.as_dict(), observe=False)

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

    def _new_bridge(self) -> Any:
        with self.runtimes.lock:
            try:
                bridge = self.bridge_factory()
            except Exception:
                raise ValueError("工具桥工厂无法创建实例") from None
            live_refs = []
            duplicate = False
            for reference in self._bridge_refs:
                existing = reference() if isinstance(reference, weakref.ReferenceType) else reference
                if existing is None:
                    continue
                live_refs.append(reference)
                duplicate = duplicate or existing is bridge
            self._bridge_refs = live_refs
            if duplicate:
                raise RpcError(-32005, "工具桥工厂必须为每个运行器创建独立实例")
            try:
                bridge_ref = weakref.ref(bridge)
            except TypeError:
                self.bridge_lifecycle.close(bridge)
                raise ValueError("工具桥实例必须支持独立身份跟踪") from None
            try:
                bridge.cancel_event = None
            except Exception:
                self.bridge_lifecycle.close(bridge)
                raise ValueError("工具桥须支持独立的 cancel_event") from None
            self._bridge_refs.append(bridge_ref)
            return bridge

    def _new_runner(self, bridge: Any, provider: Provider | None, config: ModelConfig) -> TurnRunner:
        return TurnRunner(sessions=self.sessions, tool_bridge=bridge, handlers=self.handlers,
            provider=provider, config=config, notify=lambda m, p=None: self.events.emit(m, p),
            approval_required=self.approval_required, approval_timeout=self.approval_timeout,
            tools=self.registry.specs(), system_prompt=self.tool_bundle.system_prompt,
            validate_arguments=self.registry.validate, pause_on_result=self.tool_bundle.pause_on_result,
            lifecycle_hooks=self.lifecycle_hooks,
            persistence_fence=self._fence_tool_persistence,
            history_provider=self.context.history,
            request_preparer=lambda request: self.context.prepare(request,
                self.model_catalog.resolve(config.provider, request.model), provider=config.provider))

    def _register(self) -> None:
        methods = {
            "initialize": self.on_initialize, "initialized": self.on_initialized,
            "thread/start": self.on_thread_start, "thread/list": self.on_thread_list,
            "thread/read": self.on_thread_read, "thread/resume": self.on_thread_resume,
            "thread/fork": self.on_thread_fork, "thread/archive": self.on_thread_archive,
            "thread/unarchive": self.on_thread_unarchive, "thread/name/set": self.on_thread_name,
            "thread/model/set": self.on_thread_model_set,
            "thread/reasoning/read": self.on_thread_reasoning_read,
            "thread/reasoning/set": self.on_thread_reasoning_set,
            "thread/turns/list": self.on_turn_list, "thread/items/list": self.on_items_list,
            "thread/item/result/read": self.on_tool_result_read,
            "thread/item/content/read": self.on_item_content_read,
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
            "context/compact/plan": self.on_context_compact_plan,
            "context/compact/start": self.on_context_compact_start,
            "context/compact/abort": self.on_context_compact_abort,
            "context/compact/read": self.on_context_compact_read,
            "context/compact": self.on_context_compact,
            "context/edit/read": self.on_context_edit_read,
            "context/edit": self.on_context_edit,
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
        bridge_description = self._bridge_description()
        self._bidirectional = bidirectional and protocol == PROTOCOL_VERSION
        self._protocol = protocol
        self.server.opt_out_notifications = frozenset(opt_out)
        self._state = "initializing" if protocol == PROTOCOL_VERSION else "ready"
        return {"serverName": "boss-harness", "serverVersion": __version__, "protocolVersion": protocol,
            "capabilities": {"bidirectionalRequests": True, "eventReplay": True,
                             "pagination": True, "parallelThreads": True},
            "toolBridge": {**bridge_description, "tools": self.runner.tool_names,
                           "bundleId": self.tool_bundle.id},
            "modelBridge": {"provider": self.config.provider, "model": self.config.model,
                "driven": self.provider is not None, "thinking": dict(self.config.thinking) if self.config.thinking else None,
                "serverSideFallback": self.config.server_side_fallback},
            "approval": {"requiredTools": sorted(self.approval_required), "timeoutSeconds": self.approval_timeout},
            "eventCursor": self.sessions.latest_event_cursor()}

    def _bridge_description(self) -> dict:
        try:
            metadata = self.tool_bundle.describe_bridge(self.tools)
        except Exception:
            raise ValueError("工具桥描述回调失败") from None
        if not isinstance(metadata, dict) or type(metadata.get("available")) is not bool:
            raise ValueError("工具桥描述必须包含布尔 available")
        try:
            encoded = json.dumps(metadata, ensure_ascii=False, allow_nan=False)
            if len(encoded.encode()) > 16 * 1024:
                raise ValueError
            return json.loads(encoded)
        except (TypeError, ValueError, RecursionError):
            raise ValueError("工具桥描述必须是有界 JSON 元数据") from None

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
                "toolBundleId": self.tool_bundle.id,
                "autoCompaction": self.compaction_policy.describe(),
                "approvalPolicy": "each-consequential-call", "approvalTimeoutSeconds": self.approval_timeout}

    def _discover_model_configs(self) -> dict[str, ModelConfig]:
        routes = {self.config.provider: self.config}
        if self.config.provider == "none":
            routes["none"] = replace(self.config, model="none", effort=None)
        if self.provider_factory is None:
            return routes

        environ = dict(os.environ)
        environ.pop("BOSS_HARNESS_PROVIDER", None)
        for provider in ("anthropic", "openai"):
            if provider in routes:
                continue
            if provider == "anthropic" and not (
                environ.get("ANTHROPIC_API_KEY") or environ.get("ANTHROPIC_AUTH_TOKEN")
            ):
                continue
            candidate_env = dict(environ)
            candidate_env.pop("BOSS_HARNESS_MODEL", None)
            candidate_env.pop("BOSS_HARNESS_EFFORT", None)
            model = environ.get(f"BOSS_HARNESS_{provider.upper()}_MODEL")
            effort = environ.get(f"BOSS_HARNESS_{provider.upper()}_EFFORT")
            if model:
                candidate_env[f"BOSS_HARNESS_{provider.upper()}_MODEL"] = model
            if effort:
                candidate_env["BOSS_HARNESS_EFFORT"] = effort
            try:
                routes[provider] = resolve_config(environ=candidate_env, provider=provider)
            except (OSError, TypeError, ValueError):
                # An optional route with incomplete local credentials is not selectable.
                continue
        return routes

    @staticmethod
    def _canonical_provider(value: object) -> str:
        if not isinstance(value, str) or not value.strip() or len(value) > 64 or any(c.isspace() for c in value):
            raise ValueError("provider 格式无效")
        provider = value.strip().lower()
        return "openai" if provider == "codex" else provider

    @staticmethod
    def _validate_model_id(value: object) -> str:
        if not isinstance(value, str) or not value.strip() or len(value) > 200 or any(c.isspace() for c in value):
            raise ValueError("model 格式无效")
        return value.strip()

    def _configured_route(self, provider: str) -> ModelConfig:
        config = self._model_configs.get(provider)
        if config is None or not self._route_available(provider):
            raise RpcError(-32013, "本机没有可用的该模型线路配置",
                           {"code": "MODEL_PROVIDER_UNAVAILABLE", "provider": provider})
        return config

    def _route_available(self, provider: str) -> bool:
        return (provider in self._model_configs and
                (provider == "none" or self.provider_factory is not None or
                 (provider == self.config.provider and self.provider is not None)))

    def on_model_list(self, params: dict | None) -> dict:
        models = []
        for provider, config in self._model_configs.items():
            model = config.model
            available = self._route_available(provider)
            models.append({"id": model, "provider": provider, "configured": True, "available": available,
                           "capabilities": self.model_catalog.resolve(provider, model).describe()})
        return {"models": models,
                "source": "local-config"}

    def on_thread_start(self, params: dict | None) -> dict:
        params = params or {}
        title = params.get("title", "新会话")
        if not isinstance(title, str) or len(title) > 500:
            raise ValueError("title 必须是最多 500 字符的字符串")
        policy = params.get("toolPolicy", "approval")
        if not isinstance(policy, str) or policy not in {"readOnly", "approval"}:
            raise ValueError("toolPolicy 必须是 readOnly 或 approval")
        provider = self._canonical_provider(params.get("provider", self.config.provider))
        config = self._configured_route(provider)
        model = params.get("model", config.model)
        if params.get("provider") is not None and model != config.model:
            raise RpcError(-32013, "该 provider/model 不在本机配置目录中",
                           {"code": "MODEL_ROUTE_UNAVAILABLE", "provider": provider, "model": model})
        self._validate_model_id(model)
        thread = self.sessions.create(title, projectId=params.get("projectId"),
                                      provider=provider, model=model, cwd=str(self.workspace), toolPolicy=policy)
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
            canonical_items = [] if exclude and not paged else self.events.items(thread_id)
            edit_states = self.context.context_edit_states(self.sessions.read_entries(thread_id))
            snapshot_id = uuid.uuid4().hex if paged else None
            items = [project_item(thread_id, item, snapshot_id=snapshot_id)
                     for item in canonical_items]
            for item in items:
                if item["id"] in edit_states:
                    item["contextEdit"] = edit_states[item["id"]]
            result = {"thread": thread, "items": [] if exclude or paged else items,
                    "turns": None if exclude else self.sessions.list_turns(thread_id)["turns"],
                    "activeTurnId": job["turnId"] if job else None,
                    "eventCursor": self.sessions.latest_event_cursor(), "queue": self.queue.list(thread_id)}
            if paged:
                self._snapshot_pages = {key: value for key, value in self._snapshot_pages.items()
                                        if value[2] > time.monotonic()}
                if len(self._snapshot_pages) >= 16:
                    self._snapshot_pages.pop(next(iter(self._snapshot_pages)))
                self._snapshot_pages[snapshot_id] = (thread_id, canonical_items, time.monotonic() + 120, edit_states)
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
            edit_states = snapshot[3]
        else:
            items = self.events.items(thread_id)
            edit_states = self.context.context_edit_states(self.sessions.read_entries(thread_id))
        if offset > len(items):
            raise ValueError("条目分页游标超出结果范围")
        page = []
        result = {"items": page, "nextCursor": None}
        for raw_item in items[offset:offset + limit]:
            item = project_item(thread_id, raw_item,
                                snapshot_id=snapshot_id if isinstance(snapshot_id, str) else None)
            if item["id"] in edit_states:
                item["contextEdit"] = edit_states[item["id"]]
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

    def on_item_content_read(self, params: dict | None) -> dict:
        params = params or {}
        allowed = {"threadId", "itemId", "part", "sha256", "snapshotId", "cursor", "limit"}
        if set(params) - allowed:
            raise ValueError("会话内容读取包含未知参数")
        thread_id = _text(params, "threadId")
        item_id = _text(params, "itemId", maximum=128)
        part = params.get("part")
        if not isinstance(part, str) or part not in {"text", "thinking"}:
            raise ValueError("part 必须是 text 或 thinking")
        snapshot_id = params.get("snapshotId")
        if snapshot_id is not None and (not isinstance(snapshot_id, str)
                or not re.fullmatch(r"[a-f0-9]{32}", snapshot_id)):
            raise ValueError("snapshotId 格式无效")
        self.sessions.require_thread(thread_id)
        with self.events.lock:
            if snapshot_id is not None:
                snapshot = self._snapshot_pages.get(snapshot_id)
                if snapshot is None or snapshot[0] != thread_id or snapshot[2] <= time.monotonic():
                    raise ValueError("会话快照已过期；请重新 resume")
                items = snapshot[1]
            else:
                items = self.events.items(thread_id)
            item = next((value for value in items if value.get("id") == item_id), None)
        if item is None:
            raise ValueError("条目不属于该会话或不存在")
        response = read_item_content(thread_id, item, part=part,
            sha256=_text(params, "sha256", maximum=64), cursor=params.get("cursor"),
            limit=params.get("limit", 16_384), snapshot_id=snapshot_id)
        self._check_response_budget(response)
        return response

    def on_thread_fork(self, params: dict | None) -> dict:
        params = params or {}
        thread = self.sessions.fork_thread(_text(params, "threadId"), turn_id=params.get("turnId"), title=params.get("title"))
        self.events.emit("thread/created", {"threadId": thread["id"], "thread": thread})
        return {"thread": thread}

    def _idle(self, thread_id: str) -> None:
        if thread_id in self.runtimes.active:
            raise RpcError(-32004, "请先中断该会话的运行回合")
        if thread_id in self._compaction_by_thread:
            raise RpcError(-32004, "该会话正在生成摘要，请等待完成或先取消摘要")

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

    def on_thread_model_set(self, params: dict | None) -> dict:
        params = params or {}
        if set(params) != {"threadId", "provider", "model"}:
            raise ValueError("thread/model/set 只接受 threadId、provider 和 model")
        thread_id = _text(params, "threadId")
        provider = self._canonical_provider(params["provider"])
        model = self._validate_model_id(params["model"])
        config = self._configured_route(provider)
        if model != config.model:
            raise RpcError(-32013, "该 provider/model 不在本机配置目录中",
                           {"code": "MODEL_ROUTE_UNAVAILABLE", "provider": provider, "model": model})
        with self.runtimes.lock:
            if self.runtimes.closed:
                raise RpcError(-32003, "内核正在关闭")
            thread = self.sessions.get_thread(thread_id)
            if thread.get("archived"):
                raise ValueError("请先恢复归档会话")
            self._idle(thread_id)
            if (thread.get("provider") == provider and thread.get("model") == model
                    and thread.get("reasoningEffort") is None):
                return {"thread": thread}
            updated = self.sessions.update_thread(thread_id, provider=provider, model=model, reasoningEffort=None)
        self.events.emit("thread/model/updated", {"threadId": thread_id, "provider": provider,
                                                  "model": model, "thread": updated})
        return {"thread": updated}

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
        provider = self._canonical_provider(params.get("provider", thread.get("provider", self.config.provider)))
        base = self._configured_route(provider)
        model = self._validate_model_id(params.get("model") or thread.get("model") or base.model)
        effort = self._effective_reasoning_effort(thread, provider, model)
        return replace(base, model=model, effort=effort)

    def _effective_reasoning_effort(self, thread: dict, provider: str, model: str) -> str | None:
        effort = thread.get("reasoningEffort")
        if effort is None:
            return self._configured_route(provider).effort
        capabilities = self.model_catalog.resolve(provider, model)
        if effort not in capabilities.reasoning_efforts:
            raise RpcError(-32012, "当前模型未声明支持该推理档位",
                           {"code": "REASONING_EFFORT_UNSUPPORTED", "model": model,
                            "available": list(capabilities.reasoning_efforts)})
        return effort

    def _apply_session_reasoning(self, thread_id: str, config: ModelConfig,
                                 request: ModelRequest) -> ModelRequest:
        with self.runtimes.lock:
            thread = self.sessions.get_thread(thread_id)
            effort = self._effective_reasoning_effort(thread, config.provider, request.model)
        return replace(request, effort=effort)

    def _reasoning_scope(self, thread_id: str, thread: dict) -> tuple[ModelConfig, list[str], bool]:
        """Read under the runtime lock; a setting must suit all current model owners."""
        default = self._model_config({**thread, "reasoningEffort": None}, {})
        active = self.runtimes.active.get(thread_id)
        summary = self._compaction_jobs.get(self._compaction_by_thread.get(thread_id, ""))
        primary = active["runner"].config if active else default
        configs = [primary, default]
        if summary and summary.get("config") is not None:
            configs.append(summary["config"])
        available = list(self.model_catalog.resolve(primary.provider, primary.model).reasoning_efforts)
        for config in configs[1:]:
            supported = self.model_catalog.resolve(config.provider, config.model).reasoning_efforts
            available = [effort for effort in available if effort in supported]
        return primary, available, summary is not None

    def on_thread_reasoning_set(self, params: dict | None) -> dict:
        params = params or {}
        if set(params) != {"threadId", "effort"}:
            raise ValueError("thread/reasoning/set 只接受 threadId 和 effort")
        thread_id = _text(params, "threadId")
        effort = params["effort"]
        if effort is not None and (not isinstance(effort, str) or not effort):
            raise ValueError("effort 必须是推理档位字符串或 null")
        with self.runtimes.lock:
            if self.runtimes.closed:
                raise RpcError(-32003, "内核正在关闭")
            thread = self.sessions.get_thread(thread_id)
            if thread.get("archived"):
                raise ValueError("请先恢复归档会话")
            config, available, _ = self._reasoning_scope(thread_id, thread)
            if effort is not None:
                if effort not in available:
                    raise RpcError(-32012, "会话或当前运行模型未声明支持该推理档位",
                                   {"code": "REASONING_EFFORT_UNSUPPORTED", "model": config.model,
                                    "available": available})
            if thread.get("reasoningEffort") == effort:
                return {"thread": thread}
            updated = self.sessions.update_thread(thread_id, reasoningEffort=effort)
        self.events.emit("thread/reasoning/updated", {"threadId": thread_id, "effort": effort})
        return {"thread": updated}

    def on_thread_reasoning_read(self, params: dict | None) -> dict:
        params = params or {}
        if set(params) != {"threadId"}:
            raise ValueError("thread/reasoning/read 只接受 threadId")
        thread_id = _text(params, "threadId")
        with self.runtimes.lock:
            thread = self.sessions.get_thread(thread_id)
            config, available, summary_active = self._reasoning_scope(thread_id, thread)
            capabilities = self.model_catalog.resolve(config.provider, config.model)
            effort = thread.get("reasoningEffort")
            return {"threadId": thread_id, "model": config.model, "effort": effort,
                    "configuredEffort": config.effort,
                    "supported": effort is None or effort in available,
                    "availableEfforts": available, "summaryActive": summary_active,
                    "capabilitySource": capabilities.source,
                    "capabilityIsEstimate": capabilities.estimated}

    def _system_prompt(self, read_only: bool, skill_text: str) -> str:
        prompt = self.tool_bundle.system_prompt + ("\n\n用户选择的技能：\n" + skill_text if skill_text else "")
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
                entries = self.sessions.read_entries(thread_id)
                metadata = self.context.read(thread_id, entries=entries)
                if runner.last_preparation is not None:
                    return {**metadata, **runner.last_preparation[1], "requestSource": "active",
                            "compactionJob": self._compaction_reference(thread_id)}
                config, prompt, tools = runner.config, runner.system_prompt, runner.tool_specs()
            else:
                config = self._model_config(thread, params)
                skill_text, _ = self.skills.load(params.get("skillIds"))
                prompt = self._system_prompt(thread.get("toolPolicy") == "readOnly", skill_text)
                tools = self.registry.specs(read_only=thread.get("toolPolicy") == "readOnly")
                entries = self.sessions.read_entries(thread_id)
            messages = list(self.context.history(thread_id, entries=entries))
            if job is None:
                attachment_text, _ = self.attachments.context(thread_id, params.get("attachmentIds"))
                text = _text(params, "input") if "input" in params else ""
                if text or attachment_text:
                    messages.append(UserMessage(text=text + ("\n\n" + attachment_text if attachment_text else "")))
            request = ModelRequest(model=config.model, system=prompt, messages=tuple(messages), tools=tools,
                                   max_tokens=config.max_tokens, effort=config.effort, thinking=config.thinking)
            request = self._apply_session_reasoning(thread_id, config, request)
            result = self.context.read(thread_id, request=request,
                                       capabilities=self.model_catalog.resolve(config.provider, config.model),
                                       provider=config.provider, entries=entries)
            return {**result, "provider": config.provider, "requestSource": "active" if job else "preview" if preview else "default",
                    "compactionJob": self._compaction_reference(thread_id)}

    def on_context_edit_read(self, params: dict | None) -> dict:
        params = params or {}
        if set(params) != {"threadId", "itemId"}:
            raise ValueError("context/edit/read 参数无效")
        thread_id, item_id = _text(params, "threadId"), _text(params, "itemId")
        with self.runtimes.lock:
            result = self.context.context_edit_read(thread_id, item_id)
            thread = self.sessions.get_thread(thread_id)
            if thread.get("archived"):
                result.update(canEdit=False, reason="归档会话不可编辑。")
            elif thread_id in self.runtimes.active or thread_id in self._compaction_by_thread:
                result.update(canEdit=False, reason="会话正在运行或整理摘要；请等待结束后再编辑。")
            return result

    def on_context_edit(self, params: dict | None) -> dict:
        params = params or {}
        if set(params) != {"threadId", "itemId", "sourceDigest", "replacementText"}:
            raise ValueError("context/edit 参数无效")
        thread_id, item_id = _text(params, "threadId"), _text(params, "itemId")
        replacement = params.get("replacementText")
        if replacement is not None and not isinstance(replacement, str):
            raise ValueError("replacementText 必须是字符串或 null")
        with self.runtimes.lock:
            thread = self.sessions.get_thread(thread_id)
            if thread.get("archived"):
                raise ValueError("归档会话不可编辑")
            if thread_id in self.runtimes.active or thread_id in self._compaction_by_thread:
                raise RpcError(-32004, "会话正在运行或整理摘要；请等待结束后再编辑")
            result = self.context.context_edit(thread_id, item_id, replacement,
                                               params.get("sourceDigest"))
            self.events.emit("context/edited", {"threadId": thread_id, "itemId": item_id,
                                                 "sourceDigest": result["sourceDigest"]})
            return result

    def _compaction_reference(self, thread_id: str) -> dict[str, Any] | None:
        """Read under runtimes.lock; retain lifecycle ownership through provider cleanup."""
        active_id = self._compaction_by_thread.get(thread_id)
        if active_id is not None:
            job = self._compaction_jobs.get(active_id)
            if job is not None:
                return {"jobId": job["jobId"], "status": job["status"], "active": True}
        for job in reversed(self._compaction_jobs.values()):
            if job["threadId"] == thread_id and job["status"] != "running":
                return {"jobId": job["jobId"], "status": job["status"], "active": False}
        return None

    @staticmethod
    def _source_digest(params: dict) -> str | None:
        value = params.get("sourceDigest")
        if value is None:
            return None
        if not isinstance(value, str) or len(value) != 64 or not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError("sourceDigest 格式无效")
        return value

    @staticmethod
    def _compaction_public(job: dict) -> dict[str, Any]:
        result = {"jobId": job["jobId"], "threadId": job["threadId"],
                  "throughTurnId": job["throughTurnId"], "sourceDigest": job["sourceDigest"],
                  "status": job["status"]}
        for key in ("code", "message", "result", "modelRequestCount", "processedCharacters", "totalCharacters",
                    "retainedItemCount", "firstKeptItemId", "estimatedRetainedTokens", "reason", "turnId"):
            if key in job and job[key] is not None:
                result[key] = job[key]
        return result

    def _remember_compaction_terminal(self, job: dict) -> None:
        with self.runtimes.lock:
            if job["status"] == "running":
                return
            abort = job.get("_shutdown_abort")
            if abort is not None and not abort.done.is_set():
                return
            job_id = job["jobId"]
            if job_id in self._compaction_terminal_ids:
                return
            for key in ("config", "provider", "cancel", "worker", "_shutdown_abort", "_shutdown_worker_done"):
                job.pop(key, None)
            self._compaction_terminal_ids.add(job_id)
            self._compaction_terminal_order.append(job_id)
            while len(self._compaction_terminal_order) > MAX_RETAINED_COMPACTION_JOBS:
                expired_id = self._compaction_terminal_order.popleft()
                self._compaction_terminal_ids.discard(expired_id)
                expired = self._compaction_jobs.get(expired_id)
                if expired is not None and expired["status"] != "running":
                    self._compaction_jobs.pop(expired_id, None)

    def _finish_compaction(self, job: dict) -> None:
        with self.runtimes.lock:
            job["_shutdown_worker_done"] = True
            self._retire_compaction_locked(job)
        self._close_application_resources_if_idle()

    def _retire_compaction_locked(self, job: dict) -> None:
        abort = job.get("_shutdown_abort")
        if not job.get("_shutdown_worker_done") or (abort is not None and not abort.done.is_set()):
            return
        if self._compaction_by_thread.get(job["threadId"]) == job["jobId"]:
            self._compaction_by_thread.pop(job["threadId"], None)
        self._remember_compaction_terminal(job)

    def _compaction_abort_done(self, job: dict) -> None:
        with self.runtimes.lock:
            self._retire_compaction_locked(job)
        self._close_application_resources_if_idle()

    @staticmethod
    def _missing_compaction_job() -> RpcError:
        return RpcError(-32011, "摘要任务不存在或已过期", {"code": "COMPACTION_JOB_NOT_FOUND"})

    @staticmethod
    def _compaction_safe_error(job: dict, error: Exception | str) -> str:
        secret = job["config"].api_key.get() if job["config"].api_key else ""
        message = redact_secrets(str(error), extra=(secret,))
        if len(message) > MAX_COMPACTION_ERROR_CHARACTERS:
            message = message[:MAX_COMPACTION_ERROR_CHARACTERS - 1] + "…"
        return message

    def _compaction_failed(self, job: dict, code: str, error: Exception | str) -> None:
        with self.runtimes.lock:
            # Observer failures cannot undo an append-only committed checkpoint.
            if job["status"] == "completed":
                self._compaction_committed_warning(job, error)
                return
            if job["cancel"].is_set() and code != "COMPACTION_COMMIT_UNCERTAIN":
                job.update(status="cancelled", code="COMPACTION_CANCELLED", message="摘要已取消")
            else:
                job.update(status="failed", code=code, message=self._compaction_safe_error(job, error))
        self.events.emit("context/compactionFailed", self._compaction_public(job))

    def _compaction_committed_warning(self, job: dict, error: Exception | str) -> None:
        with self.runtimes.lock:
            job.update(status="completed", code="COMPACTION_COMMITTED_REFRESH_FAILED",
                       message="摘要已提交并生效，但后续状态刷新或通知失败；请重新读取上下文，不要重复生成。"
                               + self._compaction_safe_error(job, error))

    def _compaction_provider(self, config: ModelConfig) -> Provider:
        if self.provider_factory is None:
            raise ValueError("模型摘要需要 provider_factory 创建独立供应商实例")
        try:
            provider = self.provider_factory(config)
        except Exception as exc:
            secret = config.api_key.get() if config.api_key else ""
            raise ValueError(redact_secrets(str(exc), extra=(secret,))) from None
        if provider is None:
            raise ValueError("当前未配置可用模型，无法生成摘要")
        if provider is self.provider or provider is self.runner.provider:
            raise ValueError("模型摘要必须使用独立于主回合的 provider 实例")
        return provider

    def _compaction_plan(self, params: dict) -> dict:
        through = _text(params, "throughTurnId") if "throughTurnId" in params else None
        keep = params.get("keepRecentTokens")
        if "keepRecentTokens" in params and (type(keep) is not int or not 1 <= keep <= 1_000_000):
            raise ValueError("keepRecentTokens 必须是 1 到 1000000 之间的整数")
        return self.context.compaction_plan(_text(params, "threadId"), through, keep_recent_tokens=keep)

    def on_context_compact_start(self, params: dict | None) -> dict:
        params = params or {}
        thread_id = _text(params, "threadId")
        source_digest = self._source_digest(params)
        with self.runtimes.lock:
            if self.runtimes.closed:
                raise RpcError(-32003, "内核正在关闭")
            self._idle(thread_id)
            if thread_id in self._compaction_by_thread:
                raise RpcError(-32004, "该会话已经有摘要任务在运行")
            plan = self._compaction_plan(params)
            through_turn_id = plan["throughTurnId"]
            _, source = self.context.compaction_material(thread_id, through_turn_id, source_digest or plan["sourceDigest"])
            config = self._model_config(self.sessions.get_thread(thread_id), params)
            active_manual = sum(1 for existing in self._compaction_jobs.values()
                                if existing["status"] == "running" and "turnId" not in existing)
            if active_manual >= self.runtimes.capacity:
                raise RpcError(-32005, "已达到后台摘要并发上限",
                               {"code": "COMPACTION_CONCURRENCY_LIMIT", "limit": self.runtimes.capacity})
            provider = self._compaction_provider(config)
            if any(job["runner"].provider is provider for job in self.runtimes.jobs.values()) \
                    or any(existing.get("provider") is provider
                           for existing in self._compaction_jobs.values()):
                raise RpcError(-32005, "模型供应商实例正在被其他任务使用，无法安全隔离摘要请求")
            job_id = uuid.uuid4().hex
            job = {"jobId": job_id, "threadId": thread_id, "throughTurnId": through_turn_id,
                   "sourceDigest": plan["sourceDigest"], "config": config, "provider": provider,
                   "cancel": threading.Event(), "status": "running", "modelRequestCount": 0,
                   "processedCharacters": 0, "totalCharacters": len(source),
                   "retainedItemCount": plan["retainedItemCount"], "firstKeptItemId": plan["firstKeptItemId"],
                   "estimatedRetainedTokens": plan["estimatedRetainedTokens"]}
            self._compaction_jobs[job_id] = job
            self._compaction_by_thread[thread_id] = job_id
        worker = None
        try:
            worker = threading.Thread(target=self._run_compaction, args=(job,),
                                      name=f"compact-{job_id[:8]}", daemon=True)
            job["worker"] = worker
            self.events.emit("context/compactionStarted", self._compaction_public(job))
            worker.start()
        except Exception as exc:
            if worker is not None and worker.is_alive():
                raise
            with self.runtimes.lock:
                job.update(status="failed", code="COMPACTION_START_FAILED",
                           message=self._compaction_safe_error(job, exc))
            try:
                self.events.emit("context/compactionFailed", self._compaction_public(job))
            finally:
                self._finish_compaction(job)
            raise RuntimeError(job["message"]) from None
        return self._compaction_public(job)

    def on_context_compact_abort(self, params: dict | None) -> dict:
        job_id = _text(params, "jobId", maximum=128)
        with self.runtimes.lock:
            job = self._compaction_jobs.get(job_id)
            if job is None:
                raise self._missing_compaction_job()
            if job["status"] != "running":
                return {"aborted": False, **self._compaction_public(job)}
            aborts = [self._claim_compaction_abort_locked(job)]
            turn = self.runtimes.active.get(job["threadId"])
            if turn is not None and job.get("turnId") == turn["turnId"]:
                self.runtimes.prepare_interrupt(job["threadId"], turn["turnId"], interrupt=False)
                aborts.append(turn["_shutdown_abort"])
            result = {"aborted": True, **self._compaction_public(job)}
        for abort in aborts:
            abort.start()
        return result

    def on_context_compact_read(self, params: dict | None) -> dict:
        job_id = _text(params, "jobId", maximum=128)
        with self.runtimes.lock:
            job = self._compaction_jobs.get(job_id)
            if job is None:
                raise self._missing_compaction_job()
            return self._compaction_public(job)

    def _stream_compaction(self, provider: Provider, request: ModelRequest,
                           cancel: threading.Event, *, character_limit: int = 32_000) -> AssistantMessage:
        if cancel.is_set():
            raise _CompactionCancelled
        stream = provider.stream(request)
        assistant: AssistantMessage | None = None
        error: str | None = None
        tool_event = False
        try:
            while True:
                if cancel.is_set():
                    raise _CompactionCancelled
                try:
                    event = next(stream)
                except StopIteration:
                    break
                if cancel.is_set():
                    raise _CompactionCancelled
                if event.type == "done":
                    assistant = event.message
                    break
                if event.type in {"toolcall_start", "toolcall_delta", "toolcall_end"}:
                    tool_event = True
                if event.type == "error":
                    error = event.error or "模型摘要请求失败"
                    break
        except Exception:
            if cancel.is_set():
                raise _CompactionCancelled from None
            raise
        finally:
            close = getattr(stream, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    if error is None and not cancel.is_set():
                        error = "摘要流关闭失败"
        if cancel.is_set():
            raise _CompactionCancelled
        if error is not None:
            raise _CompactionFailure("COMPACTION_PROVIDER_ERROR", error)
        if assistant is None:
            raise _CompactionFailure("COMPACTION_INCOMPLETE", "摘要模型未返回完成响应")
        if assistant.stop_reason != "stop":
            raise _CompactionFailure("COMPACTION_INVALID_STOP_REASON",
                                     "摘要模型未以正常停止原因结束")
        if tool_event or assistant.tool_calls():
            raise _CompactionFailure("COMPACTION_TOOL_CALL_REJECTED", "摘要请求不允许调用工具")
        summary = assistant.text().strip()
        if not summary:
            raise _CompactionFailure("COMPACTION_EMPTY", "摘要模型返回了空内容")
        if len(summary) > character_limit:
            raise _CompactionFailure("COMPACTION_TOO_LARGE", "摘要模型返回内容超过本次请求的字符预算")
        return assistant

    def _generate_compaction(self, job: dict, source: str) -> tuple[str, SummaryPlanner]:
        config: ModelConfig = job["config"]
        thread_id = job["threadId"]
        capabilities = self.model_catalog.resolve(config.provider, config.model)
        planner = SummaryPlanner(source, config, capabilities)
        offset, summary = 0, ""
        for index in range(1, SUMMARY_MAX_REQUESTS + 1):
            if job["cancel"].is_set():
                raise _CompactionCancelled
            with self.runtimes.lock:
                effort = self._effective_reasoning_effort(self.sessions.get_thread(thread_id), config.provider, config.model)
                planner.config = replace(config, effort=effort)
            fragment = planner.fragment(offset, summary, index)
            prepared, budget = self.context.prepare(fragment.request, capabilities, provider=config.provider)
            with self.runtimes.lock:
                job["modelRequestCount"] = index
            assistant = self._stream_compaction(job["provider"], prepared, job["cancel"],
                                                character_limit=planner.character_limit)
            self.sessions.append(thread_id, Entry(type="context_summary_usage", payload={
                "jobId": job["jobId"], "provider": config.provider, "model": prepared.model,
                "usage": asdict(assistant.usage) if assistant.usage is not None else None,
                "stopReason": assistant.stop_reason, "eligible": False,
                "requestFingerprint": request_fingerprint(config.provider, prepared), "budget": budget,
                "fragmentIndex": index, "sourceStart": fragment.start, "sourceEnd": fragment.end,
                "sourceCharacters": len(source), "sourceTextDigest": planner.source_digest}))
            summary, offset = assistant.text().strip(), fragment.end
            with self.runtimes.lock:
                job["processedCharacters"] = offset
            self.events.emit("context/compactionProgress", self._compaction_public(job))
            if offset == len(source):
                break
        else:
            raise _CompactionFailure("COMPACTION_REQUEST_LIMIT", "摘要达到 32 次模型请求上限，未写入检查点")
        return summary, planner

    def _run_compaction(self, job: dict) -> None:
        thread_id = job["threadId"]
        assistant: AssistantMessage | None = None
        try:
            plan, source = self.context.compaction_material(thread_id, job["throughTurnId"], job["sourceDigest"])
            config: ModelConfig = job["config"]
            summary, planner = self._generate_compaction(job, source)
            with self.runtimes.lock:
                if job["cancel"].is_set():
                    raise _CompactionCancelled
                current = self.context.compaction_plan(thread_id, job["throughTurnId"])
                if current["sourceDigest"] != plan["sourceDigest"]:
                    raise _CompactionFailure("COMPACTION_SOURCE_CHANGED", "摘要来源已变化，未写入检查点")
                thread = self.sessions.get_thread(thread_id)
                read_only = thread.get("toolPolicy") == "readOnly"
                business_config = self._model_config(thread, {})
                preview = ModelRequest(model=business_config.model, system=self._system_prompt(read_only, ""),
                    messages=self.context.compacted_history(thread_id, summary, plan),
                    tools=self.registry.specs(read_only=read_only), max_tokens=business_config.max_tokens,
                    effort=business_config.effort, thinking=business_config.thinking)
                try:
                    self.context.prepare(preview, self.model_catalog.resolve(business_config.provider, business_config.model),
                                         provider=business_config.provider)
                except ContextBudgetExceeded:
                    raise _CompactionFailure("COMPACTION_INSUFFICIENT",
                                             "摘要与保留回合仍超过完整请求预算；请减少保留范围或新建会话") from None
                self.context.compact(
                    thread_id, summary, job["throughTurnId"], plan["sourceDigest"], origin="model",
                    metadata={"summaryJobId": job["jobId"], "summaryProvider": config.provider,
                              "summaryModel": config.model, "modelRequestCount": job["modelRequestCount"],
                              "sourceCharacters": len(source), "sourceTextDigest": planner.source_digest},
                    _on_committed=lambda: job.update(status="completed"))
                result = self.on_context_read({"threadId": thread_id})
                job.update(result=result)
        except _CompactionCancelled:
            with self.runtimes.lock:
                job.update(status="cancelled", code="COMPACTION_CANCELLED", message="摘要已取消")
            self.events.emit("context/compactionFailed", self._compaction_public(job))
        except ContextBudgetExceeded as exc:
            self._compaction_failed(job, "COMPACTION_INPUT_TOO_LARGE", exc)
        except _CompactionFailure as exc:
            self._compaction_failed(job, exc.code, exc)
        except CheckpointCommitUncertain as exc:
            self._compaction_failed(job, exc.code, exc)
        except ValueError as exc:
            message = str(exc)
            code = "COMPACTION_SOURCE_CHANGED" if "来源" in message else "COMPACTION_FAILED"
            self._compaction_failed(job, code, message)
        except Exception as exc:
            self._compaction_failed(job, "COMPACTION_FAILED", exc)
        finally:
            try:
                if job["status"] == "completed":
                    try:
                        self.events.emit("context/compactionCompleted", self._compaction_public(job))
                        self.events.emit("context/compacted", {"threadId": thread_id, "jobId": job["jobId"], "origin": "model"})
                    except Exception as exc:
                        self._compaction_committed_warning(job, exc)
            finally:
                self._finish_compaction(job)

    def on_context_compact(self, params: dict | None) -> dict:
        thread_id = _text(params, "threadId")
        committed = False

        def published() -> None:
            nonlocal committed
            committed = True

        try:
            with self.runtimes.lock:
                self._idle(thread_id)
                source_digest = self._source_digest(params or {})
                self.context.compact(thread_id, _text(params, "summary", maximum=32_000),
                                     _text(params, "throughTurnId"), source_digest, _on_committed=published)
                result = self.on_context_read({"threadId": thread_id})
            self.events.emit("context/compacted", {"threadId": thread_id})
            return result
        except (CheckpointCommittedError, CheckpointCommitUncertain) as exc:
            raise RpcError(-32012, str(exc), {"code": exc.code, "threadId": thread_id,
                           "checkpointId": exc.checkpoint_id,
                           "checkpointCommitted": True if isinstance(exc, CheckpointCommittedError) else None}) from None
        except Exception:
            if committed:
                raise RpcError(-32012, "摘要已提交并生效，但状态刷新或通知失败；请重新读取上下文，不要重复提交。",
                               {"code": "COMPACTION_COMMITTED_REFRESH_FAILED", "threadId": thread_id,
                                "checkpointCommitted": True}) from None
            raise

    def on_context_compact_plan(self, params: dict | None) -> dict:
        with self.runtimes.lock:
            return self._compaction_plan(params or {})

    def on_attachment_add(self, params: dict | None) -> dict:
        return {"attachment": self.attachments.add(_text(params, "threadId"), _text(params, "path", maximum=4096))}

    def on_attachment_read(self, params: dict | None) -> dict:
        return {"attachment": self.attachments.read(_text(params, "threadId"), _text(params, "attachmentId"))}

    def _prepare_turn_request(self, turn: dict, request: ModelRequest) -> tuple[ModelRequest, dict]:
        config = turn["runner"].config
        request = self._apply_session_reasoning(turn["threadId"], config, request)
        capabilities = self.model_catalog.resolve(config.provider, request.model)
        try:
            prepared, budget = self.context.prepare(request, capabilities, provider=config.provider,
                                                    thread_id=turn["threadId"])
        except ContextBudgetExceeded as exc:
            prepared, budget = request, exc.budget
        policy: CompactionPolicy = turn["compactionPolicy"]
        request_index = turn["runner"].preparing_request_index
        if (policy.enabled and turn.get("automaticCompactionRequestIndex") != request_index and
                (not budget["withinBudget"] or budget["estimatedInputTokens"] * 100 >=
                 budget["inputBudget"] * policy.trigger_percent)):
            turn["automaticCompactionRequestIndex"] = request_index
            replacement = self._compact_during_turn(turn, request,
                "threshold" if budget["withinBudget"] else "budget", required=False)
            if replacement is not None:
                replacement = self._apply_session_reasoning(turn["threadId"], config, replacement)
                return self.context.prepare(replacement, capabilities, provider=config.provider,
                                            thread_id=turn["threadId"])
        if not budget["withinBudget"]:
            raise ContextBudgetExceeded(budget)
        return prepared, budget

    def _compact_during_turn(self, turn: dict, request: ModelRequest, reason: str,
                             *, required: bool) -> ModelRequest | None:
        runner, thread_id = turn["runner"], turn["threadId"]
        config = replace(runner.config, effort=request.effort)
        job: dict | None = None
        replacement: ModelRequest | None = None

        def owned() -> None:
            if turn["cancel"].is_set() or self.runtimes.closed:
                raise _CompactionCancelled
            if self.runtimes.active.get(thread_id) is not turn:
                raise ContextCompactionFailed("COMPACTION_OWNER_CHANGED", "运行回合已变化，停止上下文恢复")

        try:
            with self.runtimes.lock:
                owned()
                try:
                    plan = self.context.compaction_plan(thread_id,
                        keep_recent_tokens=turn["compactionPolicy"].keep_recent_tokens,
                        _active_turn_id=turn["turnId"])
                    _, source = self.context.compaction_material(thread_id, plan["throughTurnId"],
                        plan["sourceDigest"], _active_turn_id=turn["turnId"])
                except NoCompactionSource:
                    if required:
                        raise ContextCompactionFailed("CONTEXT_RECOVERY_UNAVAILABLE",
                            "没有可压缩的更早完整回合；请减少输入或保留范围，或新建会话") from None
                    return None
                if self.provider_factory is None:
                    if required:
                        raise ContextCompactionFailed("CONTEXT_RECOVERY_UNAVAILABLE", "自动摘要需要独立 provider_factory")
                    return None
                provider = self._compaction_provider(config)
                if any(job["runner"].provider is provider for job in self.runtimes.jobs.values()) or any(
                        active.get("provider") is provider
                        for active in self._compaction_jobs.values()):
                    raise ContextCompactionFailed("COMPACTION_PROVIDER_CONFLICT", "摘要 provider 实例正被其他任务使用")
                job_id = uuid.uuid4().hex
                job = {"jobId": job_id, "threadId": thread_id, "turnId": turn["turnId"],
                    "throughTurnId": plan["throughTurnId"], "sourceDigest": plan["sourceDigest"],
                    "config": config, "provider": provider, "cancel": turn["cancel"],
                    "worker": turn["worker"], "status": "running", "reason": reason,
                    "modelRequestCount": 0, "processedCharacters": 0, "totalCharacters": len(source),
                    "retainedItemCount": plan["retainedItemCount"], "firstKeptItemId": plan["firstKeptItemId"],
                    "estimatedRetainedTokens": plan["estimatedRetainedTokens"]}
                self._compaction_jobs[job_id] = job
                self._compaction_by_thread[thread_id] = job_id
                def abort() -> None:
                    stop = getattr(provider, "request_abort", None)
                    if callable(stop):
                        stop()
                runner.context_abort = abort
            self.events.emit("context/compactionStarted", self._compaction_public(job))
            summary, planner = self._generate_compaction(job, source)
            with self.runtimes.lock:
                owned()
                replacement = self.context.compacted_request(request, summary, plan,
                                                              _active_turn_id=turn["turnId"])
                try:
                    self.context.prepare(replacement, self.model_catalog.resolve(config.provider, request.model),
                                         provider=config.provider, thread_id=thread_id)
                except ContextBudgetExceeded:
                    raise ContextCompactionFailed("COMPACTION_INSUFFICIENT",
                        "摘要与当前请求仍超过完整预算；请减少输入或保留范围，或新建会话") from None
                owned()
                self.context.compact(thread_id, summary, plan["throughTurnId"], plan["sourceDigest"],
                    origin="model", metadata={"summaryJobId": job_id, "summaryProvider": config.provider,
                        "summaryModel": config.model, "reason": reason, "turnId": turn["turnId"],
                        "modelRequestCount": job["modelRequestCount"], "sourceCharacters": len(source),
                        "sourceTextDigest": planner.source_digest},
                    _active_turn_id=turn["turnId"], _on_committed=lambda: job.update(status="completed"))
            self.events.emit("context/compactionCompleted", self._compaction_public(job))
            self.events.emit("context/compacted", {"threadId": thread_id, "jobId": job_id,
                                                   "origin": "model", "reason": reason})
            with self.runtimes.lock:
                owned()
            return replacement
        except Exception as exc:
            if isinstance(exc, CheckpointCommittedError) and job is not None:
                self._compaction_committed_warning(job, exc)
                try:
                    self.events.emit("context/compactionCompleted", self._compaction_public(job))
                    self.events.emit("context/compacted", {"threadId": thread_id, "jobId": job["jobId"],
                                                           "origin": "model", "reason": reason})
                except Exception:
                    pass
                raise ContextCompactionFailed(exc.code, runner.safe_error(exc)) from None
            if job is not None and job["status"] != "completed":
                code = exc.code if isinstance(exc, (ContextCompactionFailed, _CompactionFailure, CheckpointCommitUncertain)) else "COMPACTION_FAILED"
                try:
                    self._compaction_failed(job, code, exc)
                except Exception:
                    pass  # Failure state is already set even if an observer cannot persist.
            if isinstance(exc, CheckpointCommitUncertain):
                raise ContextCompactionFailed(exc.code, runner.safe_error(exc)) from None
            if turn["cancel"].is_set() or self.runtimes.closed:
                raise ContextCompactionFailed("COMPACTION_CANCELLED", "自动摘要已取消，本回合停止") from None
            if job is not None and job["status"] == "completed" and replacement is not None:
                with self.runtimes.lock:
                    owned()
                return replacement  # Post-commit observer failures cannot undo the new projection.
            code = exc.code if isinstance(exc, (ContextCompactionFailed, _CompactionFailure)) else "COMPACTION_FAILED"
            raise ContextCompactionFailed(code, runner.safe_error(exc)) from None
        finally:
            runner.context_abort = None
            if job is not None:
                self._finish_compaction(job)

    def _runner_for(self, config: ModelConfig) -> TurnRunner:
        if self.provider_factory is not None:
            bridge = self._new_bridge()
            try:
                provider = self.provider_factory(config)
                if provider is not None:
                    if provider is self.provider or provider is self.runner.provider:
                        raise RpcError(-32005, "模型供应商工厂必须返回独立于应用主实例的 provider")
                    # A released execution slot still owns its provider until the
                    # worker finishes notifications and all lifecycle cleanup.
                    if any(job["runner"].provider is provider for job in self.runtimes.jobs.values()) \
                            or any(compaction.get("provider") is provider
                                   for compaction in self._compaction_jobs.values()):
                        raise RpcError(-32005, "模型供应商实例仍被其他任务持有；工厂必须返回独立实例")
                return self._new_runner(bridge, provider, config)
            except Exception:
                self.bridge_lifecycle.close(bridge)
                raise
        if not any(job["runner"] is self.runner for job in self.runtimes.jobs.values()):
            self.runner.provider, self.runner.config = self.provider, config
            return self.runner
        if self.provider is not None:
            raise RpcError(-32005, "嵌入方须提供独立 provider_factory 才能并发运行模型会话")
        bridge = self._new_bridge()
        try:
            return self._new_runner(bridge, None, config)
        except Exception:
            self.bridge_lifecycle.close(bridge)
            raise

    def on_turn_start(self, params: dict | None, *, queue_item: dict | None = None) -> dict:
        params = params or {}
        thread_id, text = _text(params, "threadId"), _text(params, "input")
        client_id = params.get("clientUserMessageId")
        if client_id is not None and (not isinstance(client_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", client_id)):
            raise ValueError("clientUserMessageId 格式无效")
        runner = None
        job = None
        receipt_notice = None
        request_digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        try:
            with self.runtimes.lock:
                if self.runtimes.closed:
                    raise RpcError(-32003, "内核正在关闭")
                thread = self.sessions.get_thread(thread_id)
                if thread.get("archived"):
                    raise ValueError("请先恢复归档会话")
                if thread_id in self._compaction_by_thread:
                    raise RpcError(-32004, "该会话正在生成摘要，请等待完成或先取消摘要")
                self.queue.settle_pauses(thread_id)
                if client_id:
                    identity = resolve_request(self.sessions, thread_id, client_id, text,
                                               queue_id=queue_item["id"] if queue_item else None)
                    if identity.turn is not None:
                        if identity.queue is not None:
                            associated = self.queue._associate_request(thread_id, identity.queue["id"], identity)
                            dispatch = self._follow_up_dispatches.get(thread_id)
                            if queue_item is not None and dispatch is not None and dispatch["queueId"] == associated["id"]:
                                dispatch["identity_reconciled"] = True
                                dispatch["again"] = (identity.turn.get("status") == "completed"
                                                     and associated["status"] == "delivered")
                            if associated != identity.queue:
                                receipt_notice = self._retain_receipt_notice_locked(thread_id, associated["id"])
                        return {"turnId": identity.turn["turnId"], "clientUserMessageId": client_id, "deduplicated": True}
                    if identity.queue is not None:
                        current = identity.queue
                        dispatch = self._follow_up_dispatches.get(thread_id)
                        if not (queue_item is not None and current["id"] == queue_item["id"]
                                and current["status"] == "delivering" and dispatch is not None
                                and dispatch["queueId"] == current["id"]):
                            pending = current["status"] in {"queued", "delivering"}
                            raise RpcError(-32004, "消息已在队列中，请先核对队列状态" if pending else "旧请求需要核对，发起新任务请使用新请求编号",
                                {"code": "REQUEST_ALREADY_QUEUED" if pending else "REQUEST_REQUIRES_REVIEW",
                                 "queueId": current["id"], "status": current["status"]})
                if thread_id in self._tool_persistence_fences:
                    raise RpcError(-32004, "该会话的工具结果尚未完成持久化核对，请重启内核后重新读取状态",
                                   {"code": "THREAD_REQUIRES_REVIEW"})
                config = self._model_config(thread, params)
                policy = (self.compaction_policy.override(params["autoCompaction"])
                          if "autoCompaction" in params else self.compaction_policy)
                model = config.model
                skill_text, skills = self.skills.load(params.get("skillIds"))
                attachment_text, attachments = self.attachments.context(thread_id, params.get("attachmentIds"))
                runner = self._runner_for(config)
                if any(compaction["status"] == "running" and compaction.get("provider") is runner.provider
                       for compaction in self._compaction_jobs.values()):
                    raise RpcError(-32005, "模型供应商实例正在执行摘要任务，请稍后重试")
                runner.last_preparation = None
                read_only = thread.get("toolPolicy") == "readOnly"
                allowed = self.registry.allowed_names(read_only=read_only)
                runner._tools = self.registry.specs(read_only=read_only)

                def validate(name: str, arguments: dict) -> None:
                    if read_only and name not in allowed:
                        raise ValueError("只读会话禁止此工具；请新建需要逐次审批的会话")
                    self.registry.validate(name, arguments)

                runner.validate_arguments = validate
                job = self.runtimes.reserve(thread_id, text, runner)
                job["compactionPolicy"] = policy
                runner.request_preparer = lambda request: self._prepare_turn_request(job, request)
                runner.recover_context = (lambda request: self._compact_during_turn(
                    job, request, "overflow", required=True)) if policy.enabled else None
                runner.turn_id = job["turnId"]
                runner._cancel = job["cancel"]
                runner.system_prompt = self._system_prompt(read_only, skill_text)
                runner.notify = lambda method, payload=None: self._notify_runner(job, method, payload)
                runner.stage_steering = lambda: self._stage_steering(job)
                job["clientUserMessageId"] = client_id
                job["requestInputDigest"] = request_digest
                job["queueId"] = queue_item["id"] if queue_item else None
                try:
                    self.sessions.record_turn(thread_id, job["turnId"], "running", model=model, provider=config.provider,
                        reasoningEffort=config.effort,
                        skillIds=[s["id"] for s in skills], toolPolicy=thread.get("toolPolicy", "approval"),
                        clientUserMessageId=client_id, requestInputDigest=request_digest, queueId=job["queueId"])
                    user = runner.append_user(thread_id, text + ("\n\n" + attachment_text if attachment_text else ""),
                                       originalInput=text, clientUserMessageId=client_id,
                                       queueId=queue_item["id"] if queue_item else None, attachments=attachments)
                    job["_input_persisted"] = True
                    if queue_item:
                        self.queue.transition(thread_id, queue_item["id"], "delivered")
                    self.events.emit("turn/started", {"threadId": thread_id, "turnId": job["turnId"],
                                                     "clientUserMessageId": client_id})
                    self.events.emit("item/completed", {"threadId": thread_id, "turnId": job["turnId"],
                        "itemId": user.id, "kind": "userMessage", "text": text,
                        "clientUserMessageId": client_id})
                    worker = threading.Thread(target=self._run_turn, args=(job,), name=f"turn-{job['turnId'][:8]}", daemon=True)
                    job["worker"] = worker
                    try:
                        worker.start()
                    except Exception:
                        # A wrapper can raise after launching. ident survives a
                        # fast finish; is_alive() alone cannot prove non-start.
                        if worker.ident is None:
                            raise
                except Exception:
                    self._settle_unstarted_turn_locked(job)
                    raise
            return {"turnId": job["turnId"], "clientUserMessageId": client_id}
        except Exception:
            # Keep jobs/provider/storage ownership through failure observers and
            # bridge cleanup. A failed observer must not replace the start error.
            try:
                if job is not None and job.get("_start_failed"):
                    self._notify_start_failure(job)
            finally:
                try:
                    if runner is not None and runner is not self.runner:
                        self.bridge_lifecycle.close(runner.tool_bridge)
                except Exception:
                    pass
                finally:
                    if job is not None and job.get("_start_failed"):
                        try:
                            self.runtimes.finish(job)
                        except Exception:
                            pass
                    try:
                        self._close_application_resources_if_idle()
                    except Exception:
                        pass
            raise
        finally:
            if receipt_notice is not None:
                self._publish_receipt_notice(receipt_notice)

    def _settle_unstarted_turn_locked(self, job: dict) -> None:
        """Best-effort persistence; the original start error remains primary."""
        job["_start_failed"] = True
        dispatch = self._follow_up_dispatches.get(job["threadId"])
        if dispatch is not None and dispatch["queueId"] == job.get("queueId"):
            dispatch["start_failed"] = True
        persisted = job.get("_input_persisted")
        if persisted is None:
            try:
                persisted = any(item.get("kind") == "userMessage" and item.get("turnId") == job["turnId"]
                                for item in self.sessions.read_items(job["threadId"]))
            except Exception:
                pass  # Unknown persistence is never described as safe to replay.
        fields = {"failureCode": "TURN_START_FAILED", "executionStarted": False,
                  "clientUserMessageId": job.get("clientUserMessageId"),
                  "requestInputDigest": job["requestInputDigest"], "queueId": job.get("queueId")}
        if persisted is not None:
            fields["inputPersisted"] = persisted
        try:
            self.sessions.record_turn(job["threadId"], job["turnId"], "error", **fields)
        except Exception:
            pass
        try:
            if job.get("queueId"):
                # The restricted settlement is idempotent, including a write
                # that committed before raising. Retry before notifying once.
                for _ in range(2):
                    try:
                        self.queue._fail_start(job["threadId"], job["queueId"], turn_id=job["turnId"],
                                               input_persisted=persisted)
                        break
                    except Exception:
                        pass
        except Exception:
            pass
        finally:
            self.runtimes.release(job)

    def _notify_start_failure(self, job: dict) -> None:
        payload = {"threadId": job["threadId"], "turnId": job["turnId"]}
        notifications = [("session/error", {**payload, "code": "TURN_START_FAILED",
                          "message": "回合未能启动，未执行模型或工具；请核对当前会话后重新发起任务。"}),
                         ("turn/completed", {**payload, "status": "error"}),
                         ("thread/updated", {**payload, "status": "error"})]
        if job.get("queueId"):
            notifications.append(("queue/updated", {**payload, "queueId": job["queueId"]}))
        for method, params in notifications:
            try:
                self.events.emit(method, params)
            except Exception:
                pass  # Do not replay an event that may already be durable.

    def _retain_receipt_notice_locked(self, thread_id: str, queue_id: str) -> dict:
        notice = {"id": uuid.uuid4().hex, "threadId": thread_id, "queueId": queue_id,
                  "owner": threading.get_ident(), "done": threading.Event()}
        self._receipt_notices[notice["id"]] = notice
        return notice

    def _publish_receipt_notice(self, notice: dict, *, finish: bool = True) -> None:
        try:
            self.events.emit("queue/updated", {"threadId": notice["threadId"], "queueId": notice["queueId"]})
        finally:
            if finish:
                self._finish_receipt_notice(notice)

    def _finish_receipt_notice(self, notice: dict) -> None:
        with self.runtimes.lock:
            self._receipt_notices.pop(notice["id"], None)
            notice["done"].set()
        self._close_application_resources_if_idle()

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
        status = None
        try:
            try:
                status = self._execute_turn(job)
            finally:
                if status == "completed":
                    with self.runtimes.lock:
                        self._follow_up_workers[job["turnId"]] = threading.current_thread()
                try:
                    if job["runner"] is not self.runner:
                        self.bridge_lifecycle.close(job["runner"].tool_bridge)
                finally:
                    self.runtimes.finish(job)
            if status == "completed":
                # A serial provider can pass to the next turn after the old
                # notifications and bridge cleanup; the tail still owns storage.
                self._start_follow_up(job["threadId"])
        finally:
            with self.runtimes.lock:
                self._follow_up_workers.pop(job["turnId"], None)
            self._close_application_resources_if_idle()

    def _close_application_resources_if_idle(self, deadline: float | None = None) -> None:
        # Startup failure may notify idle while an outer runtime lock is held.
        # Before shutdown there is nothing to close; avoid acquiring the
        # connection lock in that path. closed only transitions to True, and
        # close() checks idle again after freezing admission.
        if not self.runtimes.closed:
            return
        # begin_login takes connections.lock before the runtime lock while
        # creating its bridge. Check this domain before taking runtimes.lock.
        if not self.connections.is_idle():
            return
        with self.runtimes.lock:
            if (not self.runtimes.closed or self._shutdown_preparing
                    or self.runtimes.jobs or self._compaction_by_thread
                    or self._follow_up_workers or self._follow_up_dispatches or self._receipt_notices
                    or not self.lifecycle_hooks.closed):
                return
            if self._base_bridge_close_claimed:
                wait_for_close = self._base_bridge_close_owner != threading.get_ident()
            else:
                self._base_bridge_close_claimed = True
                self._base_bridge_close_owner = threading.get_ident()
                wait_for_close = False
        if wait_for_close:
            self._base_bridge_close_done.wait(None if deadline is None else max(0, deadline - time.monotonic()))
            return
        try:
            self.bridge_lifecycle.close(self.tools)
            self.sessions.close()
            self._owner.close()
        finally:
            self._base_bridge_close_done.set()

    def _execute_turn(self, job: dict) -> str:
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
            # Cancellation, terminal persistence and queue finalization share
            # one boundary. An accepted cancel wins even after the runner has
            # returned its result; completed output and tool facts stay intact.
            with self.runtimes.lock:
                if job["cancel"].is_set():
                    status = "interrupted"
                try:
                    self.sessions.record_turn(thread_id, job["turnId"], status)
                except (OSError, ValueError):
                    status = "error"
                    # The terminal row may be visible in JSONL even when fsync
                    # fails. Append a correction when storage permits it.
                    try:
                        self.sessions.record_turn(thread_id, job["turnId"], "error",
                                                  recoveryReason="terminalPersistenceFailure")
                    except (OSError, ValueError):
                        pass
                try:
                    if status != "completed":
                        self.queue.pause(thread_id)
                    else:
                        self.queue.pause(thread_id, kind="steering")
                except (OSError, ValueError):
                    status = "error"
                    # A steering-only settlement failure also blocks existing
                    # follow-ups. Keep that responsibility even if storage is
                    # still unavailable when attempting the broader pause.
                    try:
                        self.queue.pause(thread_id)
                    except (OSError, ValueError):
                        pass
                    try:
                        self.sessions.record_turn(thread_id, job["turnId"], "error",
                                                  recoveryReason="queueSettlementFailure")
                    except (OSError, ValueError):
                        pass
                finally:
                    self.runtimes.release(job)
            self.events.emit("turn/completed", {"threadId": thread_id, "turnId": job["turnId"], "status": status})
            self.events.emit("thread/updated", {"threadId": thread_id, "turnId": job["turnId"], "status": status})
        return status

    def _run_deterministic(self, thread_id: str, text: str, cancel: threading.Event | None = None,
                           *, runner: TurnRunner | None = None) -> str:
        runner = runner or self.runner
        if cancel is not None and cancel.is_set():
            return "interrupted"
        runner.tool_bridge.cancel_event = cancel
        runner._blocked = None
        try:
            reply = (self.tool_bundle.offline_reply(runner, thread_id, text)
                     if self.tool_bundle.offline_reply is not None else "当前未配置模型；请配置模型后继续任务。")
            if cancel is not None and cancel.is_set():
                return "interrupted"
            runner.append_agent(thread_id, reply)
            return "blocked" if runner._blocked is not None else "completed"
        finally:
            runner.tool_bridge.cancel_event = None
            runner._cancel = None

    def on_turn_interrupt(self, params: dict | None) -> dict:
        thread_id = _text(params, "threadId")
        with self.runtimes.lock:
            turn = self.runtimes.prepare_interrupt(thread_id, (params or {}).get("turnId"), interrupt=False)
            if turn is None:
                return {"interrupted": False}
            aborts = [turn["_shutdown_abort"]]
            job = self._compaction_jobs.get(self._compaction_by_thread.get(thread_id))
            if job is not None and job.get("turnId") == turn["turnId"] and job["status"] == "running":
                aborts.append(self._claim_compaction_abort_locked(job))
        for abort in aborts:
            abort.start()
        return {"interrupted": True}

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
        thread_id, text = _text(params, "threadId"), _text(params, "input")
        with self.runtimes.lock:
            if self.runtimes.closed:
                raise RpcError(-32003, "内核正在关闭")
            self.sessions.require_thread(thread_id)
            identity = resolve_request(self.sessions, thread_id, params.get("clientUserMessageId"), text)
            if (thread_id in self._tool_persistence_fences
                    and identity.queue is None and identity.turn is None):
                raise RpcError(-32004, "该会话的工具结果尚未完成持久化核对，请重启内核后重新读取状态",
                               {"code": "THREAD_REQUIRES_REVIEW"})
            item = identity.queue or self.queue.add(thread_id, text, client_id=params.get("clientUserMessageId"))
            if identity.turn is not None:
                item = self.queue._associate_request(thread_id, item["id"], identity)
            changed = item != identity.queue
            # The final response reads the latest durable receipt after a
            # synchronous dispatch. Keep storage through that bookkeeping too,
            # including unchanged retries which do not publish another event.
            notice = self._retain_receipt_notice_locked(thread_id, item["id"])
        try:
            if changed:
                self._publish_receipt_notice(notice, finish=False)
            if item["status"] == "queued":
                self._start_follow_up(thread_id)
            return {"queueItem": self.queue.get(thread_id, item["id"])}
        finally:
            self._finish_receipt_notice(notice)

    def on_queue_list(self, params: dict | None) -> dict:
        return {"items": self.queue.list(_text(params, "threadId"))}

    def on_queue_remove(self, params: dict | None) -> dict:
        thread_id = _text(params, "threadId")
        with self.runtimes.lock:
            item = self.queue.transition(thread_id, _text(params, "queueId"), "cancelled")
        self.events.emit("queue/updated", {"threadId": thread_id, "queueId": item["id"]})
        return {"queueItem": item}

    def _start_follow_up(self, thread_id: str) -> None:
        while True:
            with self.runtimes.lock:
                if self.runtimes.closed or thread_id in self.runtimes.active:
                    return
                if thread_id in self._tool_persistence_fences:
                    return
                if thread_id in self._follow_up_dispatches:
                    # A fast turn can finish before its dispatcher returns.
                    # Hand the wakeup to that dispatcher without another claim.
                    self._follow_up_dispatches[thread_id]["again"] = True
                    return
                if self.sessions.get_thread(thread_id).get("archived"):
                    return
                item = self.queue.claim(thread_id, "followUp")
                if item is None:
                    return
                dispatch = {"owner": threading.get_ident(), "done": threading.Event(), "queueId": item["id"]}
                self._follow_up_dispatches[thread_id] = dispatch
            started = False
            try:
                self.on_turn_start({"threadId": thread_id, "input": item["input"],
                    "clientUserMessageId": item.get("clientUserMessageId") or "queue-" + item["id"]}, queue_item=item)
                started = True
            except Exception as error:
                # Reserved jobs settle and notify while retaining their own
                # ownership. Only pre-reservation admission failures get here.
                if dispatch.get("identity_reconciled"):
                    started = True
                elif not dispatch.get("start_failed"):
                    try:
                        with self.runtimes.lock:
                            if isinstance(error, RpcError) and isinstance(error.data, dict) and error.data.get("code") in {
                                    "CLIENT_REQUEST_CONFLICT", "CLIENT_REQUEST_AMBIGUOUS", "REQUEST_REQUIRES_REVIEW"}:
                                if self.queue.get(thread_id, item["id"])["status"] == "delivering":
                                    self.queue.transition(thread_id, item["id"], "paused")
                            else:
                                persisted = None
                                try:
                                    persisted = any(entry.get("kind") == "userMessage" and entry.get("queueId") == item["id"]
                                        for entry in self.sessions.read_items(thread_id))
                                except Exception:
                                    pass
                                self.queue._fail_start(thread_id, item["id"], input_persisted=persisted)
                        self.events.emit("queue/updated", {"threadId": thread_id, "queueId": item["id"]})
                    except Exception:
                        pass
            finally:
                with self.runtimes.lock:
                    self._follow_up_dispatches.pop(thread_id, None)
                    again = started and dispatch.get("again", False)
                    dispatch["done"].set()
                self._close_application_resources_if_idle()
            if not again:
                return

    def _fence_tool_persistence(self, thread_id: str) -> None:
        """Keep a session closed when dispatched tool outcome cannot be confirmed."""
        with self.runtimes.lock:
            self._tool_persistence_fences.add(thread_id)

    def on_shutdown(self, params: dict | None) -> dict:
        self.close()
        return {"stopped": True}

    def _claim_compaction_abort_locked(self, job: dict) -> TrackedAbort:
        job["cancel"].set()
        if "_shutdown_abort" not in job:
            job["_shutdown_abort"] = TrackedAbort(job["provider"],
                lambda job=job: self._compaction_abort_done(job), name="compaction-abort")
        return job["_shutdown_abort"]

    def _cancel_compaction_jobs(self) -> None:
        with self.runtimes.lock:
            for job in self._compaction_jobs.values():
                if job["status"] != "running" or "provider" not in job:
                    continue
                self._claim_compaction_abort_locked(job)

    def _request_compaction_aborts(self) -> None:
        with self.runtimes.lock:
            aborts = [job["_shutdown_abort"] for job in self._compaction_jobs.values() if "_shutdown_abort" in job]
        for abort in aborts:
            abort.start()

    def _wait_compaction_jobs(self, deadline: float) -> None:
        with self.runtimes.lock:
            workers = [job.get("worker") for job in self._compaction_jobs.values()]
            workers.extend(job["_shutdown_abort"].worker for job in self._compaction_jobs.values()
                           if "_shutdown_abort" in job)
        join_until(workers, deadline)

    def _stop_compaction_jobs(self, *, deadline: float | None = None) -> None:
        deadline = time.monotonic() + 2 if deadline is None else deadline
        self._cancel_compaction_jobs()
        self._request_compaction_aborts()
        self._wait_compaction_jobs(deadline)

    def close(self) -> None:
        deadline = time.monotonic() + 2
        with self.runtimes.lock:
            self._state = "stopped"
            self._shutdown_preparing += 1
            self.runtimes.cancel_all(interrupt=False)
            self._cancel_compaction_jobs()
        try:
            # Do not invert begin_login's connections -> runtime lock order.
            # Dispatch every cancel before any potentially blocking abort hook.
            self.connections.prepare_close()
            self.connections.request_stop_aborts()
            self._request_compaction_aborts()
            self.runtimes.request_stop_aborts()
        finally:
            with self.runtimes.lock:
                self._shutdown_preparing -= 1
        self.connections.wait_for_stop(deadline)
        self._wait_compaction_jobs(deadline)
        self.runtimes.wait_for_stop(deadline)
        with self.runtimes.lock:
            follow_up_workers = list(self._follow_up_workers.values())
            dispatches = list(self._follow_up_dispatches.values())
            dispatches.extend(self._receipt_notices.values())
        join_until(follow_up_workers, deadline)
        for dispatch in dispatches:
            if dispatch["owner"] != threading.get_ident():
                dispatch["done"].wait(max(0, deadline - time.monotonic()))
        if self.lifecycle_hooks.observes_events:
            try:
                self.events.emit("kernel/shutdown", {"state": "stopping"})
            except Exception:
                pass
        self.lifecycle_hooks.close(deadline)
        self._close_application_resources_if_idle(deadline)

    def serve_forever(self) -> None:
        try:
            self.server.serve_forever()
        finally:
            self.close()
