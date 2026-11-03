"""会话只读导出（复盘与问题报告）。

职责参考 Pi MIT 固定提交 a14cdf90f0a76532f3e20bc3c01872837cef24ba 的
packages/coding-agent/src/core/session-export.ts（按当前分支序列化会话）与
export-html/（完整条目 + leaf 渲染为可阅读文档）。本模块独立实现，不复制 Pi 源码：

- 只读取已持久的会话条目，不写会话、不调用模型或工具、不发事件；
- 输出 Markdown、JSON 或自包含 HTML 文本，由外壳主进程经保存对话框写盘，内核不触碰导出目标路径；
- 默认脱敏：凭据、令牌、环境变量、本机绝对路径与附件内容一律不导出；工具结果只保留
  结构与执行状态，个人信息按工具数据中识别到的字段值在全文打码（未出现在工具数据中的
  姓名可能无法识别）；调用方显式传入 ``includeToolResults`` 才导出工具参数与结果明文
  （凭据与路径仍脱敏）；
- 区分用户输入、模型输出（模型判断）、工具调用（平台事实来源）与模型生成的摘要；
- 附带当前会话的队列状态（尚未形成回合的排队、暂停与已撤回消息）；
- 输出有字节上限，超限按条目截断并在文末标注。
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from typing import Any, Iterable

from boss_harness.compaction import verified_policy
from boss_harness.context import tool_execution_status
from boss_harness.models.secret import redact_secrets
from boss_harness.session import BRANCH_SUMMARY_ENTRY_TYPE, MAX_BRANCH_SUMMARY_CHARS, SessionStore
from boss_harness.usage import SOURCE as USAGE_SOURCE, summarize_usage

EXPORT_FORMATS = ("markdown", "json", "html")
DEFAULT_EXPORT_BYTES = 512 * 1024
MIN_EXPORT_BYTES = 64 * 1024
# 响应须低于传输单页上限（1 MiB，JSON 字符串转义会放大）。
MAX_EXPORT_BYTES = 768 * 1024
MAX_TEXT_CHARS = 16_000
MAX_RESULT_CHARS = 16_000
MAX_PII_VALUES = 4_000
MAX_QUEUE_ITEMS = 20
MAX_QUEUE_INPUT_CHARS = 800
EXPORT_SCHEMA = "boss-harness-session-export/1"

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
    "微信号", "resume", "resumetext", "resumecontent", "resumedesc", "resumedescription", "简历", "简历正文",
    "idcard", "身份证", "address", "地址", "住址", "contact", "联系方式",
    "geekdesc", "geekdescription", "workcontent",
})
_PII_PATTERNS = (
    re.compile(r"[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+"),
    re.compile(r"(?<!\d)(?:\+?86[ -]?)?1[3-9]\d(?:[ -]?\d{4}){2}(?!\d)"),
    re.compile(r"(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])"),
    re.compile(r"(?i)(微信号?|wechat|weixin|vx|wx)(\s*[:：]?\s*)[A-Za-z][-_A-Za-z0-9]{5,19}"),
)
_TOKEN_PATTERNS = (
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}"),
    # Header values may be JSON-quoted (`"Authorization": "Basic …"`) or plain `Cookie: …`.
    re.compile(r"(?i)\b(cookie|set-cookie|authorization|proxy-authorization)\b[\"']?(\s*[:=]\s*)[\"']?[^\n\"']+"),
    re.compile(r"(?i)\b(__zp_[a-z_]*|wt2|zp_token|bst|wbg)=[^;\s]+"),
    re.compile(r"\b(?=[A-Za-z0-9_+=/-]*\d)(?=[A-Za-z0-9_+=/-]*[A-Za-z])[A-Za-z0-9_+=/-]{40,}"),
)
# Vendor key prefixes (case-insensitive) and RFC 3986 userinfo, neither of which the
# generic long-token rule covers for short keys.
_KEY_PATTERN = re.compile(r"(?i)\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}")
_URL_USERINFO = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@")
# Any UPPER_CASE assignment, with or without an underscore, quoted or bare.
_ENV_ASSIGNMENT = re.compile(r"\b([A-Z][A-Z0-9_]{2,})\s*=\s*(\"[^\"]*\"|'[^']*'|\S+)")
_SENSITIVE_ENV = re.compile(r"(?i)(key|token|secret|password|passwd|cookie|auth|credential|session)")
_PATH_SEGMENT = r"[^\s/\\\"'`<>|()\[\]，。；：、！？（）《》“”‘’]+"
_ABSOLUTE_PATH = re.compile(
    rf"file://(?:/{_PATH_SEGMENT})+/?"
    rf"|(?<![\w:/.~-])(?:~|/{_PATH_SEGMENT})(?:/{_PATH_SEGMENT})+/?"
    r"|(?<![\w])[A-Za-z]:[\\/](?:[^\s\\/\"'<>|]+[\\/]?)+")


def _normalize_key(key: Any) -> str:
    return re.sub(r"[\s_-]", "", str(key)).lower()


class Redactor:
    """Default-deny text scrubbing; counts what it replaced for the export header."""

    def __init__(self, *, secrets: Iterable[str], paths: Iterable[str]) -> None:
        self.secrets = sorted({value for value in secrets if isinstance(value, str) and len(value) >= 6},
                              key=len, reverse=True)
        self.paths = sorted({value.rstrip("/\\") for value in paths
                             if isinstance(value, str) and len(value.rstrip("/\\")) > 1}, key=len, reverse=True)
        # A known path prefix swallows the rest of that path so no trailing segment survives.
        tail = "[/\\\\][^\\s\"'`<>|()\\[\\]，。；：、！？（）《》“”‘’]*"
        self.path_patterns = [re.compile(re.escape(value) + f"(?:{tail})?") for value in self.paths]
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
        text = self._sub(_KEY_PATTERN, SECRET_MARK, text, "secrets")
        text = self._sub(_URL_USERINFO, lambda m: m.group(1) + SECRET_MARK + "@", text, "secrets")
        text = self._sub(_ENV_ASSIGNMENT, lambda m: m.group(1) + "=" + ENV_MARK, text, "environment")
        for pattern in self.path_patterns:
            text, count = pattern.subn(PATH_MARK, text)
            self.counts["paths"] += count
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


def _structure(data: Any, redactor: "Redactor") -> dict:
    """Shape of tool data without values: top-level type, list sizes and (redacted) field names."""
    def name(key: Any) -> str:
        return redactor.sensitive(str(key))[:40]

    shape: dict[str, Any] = {"type": _describe_value(data)}
    if isinstance(data, dict):
        shape["fields"] = {name(key): _describe_value(value) for key, value in list(data.items())[:24]}
    elif isinstance(data, list) and data and isinstance(data[0], dict):
        shape["itemFields"] = [name(key) for key in list(data[0])[:24]]
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


def _inline_code(value: Any) -> str:
    """A code span that cannot be broken by backticks or newlines in platform-supplied text."""
    return "`" + str(value).replace("`", "'").replace("\n", " ") + "`"


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
        if bucket.get("cacheWriteTokens") is not None:
            parts.append(f"缓存写入 {bucket['cacheWriteTokens']:,}")
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
                 include_tool_results: bool, redactor: Redactor,
                 active_summary_job_id: str | None = None,
                 entries: list[dict] | None = None) -> None:
        self.thread_id, self.branch = thread_id, branch
        self.include = include_tool_results
        self.redactor = redactor
        with sessions._lock:
            thread = sessions.get_thread(thread_id)
            if entries is None:
                entries = sessions.read_entries(thread_id)
            selected = sessions._active_entries(entries) if branch else entries
            active_entries = sessions._active_entries(entries)
            leaf = sessions._leaf_state(thread_id, entries, active_entries)
        self.thread = thread
        self.leaf = leaf
        self.entries = entries
        self.turns = [sessions._public_turn(turn) for turn in sessions._turns(selected, thread_id)]
        self.active_turn_ids = {turn["turnId"] for turn in sessions._turns(active_entries, thread_id)}
        self.items = sessions._project_items(thread_id, selected)
        usage = summarize_usage(entries, self.active_turn_ids if branch else None,
                                active_job_id=active_summary_job_id)
        self.usage_turns = {bucket["turnId"]: bucket for bucket in usage["turns"]}
        self.usage_summary, self.usage_totals = usage["summaryTasks"], usage["totals"]
        self.usage_jobs = usage["summaryJobs"]
        self.usage_job_count = usage["summaryJobCount"]
        self.usage_jobs_truncated = usage["summaryJobsTruncated"]
        order = [turn["turnId"] for turn in self.turns]
        self.positions = {turn_id: index for index, turn_id in enumerate(order)}
        self.orphan_entries = 0
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
                    or (anchor is not None and (not isinstance(anchor, str) or anchor not in self.positions))):
                continue
            abandoned = payload.get("abandonedTurnIds")
            out.append({"entryId": entry.get("id"), "targetTurnId": anchor, "summary": summary.strip(),
                        "abandonedTurnCount": len(abandoned) if isinstance(abandoned, list) else None,
                        "summaryProvider": payload.get("summaryProvider"),
                        "summaryModel": payload.get("summaryModel"), "createdAt": entry.get("timestamp"),
                        "summaryJobId": _identifier(payload.get("summaryJobId"))})
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
                "data": _structure(result.get("data"), self.redactor),
                "pagination": _pagination(result.get("pagination")),
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
        self.orphan_entries = 0
        for item in self.items:
            # Context edits only change model context; the export keeps the original record.
            unit = self._item(item)
            turn_id = item.get("turnId")
            if unit is None:
                continue
            if not isinstance(turn_id, str) or turn_id not in self.positions:
                self.orphan_entries += 1
                continue
            by_turn.setdefault(turn_id, []).append(unit)
        after: dict[str | None, list[dict]] = {}
        for summary in self.summaries:
            after.setdefault(summary["targetTurnId"], []).append({
                "kind": "branchSummary", "origin": "model", "entryId": summary["entryId"],
                "label": "模型生成的被放弃分支摘要（需核对，不扩大操作授权）",
                "abandonedTurnCount": summary["abandonedTurnCount"],
                "summaryModel": self.redactor.text(summary["summaryModel"], limit=120) or None,
                "summaryJobId": summary["summaryJobId"],
                "createdAt": summary["createdAt"], "text": self.redactor.text(summary["summary"])})
        for entry in self.checkpoints:
            payload = entry["payload"]
            anchor = payload.get("throughTurnId")
            if not isinstance(anchor, str) or anchor not in self.positions:
                continue
            origin = payload.get("origin") if payload.get("origin") in {"model", "user"} else "unknown"
            after.setdefault(anchor, []).append({
                "kind": "compactionSummary", "origin": origin, "entryId": entry.get("id"),
                "label": {"model": "模型生成的上下文压缩摘要（原始记录仍保留）",
                          "user": "用户提供的上下文压缩摘要（原始记录仍保留）"}.get(
                              origin, "来源未知的上下文压缩摘要（原始记录仍保留）"),
                "createdAt": entry.get("timestamp"), "text": self.redactor.text(payload.get("summary")),
                "summaryJobId": _identifier(payload.get("summaryJobId")),
                "reason": payload.get("reason") if payload.get("reason") in _JOB_REASON else None})
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
                      "compactionPolicy": self._compaction_policy(turn.get("compactionPolicy")),
                      "skillIds": _skill_ids(turn.get("skillIds")),
                      "usage": self._scrub_usage(self.usage_turns.get(turn_id)),
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
            "orphanEntries": self.orphan_entries,
            "toolResults": "included" if self.include else "omitted",
            "usage": {"source": USAGE_SOURCE, "costAvailable": False,
                      "totals": self._scrub_usage(self.usage_totals),
                      "summaryTasks": self._scrub_usage(self.usage_summary),
                      "summaryJobCount": self.usage_job_count,
                      "summaryJobsTruncated": self.usage_jobs_truncated,
                      "summaryJobs": [self._scrub_usage(job) for job in self.usage_jobs]},
        }

    def _scrub_usage(self, bucket: dict | None) -> dict | None:
        """Copy a usage bucket with its provenance strings scrubbed like other exported text.

        ``provider``/``model`` values come from persisted entries and are recorded even
        when the request is not counted, so they must not bypass default redaction.
        Numeric totals are unchanged.
        """
        if bucket is None:
            return None
        out = dict(bucket)
        for key, limit in (("providers", 80), ("models", 120)):
            values = out.get(key)
            if isinstance(values, list):
                out[key] = [self.redactor.text(value, limit=limit)
                            for value in values if isinstance(value, str)]
        return out

    def _compaction_policy(self, value: Any) -> dict | None:
        policy = verified_policy(value, _AUTO_COMPACTION_FIELDS)
        if policy is not None and "model" in policy:
            policy["model"] = self.redactor.text(policy["model"], limit=120) or None
        return policy

    def queue(self) -> dict:
        """Queue state that never became a turn; thread-global, so independent of the branch view."""
        latest: dict[str, tuple[str, dict]] = {}
        for entry in self.entries:
            payload = entry.get("payload")
            if entry.get("type") != "queue" or not isinstance(payload, dict):
                continue
            queue_id = payload.get("id")
            if not isinstance(queue_id, str) or not queue_id or len(queue_id) > 120:
                continue
            if payload.get("status") not in {"queued", "delivering", "paused", "cancelled"}:
                continue
            latest[queue_id] = (str(entry.get("timestamp") or ""), payload)
        ordered = sorted(latest.items(), key=lambda pair: (pair[1][0], pair[0]))
        # 暂停项需要人工核对；即使之后又积累了更多历史项，也优先保留最近 20 个暂停项。
        keep_ids = {queue_id for queue_id, _ in ordered[-MAX_QUEUE_ITEMS:]}
        paused_ids = [queue_id for queue_id, (_, payload) in ordered if payload["status"] == "paused"]
        keep_ids.update(paused_ids[-MAX_QUEUE_ITEMS:])
        if len(keep_ids) > MAX_QUEUE_ITEMS:
            for queue_id, (_, payload) in ordered:
                if len(keep_ids) <= MAX_QUEUE_ITEMS:
                    break
                if queue_id in keep_ids and payload["status"] != "paused":
                    keep_ids.discard(queue_id)
        items = []
        for queue_id, (_, payload) in ordered:
            if queue_id not in keep_ids:
                continue
            kind = payload.get("kind")
            skill_ids = payload.get("skillIds")
            failure = payload.get("failureCode")
            items.append({
                "queueId": queue_id,
                "kind": kind if kind in {"steering", "followUp"} else "unknown",
                "status": payload["status"],
                "input": self.redactor.text(payload.get("input"), limit=MAX_QUEUE_INPUT_CHARS) or "",
                "skillCount": len(skill_ids) if isinstance(skill_ids, list) else 0,
                "skillIds": _skill_ids(skill_ids),
                "failureCode": failure if isinstance(failure, str) and len(failure) <= 120 else None,
                "inputPersisted": payload.get("inputPersisted")
                if type(payload.get("inputPersisted")) is bool else None,
                "deduplicated": payload.get("deduplicated") is True,
                "autoCompaction": verified_policy(payload.get("autoCompaction"),
                                                  _QUEUE_OVERRIDE_FIELDS),
            })
        return {"items": items, "totalItems": len(ordered), "maxItems": MAX_QUEUE_ITEMS}


# ---------- rendering ----------

def _usage_line(bucket: dict | None) -> str:
    return "无模型请求记录" if bucket is None else _tokens(bucket)


MAX_EXPORT_SUMMARY_JOBS = 20
_JOB_REASON = {"threshold": "触达阈值", "budget": "预算不足", "overflow": "上下文溢出"}


def _identifier(value: Any) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= 128 else None


def _skill_ids(value: Any) -> list[str]:
    """回合实际注入的技能 id：有界、去重，旧记录或畸形值不产生伪技能。"""
    if not isinstance(value, list):
        return []
    ids: list[str] = []
    for item in value[:10]:
        if isinstance(item, str) and 0 < len(item) <= 200 and item not in ids:
            ids.append(item)
    return ids


def _summary_job_facts(job: dict) -> list[str]:
    """One bounded, single-line description of a persisted summary-task usage bucket."""
    kind, origin = job.get("kind"), job.get("origin")
    facts = ["分支摘要" if kind == "branchSummary" else
             "手动压缩" if origin == "user" else "自动压缩" if origin == "model" else "摘要任务"]
    if job.get("active") is True:
        facts.append("当前生效")
    job_id = job.get("jobId")
    if isinstance(job_id, str) and job_id:
        facts.append("任务 " + job_id[:64])
    turn_id = job.get("turnId")
    if isinstance(turn_id, str) and turn_id:
        facts.append("回合 " + turn_id[:64])
    through = job.get("throughTurnId")
    if isinstance(through, str) and through:
        facts.append("摘要至 " + through[:64])
    if job.get("reason") in _JOB_REASON:
        facts.append(_JOB_REASON[job["reason"]])
    models = [model[:80] for model in job.get("models", []) if isinstance(model, str)]
    if models:
        facts.append("模型 " + "、".join(models[:4]))
    facts.append(_usage_line(job))
    return facts


def _result_facts(result: dict) -> list[str]:
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
    return facts


def _render_unit(unit: dict, view_log: bool) -> str:
    kind = unit["kind"]
    if kind == "turn":
        lines = [f"## 回合 {unit['index']} · {_inline_code(unit['turnId'])} · "
                 f"{_TURN_STATUS.get(unit['status'], '状态不明')}", ""]
        meta = [f"开始：{unit['startedAt'] or '—'}", f"结束：{unit['completedAt'] or '—'}"]
        if unit["model"]:
            meta.append(f"模型：{unit['provider'] or '—'} / {unit['model']}")
        if view_log:
            meta.append("在当前分支：" + ("是" if unit["onCurrentBranch"] else "否（已切离的分支）"))
        if unit["failureCode"]:
            meta.append(f"失败 / 恢复原因：{_inline_code(unit['failureCode'])}")
        if unit["compactionPolicy"]:
            meta.extend(_compaction_facts(unit["compactionPolicy"]))
        if unit["skillIds"]:
            meta.append("本回合技能：" + "、".join(_inline_code(item) for item in unit["skillIds"]))
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
        lines = [f"### 工具调用 {_inline_code(unit['toolName'])} — {execution['label']}", ""]
        executed = {True: "是", False: "否", None: "未知，需核对平台状态"}[execution["executed"]]
        lines.append(f"- 执行状态：`{execution['state']}`（记录状态 `{unit['status']}`）；已执行：{executed}"
                     + ("；外部写操作" if execution["externalWrite"] else "；只读"))
        approval = unit.get("approval")
        if approval:
            decision = {"approve": "用户批准", "deny": "用户拒绝", "expired": "审批已过期",
                        None: "等待审批"}.get(approval["decision"], "状态不明")
            lines.append(f"- 审批：{decision}" + (f"（{approval['decidedAt']}）" if approval["decidedAt"] else ""))
        if unit["errorCode"]:
            lines.append(f"- 错误码：{_inline_code(unit['errorCode'])}")
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
            facts = _result_facts(result)
            lines.append("- 结果（仅结构与状态，明文已省略）：" + "；".join(facts))
        return "\n".join(lines)
    if kind in {"branchSummary", "compactionSummary"}:
        extra = ""
        if kind == "branchSummary" and unit.get("abandonedTurnCount"):
            extra = f"；被放弃回合 {unit['abandonedTurnCount']} 个"
        if unit.get("summaryModel"):
            extra += f"；摘要模型 {unit['summaryModel']}"
        if unit.get("summaryJobId"):
            extra += f"；摘要任务 {_inline_text(unit['summaryJobId'])}"
        if unit.get("reason") in _JOB_REASON:
            extra += f"；{_JOB_REASON[unit['reason']]}"
        return "\n".join([f"### {unit['label']}", "", f"- 生成时间：{unit.get('createdAt') or '—'}{extra}",
                          "- 其中平台事实以原始工具结果为准，结论与推断属于模型判断。", "",
                          _fence(unit["text"] or "（空）")])
    return ""


def _inline_text(value: Any) -> str:
    """Neutralise Markdown delimiters in a single line of platform/user-supplied text."""
    return str(value).replace("`", "'").replace("\r", " ").replace("\n", " ")


_QUEUE_STATUS = {"queued": "排队中", "delivering": "正在投递", "paused": "已暂停", "cancelled": "已撤回"}
_QUEUE_KIND = {"steering": "转向当前回合", "followUp": "后续回合", "unknown": "类型不明"}
_AUTO_COMPACTION_FIELDS = ("enabled", "triggerPercent", "keepRecentTokens",
                           "provider", "model", "effort")
_QUEUE_OVERRIDE_FIELDS = _AUTO_COMPACTION_FIELDS[:3]



def _compaction_facts(policy: dict) -> list[str]:
    details = []
    if "enabled" in policy:
        details.append("开启" if policy["enabled"] else "关闭")
    if "triggerPercent" in policy:
        details.append(f"阈值 {policy['triggerPercent']}%")
    if "keepRecentTokens" in policy:
        details.append(f"保留最近 {policy['keepRecentTokens']} token")
    facts = ["自动压缩：" + " · ".join(details)] if details else []
    if any(key in policy for key in ("provider", "model", "effort")):
        line = f"摘要线路：{policy.get('provider') or '—'} / {policy.get('model') or '—'}"
        if policy.get("effort"):
            line += f" · {policy['effort']}"
        facts.append(line)
    return facts


def _queue_facts(item: dict, *, code: bool = False) -> list[str]:
    facts = []
    if item["inputPersisted"] is not None:
        facts.append("输入是否已写入会话：" + ("是" if item["inputPersisted"] else "否"))
    if item["status"] == "paused" and item["failureCode"]:
        facts.append(f"失败码：{item['failureCode']}")
    if item["deduplicated"]:
        facts.append("与既有请求关联")
    if item["skillIds"]:
        values = [_inline_code(value) if code else value for value in item["skillIds"]]
        facts.append("技能：" + "、".join(values))
    elif item["skillCount"]:
        facts.append(f"技能：{item['skillCount']} 项")
    if item["autoCompaction"]:
        facts.extend(_compaction_facts(item["autoCompaction"]))
    return facts


def _queue_heading(item: dict) -> str:
    return (f"队列项 {_inline_code(item['queueId'])} · "
            f"{_QUEUE_KIND.get(item['kind'], '类型不明')} · {_QUEUE_STATUS.get(item['status'], '状态不明')}")


def _render_queue_markdown(queue: dict) -> str:
    items = queue["items"]
    if not items:
        return ""
    parts = ["## 消息队列（未形成回合）", "",
             "> 当前会话的队列状态，与导出视图无关；以下消息没有对应的已记录回合。", ""]
    if queue["totalItems"] > len(items):
        parts += [f"- 共 {queue['totalItems']} 个未形成回合的队列项，最多列出 {len(items)} 个（暂停项优先）。", ""]
    for item in items:
        parts += [f"### {_queue_heading(item)}", ""]
        facts = _queue_facts(item, code=True)
        if facts:
            parts += ["- " + "；".join(facts), ""]
        parts += [_fence(item["input"] or "（空）"), ""]
    return "\n".join(parts).rstrip()


def _render_markdown(meta: dict, units: list[tuple[str, dict]], counts: dict, total_units: int,
                     max_bytes: int, queue: dict) -> str:
    view_log = meta["view"] == "log"
    usage = meta["usage"]
    header = [
        "# BOSS Harness 会话导出", "",
        "> 用于复盘与问题报告。默认已脱敏：凭据、令牌、环境变量、本机绝对路径与附件内容不导出。"
        + ("**本文件包含工具参数与结果明文（未再做个人信息打码，可能含候选人姓名、联系方式、简历等），请勿外传或上传到公开问题报告。**"
           if meta["toolResults"] == "included"
           else "工具结果只保留结构与执行状态；个人信息按工具数据中识别到的字段值打码，"
                "未出现在工具数据中的姓名或联系方式可能无法识别，对外发送前请自行核对。"),
        "",
        f"- 会话：{_inline_code(meta['threadId'])}（标题：{_inline_text(meta['title']) or '—'}）",
        f"- 视图：{'完整日志（含已切离分支）' if view_log else '当前分支'}；回合 {meta['turnCount']} 个",
        f"- 导出时间：{meta['exportedAt']}；内核 {meta['serverVersion']}；协议 {meta['protocolVersion']}",
        f"- 工具结果明文：{'已包含' if meta['toolResults'] == 'included' else '未包含'}",
        f"- 会话用量（{usage['source']}，费用未计价）：{_tokens(usage['totals'])}",
    ]
    if usage["summaryTasks"]["requests"]:
        header.append(f"- 摘要任务用量：{_tokens(usage['summaryTasks'])}")
    jobs = usage.get("summaryJobs") or []
    if jobs:
        shown = jobs[-MAX_EXPORT_SUMMARY_JOBS:]
        header.append(f"- 摘要任务明细：最近 {len(shown)} / {usage.get('summaryJobCount', len(jobs))} 个任务")
        header += [f"  - {_inline_text('；'.join(_summary_job_facts(job)))}" for job in shown]
    if queue["totalItems"]:
        header.append(f"- 消息队列：{queue['totalItems']} 个未形成回合的队列项")
    header += ["", "内容来源：「用户输入」为操作者原文；「模型输出」与模型生成的摘要属于模型判断，需核对；"
               "「工具调用」的执行状态与结果来自招聘平台工具，是平台事实的来源。", ""]
    body = [_render_unit(unit, view_log) for _, unit in units]
    queue_block = _render_queue_markdown(queue)
    if queue_block:
        body.append(queue_block)
    footer = ["", "---", "",
              f"脱敏统计：凭据 / 令牌 {counts['secrets']} 处，环境变量 {counts['environment']} 处，"
              f"本机路径 {counts['paths']} 处，候选人信息 {counts['personalInfo']} 处。"]
    if len(units) < total_units:
        footer.append(f"\n**已截断**：超出导出上限 {max_bytes:,} 字节，仅包含前 {len(units)} / {total_units} 个条目；"
                      "其余回合与条目未导出。")
    if meta.get("orphanEntries"):
        footer.append(f"\n另有 {meta['orphanEntries']} 个条目无法归属到任何回合（记录不完整），未导出。")
    return "\n".join(header) + "\n" + "\n\n".join(body) + "\n" + "\n".join(footer) + "\n"


def _render_json(meta: dict, units: list[tuple[str, dict]], counts: dict, total_units: int,
                 max_bytes: int, queue: dict) -> str:
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
                "beforeFirstTurn": preamble, "turns": turns, "queue": queue,
                "truncated": len(units) < total_units,
                "exportedEntries": len(units), "totalEntries": total_units, "maxBytes": max_bytes}
    return json.dumps(document, ensure_ascii=False, indent=2, default=str) + "\n"


_HTML_STYLE = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 62rem; padding: 2rem 1rem 4rem; background: Canvas; color: CanvasText;
  font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
h2 { font-size: 1.15rem; margin: 0; }
h3 { font-size: 1rem; margin: 0 0 .5rem; }
h4 { font-size: .95rem; margin: 1rem 0 .25rem; }
p { margin: .35rem 0; }
ul { margin: .25rem 0 .5rem; padding-left: 1.25rem; }
li { margin: .15rem 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
pre { margin: .5rem 0; padding: .75rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  background: color-mix(in srgb, CanvasText 6%, Canvas); border-radius: 8px; }
.notice { padding: .75rem; border-left: 4px solid #c2410c; background: color-mix(in srgb, #c2410c 8%, Canvas); }
.meta { padding-left: 1.25rem; }
section { margin: 1.5rem 0 0; padding: 1rem; border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
  border-radius: 10px; }
section.turn > h2 { display: flex; gap: .5rem; align-items: baseline; flex-wrap: wrap; }
.turn-meta { color: color-mix(in srgb, CanvasText 75%, Canvas); }
.badge { font-size: .8em; padding: .1rem .45rem; border-radius: 999px;
  border: 1px solid color-mix(in srgb, CanvasText 30%, Canvas); }
.entry { margin-top: 1rem; padding-top: .75rem; border-top: 1px dashed color-mix(in srgb, CanvasText 20%, Canvas); }
.entry.user h3 { color: #1d4ed8; }
.entry.model h3 { color: #7c3aed; }
.entry.tool h3 { color: #047857; }
.entry.tool.write h3 { color: #b45309; }
.entry.summary h3 { color: #0369a1; }
.entry.queue h3 { color: #b45309; }
.plaintext { border-left: 3px solid #b45309; }
footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid color-mix(in srgb, CanvasText 25%, Canvas);
  color: color-mix(in srgb, CanvasText 80%, Canvas); }
@media print { body { max-width: none; padding: 0; } section { break-inside: avoid; } }
"""


