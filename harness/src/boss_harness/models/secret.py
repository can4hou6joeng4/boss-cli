"""凭据的包装与错误文本脱敏。

存在理由：治理文档要求凭据不得进入代码、测试样例或公开日志。只给 dataclass 字段加
`repr=False` 是不够的——`dataclasses.asdict()` 无视它，会把字段值原样吐出来；一旦有人为了
日志或快照写一行 `json.dumps(asdict(config))`，凭据就明文落盘了。

`Secret` 把这件事变成结构性保证：
- `repr` / `str` 一律输出 `<redacted>`，误打进日志也拿不到明文；
- 它不是可 JSON 序列化的对象，`json.dumps(asdict(config))` 会直接失败，而不是安静地泄漏。

`redact_secrets` 是第二道网：错误文本常被写进会话文件并推给外壳，若上游把它回显过的
Authorization 或 api_key 带回来，这里会把它抹掉。
"""
from __future__ import annotations

import re

#: 常见凭据形态：Bearer 令牌、sk- 前缀密钥、以及 key/token/secret/password 的赋值形式。
_PATTERNS = (
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{6,}"),
    re.compile(r"\bsk-[A-Za-z0-9._\-]{6,}"),
    re.compile(r"(?i)\b(api[_-]?key|auth[_-]?token|access[_-]?token|token|secret|password)\b"
               r"([\"']?\s*[:=]\s*[\"']?)([A-Za-z0-9._\-]{6,})"),
)

_REDACTED = "<redacted>"


class Secret:
    """一次性凭据的包装；取值必须显式调用 `get()`。

    刻意**不写成 dataclass**：`dataclasses.asdict()` 会递归进 dataclass 并把字段值原样取出
    （这正是它绕过 `repr=False` 的原因）。普通对象它只做一次 deepcopy，于是
    `json.dumps(asdict(config))` 会因为「对象不可 JSON 序列化」直接失败，而不是安静地泄漏明文。
    """

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def get(self) -> str:
        return self._value

    def __bool__(self) -> bool:
        return bool(self._value)

    def __repr__(self) -> str:
        return _REDACTED

    __str__ = __repr__


def redact_secrets(text: str, extra: tuple[str, ...] = ()) -> str:
    """抹掉文本里的凭据。

    `extra` 用于传入调用方已知的凭据原值：比起靠形态猜，直接按值替换最可靠。
    """
    if not text:
        return text
    out = text
    for candidate in extra:
        if candidate and len(candidate) >= 6:
            out = out.replace(candidate, _REDACTED)
    out = _PATTERNS[0].sub(f"Bearer {_REDACTED}", out)
    out = _PATTERNS[1].sub(_REDACTED, out)
    out = _PATTERNS[2].sub(lambda match: f"{match.group(1)}{match.group(2)}{_REDACTED}", out)
    return out
