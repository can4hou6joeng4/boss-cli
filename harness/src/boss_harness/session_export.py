"""会话只读导出（复盘与问题报告）。

职责参考 Pi MIT 固定提交 a14cdf90f0a76532f3e20bc3c01872837cef24ba 的
packages/coding-agent/src/core/session-export.ts（按当前分支序列化会话）与
export-html/（完整条目 + leaf 渲染为可阅读文档）。本模块独立实现，不复制 Pi 源码：

- 只读取已持久的会话条目，不写会话、不调用模型或工具、不发事件；
- 输出 Markdown 或 JSON 文本，由外壳主进程经保存对话框写盘，内核不触碰导出目标路径；
- 默认脱敏：凭据、令牌、环境变量、本机绝对路径与附件内容一律不导出；工具结果只保留
  结构与执行状态，候选人个人信息（姓名、手机号、邮箱、微信、简历正文等）在全文中打码；
  调用方显式传入 ``includeToolResults`` 才导出工具参数与结果明文（凭据与路径仍脱敏）；
- 区分用户输入、模型输出（模型判断）、工具调用（平台事实来源）与模型生成的摘要；
- 输出有字节上限，超限按条目截断并在文末标注。
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from boss_harness.context import tool_execution_status
from boss_harness.models.secret import redact_secrets
from boss_harness.session import BRANCH_SUMMARY_ENTRY_TYPE, MAX_BRANCH_SUMMARY_CHARS, SessionStore
from boss_harness.usage import SOURCE as USAGE_SOURCE, summarize_usage

EXPORT_FORMATS = ("markdown", "json")
DEFAULT_EXPORT_BYTES = 512 * 1024
MIN_EXPORT_BYTES = 64 * 1024
# 响应须低于传输单页上限（1 MiB，JSON 字符串转义会放大）。
MAX_EXPORT_BYTES = 768 * 1024
MAX_TEXT_CHARS = 16_000
MAX_RESULT_CHARS = 16_000
MAX_PII_VALUES = 4_000
EXPORT_SCHEMA = "boss-cli-session-export/1"

SECRET_MARK = "[已脱敏:凭据]"
ENV_MARK = "[已脱敏:环境变量]"
PATH_MARK = "[已脱敏:本机路径]"
PII_MARK = "[已打码:候选人信息]"
OMITTED = "[已省略]"

# 只读招聘工具的检索条件；其余参数（候选人 / 职位标识、招呼文本等）默认省略。
_SAFE_ARGUMENTS = frozenset({"keyword", "query", "page", "city", "salary", "experience", "education", "action"})
# 工具结果中视为候选人个人信息的字段（归一化：小写、去掉 _ - 空格）。
_PII_KEYS = frozenset({
    "name", "geekname", "realname", "candidatename", "fullname", "nickname", "username", "姓名", "名字",
    "phone", "mobile", "tel", "telephone", "phonenumber", "mobilephone", "手机", "手机号", "电话",
    "email", "mail", "emailaddress", "邮箱", "wechat", "weixin", "wx", "wechatid", "weixinid", "微信",
    "微信号", "resume", "resumetext", "resumecontent", "简历", "简历正文", "idcard", "身份证", "address",
    "地址", "住址", "contact", "联系方式",
})
_PII_PATTERNS = (
    re.compile(r"[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+"),
    re.compile(r"(?<!\d)(?:\+?86[ -]?)?1[3-9]\d(?:[ -]?\d{4}){2}(?!\d)"),
    re.compile(r"(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])"),
    re.compile(r"(?i)(微信号?|wechat|weixin|vx|wx)(\s*[:：]?\s*)[A-Za-z][-_A-Za-z0-9]{5,19}"),
)
_TOKEN_PATTERNS = (
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}"),
    re.compile(r"(?i)\b(cookie|set-cookie|authorization)\b(\s*[:=]\s*)[^\n]+"),
    re.compile(r"(?i)\b(__zp_[a-z_]*|wt2|zp_token|bst|wbg)=[^;\s]+"),
    re.compile(r"\b(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{40,}"),
)
_ENV_ASSIGNMENT = re.compile(r"\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)=(\"[^\"]*\"|'[^']*'|\S+)")
_SENSITIVE_ENV = re.compile(r"(?i)(key|token|secret|password|passwd|cookie|auth|credential|session)")
_PATH_SEGMENT = r"[^\s/\"'`<>|()\[\]，。；：、！？（）《》“”‘’]+"
_ABSOLUTE_PATH = re.compile(
    rf"file://(?:/{_PATH_SEGMENT})+/?"
    rf"|(?<![\w:/.~-])(?:~|/{_PATH_SEGMENT})(?:/{_PATH_SEGMENT})+/?"
    r"|(?<![\w])[A-Za-z]:\\(?:[^\s\\\"'<>|]+\\?)+")


def _normalize_key(key: Any) -> str:
    return re.sub(r"[\s_-]", "", str(key)).lower()


class Redactor:
    """Default-deny text scrubbing; counts what it replaced for the export header."""

    def __init__(self, *, secrets: Iterable[str], paths: Iterable[str]) -> None:
        self.secrets = sorted({value for value in secrets if isinstance(value, str) and len(value) >= 6},
                              key=len, reverse=True)
        self.paths = sorted({value.rstrip("/\\") for value in paths
                             if isinstance(value, str) and len(value.rstrip("/\\")) > 1}, key=len, reverse=True)
        self.pii_values: list[str] = []
        self.counts = {"secrets": 0, "environment": 0, "paths": 0, "personalInfo": 0}

    def collect_personal(self, value: Any, *, depth: int = 0) -> None:
        """Remember candidate identity values from tool data so they are masked everywhere."""
        if depth > 32 or len(self.pii_values) >= MAX_PII_VALUES:
            return
        if isinstance(value, dict):
            for key, child in value.items():
                if _normalize_key(key) in _PII_KEYS:
                    self._remember(child, depth + 1)
                self.collect_personal(child, depth=depth + 1)
        elif isinstance(value, list):
            for child in value[:2_000]:
                self.collect_personal(child, depth=depth + 1)

    def _remember(self, value: Any, depth: int) -> None:
        if depth > 32 or len(self.pii_values) >= MAX_PII_VALUES:
            return
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = str(value)
        if isinstance(value, str):
            text = value.strip()
            if 2 <= len(text) <= 4_000 and text not in self.pii_values:
                self.pii_values.append(text)
        elif isinstance(value, (list, dict)):
            for child in (value.values() if isinstance(value, dict) else value[:200]):
                self._remember(child, depth + 1)

    def finalize(self) -> None:
        self.pii_values.sort(key=len, reverse=True)

    def _sub(self, pattern: re.Pattern, repl: Any, text: str, counter: str) -> str:
        result, count = pattern.subn(repl, text)
        self.counts[counter] += count
        return result

    def sensitive(self, text: str) -> str:
        """Credentials, tokens, environment values and local paths; applied to every exported string."""
        for value in self.secrets:
            if value in text:
                self.counts["secrets"] += text.count(value)
                text = text.replace(value, SECRET_MARK)
        scrubbed = redact_secrets(text)
        if scrubbed != text:
            self.counts["secrets"] += scrubbed.count("<redacted>")
            text = scrubbed.replace("<redacted>", SECRET_MARK)
        text = self._sub(_TOKEN_PATTERNS[0], SECRET_MARK, text, "secrets")
        text = self._sub(_TOKEN_PATTERNS[1], lambda m: m.group(1) + m.group(2) + SECRET_MARK, text, "secrets")
        text = self._sub(_TOKEN_PATTERNS[2], lambda m: m.group(1) + "=" + SECRET_MARK, text, "secrets")
        text = self._sub(_ENV_ASSIGNMENT, lambda m: m.group(1) + "=" + ENV_MARK, text, "environment")
        for value in self.paths:
            if value in text:
                self.counts["paths"] += text.count(value)
                text = text.replace(value, PATH_MARK)
        text = self._sub(_ABSOLUTE_PATH, PATH_MARK, text, "paths")
        return self._sub(_TOKEN_PATTERNS[3], SECRET_MARK, text, "secrets")

    def personal(self, text: str) -> str:
        for value in self.pii_values:
            if value in text:
                self.counts["personalInfo"] += text.count(value)
                text = text.replace(value, PII_MARK)
        text = self._sub(_PII_PATTERNS[0], PII_MARK, text, "personalInfo")
        text = self._sub(_PII_PATTERNS[1], PII_MARK, text, "personalInfo")
        text = self._sub(_PII_PATTERNS[2], PII_MARK, text, "personalInfo")
        return self._sub(_PII_PATTERNS[3], lambda m: m.group(1) + m.group(2) + PII_MARK, text, "personalInfo")

    def text(self, value: Any, *, limit: int = MAX_TEXT_CHARS) -> str:
        """Full default scrubbing for free text (titles, inputs, model output, summaries)."""
        if not isinstance(value, str):
            return ""
        return _clip(self.personal(self.sensitive(value)), limit)


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…（本段已截断：原长 {len(text)} 字符，仅保留前 {limit} 字符）"


def _known_secrets(extra: Iterable[str]) -> list[str]:
    values = [value for value in extra if value]
    for key, value in os.environ.items():
        if _SENSITIVE_ENV.search(key) and isinstance(value, str) and len(value) >= 8:
            values.append(value)
    return values


def _known_paths(extra: Iterable[Path | str]) -> list[str]:
    values = [str(value) for value in extra if value]
    try:
        values.append(str(Path.home()))
    except (OSError, RuntimeError):
        pass
    for value in list(values):
        try:
            values.append(str(Path(value).resolve()))
        except (OSError, RuntimeError):
            pass
    return values


def _describe_value(value: Any) -> str:
    if isinstance(value, list):
        return f"列表 {len(value)} 项"
    if isinstance(value, dict):
        keys = [str(key)[:40] for key in list(value)[:12]]
        more = "…" if len(value) > 12 else ""
        return "对象（字段：" + "、".join(keys) + more + "）"
    if value is None:
        return "空"
    if isinstance(value, bool):
        return "布尔值"
    if isinstance(value, (int, float)):
        return "数值"
    if isinstance(value, str):
        return f"文本 {len(value)} 字符"
    return "未知类型"


def _structure(data: Any) -> dict:
    """Shape of tool data without values: top-level type, list sizes and field names."""
    shape: dict[str, Any] = {"type": _describe_value(data)}
    if isinstance(data, dict):
        shape["fields"] = {str(key)[:40]: _describe_value(value) for key, value in list(data.items())[:24]}
    elif isinstance(data, list) and data and isinstance(data[0], dict):
        shape["itemFields"] = [str(key)[:40] for key in list(data[0])[:24]]
    return shape


def _pagination(value: Any) -> dict | None:
    if not isinstance(value, dict):
        return None
    out = {}
    for key in ("page", "has_more", "hasMore", "total", "total_kind", "page_size"):
        item = value.get(key)
        if item is None or isinstance(item, (bool, int, float)) or (isinstance(item, str) and len(item) <= 40):
            if key in value:
                out[key] = item
    return out


def _fence(text: str, language: str = "text") -> str:
    longest = max((len(run) for run in re.findall(r"`+|~+", text)), default=0)
    marker = "`" * max(3, longest + 1)
    return f"{marker}{language}\n{text}\n{marker}"


def _tokens(bucket: dict) -> str:
    if bucket["requests"] == 0:
        return "无模型请求记录"
    parts = [f"模型请求 {bucket['requests']} 次"]
    if bucket["verifiedRequests"]:
        parts.append(f"输入 {bucket['promptTokens']:,} / 输出 {bucket['outputTokens']:,} token")
        if bucket.get("cacheReadTokens") is not None:
            parts.append(f"缓存读取 {bucket['cacheReadTokens']:,}")
        if bucket.get("reasoningTokens") is not None:
            parts.append(f"推理 {bucket['reasoningTokens']:,}")
    unreported = bucket.get("unreportedRequests", 0)
    if unreported:
        parts.append(f"provider 未上报用量 {unreported} 次（不按 0 计）")
    other = bucket["unverifiedRequests"] - unreported
    if other > 0:
        reasons = "、".join(f"{key} {value}" for key, value in bucket["unverifiedReasons"].items() if key != "missing")
        parts.append(f"不可验证 {other} 次（{reasons}）")
    if not bucket["verifiedRequests"]:
        parts.append("无可验证的 provider 用量")
    return "；".join(parts)


_TURN_STATUS = {"completed": "已完成", "interrupted": "已中断", "blocked": "已阻断", "error": "出错",
                "running": "进行中（导出时尚未结束）"}


class _Exporter:
    def __init__(self, sessions: SessionStore, thread_id: str, *, branch: bool,
                 include_tool_results: bool, redactor: Redactor) -> None:
        self.thread_id, self.branch = thread_id, branch
        self.include = include_tool_results
        self.redactor = redactor
        with sessions._lock:
            thread = sessions.get_thread(thread_id)
            entries = sessions.read_entries(thread_id)
            selected = sessions._active_entries(entries) if branch else entries
            active_entries = sessions._active_entries(entries)
            leaf = sessions._leaf_state(thread_id, entries, active_entries)
        self.thread = thread
        self.leaf = leaf
        self.turns = [sessions._public_turn(turn) for turn in sessions._turns(selected, thread_id)]
        self.active_turn_ids = {turn["turnId"] for turn in sessions._turns(active_entries, thread_id)}
        self.items = sessions._project_items(thread_id, selected)
        usage = summarize_usage(entries, self.active_turn_ids if branch else None)
        self.usage_turns = {bucket["turnId"]: bucket for bucket in usage["turns"]}
        self.usage_summary, self.usage_totals = usage["summaryTasks"], usage["totals"]
        order = [turn["turnId"] for turn in self.turns]
        self.positions = {turn_id: index for index, turn_id in enumerate(order)}
        self.summaries = self._summaries(selected)
        self.checkpoints = [entry for entry in selected if entry.get("type") == "context_checkpoint"
                            and isinstance(entry.get("payload"), dict)]
        for item in self.items:
            if item.get("kind") == "toolCall":
                result = item.get("result")
                if isinstance(result, dict):
                    redactor.collect_personal(result.get("data"))
                    redactor.collect_personal(result.get("error"))
                redactor.collect_personal(item.get("toolArguments"))
        redactor.finalize()

    def _summaries(self, entries: list[dict]) -> list[dict]:
        out = []
        for entry in entries:
            payload = entry.get("payload")
            if entry.get("type") != BRANCH_SUMMARY_ENTRY_TYPE or not isinstance(payload, dict):
                continue
            summary, anchor = payload.get("summary"), payload.get("targetTurnId")
            if (not isinstance(summary, str) or not summary.strip() or len(summary) > MAX_BRANCH_SUMMARY_CHARS
                    or (anchor is not None and anchor not in self.positions)):
                continue
            abandoned = payload.get("abandonedTurnIds")
            out.append({"entryId": entry.get("id"), "targetTurnId": anchor, "summary": summary.strip(),
                        "abandonedTurnCount": len(abandoned) if isinstance(abandoned, list) else None,
                        "summaryProvider": payload.get("summaryProvider"),
                        "summaryModel": payload.get("summaryModel"), "createdAt": entry.get("timestamp")})
        return out

    # ---------- structured units ----------

    def _arguments(self, arguments: Any) -> dict:
        if not isinstance(arguments, dict):
            return {}
        out: dict[str, Any] = {}
        for key, value in list(arguments.items())[:40]:
            name = str(key)[:64]
            if self.include:
                out[name] = value
            elif key in _SAFE_ARGUMENTS and (isinstance(value, (int, float, bool)) or value is None
                                             or (isinstance(value, str) and len(value) <= 200)
                                             or (isinstance(value, list) and len(value) <= 20
                                                 and all(isinstance(v, str) and len(v) <= 40 for v in value))):
                out[name] = value
            else:
                out[name] = f"{OMITTED}（{_describe_value(value)}）"
        return self._scrub_json(out, personal=not self.include)

    def _scrub_json(self, value: Any, *, personal: bool) -> Any:
        if isinstance(value, str):
            text = self.redactor.sensitive(value)
            return self.redactor.personal(text) if personal else text
        if isinstance(value, list):
            return [self._scrub_json(child, personal=personal) for child in value]
        if isinstance(value, dict):
            return {self.redactor.sensitive(str(key)): self._scrub_json(child, personal=personal)
                    for key, child in value.items()}
        return value

    def _tool(self, item: dict) -> dict:
        status = tool_execution_status(item)
        result = item.get("result") if isinstance(item.get("result"), dict) else None
        approval = item.get("approval") if isinstance(item.get("approval"), dict) else None
        unit: dict[str, Any] = {
            "kind": "toolCall", "origin": "platform", "itemId": item.get("id"),
            "toolName": item.get("toolName"), "status": item.get("status"),
            "execution": status,
            "errorCode": item.get("errorCode") if isinstance(item.get("errorCode"), str) else None,
            "recoveryAction": self.redactor.text(item.get("recoveryAction"), limit=600) or None,
            "arguments": self._arguments(item.get("toolArguments")),
        }
        if approval is not None:
            unit["approval"] = {"required": True, "decision": approval.get("decision"),
                                "decidedAt": approval.get("decidedAt"),
                                "description": self.redactor.text(approval.get("description"), limit=300)}
        source = item.get("source")
        if isinstance(source, dict):
            unit["source"] = {key: source.get(key) for key in ("ref", "queriedAt")
                              if isinstance(source.get(key), str) and len(source[key]) <= 120}
        if result is None:
            unit["result"] = None
        elif self.include:
            body = {key: result.get(key) for key in ("ok", "data", "pagination", "error", "hints")}
            text = json.dumps(self._scrub_json(body, personal=False), ensure_ascii=False, indent=2,
                              default=str)
            unit["result"] = {"included": True, "text": _clip(text, MAX_RESULT_CHARS)}
        else:
            error = result.get("error") if isinstance(result.get("error"), dict) else None
            unit["result"] = {
                "included": False, "ok": result.get("ok") if isinstance(result.get("ok"), bool) else None,
                "data": _structure(result.get("data")), "pagination": _pagination(result.get("pagination")),
                "error": ({"code": error.get("code") if isinstance(error.get("code"), str) else None,
                           "message": self.redactor.text(error.get("message"), limit=600) or None}
                          if error else None),
                "hintCount": len(result["hints"]) if isinstance(result.get("hints"), list) else 0,
            }
        return unit

    def _item(self, item: dict) -> dict | None:
        kind = item.get("kind")
        if kind == "userMessage":
            text = item.get("originalInput") if isinstance(item.get("originalInput"), str) else item.get("text")
            attachments = item.get("attachments") if isinstance(item.get("attachments"), list) else []
            return {"kind": "userInput", "origin": "user", "itemId": item.get("id"),
                    "queued": bool(item.get("queueId")), "text": self.redactor.text(text),
                    "attachments": [{"mediaType": str(a.get("mediaType", ""))[:80],
                                     "bytes": a.get("bytes") if type(a.get("bytes")) is int else None}
                                    for a in attachments[:32] if isinstance(a, dict)]}
        if kind == "agentMessage":
            thinking = item.get("thinking")
            return {"kind": "modelOutput", "origin": "model", "itemId": item.get("id"),
                    "status": item.get("status") or "completed", "text": self.redactor.text(item.get("text")),
                    "thinkingCharacters": len(thinking) if isinstance(thinking, str) else 0}
        if kind == "toolCall":
            return self._tool(item)
        return None

    def units(self) -> list[tuple[str, dict]]:
        """Ordered (turnId, unit) list; turn headers precede their items, summaries follow their anchor."""
        by_turn: dict[str, list[dict]] = {}
        for item in self.items:
            # Context edits only change model context; the export keeps the original record.
            unit = self._item(item)
            turn_id = item.get("turnId")
            if unit is not None and isinstance(turn_id, str):
                by_turn.setdefault(turn_id, []).append(unit)
        after: dict[str | None, list[dict]] = {}
        for summary in self.summaries:
            after.setdefault(summary["targetTurnId"], []).append({
                "kind": "branchSummary", "origin": "model", "entryId": summary["entryId"],
                "label": "模型生成的被放弃分支摘要（需核对，不扩大操作授权）",
                "abandonedTurnCount": summary["abandonedTurnCount"],
                "summaryModel": self.redactor.text(summary["summaryModel"], limit=120) or None,
                "createdAt": summary["createdAt"], "text": self.redactor.text(summary["summary"])})
        for entry in self.checkpoints:
            payload = entry["payload"]
            anchor = payload.get("throughTurnId")
            if anchor not in self.positions:
                continue
            origin = payload.get("origin") if payload.get("origin") in {"model", "user"} else "unknown"
            after.setdefault(anchor, []).append({
                "kind": "compactionSummary", "origin": origin, "entryId": entry.get("id"),
                "label": ("模型生成的上下文压缩摘要（原始记录仍保留）" if origin == "model"
                          else "用户提供的上下文压缩摘要（原始记录仍保留）"),
                "createdAt": entry.get("timestamp"), "text": self.redactor.text(payload.get("summary"))})
        units: list[tuple[str, dict]] = [("", unit) for unit in after.get(None, [])]
        for index, turn in enumerate(self.turns):
            turn_id = turn["turnId"]
            header = {"kind": "turn", "index": index + 1, "turnId": turn_id,
                      "status": turn.get("status"), "startedAt": turn.get("startedAt"),
                      "completedAt": turn.get("completedAt"),
                      "provider": turn.get("provider") if isinstance(turn.get("provider"), str) else None,
                      "model": self.redactor.text(turn.get("model"), limit=120) or None,
                      "onCurrentBranch": turn_id in self.active_turn_ids,
                      "failureCode": next((turn[key] for key in ("failureCode", "recoveryReason", "taskRecoveryReason")
                                           if isinstance(turn.get(key), str) and len(turn[key]) <= 120), None),
                      "usage": self.usage_turns.get(turn_id),
                      "usageLabel": _usage_line(self.usage_turns.get(turn_id))}
            units.append((turn_id, header))
            units.extend((turn_id, unit) for unit in by_turn.get(turn_id, []))
            units.extend((turn_id, unit) for unit in after.get(turn_id, []))
        return units

    def meta(self, server_version: str) -> dict:
        return {
            "schema": EXPORT_SCHEMA, "exportedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "serverVersion": server_version, "protocolVersion": "0.2.0",
            "threadId": self.thread_id, "title": " ".join(self.redactor.text(self.thread.get("title"), limit=200).split()),
            "createdAt": self.thread.get("createdAt"), "view": "branch" if self.branch else "log",
            "branched": self.leaf["branched"], "turnCount": len(self.turns),
            "toolResults": "included" if self.include else "omitted",
            "usage": {"source": USAGE_SOURCE, "costAvailable": False,
                      "totals": self.usage_totals, "summaryTasks": self.usage_summary},
        }


# ---------- rendering ----------

def _usage_line(bucket: dict | None) -> str:
    return "无模型请求记录" if bucket is None else _tokens(bucket)


def _render_unit(unit: dict, view_log: bool) -> str:
    kind = unit["kind"]
    if kind == "turn":
        lines = [f"## 回合 {unit['index']} · `{unit['turnId']}` · {_TURN_STATUS.get(unit['status'], '状态不明')}", ""]
        meta = [f"开始：{unit['startedAt'] or '—'}", f"结束：{unit['completedAt'] or '—'}"]
        if unit["model"]:
            meta.append(f"模型：{unit['provider'] or '—'} / {unit['model']}")
        if view_log:
            meta.append("在当前分支：" + ("是" if unit["onCurrentBranch"] else "否（已切离的分支）"))
        if unit["failureCode"]:
            meta.append(f"失败 / 恢复原因：`{unit['failureCode']}`")
        lines.append("- " + "；".join(meta))
        lines.append(f"- 用量（provider 上报，不估算、不计价）：{unit['usageLabel']}")
        return "\n".join(lines)
    if kind == "userInput":
        title = "### 用户输入" + ("（来自消息队列）" if unit["queued"] else "")
        parts = [title, "", _fence(unit["text"] or "（空）")]
        if unit["attachments"]:
            parts.append("\n附件 " + str(len(unit["attachments"])) + " 个（文件名与内容未导出）："
                         + "、".join(f"{a['mediaType'] or '未知类型'} {a['bytes'] if a['bytes'] is not None else '?'} 字节"
                                    for a in unit["attachments"]))
        return "\n".join(parts)
    if kind == "modelOutput":
        status = "" if unit["status"] == "completed" else f"（状态：{unit['status']}，可能不完整）"
        parts = [f"### 模型输出（模型判断，未经平台核实）{status}", "", _fence(unit["text"] or "（无文本）")]
        if unit["thinkingCharacters"]:
            parts.append(f"\n模型推理内容 {unit['thinkingCharacters']} 字符，未导出。")
        return "\n".join(parts)
    if kind == "toolCall":
        execution = unit["execution"]
        lines = [f"### 工具调用 `{unit['toolName']}` — {execution['label']}", ""]
        executed = {True: "是", False: "否", None: "未知，需核对平台状态"}[execution["executed"]]
        lines.append(f"- 执行状态：`{execution['state']}`（记录状态 `{unit['status']}`）；已执行：{executed}"
                     + ("；外部写操作" if execution["externalWrite"] else "；只读"))
        approval = unit.get("approval")
        if approval:
            decision = {"approve": "用户批准", "deny": "用户拒绝", "expired": "审批已过期",
                        None: "等待审批"}.get(approval["decision"], "状态不明")
            lines.append(f"- 审批：{decision}" + (f"（{approval['decidedAt']}）" if approval["decidedAt"] else ""))
        if unit["errorCode"]:
            lines.append(f"- 错误码：`{unit['errorCode']}`")
        if unit["recoveryAction"]:
            lines.append(f"- 恢复建议：{unit['recoveryAction']}")
        if unit.get("source"):
            lines.append("- 来源：" + "；".join(f"{key}={value}" for key, value in unit["source"].items()))
        if unit["arguments"]:
            lines.append("- 参数：" + "，".join(f"{key}={json.dumps(value, ensure_ascii=False)}"
                                              if not (isinstance(value, str) and value.startswith(OMITTED))
                                              else f"{key}={value}"
                                              for key, value in unit["arguments"].items()))
        result = unit["result"]
        if result is None:
            lines.append("- 结果：无（未执行或尚未返回）")
        elif result["included"]:
            lines.append("- 结果明文（平台事实；含候选人个人信息，请勿外传）：")
            lines.append("")
            lines.append(_fence(result["text"], "json"))
        else:
            facts = [f"ok={str(result['ok']).lower() if result['ok'] is not None else '未知'}",
                     "data：" + result["data"]["type"]]
            if result["data"].get("itemFields"):
                facts.append("条目字段：" + "、".join(result["data"]["itemFields"]))
            if result["data"].get("fields"):
                facts.append("字段：" + "、".join(f"{k}（{v}）" for k, v in result["data"]["fields"].items()))
            if result["pagination"] is not None:
                facts.append("分页：" + json.dumps(result["pagination"], ensure_ascii=False))
            if result["error"]:
                facts.append(f"错误：{result['error']['code'] or '—'} {result['error']['message'] or ''}".rstrip())
            if result["hintCount"]:
                facts.append(f"hints {result['hintCount']} 条未导出")
            lines.append("- 结果（仅结构与状态，明文已省略）：" + "；".join(facts))
        return "\n".join(lines)
    if kind in {"branchSummary", "compactionSummary"}:
        extra = ""
        if kind == "branchSummary" and unit.get("abandonedTurnCount"):
            extra = f"；被放弃回合 {unit['abandonedTurnCount']} 个"
        if unit.get("summaryModel"):
            extra += f"；摘要模型 {unit['summaryModel']}"
        return "\n".join([f"### {unit['label']}", "", f"- 生成时间：{unit.get('createdAt') or '—'}{extra}",
                          "- 其中平台事实以原始工具结果为准，结论与推断属于模型判断。", "",
                          _fence(unit["text"] or "（空）")])
    return ""


def _render_markdown(meta: dict, units: list[tuple[str, dict]], counts: dict, total_units: int,
                     max_bytes: int) -> str:
    view_log = meta["view"] == "log"
    usage = meta["usage"]
    header = [
        "# BOSS-CLI 会话导出", "",
        "> 用于复盘与问题报告。默认已脱敏：凭据、令牌、环境变量、本机绝对路径与附件内容不导出；"
        + ("**本文件包含工具参数与结果明文（可能含候选人姓名、联系方式、简历等个人信息），请勿外传或上传到公开问题报告。**"
           if meta["toolResults"] == "included"
           else "工具结果只保留结构与执行状态，候选人个人信息已打码。"),
        "",
        f"- 会话：`{meta['threadId']}`（标题：{meta['title'] or '—'}）",
        f"- 视图：{'完整日志（含已切离分支）' if view_log else '当前分支'}；回合 {meta['turnCount']} 个",
        f"- 导出时间：{meta['exportedAt']}；内核 {meta['serverVersion']}；协议 {meta['protocolVersion']}",
        f"- 工具结果明文：{'已包含' if meta['toolResults'] == 'included' else '未包含'}",
        f"- 会话用量（{usage['source']}，费用未计价）：{_tokens(usage['totals'])}",
    ]
    if usage["summaryTasks"]["requests"]:
        header.append(f"- 摘要任务用量：{_tokens(usage['summaryTasks'])}")
    header += ["", "内容来源：「用户输入」为操作者原文；「模型输出」与模型生成的摘要属于模型判断，需核对；"
               "「工具调用」的执行状态与结果来自招聘平台工具，是平台事实的来源。", ""]
    body = [_render_unit(unit, view_log) for _, unit in units]
    footer = ["", "---", "",
              f"脱敏统计：凭据 / 令牌 {counts['secrets']} 处，环境变量 {counts['environment']} 处，"
              f"本机路径 {counts['paths']} 处，候选人信息 {counts['personalInfo']} 处。"]
    if len(units) < total_units:
        footer.append(f"\n**已截断**：超出导出上限 {max_bytes:,} 字节，仅包含前 {len(units)} / {total_units} 个条目；"
                      "其余回合与条目未导出。")
    return "\n".join(header) + "\n" + "\n\n".join(body) + "\n" + "\n".join(footer) + "\n"


def _render_json(meta: dict, units: list[tuple[str, dict]], counts: dict, total_units: int,
                 max_bytes: int) -> str:
    turns: list[dict] = []
    preamble: list[dict] = []
    for _, unit in units:
        if unit["kind"] == "turn":
            turns.append({**unit, "entries": []})
        elif turns:
            turns[-1]["entries"].append(unit)
        else:
            preamble.append(unit)
    document = {**meta, "redaction": {"marks": {"secret": SECRET_MARK, "environment": ENV_MARK,
                                                 "path": PATH_MARK, "personalInfo": PII_MARK},
                                       "counts": dict(counts)},
                "origins": {"user": "用户输入", "model": "模型判断", "platform": "平台事实（工具结果）"},
                "beforeFirstTurn": preamble, "turns": turns,
                "truncated": len(units) < total_units,
                "exportedEntries": len(units), "totalEntries": total_units, "maxBytes": max_bytes}
    return json.dumps(document, ensure_ascii=False, indent=2, default=str) + "\n"


def _wire_bytes(text: str) -> int:
    return len(json.dumps(text, ensure_ascii=False).encode("utf-8"))


def export_thread(sessions: SessionStore, thread_id: str, *, branch: bool, fmt: str,
                  include_tool_results: bool, max_bytes: int, server_version: str,
                  secrets: Iterable[str] = (), paths: Iterable[Path | str] = ()) -> dict:
    """Render one session as a bounded, redacted document; reads only, writes nothing."""
    if fmt not in EXPORT_FORMATS:
        raise ValueError("format 必须是 markdown 或 json")
    if type(include_tool_results) is not bool:
        raise ValueError("includeToolResults 必须是布尔值")
    if type(max_bytes) is not int or not MIN_EXPORT_BYTES <= max_bytes <= MAX_EXPORT_BYTES:
        raise ValueError(f"maxBytes 必须是 {MIN_EXPORT_BYTES} 到 {MAX_EXPORT_BYTES} 的整数")
    redactor = Redactor(secrets=_known_secrets(secrets), paths=_known_paths(paths))
    exporter = _Exporter(sessions, thread_id, branch=branch,
                         include_tool_results=include_tool_results, redactor=redactor)
    units = exporter.units()
    meta = exporter.meta(server_version)
    render = _render_markdown if fmt == "markdown" else _render_json
    counts = dict(redactor.counts)

    def size(count: int) -> int:
        # Budget the escaped transport spelling: it bounds the written file and keeps the
        # response under the single-page RPC limit even for JSON-heavy content.
        return _wire_bytes(render(meta, units[:count], counts, len(units), max_bytes))

    keep = len(units)
    if size(keep) > max_bytes:
        low, high = 0, len(units)
        while low < high:
            middle = (low + high + 1) // 2
            if size(middle) <= max_bytes:
                low = middle
            else:
                high = middle - 1
        keep = low
    content = render(meta, units[:keep], counts, len(units), max_bytes)
    if _wire_bytes(content) > max_bytes:
        raise ValueError("会话导出头部超出大小上限")
    exported_turns = sum(1 for _, unit in units[:keep] if unit["kind"] == "turn")
    extension = "md" if fmt == "markdown" else "json"
    return {"threadId": thread_id, "view": meta["view"], "format": fmt,
            "mediaType": "text/markdown" if fmt == "markdown" else "application/json",
            "suggestedFileName": f"boss-cli-session-{thread_id}-{meta['view']}.{extension}",
            "content": content, "bytes": len(content.encode("utf-8")), "maxBytes": max_bytes,
            "truncated": keep < len(units), "turnCount": len(exporter.turns), "exportedTurnCount": exported_turns,
            "toolResults": meta["toolResults"], "redactions": counts}
