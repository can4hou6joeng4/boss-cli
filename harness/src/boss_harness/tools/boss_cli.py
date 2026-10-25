"""领域工具适配：经进程边界调用 boss-agent-cli。

这是"只经进程边界复用上游"的落点：绝不 import 上游 Python 代码，
只启动子进程、只读它 stdout 上的七键 JSON 信封。
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from shutil import which
from typing import Any, Callable

from boss_harness.models.secret import redact_secrets
from boss_harness.toolkit import ToolResult

DEFAULT_TIMEOUT_SECONDS = 120

# Public CLI labels, checked against boss-agent-cli@bdc7034df563f1ea458d3af5bb4b40e8ea4603a8
# src/boss_agent_cli/api/boss.yaml and search_filters.py. This adapter accepts
# enum labels only; experience/education also accept explicit label arrays.
SEARCH_FILTER_VALUES: dict[str, tuple[str, ...]] = {
    "city": (
        "北京", "上海", "广州", "深圳", "杭州", "成都", "南京", "武汉", "西安", "苏州",
        "长沙", "郑州", "重庆", "天津", "合肥", "厦门", "济南", "青岛", "大连", "宁波",
        "福州", "东莞", "珠海", "佛山", "昆明", "贵阳", "太原", "南昌", "南宁", "石家庄",
        "哈尔滨", "长春", "沈阳", "海口", "兰州", "乌鲁木齐", "无锡", "常州", "温州", "惠州",
    ),
    "salary": ("3K以下", "3-5K", "5-10K", "10-15K", "10-20K", "20-50K", "50K以上"),
    "experience": ("应届", "1年以内", "1-3年", "3-5年", "5-10年", "10年以上"),
    "education": ("大专", "本科", "硕士", "博士"),
}


def _search_set_schema(field: str, description: str) -> dict[str, Any]:
    labels = list(SEARCH_FILTER_VALUES[field])
    return {
        "anyOf": [
            {"type": "string", "enum": labels},
            {"type": "array", "items": {"type": "string", "enum": labels},
             "minItems": 1, "maxItems": len(labels), "uniqueItems": True},
        ],
        "description": description,
    }

# 来自上游 schema/error_codes.py；命中后必须交回用户，不能继续自动调用。
PAUSE_CODES = frozenset({
    "AUTH_REQUIRED", "AUTH_EXPIRED", "LOGIN_EXPIRED", "TOKEN_REFRESH_FAILED",
    "ACCOUNT_RISK", "ENVIRONMENT_RISK", "ENVIRONMENT_RISK_LOCKED", "LOGIN_RISK_CONTROL",
    "RATE_LIMITED", "REQUEST_BUDGET_EXHAUSTED", "CAPTCHA_REQUIRED", "CAPTCHA_FAILED",
    "VERIFICATION_REQUIRED", "PLATFORM_VERIFICATION_REQUIRED", "GREET_LIMIT", "GREET_RESULT_UNKNOWN", "ACTION_UNCONFIRMED",
    "CIRCUIT_BREAKER_OPEN", "STOPPED_BY_SAFETY", "RECRUITER_NOT_AUTHORIZED",
})

#: 显式指定上游二进制的环境变量（最高优先级）。
BINARY_ENV = "BOSS_CLI_BIN"

_HERE = Path(__file__).resolve()
#: 仓库根（harness/src/boss_harness/tools/ -> 上溯四级）。
REPO_ROOT = _HERE.parents[4]


@dataclass
class BinaryChoice:
    path: str
    source: str  # env | sibling | path


def resolve_binary(explicit: str | None = None) -> BinaryChoice:
    """按优先级找一个可用的上游二进制，并说明来源。

    顺序：显式参数 -> 环境变量 -> 并排的上游仓库虚拟环境 -> PATH。
    并排候选是为规避 PATH 上可能存在的悬空安装（本项目早期版本留下过）。
    """
    if explicit:
        return BinaryChoice(explicit, "explicit")
    env = os.environ.get(BINARY_ENV)
    if env:
        return BinaryChoice(env, "env")

    sibling = REPO_ROOT.parent / "boss-agent-cli" / ".venv" / "bin" / "boss"
    if sibling.exists():
        return BinaryChoice(str(sibling), "sibling")

    found = which("boss")
    if found:
        return BinaryChoice(found, "path")
    return BinaryChoice("boss", "path")


class BossCliTool:
    """一个 boss 命令就是一个工具。始终传 --json 并捕获管道。"""

    def __init__(self, binary: str | None = None, data_dir: str | None = None) -> None:
        choice = resolve_binary(binary)
        self.binary = choice.path
        self.source = choice.source
        self.data_dir = data_dir or os.environ.get("BOSS_CLI_DATA_DIR")
        self.cancel_event: threading.Event | None = None

    def available(self) -> bool:
        return (Path(self.binary).is_file() and os.access(self.binary, os.X_OK)) if "/" in self.binary else which(self.binary) is not None

    def call(self, *args: str, timeout: int = DEFAULT_TIMEOUT_SECONDS, stdin: str | None = None) -> ToolResult:
        argv = [self.binary, "--json"]
        if self.data_dir:
            argv += ["--data-dir", self.data_dir]
        argv += list(args)
        def failure(code: str, message: str) -> ToolResult:
            return ToolResult(ok=False, command=" ".join(args), error={"code": code, "message": redact_secrets(message)})

        if self.cancel_event is not None and self.cancel_event.is_set():
            return failure("CANCELLED", "操作已停止，未启动 CLI")
        try:
            proc = subprocess.Popen(argv, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                    start_new_session=os.name == "posix")
        except OSError:
            return failure("CLI_ERROR", "上游 CLI 不可执行，请检查 BOSS_CLI_BIN")
        deadline = time.monotonic() + timeout
        completed = threading.Event()
        output: list[tuple[str, str]] = []
        def communicate() -> None:
            try:
                # One I/O exchange handles pipe backpressure. Retrying communicate
                # with an empty input can strand a partially written credential.
                output.append(proc.communicate(input=stdin))
            except (OSError, ValueError):
                pass
            finally:
                completed.set()
        io_worker = threading.Thread(target=communicate, daemon=True, name="boss-cli-stdio")
        io_worker.start()
        while not completed.is_set():
            cancelled = self.cancel_event is not None and self.cancel_event.is_set()
            if cancelled or time.monotonic() >= deadline:
                self._terminate(proc)
                io_worker.join(1)
                code = "CANCELLED" if cancelled else "TOOL_TIMEOUT"
                return failure(code, "CLI 已停止；已发出的操作可能生效，请先核对平台状态，不要直接重试。")
            completed.wait(min(0.1, max(0.001, deadline - time.monotonic())))
        if not output:
            return failure("CLI_ERROR", "CLI 输入输出未能完成")
        stdout, stderr = output[0]

        stdout = stdout.strip()
        if not stdout:
            return ToolResult(
                ok=False,
                command=" ".join(args),
                error={"code": "CLI_ERROR", "message": redact_secrets(stderr.strip()[:400]) or "无输出"},
            )
        try:
            envelope = json.loads(stdout)
        except json.JSONDecodeError:
            return failure("CLI_ERROR", "stdout 不是 JSON 信封")

        keys = {"ok", "schema_version", "command", "data", "pagination", "error", "hints"}
        if (not isinstance(envelope, dict) or set(envelope) != keys
                or type(envelope["ok"]) is not bool
                or not isinstance(envelope["schema_version"], str)
                or not envelope["schema_version"].startswith("1.")
                or not isinstance(envelope["command"], str)
                or proc.returncode != (0 if envelope["ok"] else 1)
                or (envelope["hints"] is not None and not isinstance(envelope["hints"], dict))
                or (envelope["pagination"] is not None and not isinstance(envelope["pagination"], dict))
                or (envelope["ok"] and envelope["error"] is not None)
                or (not envelope["ok"] and (not isinstance(envelope["error"], dict)
                    or not isinstance(envelope["error"].get("code"), str)
                    or not isinstance(envelope["error"].get("message"), str)))):
            return failure("CLI_CONTRACT_ERROR", "上游输出不符合 v1 七键信封或退出码契约，请核对上游版本")

        ok = envelope["ok"]
        error = envelope["error"]
        # This business command reports list success even if summary enrichment
        # hits a platform stop. Project only its explicit metadata; candidate
        # content, free-form errors and other commands cannot trigger this rule.
        if ok and args[:2] == ("hr", "chat") and envelope["command"] == "recruiter-chat":
            hints = envelope["hints"]
            summaries = hints.get("summary_sources") if type(hints) is dict else None
            code = summaries.get("last_messages_error_code") if type(summaries) is dict else None
            if type(code) is str and code in PAUSE_CODES:
                ok = False
                error = {
                    "code": code,
                    "message": "已保留本页沟通列表的部分结果；最近消息补取未完成，平台要求暂停。",
                    "recovery_action": "请先核对已取得结果，处理平台登录、验证或访问限制后，再明确发起后续任务；不要自动重试。",
                }

        return ToolResult(
            ok=ok,
            command=str(envelope.get("command", " ".join(args))),
            data=envelope.get("data"),
            error=error,
            hints=envelope.get("hints"),
            raw=stdout,
            pagination=envelope.get("pagination"),
        )

    @staticmethod
    def _terminate(proc: subprocess.Popen) -> None:
        def stop(sig: int) -> None:
            try:
                if os.name == "posix":
                    os.killpg(proc.pid, sig)
                elif proc.poll() is None:
                    proc.kill()
            except ProcessLookupError:
                pass
        stop(signal.SIGTERM)
        try:
            proc.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass
        # A child can exit before descendants close inherited pipes. The sole
        # I/O worker drains them after the process group has been retired.
        stop(signal.SIGKILL)
        proc.wait()

    # ---------- 能力发现 ----------

    def discover_tools(self) -> ToolResult:
        """向 boss schema 读取能力目录；可执行工具仍受本地允许清单约束。"""
        return self.call("schema", "--format", "mcp-tools")

    # ---------- 首版用到的只读工具 ----------

    def search(
        self, keyword: str, *, page: int | None = None, city: str | None = None,
        salary: str | None = None, experience: str | list[str] | None = None,
        education: str | list[str] | None = None,
    ) -> ToolResult:
        """读取指定条件的一页列表；不翻页、补详情或去掉条件重试。"""
        filters = {"city": city, "salary": salary, "experience": experience, "education": education}
        arguments = {"keyword": keyword, **({"page": page} if page is not None else {}),
                     **{key: value for key, value in filters.items() if value is not None}}
        validate_arguments("boss_search", arguments)
        # An omitted page keeps the original keyword-only CLI contract. Upstream
        # search defaults to page 1; an explicit page, including 1, stays explicit.
        options = [] if page is None else [f"--page={page}"]
        for key, value in filters.items():
            if value is not None:
                # Canonicalize only the CLI projection. Original structured
                # arguments remain unchanged in tool events and session history.
                label = ",".join(item for item in SEARCH_FILTER_VALUES[key] if item in value) if isinstance(value, list) else value
                options.append(f"--{key}={label}")
        return self.call("search", *options, "--", keyword)


#: 暴露给模型的工具表：只读工具与需要审批的写操作。
#: `input_schema` 一律 `additionalProperties: false`，必填字段用 `required` 显式声明。
#:
#: `requires_approval` 是给内核的闸门信号：为 True 的工具在执行前必须先拿到用户批准
#: （`approval/requested` -> `approval/respond`），拿不到就 fail closed。它对应 Pi 建议的
#: `destructiveHint` 一类的提示位，属于**提示**而非保证：真正的边界在内核的闸门本身。
TOOLS: tuple[dict[str, Any], ...] = (
    {
        "name": "boss_search",
        "description": "按关键词和明确条件读取一页职位列表（只读）；筛选是平台标签与上游列表粗筛，不代表个人资格或完整薪资匹配，不自动翻页或补详情",
        "input_schema": {
            "type": "object",
            "properties": {
                "keyword": {"type": "string", "minLength": 1, "pattern": r"\S", "description": "非空搜索关键词，例如岗位名或技能；始终作为单个位置参数"},
                "page": {"type": "integer", "minimum": 1, "default": 1, "description": "只读取此页，从 1 开始；读取下一页时须保留本次全部筛选条件"},
                "city": {"type": "string", "enum": list(SEARCH_FILTER_VALUES["city"]),
                         "description": "单个城市标签；未指定时沿用上游默认范围，不推断为用户所在地"},
                "salary": {"type": "string", "enum": list(SEARCH_FILTER_VALUES["salary"]),
                           "description": "平台薪资标签；上游本地粗筛仅排除返回薪资上限低于请求下限的职位，未知薪资可保留，不保证完整区间匹配"},
                "experience": _search_set_schema("experience", "单个岗位经验标签或非空无重复标签数组；数组表达任一标签，和其他维度同时提交一次指定页查询。多标签依赖平台筛选，不保证严格匹配或个人资格"),
                "education": _search_set_schema("education", "单个岗位学历标签或非空无重复标签数组；数组表达任一标签，和其他维度同时提交一次指定页查询。多标签依赖平台筛选，不保证严格匹配或个人资格"),
            },
            "required": ["keyword"],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, args: tool.search(**args),
    },
    {
        "name": "boss_detail",
        "description": "查看职位详细信息（含岗位职责、任职要求与公司信息，只读）",
        "input_schema": {
            "type": "object",
            "properties": {
                "security_id": {"type": "string", "description": "职位安全 ID (securityId)"},
                "job_id": {"type": "string", "description": "职位加密 ID (jobId)，可选"},
            },
            "required": ["security_id"],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, args: tool.call("detail", *([f"--job-id={args['job_id']}"] if args.get("job_id") else []), "--", args["security_id"]),
    },
    {
        "name": "boss_recommend",
        "description": "基于简历获取个性化匹配职位推荐列表（只读）",
        "input_schema": {
            "type": "object",
            "properties": {
                "page": {"type": "integer", "minimum": 1, "description": "页码，从 1 开始", "default": 1},
            },
            "required": [],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, args: tool.call("recommend", *([f"--page={args['page']}"] if args.get("page") else [])),
    },
    {
        "name": "boss_status",
        "description": "查看当前 BOSS 直聘登录状态与平台会话健康度（只读）",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, _args: tool.call("status"),
    },
    {
        "name": "boss_stats",
        "description": "查看投递转化漏斗统计与沟通数据看板（只读）",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, _args: tool.call("stats"),
    },
    {
        "name": "boss_hr_jobs",
        "description": "招聘者模式：查看已发布的职位列表（只读）",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "只允许读取列表", "enum": ["list"], "default": "list"},
            },
            "required": [],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, _args: tool.call("hr", "jobs", "list"),
    },
    {
        "name": "boss_hr_jobs_detail",
        "description": "招聘者模式：查看指定职位的完整详情（含岗位描述，只读）",
        "input_schema": {
            "type": "object",
            "properties": {
                "enc_job_id": {"type": "string", "description": "职位的加密 ID（encryptJobId）"},
            },
            "required": ["enc_job_id"],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, args: tool.call("hr", "jobs", "detail", "--", args["enc_job_id"]),
    },
    {
        "name": "boss_hr_recommendations",
        "description": "招聘者模式：读取指定职位的推荐牛人卡片列表（只读）",
        "input_schema": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string", "description": "招聘职位的加密 ID"},
                "page": {"type": "integer", "minimum": 1, "description": "页码，从 1 开始", "default": 1},
            },
            "required": ["job_id"],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, args: tool.call("hr", "recommendations", f"--job-id={args['job_id']}", *([f"--page={args['page']}"] if args.get("page") else [])),
    },
    {
        "name": "boss_hr_candidates",
        "description": "招聘者模式：搜索候选人（只读）",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词，例如技术方向或技能"},
            },
            "required": [],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, args: tool.call("hr", "candidates", "--", *([args["query"]] if args.get("query") else [])),
    },
    {
        "name": "boss_hr_chat",
        "description": "招聘者模式：查看候选人沟通列表与未读数（只读）；上游可能补取最近消息，遇平台停止信号保留部分列表并暂停，不保证摘要完整",
        "input_schema": {
            "type": "object",
            "properties": {
                "page": {"type": "integer", "minimum": 1, "description": "页码", "default": 1},
            },
            "required": [],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, args: tool.call("hr", "chat", *([f"--page={args['page']}"] if args.get("page") else [])),
    },
    {
        "name": "boss_hr_resume",
        "description": "招聘者模式：查看候选人在线简历（只读）",
        "input_schema": {
            "type": "object",
            "properties": {
                "geek_id": {"type": "string", "description": "候选人 geek_id"},
                "job_id": {"type": "string", "description": "关联职位 ID"},
                "security_id": {"type": "string", "description": "候选人 security_id"},
            },
            "required": ["geek_id", "job_id", "security_id"],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, args: tool.call("hr", "resume", f"--job-id={args['job_id']}", f"--security-id={args['security_id']}", "--", args["geek_id"]),
    },
    {
        "name": "boss_hr_greet",
        "description": "招聘者模式：向指定候选人发起首次打招呼（写操作，需操作者明确批准）",
        "input_schema": {
            "type": "object",
            "properties": {
                "geek_id": {"type": "string", "description": "推荐卡片 encryptGeekId"},
                "job_id": {"type": "string", "description": "推荐卡片 encryptJobId"},
                "expect_id": {"type": "string", "description": "推荐卡片 expectId"},
                "lid": {"type": "string", "description": "推荐卡片 lid"},
                "security_id": {"type": "string", "description": "推荐卡片 securityId"},
                "message": {"type": "string", "description": "打招呼内容文本"},
            },
            "required": ["geek_id", "job_id", "expect_id", "lid", "security_id", "message"],
            "additionalProperties": False,
        },
        "requires_approval": True,
        "handler": lambda tool, args: tool.call("hr", "greet", *(f"--{key.replace('_', '-')}={args[key]}" for key in ("geek_id", "job_id", "expect_id", "lid", "security_id", "message")), "--yes"),
    },
    {
        "name": "boss_list_tools",
        "description": "列出上游 boss-agent-cli 当前提供的全部能力目录（只读）",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
        "requires_approval": False,
        "handler": lambda tool, _args: tool.discover_tools(),
    },
)

READ_ONLY_TOOLS = tuple(tool for tool in TOOLS if not tool.get("requires_approval"))


def validate_arguments(name: str, arguments: dict[str, Any]) -> None:
    """校验允许清单声明的 JSON Schema 子集，拒绝隐式类型转换。"""
    spec = next((tool for tool in TOOLS if tool["name"] == name), None)
    if spec is None:
        return  # 未知工具由执行器返回 NOT_SUPPORTED，不能落到任意 CLI 命令。
    schema = spec["input_schema"]
    properties = schema["properties"]
    if not isinstance(arguments, dict) or set(arguments) - set(properties):
        raise ValueError("工具参数包含未知字段或不是对象")
    for key in schema["required"]:
        if key not in arguments or (isinstance(arguments[key], str) and not arguments[key].strip()):
            raise ValueError(f"缺少有效参数：{key}")
    for key, value in arguments.items():
        _validate_value(key, value, properties[key])


def _validate_value(key: str, value: Any, rule: dict[str, Any]) -> None:
    if "anyOf" in rule:
        for branch in rule["anyOf"]:
            try:
                _validate_value(key, value, branch)
            except ValueError:
                continue
            break
        else:
            raise ValueError(f"参数类型或取值无效：{key}")
    kind = rule.get("type")
    if kind is not None and type(value) is not {"string": str, "integer": int, "array": list}.get(kind):
        raise ValueError(f"参数类型无效：{key}")
    if "enum" in rule and value not in rule["enum"]:
        raise ValueError(f"参数取值无效：{key}")
    if "minimum" in rule and value < rule["minimum"]:
        raise ValueError(f"参数小于最小值：{key}")
    if kind == "string":
        if "minLength" in rule and len(value) < rule["minLength"]:
            raise ValueError(f"参数短于最小长度：{key}")
        if "pattern" in rule and re.search(rule["pattern"], value) is None:
            raise ValueError(f"参数格式无效：{key}")
    if kind == "array":
        if len(value) < rule.get("minItems", 0) or len(value) > rule.get("maxItems", len(value)):
            raise ValueError(f"参数数组长度无效：{key}")
        for index, item in enumerate(value):
            _validate_value(f"{key}[{index}]", item, rule["items"])
        if rule.get("uniqueItems") and any(item in value[:index] for index, item in enumerate(value)):
            raise ValueError(f"参数数组包含重复值：{key}")


def tool_handlers() -> dict[str, Callable[[BossCliTool, dict[str, Any]], ToolResult]]:
    return {item["name"]: item["handler"] for item in TOOLS}


def approval_required_tools() -> frozenset[str]:
    """需要用户批准才能执行的工具名。"""
    return frozenset(str(item["name"]) for item in TOOLS if item.get("requires_approval"))


def should_pause(result: ToolResult) -> bool:
    return not result.ok and (result.error or {}).get("code") in PAUSE_CODES
