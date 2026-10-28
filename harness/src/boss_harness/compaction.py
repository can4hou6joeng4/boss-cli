"""User-controlled automatic compaction policy and explicit failure contract.

Pi d5b3de22d0e24a3e9c38a9410d3329b099717283 separates request preparation
from tool execution. This harness triggers against the complete input budget,
which already excludes the unchanged output reserve and safety allowance.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os

from boss_harness.models.capabilities import REASONING_EFFORTS


_COMPACTION_FIELDS = {"enabled", "triggerPercent", "keepRecentTokens", "provider", "model", "effort"}
_PROVIDERS = {"anthropic", "openai", "codex"}

class ContextCompactionFailed(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class CompactionPolicy:
    enabled: bool = True
    trigger_percent: int = 80
    keep_recent_tokens: int = 20_000
    provider: str | None = None
    model: str | None = None
    effort: str | None = None

    def __post_init__(self) -> None:
        if type(self.enabled) is not bool:
            raise ValueError("自动压缩 enabled 必须是布尔值")
        if type(self.trigger_percent) is not int or not 1 <= self.trigger_percent <= 100:
            raise ValueError("自动压缩 triggerPercent 必须是 1 到 100 的整数")
        if type(self.keep_recent_tokens) is not int or not 1 <= self.keep_recent_tokens <= 1_000_000:
            raise ValueError("自动压缩 keepRecentTokens 必须是 1 到 1000000 的整数")
        if self.provider is not None:
            if not isinstance(self.provider, str) or self.provider.strip().lower() not in _PROVIDERS:
                raise ValueError("自动压缩 provider 必须是 anthropic、openai 或 codex")
            normalized = self.provider.strip().lower()
            object.__setattr__(self, "provider", "openai" if normalized == "codex" else normalized)
        if self.model is not None and (not isinstance(self.model, str) or not self.model.strip()
                                       or len(self.model) > 200 or any(c.isspace() for c in self.model)):
            raise ValueError("自动压缩 model 必须是最多 200 字符的非空模型 ID")
        if self.effort is not None and (not isinstance(self.effort, str)
                                        or self.effort not in REASONING_EFFORTS):
            raise ValueError("自动压缩 effort 档位无效")

    def describe(self) -> dict:
        return {"enabled": self.enabled, "triggerPercent": self.trigger_percent,
                "keepRecentTokens": self.keep_recent_tokens, "provider": self.provider,
                "model": self.model, "effort": self.effort}

    def override(self, value: object) -> CompactionPolicy:
        if not isinstance(value, dict) or set(value) - {"enabled", "triggerPercent", "keepRecentTokens"}:
            raise ValueError("autoCompaction 必须是只包含 enabled、triggerPercent、keepRecentTokens 的对象")
        return CompactionPolicy(value.get("enabled", self.enabled),
                                value.get("triggerPercent", self.trigger_percent),
                                value.get("keepRecentTokens", self.keep_recent_tokens),
                                self.provider, self.model, self.effort)

    @classmethod
    def from_environment(cls) -> CompactionPolicy:
        raw = os.environ.get("BOSS_HARNESS_COMPACTION")
        if raw is None:
            return cls()
        def unique(pairs: list[tuple]) -> dict:
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate field")
                result[key] = value
            return result
        try:
            if len(raw.encode("utf-8")) > 4096:
                raise ValueError("too large")
            value = json.loads(raw, object_pairs_hook=unique)
            if not isinstance(value, dict) or set(value) - _COMPACTION_FIELDS:
                raise ValueError("unknown field")
            return cls(value.get("enabled", True), value.get("triggerPercent", 80),
                       value.get("keepRecentTokens", 20_000), value.get("provider"),
                       value.get("model"), value.get("effort"))
        except (TypeError, ValueError, UnicodeError):
            raise ValueError("BOSS_HARNESS_COMPACTION 配置无效；请检查自动压缩字段与类型") from None
