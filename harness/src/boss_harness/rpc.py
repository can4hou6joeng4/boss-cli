"""Bidirectional JSON-RPC transport; services own authorization and state.

Only LF terminates a frame. stdout carries protocol frames, never target content
or diagnostics. Server requests are correlated independently of client requests.
"""
from __future__ import annotations

from concurrent.futures import Future
from dataclasses import dataclass
import json
import sys
import threading
import uuid
from typing import Any, Callable

from boss_harness.models.secret import redact_secrets

Handler = Callable[[dict[str, Any] | None], Any]
MAX_FRAME_BYTES = 8 * 1024 * 1024


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code, self.data = code, data


@dataclass(frozen=True)
class ServerRequest:
    id: str
    future: Future


class JsonRpcServer:
    def __init__(self) -> None:
        self._methods: dict[str, Handler] = {}
        self._out = sys.stdout
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: dict[str, tuple[Future, threading.Timer]] = {}
        self._closed = False
        self.opt_out_notifications: frozenset[str] = frozenset()
        self.before_dispatch: Callable[[str], None] | None = None

    def register(self, method: str, handler: Handler) -> None:
        self._methods[method] = handler

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        if method in self.opt_out_notifications:
            return
        frame: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            frame["params"] = params
        self._write(frame)

    def request(self, method: str, params: dict[str, Any], *, timeout: float = 300) -> ServerRequest:
        request_id = "server-" + uuid.uuid4().hex
        future: Future = Future()

        def expire() -> None:
            self.cancel_request(request_id, TimeoutError("客户端请求已过期"))

        timer = threading.Timer(timeout, expire)
        timer.daemon = True
        with self._pending_lock:
            if self._closed:
                raise ConnectionError("连接已关闭")
            self._pending[request_id] = (future, timer)
        try:
            self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        except Exception as exc:
            self.cancel_request(request_id, exc)
            raise
        timer.start()
        return ServerRequest(request_id, future)

    def cancel_request(self, request_id: str, error: Exception | None = None) -> bool:
        with self._pending_lock:
            pending = self._pending.pop(request_id, None)
        if pending is None:
            return False
        future, timer = pending
        timer.cancel()
        if not future.done():
            future.set_exception(error or ConnectionError("请求已取消"))
        return True

    def close(self) -> None:
        with self._pending_lock:
            self._closed = True
            ids = tuple(self._pending)
        for request_id in ids:
            self.cancel_request(request_id, ConnectionError("客户端连接已断开"))

    def respond(self, request_id: Any, result: Any) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def respond_error(self, request_id: Any, code: int, message: str, data: Any = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._write({"jsonrpc": "2.0", "id": request_id, "error": error})

    def _write(self, frame: dict[str, Any]) -> None:
        encoded = json.dumps(frame, ensure_ascii=False, allow_nan=False) + "\n"
        if len(encoded.encode("utf-8")) > MAX_FRAME_BYTES:
            raise ValueError("协议帧超过大小限制")
        with self._write_lock:
            if self._closed:
                raise ConnectionError("连接已关闭")
            self._out.write(encoded)
            self._out.flush()

    def serve_forever(self) -> None:
        def reject_constant(value: str) -> None:
            raise ValueError("非有限JSON数值")
        try:
            while True:
                raw = sys.stdin.readline(MAX_FRAME_BYTES + 1)
                if not raw:
                    break
                if len(raw.encode("utf-8")) > MAX_FRAME_BYTES or not raw.endswith("\n"):
                    self.respond_error(None, -32600, "协议帧过大或缺少 LF 终止符")
                    break
                if not raw.strip():
                    continue
                try:
                    message = json.loads(raw, parse_constant=reject_constant)
                except (json.JSONDecodeError, ValueError):
                    self.respond_error(None, -32700, "无效的 JSON 帧")
                    continue
                self._dispatch(message)
        finally:
            self.close()

    def _receive_response(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        if not isinstance(request_id, str) or ("result" in message) == ("error" in message):
            return
        with self._pending_lock:
            pending = self._pending.pop(request_id, None)
        if pending is None:
            return
        future, timer = pending
        timer.cancel()
        if future.done():
            return
        if "error" in message:
            future.set_exception(RpcError(-32001, "客户端未完成请求", message["error"]))
        else:
            future.set_result(message["result"])

    def _dispatch(self, message: Any) -> None:
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            self.respond_error(None, -32600, "无效的 JSON-RPC 请求")
            return
        if "method" not in message and "id" in message:
            self._receive_response(message)
            return
        method = message.get("method")
        has_id = "id" in message
        request_id = message.get("id")
        if not isinstance(method, str) or (has_id and type(request_id) not in (str, int)):
            self.respond_error(None, -32600, "请求 method 或 id 无效")
            return
        if message.get("params") is not None and not isinstance(message["params"], dict):
            if has_id:
                self.respond_error(request_id, -32602, "params 必须是对象")
            return
        handler = self._methods.get(method)
        try:
            if self.before_dispatch is not None:
                self.before_dispatch(method)
            if handler is None:
                raise RpcError(-32601, "未知方法")
            result = handler(message.get("params"))
        except Exception as exc:
            safe_message = redact_secrets(str(exc))
            print(f"[harness] {method}: {safe_message}", file=sys.stderr)
            if has_id:
                code = exc.code if isinstance(exc, RpcError) else (-32602 if isinstance(exc, ValueError) else -32603)
                self.respond_error(request_id, code, safe_message, exc.data if isinstance(exc, RpcError) else None)
            return
        if has_id:
            self.respond(request_id, result)
