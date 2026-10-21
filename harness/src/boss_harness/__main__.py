"""CLI composition root for the independent recruitment app-server."""
from __future__ import annotations

import argparse
import os
import json
import sys
from dataclasses import replace
from pathlib import Path

from boss_harness import __version__
from boss_harness.application import ApplicationService as Harness, _approval_timeout
from boss_harness.models import DEFAULT_MODEL, ModelConfig, build_provider, resolve_config
from boss_harness.rpc import JsonRpcServer

DEFAULT_STATE_DIR = Path(os.environ.get("BOSS_CLI_HARNESS_DIR", Path.home() / ".boss-cli" / "harness"))


def _build_config(args: argparse.Namespace) -> ModelConfig:
    """命令行 > 环境变量；`--provider none` 可强制离线。

    provider 交给 `resolve_config` 一起决定，不能解析完再 `replace`：模型配置的字段会随
    provider 增加，而各线路的端点与凭据来源不同，事后替换会让 `--provider openai` 拿到
    Anthropic 的端点并丢掉 Codex 配置里的凭据。
    """
    explicit = None if args.provider == "auto" else args.provider
    config = resolve_config(provider=explicit)
    if args.model:
        config = replace(config, model=args.model)
    return config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="boss-harness", description="BOSS-CLI Agent Harness 内核")
    parser.add_argument("--listen", default="stdio://", help="传输端点，当前仅支持 stdio://")
    parser.add_argument("--state-dir", default=str(DEFAULT_STATE_DIR), help="内核状态目录")
    parser.add_argument("--repair-state", action="store_true", help="独占状态目录，备份 SQLite 索引后从原始日志重建")
    parser.add_argument(
        "--provider",
        default="auto",
        choices=["auto", "anthropic", "openai", "codex", "none"],
        help="模型供应商；openai 与其别名 codex 走 Codex 配置里的 Responses 线路，none 表示走确定性回合（离线）",
    )
    parser.add_argument("--model", default=None, help=f"模型 id，默认 {DEFAULT_MODEL}")
    parser.add_argument("--version", action="version", version=f"boss-harness {__version__}")
    args = parser.parse_args(argv)

    if args.repair_state:
        from boss_harness.maintenance import repair_index
        try:
            print(json.dumps(repair_index(Path(args.state_dir)), ensure_ascii=False))
            return 0
        except Exception as exc:
            print(f"[harness] 索引修复失败：{exc}", file=sys.stderr)
            return 2

    if args.listen != "stdio://":
        print(f"[harness] 暂不支持 --listen {args.listen}", file=sys.stderr)
        return 2

    try:
        config = _build_config(args)
        provider = build_provider(config)
    except Exception as exc:  # noqa: BLE001
        # 这里只包住「配置解析 + 构造 provider」两件事，所以宽捕获是安全的：任何失败都意味着
        # 模型线路起不来（缺凭据、缺端点、SDK 拒绝无凭据构造等），应当给出可读信息并以 2 退出。
        print(f"[harness] 模型配置不可用（{type(exc).__name__}）：{exc}", file=sys.stderr)
        return 2
    server = JsonRpcServer()
    try:
        # 构造 Harness 会创建会话目录；state-dir 不可写同样是启动期的配置问题，应当走同一个干净
        # 退出码，而不是把回溯打到 stdout（stdout 只走协议）并以 1 结束。
        harness = Harness(server, Path(args.state_dir), config, provider, provider_factory=build_provider)
    except OSError as exc:
        print(f"[harness] 启动失败（{type(exc).__name__}）：{exc}", file=sys.stderr)
        return 2
    bridge = harness.tools
    print(
        f"[harness] listening on stdio, state={args.state_dir}, "
        f"boss binary={bridge.binary} (source={bridge.source}, available={bridge.available()}), "
        f"model provider={config.provider} model={config.model} driven={harness.provider is not None}",
        file=sys.stderr,
    )
    harness.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