def _h(value: Any) -> str:
    return escape(str(value), quote=True)


def _turn_heading_html(unit: dict, view_log: bool) -> str:
    status = _TURN_STATUS.get(unit["status"], "状态不明")
    meta = [f"开始：{unit['startedAt'] or '—'}", f"结束：{unit['completedAt'] or '—'}"]
    if unit["model"]:
        meta.append(f"模型：{unit['provider'] or '—'} / {unit['model']}")
    if view_log:
        meta.append("在当前分支：" + ("是" if unit["onCurrentBranch"] else "否（已切离的分支）"))
    if unit["failureCode"]:
        meta.append(f"失败 / 恢复原因：{unit['failureCode']}")
    if unit["compactionPolicy"]:
        meta.extend(_compaction_facts(unit["compactionPolicy"]))
    if unit["skillIds"]:
        meta.append("本回合技能：" + "、".join(unit["skillIds"]))
    return "".join([
        f'<section class="turn">',
        f'<h2>回合 {unit["index"]} · <code>{_h(unit["turnId"])}</code> <span class="badge">{_h(status)}</span></h2>',
        f'<p class="turn-meta">{"；".join(_h(item) for item in meta)}</p>',
        f'<p class="turn-meta">用量（provider 上报，不估算、不计价）：{_h(unit["usageLabel"])}</p>',
    ])


