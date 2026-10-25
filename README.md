# BOSS-CLI

面向招聘任务的 Agent Harness，定位为“招聘垂直领域的 Pi”。招聘能力通过 `boss-agent-cli` 的进程接口接入；执行循环、模型接入、会话状态和桌面交互由本项目负责。

## 当前能力

- Electron / React 工作台通过双向 stdio JSON-RPC 连接 Python 内核。
- OpenAI Responses、Anthropic Messages 和无模型的确定性模式。
- 13 个允许清单工具：12 个只读工具、1 个逐次审批的招聘者打招呼工具。能力发现不会自动增加工具权限。
- 会话内串行工具、按会话隔离并发、停止、steering / follow-up、审批及平台风控暂停。
- SQLite 索引与 append-only JSONL、事件回放、冻结快照、完整回合分支及重启恢复；未知外部操作结果不自动重发。
- 工具结果附来源编号，保留分页状态及本页数量语义；大结果的实时通知明确省略详情，完整结果保存在会话历史。
- 会话内官方登录浏览器及独立登录通道；模型与普通 renderer 不接收平台 Cookie。

当前仓库交付源码及 Python 内核构建。`npm run build` 生成 Electron main / preload / renderer，桌面启动仍依赖仓库布局和 Python 环境；独立安装包、签名和真实招聘平台的完整验收仍待完成。

## 本地开发

使用 Node.js 24+、Python 3.12，桌面最低 macOS 12。内核声明支持 Python 3.10+，读取 TOML 配置需要 3.11+；当前验收环境为 macOS、Node 24 和 Python 3.12。

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e ./harness
npm ci
npx install-electron --no
npm run typecheck
npm run build
BOSS_HARNESS_PROVIDER=none npm run dev
```

Electron 运行时从官方源单独下载和校验，失败后需先恢复安装再启动。`none` 模式不调用模型；使用 `/tools` 或 `/search 关键词` 时仍会调用配置的上游 CLI。

工具可执行文件按 `BOSS_CLI_BIN`、并排 `boss-agent-cli/.venv/bin/boss`、PATH 的顺序查找。`BOSS_CLI_DATA_DIR` 是上游登录及平台状态目录，`BOSS_CLI_HARNESS_DIR` 是本项目的会话目录，两者分别管理。

默认桌面模型为 OpenAI Responses，可由 `BOSS_HARNESS_PROVIDER` 选择 `openai`、`anthropic` 或 `none`。OpenAI 配置读取本地 Codex 配置或 `BOSS_HARNESS_OPENAI_*` 环境变量；Anthropic 使用 `ANTHROPIC_*`。真实模型请求可能联网并产生费用。不要将凭据写入仓库或公开日志。

## 模块边界

| 路径 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 主进程、preload 和 React 工作台 |
| `packages/protocol` | JSON-RPC、会话条目及通知契约 |
| `packages/app-client` | 进程连接、双向请求、握手、超时及重连 |
| `harness/src/boss_harness` | 执行、上下文、持久化、恢复和模型接入 |
| `harness/src/boss_harness/tools` | 招聘提示、工具契约、CLI 适配及平台暂停规则 |

## 贡献与验证

贡献、单行中文提交格式、PR 和发布约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，来源及适配差异见 [UPSTREAM.md](UPSTREAM.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

CI 从 Git 源码执行 npm 依赖审计、类型检查、桌面构建和 Python wheel / sdist 构建。离线回归使用模拟工具、脱敏数据和临时状态；测试代码、夹具、离线 provider 及测试专用配置按项目约定仅保留本地，不进入提交。远程源码构建不声称运行这些本地测试。

招聘平台事实、模型判断和用户偏好须分别说明。代码交付授权不等于对外沟通、投递或批量操作授权；遇到认证、验证码、风控、限流或写操作结果不确定时停止相关操作，交由用户核对与恢复。
