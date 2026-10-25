# BOSS-CLI

面向招聘任务的 Agent Harness，定位为“招聘垂直领域的 Pi”。招聘能力通过 `boss-agent-cli` 的进程接口接入；执行循环、模型接入、会话状态和桌面交互由本项目负责。

## 当前能力

- Electron / React 工作台通过双向 stdio JSON-RPC 连接 Python 内核。
- OpenAI Responses、Anthropic Messages 和无模型的确定性模式。
- 13 个允许清单工具：12 个只读工具、1 个逐次审批的招聘者打招呼工具。能力发现不会自动增加工具权限。
- 会话内串行工具、按会话隔离并发、停止、steering / follow-up、审批及平台风控暂停。
- SQLite 索引与 append-only JSONL、事件回放、冻结快照、完整回合分支及重启恢复；未知外部操作结果不自动重发。
- 工具结果附来源编号，保留分页状态及本页数量语义；大结果保存在会话历史，可在桌面手动分段查看，重连不会重复执行工具。
- 职位搜索支持明确的城市、薪资、经验、学历和页码；每次工具调用读取一页，筛选标签不等于个人资格核验。
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

## 明确条件搜索

在模型会话中可以要求“上海 Python、20–50K、3–5 年、本科，先看第一页”，模型通过 `boss_search` 传递结构化条件：

```json
{"keyword":"Python","city":"上海","salary":"20-50K","experience":"3-5年","education":"本科","page":1}
```

随后查看第二页时保持全部条件，只把 `page` 改为 `2`。工具不会自动拉取下一页，也不会自动放宽条件或逐个补取详情。平台返回 `has_more=null` 或没有分页信息时，是否还有后续结果仍未知；本页数量不能当作全量总数。

城市及岗位标签受当前适配契约的枚举约束，可通过 `tool/list` 查看。未知城市、标签、额外字段或非正整数页码在执行前被拒绝；旧 CLI 不支持新选项时保留明确错误，不去掉条件重查。平台标签与上游本地预筛不构成严格资格证明：经验、学历或薪资字段未知时须注明未知，再结合职位原始要求分析。

仅传 `keyword` 的旧调用继续有效，由上游默认读取第 1 页。无模型模式的 `/search 关键词` 仍为关键词查询快捷入口，不解析结构化筛选标志。URL、多选及更多列表筛选是后续扩展范围。

## 大结果与会话恢复

超过 64 KiB 的工具结果通过结果引用展示，完整原文继续保存在会话历史及模型上下文中。在工具卡片展开“查看完整结构化结果（分段）”，点击“读取第一段”，再用上一段、下一段查看；每次最多读取 16,384 个 Unicode 字符，不自动下载全部内容或写入文件。旧的小结果仍直接显示。

RPC 客户端可通过 `thread/item/result/read`，传入 `threadId`、`itemId`、引用中的 `sha256` 及可选 `cursor`、`limit` 读取标准 JSON 文本；默认 16,384、最多 32,768 个 Unicode 码点。引用包含该文本的 UTF-8 SHA-256、字节数和码点数，服务端游标绑定会话、条目及版本。结果发生修订时返回 `STALE_RESULT`，客户端须重新获取并确认引用，不能混用不同版本。

会话条目和事件回放还按约 1 MiB 响应预算分页，游标只推进到实际返回的数据。非分页读取或单条记录无法传输时会返回明确的 `RESPONSE_TOO_LARGE` 错误，连接继续可用；支持快照的客户端应通过 `thread/resume` 的冻结分页恢复。原始记录不被裁剪，读取不触发招聘工具。

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
