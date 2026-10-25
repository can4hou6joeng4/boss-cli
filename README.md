# BOSS-CLI

面向招聘任务的 Agent Harness，定位为“招聘垂直领域的 Pi”。招聘能力通过 `boss-agent-cli` 的进程接口接入；执行循环、模型接入、会话状态和桌面交互由本项目负责。

## 当前能力

- Electron / React 工作台通过双向 stdio JSON-RPC 连接 Python 内核。
- OpenAI Responses、Anthropic Messages 和无模型的确定性模式。
- 13 个允许清单工具：12 个只读工具、1 个逐次审批的招聘者打招呼工具。能力发现不会自动增加工具权限。
- 会话内串行工具、按会话隔离并发、停止、steering / follow-up、审批及平台风控暂停。
- SQLite 索引与 append-only JSONL、事件回放、冻结快照、完整回合分支及重启恢复；未知外部操作结果不自动重发。
- 工具结果附来源编号，保留分页状态及本页数量语义；大结果保存在会话历史，可在桌面手动分段查看，重连不会重复执行工具。
- 职位搜索支持明确的城市、薪资、经验/学历标签集合和页码；每次工具调用提交指定页的逻辑查询，网络尝试由业务 CLI 管理；筛选标签不等于个人资格核验。
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

## 模型配置来源

OpenAI Responses 的完整显式配置由以下三项组成，去除首尾空白后均须非空：

| 配置 | 来源 |
| --- | --- |
| 端点 | `BOSS_HARNESS_OPENAI_BASE_URL` |
| 凭据 | `BOSS_HARNESS_OPENAI_API_KEY` |
| 模型 | 命令行 `--model`，其次为 `BOSS_HARNESS_MODEL` |

三项齐备时不访问 Codex 配置文件，Python 3.10 也可使用这一路线；可选推理强度只取 `BOSS_HARNESS_EFFORT`，未指定则由模型服务决定，不再继承文件中的值。没有 `BOSS_HARNESS_OPENAI_MODEL` 别名。

缺少任一项时才读取 `BOSS_HARNESS_CODEX_CONFIG`、`CODEX_HOME/config.toml` 或默认 `~/.codex/config.toml`，按此顺序选择文件，显式字段仍优先。读取 TOML 需要 Python 3.11+；已有文件不可读或语法损坏时明确报错，不退到其他 provider。文件不存在或缺少可用 profile 时继续检查端点与凭据，缺项会报错；未提供模型且没有可用文件模型时保留既有 `DEFAULT_MODEL`。

当前文件适配要求文件自身同时提供 `model`、`model_provider` 及该 provider 的 `base_url` 才形成可用 profile；认证仅识别 `experimental_bearer_token`，尚未适配 Codex 的 `env_key`、OAuth 或任意 `wire_api`。配置解析只读本地文件，不探测真实服务。

## 明确条件搜索

在模型会话中可以要求“上海 Python、20–50K、3–5 年、本科，先看第一页”，模型通过 `boss_search` 传递结构化条件：

```json
{"keyword":"Python","city":"上海","salary":"20-50K","experience":"3-5年","education":"本科","page":1}
```

随后查看第二页时保持全部条件，只把 `page` 改为 `2`。工具不会自动拉取下一页，也不会自动放宽条件或逐个补取详情。平台返回 `has_more=null` 或没有分页信息时，是否还有后续结果仍未知；本页数量不能当作全量总数。

城市及岗位标签受当前适配契约的枚举约束，可通过 `tool/list` 查看。未知城市、标签、额外字段或非正整数页码在执行前被拒绝；旧 CLI 不支持新选项时保留明确错误，不去掉条件重查。平台标签与上游本地预筛不构成严格资格证明：经验、学历或薪资字段未知时须注明未知，再结合职位原始要求分析。

经验、学历也接受非空、无重复的枚举数组，例如“3–5 年或 5–10 年，本科或硕士”：

```json
{"keyword":"Python","city":"上海","experience":["3-5年","5-10年"],"education":["本科","硕士"],"page":1}
```

