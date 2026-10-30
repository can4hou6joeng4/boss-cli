"""Bidirectional JSON-RPC transport; services own authorization and state.

Only LF terminates a frame. stdout carries protocol frames, never target content
or diagnostics. Server requests are correlated independently of client requests.
"""
from __future__ import annotations

from concurrent.futures import Future
from dataclasses import dataclass
import json
import math
import sys
import threading
import uuid
from typing import Any, Callable

from boss_harness.models.secret import redact_secrets

Handler = Callable[[dict[str, Any] | None], Any]
MAX_FRAME_BYTES = 8 * 1024 * 1024
MAX_JSON_DEPTH = 64


def _reject_json_constant(_: str) -> None:
    raise ValueError("JSON 数值必须有限")


def _finite_json_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("JSON 数值必须有限")
    return parsed


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON 对象包含重复键")
        result[key] = value
    return result


def _validate_json_value(value: Any, *, depth: int = 0) -> None:
    if depth > MAX_JSON_DEPTH:
        raise ValueError("JSON 嵌套层级超过限制")
    if isinstance(value, str):
        if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
            raise ValueError("JSON 字符串包含无效 Unicode 代理项")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            _validate_json_value(key, depth=depth + 1)
            _validate_json_value(item, depth=depth + 1)
        return
    if isinstance(value, list):
        for item in value:
            _validate_json_value(item, depth=depth + 1)


def _decode_json_frame(raw: str) -> Any:
    try:
        value = json.loads(raw, object_pairs_hook=_unique_json_object,
                           parse_constant=_reject_json_constant,
                           parse_float=_finite_json_float)
        _validate_json_value(value)
        return value
    except (json.JSONDecodeError, ValueError, RecursionError):
        raise ValueError("无效的 JSON 帧") from None


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code, self.data = code, data


class FrameTooLargeError(ValueError):
    """Raised before writing any bytes; callers may send a bounded error once."""


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
        try:
            timer.start()
        except Exception:
            # The request is already visible to the client, but an approval
            # without a working deadline must fail closed and leave no waiter.
            self.cancel_request(request_id, TimeoutError("客户端请求计时器未能启动"))
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

    def _respond_too_large(self, request_id: Any) -> None:
        message = "响应超过协议帧限制，请使用分页或结果分块读取"
        data = {"code": "RESPONSE_TOO_LARGE"}
        try:
            self.respond_error(request_id, -32010, message, data)
        except FrameTooLargeError:
            # An unusually long client ID can itself fill a frame. No bytes have
            # been sent, so the bounded protocol error must omit that invalid ID.
            self.respond_error(None, -32010, message, data)

    def _respond_invalid(self, request_id: Any) -> None:
        message = "处理结果无法编码为有效的 JSON-RPC 响应"
        data = {"code": "RESPONSE_INVALID"}
        try:
            self.respond_error(request_id, -32603, message, data)
        except (FrameTooLargeError, UnicodeEncodeError):
            try:
                self.respond_error(None, -32603, message, data)
            except (FrameTooLargeError, UnicodeEncodeError):
                pass

    def _write(self, frame: dict[str, Any]) -> None:
        encoded = json.dumps(frame, ensure_ascii=False, allow_nan=False) + "\n"
        if len(encoded.encode("utf-8")) > MAX_FRAME_BYTES:
            raise FrameTooLargeError("协议帧超过大小限制")
        with self._write_lock:
            if self._closed:
                raise ConnectionError("连接已关闭")
            self._out.write(encoded)
            self._out.flush()

    def serve_forever(self) -> None:
        try:
            while True:
                raw = sys.stdin.readline(MAX_FRAME_BYTES + 1)
                if not raw:
                    break
                try:
                    encoded = raw.encode("utf-8")
                except UnicodeEncodeError:
                    self.respond_error(None, -32700, "无效的 JSON 帧")
                    continue
                if len(encoded) > MAX_FRAME_BYTES or not raw.endswith("\n"):
                    self.respond_error(None, -32600, "协议帧过大或缺少 LF 终止符")
                    break
                if not raw.strip():
                    continue
                try:
                    message = _decode_json_frame(raw)
                except ValueError:
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
                try:
                    self.respond_error(request_id, code, safe_message, exc.data if isinstance(exc, RpcError) else None)
                except FrameTooLargeError:
                    self._respond_too_large(request_id)
            return
        if has_id:
            try:
                self.respond(request_id, result)
            except FrameTooLargeError:
                # Encoding failed before stdout was touched. Never rerun the
                # handler: it may already have performed a consequential action.
                self._respond_too_large(request_id)
            except (RecursionError, UnicodeEncodeError, ValueError):
                # The handler has already run; return a bounded error without
                # retrying it when its result cannot be encoded as JSON.
                self._respond_invalid(request_id)