def _render_unit_html(unit: dict) -> str:
    kind = unit["kind"]
    if kind == "userInput":
        title = "用户输入" + ("（来自消息队列）" if unit["queued"] else "")
        parts = [f'<div class="entry user"><h3>{_h(title)}</h3>',
                 f'<pre>{_h(unit["text"] or "（空）")}</pre>']
        if unit["attachments"]:
            items = "".join(
                f'<li>{_h(a["mediaType"] or "未知类型")} {_h(a["bytes"] if a["bytes"] is not None else "?")} 字节</li>'
                for a in unit["attachments"])
            parts.append(f'<p>附件 {len(unit["attachments"])} 个（文件名与内容未导出）：</p><ul>{items}</ul>')
        parts.append("</div>")
        return "".join(parts)
    if kind == "modelOutput":
        status = "" if unit["status"] == "completed" else f"（状态：{unit['status']}，可能不完整）"
        parts = [f'<div class="entry model"><h3>模型输出（模型判断，未经平台核实）{_h(status)}</h3>',
                 f'<pre>{_h(unit["text"] or "（无文本）")}</pre>']
        if unit["thinkingCharacters"]:
            parts.append(f'<p>模型推理内容 {unit["thinkingCharacters"]} 字符，未导出。</p>')
        parts.append("</div>")
        return "".join(parts)
    if kind == "toolCall":
        execution = unit["execution"]
        executed = {True: "是", False: "否", None: "未知，需核对平台状态"}[execution["executed"]]
        classes = "entry tool" + (" write" if execution["externalWrite"] else "")
        parts = [f'<div class="{classes}"><h3>工具调用 <code>{_h(unit["toolName"])}</code> — {_h(execution["label"])}</h3><ul>',
                 f'<li>执行状态：<code>{_h(execution["state"])}</code>（记录状态 <code>{_h(unit["status"])}</code>）；'
                 f'已执行：{executed}；{"外部写操作" if execution["externalWrite"] else "只读"}</li>']
        approval = unit.get("approval")
        if approval:
            decision = {"approve": "用户批准", "deny": "用户拒绝", "expired": "审批已过期",
                        None: "等待审批"}.get(approval["decision"], "状态不明")
            parts.append(f'<li>审批：{_h(decision)}'
                         + (f'（{_h(approval["decidedAt"])}）' if approval["decidedAt"] else "") + "</li>")
        if unit["errorCode"]:
            parts.append(f'<li>错误码：<code>{_h(unit["errorCode"])}</code></li>')
        if unit["recoveryAction"]:
            parts.append(f'<li>恢复建议：{_h(unit["recoveryAction"])}</li>')
        if unit.get("source"):
            parts.append("<li>来源：" + "；".join(f"{_h(key)}={_h(value)}" for key, value in unit["source"].items())
                         + "</li>")
        if unit["arguments"]:
            shown = "，".join(f"{_h(key)}={_h(json.dumps(value, ensure_ascii=False))}" if not (
                isinstance(value, str) and value.startswith(OMITTED)) else f"{_h(key)}={_h(value)}"
                for key, value in unit["arguments"].items())
            parts.append(f"<li>参数：{shown}</li>")
        result = unit["result"]
        if result is None:
            parts.append("<li>结果：无（未执行或尚未返回）</li>")
        elif result["included"]:
            parts.append(f'<li>结果明文（平台事实；含个人信息，请勿外传）：</li></ul>'
                         f'<pre class="plaintext">{_h(result["text"])}</pre>')
            return "".join(parts) + "</div>"
        else:
            parts.append(f'<li>结果（仅结构与状态，明文已省略）：{_h("；".join(_result_facts(result)))}</li>')
        parts.append("</ul></div>")
        return "".join(parts)
    if kind in {"branchSummary", "compactionSummary"}:
        extra = []
        if kind == "branchSummary" and unit.get("abandonedTurnCount"):
            extra.append(f"被放弃回合 {unit['abandonedTurnCount']} 个")
        if unit.get("summaryModel"):
            extra.append(f"摘要模型 {unit['summaryModel']}")
        if unit.get("summaryJobId"):
            extra.append(f"摘要任务 {_inline_text(unit['summaryJobId'])}")
        if unit.get("reason") in _JOB_REASON:
            extra.append(_JOB_REASON[unit["reason"]])
        extra_text = f"；{'；'.join(extra)}" if extra else ""
        return "".join([f'<div class="entry summary"><h3>{_h(unit["label"])}</h3>',
                        f'<p>生成时间：{_h(unit.get("createdAt") or "—")}{_h(extra_text)}</p>',
                        "<p>其中平台事实以原始工具结果为准，结论与推断属于模型判断。</p>",
                        f'<pre>{_h(unit["text"] or "（空）")}</pre></div>'])
    return ""