数组表示同一维度的任一标签，两个维度同时提交到一次指定页查询；不拆成组合搜索。传给业务 CLI 时按固定枚举顺序生成单个逗号参数，原始数组留在会话记录中。空数组、重复/未知标签、混合类型及逗号字符串均拒绝；省略字段才表示不设条件。下一页重复全部条件，仅改页码。城市、薪资仍只接受单标签。

多标签依赖平台筛选；当前业务上游对逗号经验/学历不执行单标签顺序粗筛。离线验证只能证明参数传递，不能证明平台严格返回集合内结果；须核对返回字段并标注未知或不匹配项。一次调用至多查询指定逻辑列表页，不补详情；缓存命中可能不发列表请求。网络尝试、认证及缓存维护仍由业务 CLI 决定，不能按工具调用次数推算网络请求量。

仅传 `keyword` 的旧调用继续有效，由上游默认读取第 1 页。无模型模式的 `/search 关键词` 仍为关键词查询快捷入口，不解析结构化筛选标志。URL、薪资多选及更多列表筛选是后续扩展范围。

## 业务 CLI 请求与认证边界

本项目按工具契约派发一次业务 CLI 进程调用，不自动展开组合或追加页面；其中的网络尝试、认证刷新、缓存及摘要补取由所配置的业务 CLI 决定。“只读”描述招聘业务动作，不表示单次网络请求，也不表示不维护本地状态。

已核验的业务 commit `bdc7034df563f1ea458d3af5bb4b40e8ea4603a8` 中，部分只读 HTTP 请求在默认路径下可因限流冷却或明确 token 过期而重试，最多 3 次重试、共 4 次尝试；认证刷新还可能使用浏览器并保存凭据。这个数值只属于该固定路径，不是每个工具的总请求预算。最终成功信封不会披露此前被重试的停止事件。该来源是开放 PR #479 的 head，并非已发布兼容基线；更换 `BOSS_CLI_BIN`、版本或上游配置后须重新核验。

Harness 只能在 CLI 返回的最终错误或受支持的部分结果停止元数据可见时暂停；中断、外层超时和进程组清理不能保证在不可见的第一次限制响应后精确停止。成功结果也不能证明此次未发生限流、认证过期或刷新。模型不得据此报告“首次限流即停止”或“没有触碰浏览器”。

当前适配未提供控制这些工具内部重试或认证刷新的参数。业务 CLI 的 `--browser-source` 是登录态来源策略，显式 CDP 也会改变运行前提；它们不能替代一个独立的无重试契约。Harness 不会为了改变请求次数而自动切换来源、改写上游共享配置或添加未知参数。部署前如需严格的首次停止或禁止认证刷新，须先使用已明确支持并核验这些约束的业务版本与配置；当前适配尚不能保证这一要求。

固定调用链、可观察范围及后续能力接入条件见 [UPSTREAM.md](UPSTREAM.md)。

## 平台暂停与聊天部分结果

`boss_hr_chat` 读取本页沟通列表时，业务 CLI 还可能为会话补取最近消息；列表只读不等于只有一个网络请求。默认摘要预算及补取行为沿用业务 CLI，本项目不追加补批或探测。

如果列表已取得、最近消息补取遇到认证、验证码、风控或限流停止码，工具保留已取得的 `data`、原始 `hints` 及分页，但以本地失败结果明确标记“部分结果，平台要求暂停”。收到这一可见停止信号后，当前回合暂停，同批后续工具不执行，也不再自动请求模型；列表不等于完整最近消息，未知未读状态不能当成已读。

适配仅识别 `hr chat` / `recruiter-chat` 的固定元数据 `hints.summary_sources.last_messages_error_code` 及既有停止码，不从候选人文本、任意错误字符串或其他命令推断授权和状态。原始 CLI 信封保留在适配对象的 `raw` 中，仍反映上游成功；会话与桌面保存、展示的是本地失败状态及部分结果。原有顶层失败保持原错误，普通成功和非停止摘要错误保持既有行为。

用户处理平台限制后再明确发起后续任务。恢复会话不会自动重试、补取消息、翻页或探测状态；上游 `hints` 中的建议命令仅作为来源数据，不构成执行授权。

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
