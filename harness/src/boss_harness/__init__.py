"""BOSS-CLI 的 Agent Harness 内核。

对外只暴露一条进程边界：以 stdio 上的 JSON-RPC 服务端运行，
由桌面外壳作为子进程启动。内核之外不 import 任何领域代码，
领域能力一律经 tools/ 下的适配器走子进程调用。
"""

__version__ = "0.2.0rc1"