def _render_queue_html(queue: dict) -> str:
    items = queue["items"]
    if not items:
        return ""
    parts = ['<section class="queue"><h2>消息队列（未形成回合）</h2>',
             "<p>当前会话的队列状态，与导出视图无关；以下消息没有对应的已记录回合。</p>"]
    if queue["totalItems"] > len(items):
        parts.append(f"<p>共 {queue['totalItems']} 个未形成回合的队列项，最多列出 {len(items)} 个（暂停项优先）。</p>")
    for item in items:
        kind = _QUEUE_KIND.get(item["kind"], "类型不明")
        status = _QUEUE_STATUS.get(item["status"], "状态不明")
        parts.append(f'<div class="entry queue"><h3>队列项 <code>{_h(item["queueId"])}</code> · '
                     f'{_h(kind)} · {_h(status)}</h3>')
        facts = _queue_facts(item)
        if facts:
            parts.append("<ul>" + "".join(f"<li>{_h(fact)}</li>" for fact in facts) + "</ul>")
        parts.append(f'<pre>{_h(item["input"] or "（空）")}</pre></div>')
    parts.append("</section>")
    return "".join(parts)


def _render_html(meta: dict, units: list[tuple[str, dict]], counts: dict, total_units: int,
                 max_bytes: int, queue: dict) -> str:
    view_log = meta["view"] == "log"
    usage = meta["usage"]
    notice = ("用于复盘与问题报告。默认已脱敏：凭据、令牌、环境变量、本机绝对路径与附件内容不导出。"
              + ("<strong>本文件包含工具参数与结果明文（未再做个人信息打码，可能含候选人姓名、联系方式、简历等），"
                 "请勿外传或上传到公开问题报告。</strong>"
                 if meta["toolResults"] == "included"
                 else "工具结果只保留结构与执行状态；个人信息按工具数据中识别到的字段值打码，"
                      "未出现在工具数据中的姓名或联系方式可能无法识别，对外发送前请自行核对。"))
    rows = [
        f"会话：<code>{_h(meta['threadId'])}</code>（标题：{_h(meta['title']) or '—'}）",
        f"视图：{'完整日志（含已切离分支）' if view_log else '当前分支'}；回合 {meta['turnCount']} 个",
        f"导出时间：{_h(meta['exportedAt'])}；内核 {_h(meta['serverVersion'])}；"
        f"协议 {_h(meta['protocolVersion'])}",
        f"工具结果明文：{'已包含' if meta['toolResults'] == 'included' else '未包含'}",
        f"会话用量（{_h(usage['source'])}，费用未计价）：{_h(_tokens(usage['totals']))}",
    ]
    if usage["summaryTasks"]["requests"]:
        rows.append(f"摘要任务用量：{_h(_tokens(usage['summaryTasks']))}")
    jobs = usage.get("summaryJobs") or []
    if jobs:
        shown = jobs[-MAX_EXPORT_SUMMARY_JOBS:]
        rows.append(f"摘要任务明细：最近 {len(shown)} / {usage.get('summaryJobCount', len(jobs))} 个任务")
        rows += [f"摘要任务：{_h(_inline_text('；'.join(_summary_job_facts(job))))}" for job in shown]
    if queue["totalItems"]:
        rows.append(f"消息队列：{queue['totalItems']} 个未形成回合的队列项")
    parts = ['<!doctype html>', '<html lang="zh-CN"><head><meta charset="utf-8">',
             '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
             '<meta name="referrer" content="no-referrer">',
             '<meta name="viewport" content="width=device-width, initial-scale=1">',
             '<title>BOSS Harness 会话导出</title>', f"<style>{_HTML_STYLE}</style></head><body>",
             "<header><h1>BOSS Harness 会话导出</h1>",
             f'<p class="notice">{notice}</p>',
             '<ul class="meta">' + "".join(f"<li>{row}</li>" for row in rows) + "</ul>",
             "<p>内容来源：「用户输入」为操作者原文；「模型输出」与模型生成的摘要属于模型判断，需核对；"
             "「工具调用」的执行状态与结果来自招聘平台工具，是平台事实的来源。</p></header><main>"]
    open_section = False
    for _, unit in units:
        if unit["kind"] == "turn":
            if open_section:
                parts.append("</section>")
            parts.append(_turn_heading_html(unit, view_log))
            open_section = True
        else:
            if not open_section:
                parts.append('<section class="preamble">')
                open_section = True
            parts.append(_render_unit_html(unit))
    if open_section:
        parts.append("</section>")
    queue_html = _render_queue_html(queue)
    if queue_html:
        parts.append(queue_html)
    parts.append("</main><footer>")
    parts.append(f"<p>脱敏统计：凭据 / 令牌 {counts['secrets']} 处，环境变量 {counts['environment']} 处，"
                 f"本机路径 {counts['paths']} 处，个人信息 {counts['personalInfo']} 处。</p>")
    if len(units) < total_units:
        parts.append(f"<p><strong>已截断</strong>：超出导出上限 {max_bytes:,} 字节，仅包含前 "
                     f"{len(units)} / {total_units} 个条目；其余回合与条目未导出。</p>")
    if meta.get("orphanEntries"):
        parts.append(f"<p>另有 {meta['orphanEntries']} 个条目无法归属到任何回合（记录不完整），未导出。</p>")
    parts.append("</footer></body></html>")
    return "\n".join(parts) + "\n"


