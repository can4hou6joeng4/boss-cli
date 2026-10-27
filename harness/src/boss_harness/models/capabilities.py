"""模型容量声明，与供应商传输及凭据解析分离。

职责参考 Pi commit d5b3de22d0e24a3e9c38a9410d3329b099717283（MIT）的
packages/ai/src/types.ts Model.contextWindow/maxTokens。这里独立实现显式容量
覆盖，不引入 Pi 的模型目录；未知模型沿用原有容量并明确标为估算。
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType


_ENV_NAME = "BOSS_HARNESS_MODEL_LIMITS"
_MAX_JSON_BYTES = 64 * 1024
_MAX_MODELS = 128
_PROVIDERS = frozenset({"anthropic", "openai", "none"})
_FIELDS = frozenset({"contextWindow", "maxOutputTokens", "reasoningEfforts"})
_REQUIRED_FIELDS = frozenset({"contextWindow", "maxOutputTokens"})
REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
_REASONING_EFFORT_SET = frozenset(REASONING_EFFORTS)
_CONFIG_ERROR = "BOSS_HARNESS_MODEL_LIMITS 必须是有效的模型容量配置"
_UNSET = object()


@dataclass(frozen=True)
class ModelCapabilities:
    context_window: int
    max_output_tokens: int
    source: str = "configured"
    estimated: bool = False
    reasoning_efforts: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if (type(self.context_window) is not int or self.context_window <= 4096
                or type(self.max_output_tokens) is not int or self.max_output_tokens <= 0
                or self.max_output_tokens > self.context_window):
            raise ValueError("模型上下文窗口必须大于 4096，输出上限必须为不超过窗口的正整数")
        if not isinstance(self.source, str) or not self.source.strip() or type(self.estimated) is not bool:
            raise ValueError("模型容量来源或估算标记无效")
        if (not isinstance(self.reasoning_efforts, tuple)
                or len(self.reasoning_efforts) > len(_REASONING_EFFORT_SET)
                or any(not isinstance(level, str) or level not in _REASONING_EFFORT_SET
                       for level in self.reasoning_efforts)
                or len(set(self.reasoning_efforts)) != len(self.reasoning_efforts)):
            raise ValueError("模型推理档位声明无效")

    def describe(self) -> dict[str, int | str | bool | list[str]]:
        return {"contextWindow": self.context_window, "maxOutputTokens": self.max_output_tokens,
                "capabilitySource": self.source, "capacityIsEstimate": self.estimated,
                "reasoningEfforts": list(self.reasoning_efforts)}


_LEGACY_DEFAULT = ModelCapabilities(200_000, 64_000, source="legacy-default", estimated=True)


def _valid_key(key: object) -> bool:
    return (isinstance(key, tuple) and len(key) == 2 and isinstance(key[0], str)
            and key[0] in _PROVIDERS and isinstance(key[1], str) and bool(key[1])
            and not any(char.isspace() for char in key[1]))


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(_CONFIG_ERROR)
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise ValueError(_CONFIG_ERROR)


@dataclass(frozen=True, init=False)
class ModelCatalog:
    _overrides: Mapping[tuple[str, str], ModelCapabilities] = field(repr=False)

    def __init__(self, overrides: Mapping[tuple[str, str], ModelCapabilities] | None = None) -> None:
        if overrides is None:
            copied: dict[tuple[str, str], ModelCapabilities] = {}
        else:
            if not isinstance(overrides, Mapping) or len(overrides) > _MAX_MODELS:
                raise ValueError("模型容量覆盖表无效")
            copied = {}
            for key, value in overrides.items():
                if not _valid_key(key) or not isinstance(value, ModelCapabilities):
                    raise ValueError("模型容量覆盖表无效")
                copied[key] = value
        object.__setattr__(self, "_overrides", MappingProxyType(copied))

    def resolve(self, provider: str, model: str) -> ModelCapabilities:
        return self._overrides.get((provider, model), _LEGACY_DEFAULT)

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> ModelCatalog:
        raw = (os.environ if environ is None else environ).get(_ENV_NAME, _UNSET)
        if raw is _UNSET:
            return cls()
        try:
            if not isinstance(raw, str) or len(raw.encode("utf-8")) > _MAX_JSON_BYTES:
                raise ValueError(_CONFIG_ERROR)
            parsed = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
            if not isinstance(parsed, dict) or len(parsed) > _MAX_MODELS:
                raise ValueError(_CONFIG_ERROR)
            overrides: dict[tuple[str, str], ModelCapabilities] = {}
            for name, limits in parsed.items():
                provider, separator, model = name.partition("/")
                key = (provider, model)
                if (not separator or not _valid_key(key) or not isinstance(limits, dict)
                        or not _REQUIRED_FIELDS <= set(limits) or set(limits) - _FIELDS):
                    raise ValueError(_CONFIG_ERROR)
                efforts = limits.get("reasoningEfforts", [])
                if (not isinstance(efforts, list) or any(not isinstance(level, str) for level in efforts)):
                    raise ValueError(_CONFIG_ERROR)
                overrides[key] = ModelCapabilities(limits["contextWindow"], limits["maxOutputTokens"],
                                                   reasoning_efforts=tuple(efforts))
            return cls(overrides)
        except (ValueError, TypeError, RecursionError, UnicodeError):
            # Never include raw configuration or JSON parser excerpts in errors.
            raise ValueError(_CONFIG_ERROR) from None
