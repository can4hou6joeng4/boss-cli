"""Explicit, bounded connection checks; never return credentials or account data.

Checks run outside the RPC reader so stop/approval requests remain responsive.
Only a user-triggered model/platform check accesses the network. Results are
ephemeral observations of this process, never a claim about future calls.
An explicit ``bridge_factory=None`` disables the platform host capabilities,
independently of model access or the names of the selected tools. This follows
Pi d5b3de22d0e24a3e9c38a9410d3329b099717283 SDK's explicit composition boundary.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import re
import shlex
import threading
import time
import uuid
import weakref
from typing import Callable

from boss_harness.bridge_lifecycle import BridgeLifecycle
from boss_harness.hooks import LifecycleHooks
from boss_harness.models import ModelConfig, Provider, build_provider
from boss_harness.models.types import ModelRequest, UserMessage
from boss_harness.rpc import RpcError
from boss_harness.request_policy import ModelRequestRejected, check_model_request
from boss_harness.shutdown import join_until
from boss_harness.tools import BossCliTool, should_pause
from boss_harness.tools.boss_cli import PAUSE_CODES

PUBLIC_CHECK_CODES = PAUSE_CODES | {
    "CLI_ERROR", "CLI_CONTRACT_ERROR", "TOOL_TIMEOUT", "CANCELLED", "NETWORK_ERROR",
    "INVALID_PARAM", "NOT_SUPPORTED", "LOGIN_CREDENTIAL_EXTRACTION_FAILED", "CONNECTION_FAILED",
}
_PLATFORM_DISABLED = "当前工具组合未启用平台连接与登录"


def _disabled() -> dict:
    return {"state": "disabled", "code": "NOT_SUPPORTED", "summary": _PLATFORM_DISABLED}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class _ModelCheck:
    cancel: threading.Event
    provider: Provider | None = None
    worker_done: bool = False
    abort_started: bool = False
    abort_pending: bool = False
    abort_worker: threading.Thread | None = None


class ConnectionChecks:
    def __init__(self, config: ModelConfig, *, bridge_factory: Callable | None = BossCliTool,
                 provider_factory: Callable[[ModelConfig], Provider | None] = build_provider,
                 timeout: float = 25.0,
                 request_preparer: Callable[[ModelRequest], ModelRequest] | None = None,
                 request_budget: Callable[[ModelRequest], dict] | None = None,
                 lifecycle_hooks: LifecycleHooks | None = None,
                 browser_source_policy: str | None = None,
                 bridge_lifecycle: BridgeLifecycle | None = None) -> None:
        self.config, self.bridge_factory = config, bridge_factory
        self.provider_factory, self.timeout = provider_factory, timeout
        self.request_preparer = request_preparer
        self.request_budget, self.lifecycle_hooks = request_budget, lifecycle_hooks
        self.browser_source_policy = browser_source_policy
        self.bridge_lifecycle = bridge_lifecycle or BridgeLifecycle()
        self.lock = threading.RLock()
        self.active: dict[str, tuple[threading.Thread, threading.Event]] = {}
        self._model_check: _ModelCheck | None = None
        self.closed = False
        self.on_idle: Callable[[], None] | None = None
        self.login = {"state": "idle", "summary": "尚未开始扫码登录"}
        self.login_cancel: threading.Event | None = None
        real = config.provider in {"openai", "anthropic"}
        self.report = {
            "cli": {"state": "unchecked", "summary": "尚未检查本机 CLI 与登录态"},
            "model": {"state": "unchecked" if real else "disabled", "provider": config.provider,
                      "model": config.model, "summary": "已配置，尚未发送请求" if real else "当前为离线运行配置"},
            "platform": {"state": "unchecked", "summary": "尚未在线验证", "authState": "unknown"},
        }
        if browser_source_policy is not None:
            self.report["cli"]["browserSourcePolicy"] = browser_source_policy
            self.report["platform"]["browserSourcePolicy"] = browser_source_policy
        if bridge_factory is None:
            self.report["cli"].update(_disabled())
            self.report["platform"].update(_disabled())
            self.login = _disabled()

    def read(self) -> dict:
        with self.lock:
            report = deepcopy(self.report)
            if self.bridge_factory is None:
                report["cli"].update(_disabled())
                report["platform"].update(_disabled())
            return report

    def _require_platform(self) -> None:
        if self.bridge_factory is None:
            raise RpcError(-32006, _PLATFORM_DISABLED, {"code": "NOT_SUPPORTED"})

    def _new_bridge(self):
        if self.bridge_factory is None:
            raise RpcError(-32006, _PLATFORM_DISABLED, {"code": "NOT_SUPPORTED"})
        bridge = self.bridge_factory()
        try:
            weakref.ref(bridge)
        except TypeError:
            self.bridge_lifecycle.close(bridge)
            raise ValueError("工具桥实例必须支持独立身份跟踪") from None
        return bridge

    def _set(self, target: str, **values) -> None:
        with self.lock:
            self.report[target].update(values)

    def start(self, target: str) -> dict:
        if not isinstance(target, str) or target not in {"local", "model", "platform"}:
            raise ValueError("target 必须是 local、model 或 platform")
        key = "cli" if target == "local" else target
        with self.lock:
            if key != "model" and self.bridge_factory is None:
                return self.read()
            # Serialize CLI checks against each other; never fan out platform probes.
            busy = key in self.active or (key in {"cli", "platform"} and (
                any(k in self.active for k in ("cli", "platform", "login")) or self.login["state"] in {"waiting", "saving"}))
            if self.closed or busy or self.report[key]["state"] == "disabled":
                return self.read()
            self.report[key].pop("requestRejected", None)
            self._set(key, state="checking", summary="检查中…", code=None, checkedAt=None)
            cancel = threading.Event()
            try:
                worker = threading.Thread(target=self._run, args=(key, cancel), daemon=True, name=f"connection-{key}")
                self.active[key] = worker, cancel
                if key == "model":
                    self._model_check = _ModelCheck(cancel)
                worker.start()
            except Exception:
                self.active.pop(key, None)
                if key == "model":
                    self._model_check = None
                self._set(key, state="failed", code="CHECK_FAILED", summary="检查失败，请核对本机配置后重试", checkedAt=_now())
            return self.read()

    def _current_model_locked(self, job: _ModelCheck) -> bool:
        active = self.active.get("model")
        return self._model_check is job and active is not None and active[1] is job.cancel

    def _retire_model_locked(self, job: _ModelCheck) -> None:
        # Like Pi's activeRun/waitForIdle, ownership includes cancellation and
        # cleanup, not only the last streamed event. Never reuse during abort.
        if self._current_model_locked(job) and job.worker_done and not job.abort_pending:
            self.active.pop("model", None)
            self._model_check = None
            job.provider = None

    def _abort_model(self, job: _ModelCheck, provider: Provider) -> None:
        try:
            abort = getattr(provider, "request_abort", None)
            if callable(abort):
                abort()
        except Exception:
            pass
        finally:
            with self.lock:
                job.abort_pending = False
                self._retire_model_locked(job)
            self._notify_idle()

    def _notify_idle(self) -> None:
        if self.on_idle is not None:
            self.on_idle()

    def is_idle(self) -> bool:
        with self.lock:
            return not self.active

    def _request_model_abort_locked(self, job: _ModelCheck) -> None:
        if not self._current_model_locked(job) or job.provider is None or job.abort_started:
            return
        job.abort_started = job.abort_pending = True
        try:
            worker = threading.Thread(target=self._abort_model, args=(job, job.provider),
                                      daemon=True, name="connection-model-abort")
            job.abort_worker = worker
            worker.start()
        except Exception:
            # No synchronous fallback: a provider's abort may itself block.
            job.abort_started = job.abort_pending = False
            job.abort_worker = None

    def _expire_model(self, job: _ModelCheck) -> None:
        with self.lock:
            if (not self._current_model_locked(job) or job.cancel.is_set()
                    or self.report["model"]["state"] != "checking"):
                return
            job.cancel.set()
            self._set("model", state="failed", code="CHECK_TIMEOUT", summary="模型检查超时，请核对网络后重试", checkedAt=_now())
            self._request_model_abort_locked(job)

    @staticmethod
    def _error(result) -> dict:
        raw = (result.error or {}).get("code", "CONNECTION_FAILED")
        # Do not expose upstream messages/hints, which can contain account details.
        code = raw if isinstance(raw, str) and raw in PUBLIC_CHECK_CODES else "CONNECTION_FAILED"
        blocked = should_pause(result)
        summary = "平台要求恢复登录或处理验证；已停止访问，请在官方页面处理后手动重新检查" if blocked else "检查失败，请核对本机配置或网络后重试"
        return {"state": "blocked" if blocked else "failed", "code": code, "summary": summary}

    def read_login(self) -> dict:
        with self.lock:
            return _disabled() if self.bridge_factory is None else deepcopy(self.login)

    def begin_login(self) -> dict:
        """Host-only control: no credentials, browser access or network here."""
        with self.lock:
            self._require_platform()
            if self.closed:
                raise ValueError("连接服务已关闭")
            if self.login["state"] in {"waiting", "saving"}:
                return self.read_login()
            if any(k in self.active for k in ("cli", "platform", "login")):
                return {"state": "failed", "code": "CHECK_BUSY", "summary": "请等待当前平台检查结束后再登录"}
            bridge = self._new_bridge()
            try:
                available = bridge.available()
            finally:
                self.bridge_lifecycle.close(bridge)
            if not available:
                return {"state": "failed", "code": "CLI_UNAVAILABLE", "summary": "上游 CLI 不可用，请先检查本机连接"}
            self.login_cancel = threading.Event()
            self.login = {"id": uuid.uuid4().hex, "state": "waiting", "summary": "请在下方选择你已有的账号身份并扫码，完成官方页面提示后自动连接"}
            return self.read_login()

    def cancel_login(self, attempt: str) -> dict:
        with self.lock:
            self._require_platform()
            if attempt == self.login.get("id") and self.login["state"] in {"waiting", "saving"}:
                saving = self.login["state"] == "saving"
                if self.login_cancel:
                    self.login_cancel.set()
                self.login.update(state="cancelled", summary="保存已停止，登录态可能已更新，请手动检查" if saving else "已取消扫码登录")
                if saving:
                    self._set("platform", state="unchecked", code=None, checkedAt=None,
                              summary="登录保存已取消，请手动核对登录态")
            return self.read_login()

    def complete_login(self, params: dict) -> dict:
        """Only Electron's trusted host supplies official-origin cookies.

        The model and renderer allowlists do not expose this method. The payload
        is never persisted, emitted as an event, or included in an exception.
        Upstream validates once before replacing its encrypted session.
        """
        self._require_platform()
        cookies, user_agent = params.get("cookies"), params.get("userAgent")
        if (not isinstance(cookies, dict) or not 1 <= len(cookies) <= 200
                or not isinstance(user_agent, str) or len(user_agent) > 512
                or any(ord(c) < 32 or ord(c) == 127 for c in user_agent)
                or any(not isinstance(k, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", k)
                       or not isinstance(v, str) or any(ord(c) < 32 or ord(c) == 127 or c == ";" for c in v)
                       for k, v in cookies.items())
                or not cookies.get("wt2")):
            raise ValueError("官方登录态格式无效")
        cookie_header = "; ".join(f"{k}={v}" for k, v in cookies.items())
        if len(cookie_header.encode("utf-8")) > 64 * 1024:
            raise ValueError("官方登录态超过大小限制")
        # This is parsed as data by the upstream; no shell or curl is executed.
        payload = "curl https://www.zhipin.com/ --cookie " + shlex.quote(cookie_header) + " --user-agent " + shlex.quote(user_agent)
        with self.lock:
            if self.closed or params.get("id") != self.login.get("id") or self.login["state"] != "waiting":
                raise ValueError("扫码登录已结束，请重新打开官方登录窗口")
            cancel = self.login_cancel
            assert cancel is not None
            self.login.update(state="saving", summary="已检测到扫码登录，正在通过上游验证并保存…")
            self._set("platform", state="checking", code=None, checkedAt=None, summary="正在验证新的官方登录态…")
            worker = threading.Thread(target=self._save_login, args=(payload, cancel), daemon=True, name="platform-login")
            self.active["login"] = worker, cancel
            worker.start()
            return self.read_login()

    def _save_login(self, payload: str, cancel: threading.Event) -> None:
        bridge = None
        try:
            if self.bridge_factory is None:
                return
            bridge = self._new_bridge()
            bridge.cancel_event = cancel
            result = bridge.call("login", "--curl-file", "-", stdin=payload, timeout=20)
            payload = ""
            if cancel.is_set():
                return
            outcome = {"state": "ready", "code": None, "summary": "官方账号验证通过，登录态已保存；可用功能取决于账号身份"} if result.ok else self._error(result)
            if result.ok:
                # This second call is local-only. Never silently replay a live probe.
                local = bridge.call("status", timeout=15)
                data = local.data if local.ok and isinstance(local.data, dict) else {}
                auth = data.get("auth_state")
                auth = auth if auth in {"complete", "partial", "broken", "missing"} else "unknown"
                if not local.ok or data.get("logged_in") is not True or auth in {"broken", "missing"}:
                    outcome = {"state": "failed", "code": "LOGIN_READBACK_FAILED", "summary": "登录保存后未能读取本地状态，请检查本机连接"}
                elif auth != "complete":
                    outcome = {"state": "unchecked", "code": "LOGIN_INCOMPLETE", "summary": "登录已保存，但认证信息仍不完整；请在官方页面完成剩余提示后重新登录"}
                outcome["authState"] = auth
            with self.lock:
                if not cancel.is_set():
                    self._set("platform", **outcome, checkedAt=_now())
                    self.login.update(state="succeeded" if outcome["state"] == "ready" else "failed" if outcome["state"] == "unchecked" else outcome["state"],
                                      code=outcome.get("code"), summary=outcome["summary"])
        except Exception:
            with self.lock:
                if not cancel.is_set():
                    self.login.update(state="failed", code="LOGIN_SAVE_FAILED", summary="保存登录态失败，请检查上游 CLI 与网络")
                    self._set("platform", state="failed", code="LOGIN_SAVE_FAILED", summary=self.login["summary"], checkedAt=_now())
        finally:
            if bridge is not None:
                self.bridge_lifecycle.close(bridge)
            with self.lock:
                self.active.pop("login", None)
            self._notify_idle()

    def _local_auth(self, bridge) -> bool:
        if self.bridge_factory is None:
            self._set("platform", **_disabled())
            return False
        result = bridge.call("status", timeout=15)
        if not result.ok:
            self._set("platform", **self._error(result), authState="unknown", checkedAt=_now())
            return False
        data = result.data if isinstance(result.data, dict) else {}
        auth = data.get("auth_state")
        auth = auth if auth in {"complete", "partial", "broken", "missing"} else "unknown"
        self._set("platform", authState=auth)
        risk = data.get("cdp_risk_lock") or {}
        if isinstance(risk, dict) and (risk.get("locked") or risk.get("group_locked")):
            self._set("platform", state="blocked", code="ENVIRONMENT_RISK_LOCKED",
                      summary="本地存在平台风控锁；已停止在线检查，请在官方页面处理", checkedAt=_now())
            return False
        if data.get("logged_in") is not True or auth == "broken":
            self._set("platform", state="blocked", code="AUTH_REQUIRED", summary="本地登录态不可用，请先完成 boss login", checkedAt=_now())
            return False
        return True

    def _run(self, key: str, cancel: threading.Event) -> None:
        provider = None
        bridge = None
        timer = None
        stream = None
        job = None
        try:
            if key != "model" and self.bridge_factory is None:
                self._set(key, **_disabled())
                return
            if key == "model":
                with self.lock:
                    current = self._model_check
                    if current is None or current.cancel is not cancel:
                        return
                    job = current
                    if cancel.is_set():
                        return
                timer = threading.Timer(self.timeout, self._expire_model, args=(job,))
                timer.daemon = True
                timer.start()
                config = replace(self.config, max_tokens=512, effort="low", thinking=None)
                request = ModelRequest(model=config.model, system="Connection check. Reply OK only.",
                    messages=(UserMessage("Reply OK."),), max_tokens=512, effort=config.effort)
                if self.request_preparer is not None:
                    request = self.request_preparer(request)
                if cancel.is_set():
                    return
                budget = self.request_budget(request) if self.request_budget is not None else {}
                check_model_request(self.lifecycle_hooks, config, request, budget,
                    purpose="connection_check", request_index=0, cancel_event=cancel)
                if cancel.is_set():
                    return
                provider = self.provider_factory(replace(config, max_tokens=request.max_tokens))
                if provider is None:
                    raise ValueError("no provider")
                with self.lock:
                    if not self._current_model_locked(job) or self.closed or cancel.is_set():
                        return
                    job.provider = provider
                success = False
                if cancel.is_set():
                    return
                stream = provider.stream(request)
                while not cancel.is_set():
                    try:
                        event = next(stream)
                    except StopIteration:
                        break
                    if cancel.is_set():
                        return
                    if event.type == "error":
                        break
                    if event.type == "done" and event.message:
                        message = event.message
                        success = message.stop_reason == "stop" and bool(message.text().strip()) and not message.tool_calls()
                        break
                outcome = {"state": "ready", "summary": "真实模型已完成一次小请求"} if success else {
                    "state": "failed", "code": "MODEL_CHECK_FAILED", "summary": "模型未完成有效响应，请核对供应商、模型与网络"}
            else:
                bridge = self._new_bridge()
                bridge.cancel_event = cancel
                if not bridge.available():
                    outcome = {"state": "failed", "code": "CLI_UNAVAILABLE", "summary": "上游 CLI 不可执行，请检查 BOSS_CLI_BIN"}
                elif key == "cli":
                    # A local schema check validates the seven-key process contract.
                    result = bridge.call("schema", "--format", "mcp-tools", timeout=15)
                    outcome = {"state": "ready", "summary": "CLI 可执行，v1 JSON 契约有效", "binarySource": bridge.source} if result.ok else self._error(result)
                    if result.ok:
                        self._local_auth(bridge)
                elif self._local_auth(bridge):
                    result = bridge.call("status", "--live", timeout=20)
                    outcome = {"state": "ready", "summary": "已完成一次平台只读在线验证"} if result.ok else self._error(result)
                else:
                    return
            with self.lock:
                active = self.active.get(key)
                if active is not None and active[1] is cancel and not cancel.is_set():
                    self._set(key, **outcome, checkedAt=_now())
        except ModelRequestRejected as exc:
            with self.lock:
                active = self.active.get(key)
                if active is not None and active[1] is cancel and not cancel.is_set():
                    self._set(key, state="failed", code=exc.code, summary=str(exc),
                              requestRejected=True, checkedAt=_now())
        except Exception:
            with self.lock:
                active = self.active.get(key)
                if active is not None and active[1] is cancel and not cancel.is_set():
                    self._set(key, state="failed", code="CHECK_FAILED", summary="检查失败，请核对本机配置后重试", checkedAt=_now())
        finally:
            if timer:
                timer.cancel()
            try:
                if stream is not None:
                    close = getattr(stream, "close", None)
                    if callable(close):
                        close()
            except Exception:
                pass
            finally:
                try:
                    if bridge is not None:
                        self.bridge_lifecycle.close(bridge)
                finally:
                    with self.lock:
                        if job is not None:
                            job.worker_done = True
                            self._retire_model_locked(job)
                        else:
                            active = self.active.get(key)
                            if active is not None and active[1] is cancel:
                                self.active.pop(key, None)
                    self._notify_idle()

    def prepare_close(self) -> None:
        with self.lock:
            self.closed = True
            if self.login_cancel:
                self.login_cancel.set()
            for _, cancel in self.active.values():
                cancel.set()
            job = self._model_check
            if job is not None and self._current_model_locked(job):
                if self.report["model"]["state"] == "checking":
                    self._set("model", state="failed", code="CANCELLED", summary="模型检查已停止", checkedAt=_now())

    def request_stop_aborts(self) -> None:
        with self.lock:
            job = self._model_check
            if job is not None:
                self._request_model_abort_locked(job)

    def wait_for_stop(self, deadline: float) -> None:
        with self.lock:
            job = self._model_check
            workers = [worker for worker, _ in self.active.values()]
            if job is not None and job.abort_worker is not None:
                workers.append(job.abort_worker)
        # Let cancellation retire model streams and CLI process groups before
        # host exit. Non-cooperative providers retain their ownership record.
        # Never join while holding the lock needed by worker finalization.
        join_until(workers, deadline)

    def close(self, *, deadline: float | None = None) -> None:
        deadline = time.monotonic() + 2 if deadline is None else deadline
        self.prepare_close()
        self.request_stop_aborts()
        self.wait_for_stop(deadline)
