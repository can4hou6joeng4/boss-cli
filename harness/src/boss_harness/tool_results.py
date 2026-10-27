"""Bounded transport projections and content-addressed reads of durable results.

Pi reference: 5ba1cbaf3d96d204d847c84ce235c62dae23e0fd, coding-agent rpc.md,
session-format.md, SessionManager and agent-loop toolResult messages. Adopt the
separation of canonical messages, model context and RPC presentation. Chunked
result references are this project's independent transport contract, not Pi RPC.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from typing import Any

from boss_harness.item_content import project_item_content
from boss_harness.models.types import (
    DEFAULT_MODEL_TOOL_RESULT_BYTES, MAX_MODEL_TOOL_RESULT_BYTES, MIN_MODEL_TOOL_RESULT_BYTES,
)
from boss_harness.rpc import RpcError

MAX_INLINE_TOOL_RESULT_BYTES = 64 * 1024
MAX_PAGE_BYTES = 1024 * 1024
DEFAULT_RESULT_CHARS = 16_384
MAX_RESULT_CHARS = 32_768
MODEL_RESULT_READ_CHARS = 8_192


def result_text(result: Any) -> str:
    """Stable JSON spelling; character offsets are Unicode code points, not bytes."""
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def result_reference(thread_id: str, item_id: str, text: str) -> dict:
    encoded = text.encode("utf-8")
    return {"threadId": thread_id, "itemId": item_id, "encoding": "json",
            "sha256": hashlib.sha256(encoded).hexdigest(), "byteLength": len(encoded),
            "characterLength": len(text)}


def model_result_content(result: dict, item_id: str | None, *, source: dict | None,
                         max_bytes: int, preview: str) -> str:
    """Keep small results structured; replace oversized model payloads with a verifiable reference."""
    if (type(max_bytes) is not int
            or not MIN_MODEL_TOOL_RESULT_BYTES <= max_bytes <= MAX_MODEL_TOOL_RESULT_BYTES):
        max_bytes = DEFAULT_MODEL_TOOL_RESULT_BYTES
    payload = {**result, **({"source": source} if source is not None else {})}
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode("utf-8")) <= max_bytes:
        return encoded

    projected: dict[str, Any] = {
        "ok": result.get("ok"),
        "command": result.get("command"),
        "resultOmitted": True,
    }
    if source is not None:
        projected["source"] = source
    if item_id is not None:
        text = result_text(result)
        reference = result_reference("", item_id, text)
        projected["resultRef"] = {key: reference[key] for key in
                                  ("itemId", "sha256", "byteLength", "characterLength")}
    else:
        projected["resultUnavailable"] = True

    preview = preview if isinstance(preview, str) else ""
    keep = min(len(preview), max_bytes // 2)
    while True:
        if keep:
            projected["resultPreview"] = preview[:keep]
        candidate = json.dumps(projected, ensure_ascii=False, allow_nan=False)
        try:
            if len(candidate.encode("utf-8")) <= max_bytes:
                return candidate
        except UnicodeEncodeError:
            pass
        projected.pop("resultPreview", None)
        if keep <= 1:
            return json.dumps(projected, ensure_ascii=True, allow_nan=False)
        keep //= 2


def model_result_for_item(item: dict) -> str:
    """Bound legacy history projections without changing their durable source records."""
    limit = item.get("modelResultLimitBytes", DEFAULT_MODEL_TOOL_RESULT_BYTES)
    if type(limit) is not int or not MIN_MODEL_TOOL_RESULT_BYTES <= limit <= MAX_MODEL_TOOL_RESULT_BYTES:
        limit = DEFAULT_MODEL_TOOL_RESULT_BYTES
    existing = item.get("modelResult")
    if isinstance(existing, str):
        try:
            if len(existing.encode("utf-8")) <= limit:
                return existing
        except UnicodeEncodeError:
            pass
    result = item.get("result")
    if isinstance(result, dict) and isinstance(item.get("id"), str):
        return model_result_content(result, item["id"], source=item.get("source"), max_bytes=limit,
                                    preview=item.get("resultSummary", ""))
    return model_result_content({}, None, source=None, max_bytes=limit,
                                preview=item.get("resultSummary") or existing or "")


def project_error(error: dict | None) -> dict | None:
    """An error preview must not reintroduce an omitted result's large body."""
    if error is None or wire_size(error) <= 4096:
        return error
    preview = {key: str(error.get(key) or "")[:maximum]
               for key, maximum in (("code", 128), ("message", 2000), ("recovery_action", 1000))}
    return {**preview, "detailsOmitted": True}


