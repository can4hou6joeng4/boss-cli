"""JSON-RPC 2.0 的读写与分发。

帧格式与外壳侧 packages/app-client 严格对应：每行一个 JSON 对象。
stdout 只走协议，日志一律走 stderr。

回合跑在工作线程里（这样主循环才读得到 `turn/interrupt`），因此写 stdout 必须上锁：
两个线程各写半行的话，外壳会收到解析不了的碎帧。
"""
from __future__ import annotations

import json
import sys
import threading
from typing import Any, Callable

from boss_harness.models.secret import redact_secrets

Handler = Callable[[dict[str, Any] | None], Any]


class JsonRpcServer:
    def __init__(self) -> None:
        self._methods: dict[str, Handler] = {}
        self._out = sys.stdout
        self._write_lock = threading.Lock()

    def register(self, method: str, handler: Handler) -> None:
        self._methods[method] = handler

    # ---------- 发送 ----------

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        frame: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            frame["params"] = params
        self._write(frame)

    def respond(self, request_id: Any, result: Any) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def respond_error(self, request_id: Any, code: int, message: str, data: Any = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._write({"jsonrpc": "2.0", "id": request_id, "error": error})

    def _write(self, frame: dict[str, Any]) -> None:
        with self._write_lock:
            self._out.write(json.dumps(frame, ensure_ascii=False) + "\n")
            self._out.flush()

    # ---------- 接收 ----------

    def serve_forever(self) -> None:
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self.respond_error(None, -32700, "无效的 JSON 帧")
                continue
            self._dispatch(message)

    def _dispatch(self, message: Any) -> None:
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            self.respond_error(None, -32600, "无效的 JSON-RPC 请求")
            return
        method = message.get("method")
        if not isinstance(method, str):
            self.respond_error(message.get("id"), -32600, "请求缺少 method")
            return
        handler = self._methods.get(method)
        request_id = message.get("id")
        if "id" in message and (type(request_id) not in (str, int) and request_id is not None):
            self.respond_error(None, -32600, "请求 id 无效")
            return
        if message.get("params") is not None and not isinstance(message["params"], dict):
            if "id" in message:
                self.respond_error(request_id, -32602, "params 必须是对象")
            return
        if request_id is not None:
            print(f"[harness] <- {method}", file=sys.stderr)
        if handler is None:
            if request_id is not None:
                self.respond_error(request_id, -32601, f"method not found: {method}")
            return
        try:
            result = handler(message.get("params"))
        except Exception as exc:  # noqa: BLE001 - 内核不因单次调用崩溃
            safe_message = redact_secrets(str(exc))
            print(f"[harness] handler error in {method}: {safe_message}", file=sys.stderr)
            if request_id is not None:
                self.respond_error(request_id, -32602 if isinstance(exc, ValueError) else -32603, safe_message)
            return
        if request_id is not None:
            self.respond(request_id, result)
