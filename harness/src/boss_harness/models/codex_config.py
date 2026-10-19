"""读取 `~/.codex/config.toml` 的模型配置。

存在理由：用户要求内核可以直接用 Codex 侧已经配好的模型（`model_provider` +
`[model_providers.<id>]`），而不是把模型 id 和端点再抄一份进仓库。

边界与安全：
- 只读文件、只返回内存中的配置对象，**不写入任何位置**；
- `bearer_token` 用 `Secret` 包装（`repr` 脱敏、不可 JSON 序列化），而不是裸字符串或只加
  `repr=False`——`dataclasses.asdict()` 会无视后者；
- 凭据缺失或不完整时返回 None，由调用方决定报错还是退回其它 provider。

与 Pi 的对应：Pi 把「模型目录」和「凭据存储」分开（`Models` / `CredentialStore`）。
本项目规模还小，只做「按需读取一份本地 provider 配置」，不引入凭据存储抽象。
"""
from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from boss_harness.models.secret import Secret

try:  # tomllib 自 Python 3.11 起进入标准库
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - 仅在 3.10 上触发
    tomllib = None  # type: ignore[assignment]

DEFAULT_CONFIG_PATH = Path.home() / ".codex" / "config.toml"


@dataclass(frozen=True)
class CodexModelProfile:
    """从 Codex 配置里解析出的一条模型线路。"""

    model: str
    base_url: str
    wire_api: str = "responses"
    provider_id: str = ""
    effort: str | None = None
    #: 端点的 bearer 凭据。用 Secret 包装而不是裸字符串：repr 会显示 `<redacted>`，
    #: 且它不可 JSON 序列化，所以误写进日志或 `asdict` 快照都拿不到明文。
    bearer_token: Secret | None = None


def config_path(
    explicit: str | os.PathLike[str] | None = None,
    environ: Mapping[str, str] | None = None,
) -> Path:
    """解析配置文件位置：显式入参 > BOSS_HARNESS_CODEX_CONFIG > CODEX_HOME > ~/.codex。

    `environ` 传进来时只用它判断，不读进程环境：这样调用方（含测试）给出的环境映射
    能决定全部行为，不会偷偷读到本机的真实配置。
    """
    if explicit:
        return Path(explicit).expanduser()
    env = os.environ if environ is None else environ
    override = (env.get("BOSS_HARNESS_CODEX_CONFIG") or "").strip()
    if override:
        return Path(override).expanduser()
    home = (env.get("CODEX_HOME") or "").strip()
    if home:
        return Path(home).expanduser() / "config.toml"
    return DEFAULT_CONFIG_PATH


def load_profile(
    path: str | os.PathLike[str] | None = None,
    environ: Mapping[str, str] | None = None,
) -> CodexModelProfile | None:
    """读取并解析配置；文件缺失、解析失败或缺关键字段时返回 None。"""
    target = config_path(path, environ)
    if not target.is_file():
        return None
    if tomllib is None:  # pragma: no cover - 仅在 3.10 上触发
        raise RuntimeError("openai 线路需要 Python 3.11+ 才能解析 Codex 的 TOML 配置")

    try:
        with target.open("rb") as handle:
            data = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return None

    return profile_from_mapping(data)


def profile_from_mapping(data: dict[str, Any]) -> CodexModelProfile | None:
    """把已解析的配置映射转成 profile（便于测试时直接喂内存字典）。"""
    model = str(data.get("model") or "").strip()
    provider_id = str(data.get("model_provider") or "").strip()
    providers = data.get("model_providers")
    entry: dict[str, Any] = {}
    if isinstance(providers, dict) and provider_id:
        raw = providers.get(provider_id)
        if isinstance(raw, dict):
            entry = raw

    base_url = str(entry.get("base_url") or "").strip()
    if not model or not base_url:
        return None

    token = entry.get("experimental_bearer_token")
    effort = str(data.get("model_reasoning_effort") or "").strip() or None
    return CodexModelProfile(
        model=model,
        base_url=base_url,
        wire_api=str(entry.get("wire_api") or "responses").strip() or "responses",
        provider_id=provider_id or str(entry.get("name") or ""),
        effort=effort,
        bearer_token=Secret(str(token).strip()) if token else None,
    )