def project_item(thread_id: str, item: dict, *, snapshot_id: str | None = None) -> dict:
    """Never mutate durable/model history while preparing renderer-facing items."""
    projected = {key: value for key, value in item.items()
                 if key not in {"modelResult", "modelResultLimitBytes", "resultOmitted", "resultRef"}}
    projected = project_item_content(thread_id, projected, snapshot_id=snapshot_id)
    result = item.get("result")
    if isinstance(result, dict):
        text = result_text(result)
        if len(text.encode("utf-8")) > MAX_INLINE_TOOL_RESULT_BYTES:
            projected.pop("result", None)
            projected.update(resultOmitted=True, resultRef=result_reference(thread_id, str(item["id"]), text))
            for key, maximum in (("errorCode", 128), ("recoveryAction", 1000), ("resultSummary", 4000)):
                if key in projected:
                    projected[key] = str(projected[key])[:maximum] if projected[key] is not None else None
    return projected


def wire_size(value: Any) -> int:
    """Match the transport JSON spelling, leaving room for response ID and framing."""
    return len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")) + 512


def _cursor(reference: dict, offset: int) -> str:
    data = [reference["threadId"], reference["itemId"], reference["sha256"], offset]
    return "tr1_" + base64.urlsafe_b64encode(result_text(data).encode("utf-8")).decode().rstrip("=")


def read_result_chunk(thread_id: str, item: dict, *, sha256: str, cursor: str | None = None,
                      limit: int = DEFAULT_RESULT_CHARS) -> dict:
    if type(limit) is not int or not 1 <= limit <= MAX_RESULT_CHARS:
        raise ValueError(f"limit 必须是 1 到 {MAX_RESULT_CHARS} 的整数")
    if item.get("kind") != "toolCall" or not isinstance(item.get("result"), dict):
        raise ValueError("该条目没有可读取的完整工具结果")
    if not isinstance(sha256, str) or re.fullmatch(r"[a-f0-9]{64}", sha256) is None:
        raise ValueError("sha256 必须是结果引用中的 64 位小写十六进制摘要")
    text = result_text(item["result"])
    reference = result_reference(thread_id, str(item["id"]), text)
    if sha256 != reference["sha256"]:
        raise RpcError(-32011, "工具结果已变化，请重新读取条目并确认新结果引用", {"code": "STALE_RESULT"})
    return read_result_text_chunk(thread_id, str(item["id"]), text, sha256=sha256,
                                  cursor=cursor, limit=limit)


def read_result_text_chunk(thread_id: str, item_id: str, text: str, *, sha256: str,
                           cursor: str | None = None, limit: int = DEFAULT_RESULT_CHARS) -> dict:
    if type(limit) is not int or not 1 <= limit <= MAX_RESULT_CHARS:
        raise ValueError(f"limit 必须是 1 到 {MAX_RESULT_CHARS} 的整数")
    reference = result_reference(thread_id, item_id, text)
    if not isinstance(sha256, str) or sha256 != reference["sha256"]:
        raise RpcError(-32011, "工具结果已变化，请重新读取条目并确认新结果引用", {"code": "STALE_RESULT"})
    offset = 0
    if cursor is not None:
        try:
            if not isinstance(cursor, str) or not cursor.startswith("tr1_") or len(cursor) > 2048:
                raise ValueError()
            encoded = cursor[4:]
            value = json.loads(base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True))
            if (not isinstance(value, list) or len(value) != 4
                    or value[:3] != [thread_id, item_id, reference["sha256"]]
                    or type(value[3]) is not int or not 0 <= value[3] < len(text)):
                raise ValueError()
            offset = value[3]
        except (ValueError, TypeError, UnicodeDecodeError, binascii.Error):
            raise ValueError("工具结果游标无效、归属不匹配或结果已变化") from None
    end = min(offset + limit, len(text))
    return {"text": text[offset:end], "offset": offset, "resultRef": reference,
            "nextCursor": _cursor(reference, end) if end < len(text) else None}