def _suggested_file_name(thread_id: str, view: str, extension: str) -> str:
    """导出文件默认名：只含固定前缀、会话 id、视图与扩展名，不带标题或路径。"""
    return f"boss-harness-session-{thread_id}-{view}.{extension}"


def _wire_bytes(text: str) -> int:
    return len(json.dumps(text, ensure_ascii=False).encode("utf-8"))


def export_thread(sessions: SessionStore, thread_id: str, *, branch: bool, fmt: str,
                  include_tool_results: bool, max_bytes: int, server_version: str,
                  secrets: Iterable[str] = (), paths: Iterable[Path | str] = (),
                  active_summary_job_id: str | None = None,
                  entries: list[dict] | None = None) -> dict:
    """Render one session as a bounded, redacted document; reads only, writes nothing.

    ``active_summary_job_id`` is the caller's validated current-branch
    checkpoint job; it only marks the matching summary-task usage row.
    ``entries`` may pin the snapshot a caller already read so the document and
    that marker describe the same records.
    """
    if fmt not in EXPORT_FORMATS:
        raise ValueError("format 必须是 markdown、json 或 html")
    if type(include_tool_results) is not bool:
        raise ValueError("includeToolResults 必须是布尔值")
    if type(max_bytes) is not int or not MIN_EXPORT_BYTES <= max_bytes <= MAX_EXPORT_BYTES:
        raise ValueError(f"maxBytes 必须是 {MIN_EXPORT_BYTES} 到 {MAX_EXPORT_BYTES} 的整数")
    redactor = Redactor(secrets=_known_secrets(secrets), paths=_known_paths(paths))
    exporter = _Exporter(sessions, thread_id, branch=branch,
                         include_tool_results=include_tool_results, redactor=redactor,
                         active_summary_job_id=active_summary_job_id, entries=entries)
    units = exporter.units()
    meta = exporter.meta(server_version)
    queue = exporter.queue()
    render = {"markdown": _render_markdown, "json": _render_json, "html": _render_html}[fmt]
    counts = dict(redactor.counts)

    def size(count: int) -> int:
        # Budget the escaped transport spelling: it bounds the written file and keeps the
        # response under the single-page RPC limit even for JSON-heavy content.
        return _wire_bytes(render(meta, units[:count], counts, len(units), max_bytes, queue))

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
    content = render(meta, units[:keep], counts, len(units), max_bytes, queue)
    if _wire_bytes(content) > max_bytes:
        raise ValueError("会话导出头部超出大小上限")
    exported_turns = sum(1 for _, unit in units[:keep] if unit["kind"] == "turn")
    extension = {"markdown": "md", "json": "json", "html": "html"}[fmt]
    return {"threadId": thread_id, "view": meta["view"], "format": fmt,
            "mediaType": {"markdown": "text/markdown", "json": "application/json",
                          "html": "text/html"}[fmt],
            "suggestedFileName": _suggested_file_name(thread_id, meta["view"], extension),
            "content": content, "bytes": len(content.encode("utf-8")), "maxBytes": max_bytes,
            "truncated": keep < len(units), "turnCount": len(exporter.turns), "exportedTurnCount": exported_turns,
            "toolResults": meta["toolResults"], "redactions": counts}
