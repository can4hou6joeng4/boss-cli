# BOSS-CLI

<p align="center">
  <strong>面向招聘任务的 Agent Harness</strong><br>
  用可控的模型回合、招聘工具与可恢复会话，完成有边界的招聘工作流。
</p>

<p align="center">
  <a href="https://github.com/can4hou6joeng4/boss-cli/actions/workflows/build.yml"><img src="https://github.com/can4hou6joeng4/boss-cli/actions/workflows/build.yml/badge.svg" alt="Build"></a>
  <a href="https://github.com/can4hou6joeng4/boss-cli/issues"><img src="https://img.shields.io/github/issues/can4hou6joeng4/boss-cli" alt="Issues"></a>
  <a href="https://github.com/can4hou6joeng4/boss-cli/pulls"><img src="https://img.shields.io/github/issues-pr/can4hou6joeng4/boss-cli" alt="Pull requests"></a>
  <a href="https://github.com/can4hou6joeng4/boss-cli/stargazers"><img src="https://img.shields.io/github/stars/can4hou6joeng4/boss-cli" alt="Stars"></a>
</p>

> `boss-agent-cli` 负责招聘平台接入；BOSS-CLI 负责模型适配、执行循环、权限边界、会话状态和桌面交互。内核借鉴 Pi 的 Agent Harness / Durable 设计思想，按本项目的招聘安全契约独立实现。

**快速导航**　[能力地图](#你会得到什么) · [快速开始](#快速开始) · [试一次](#试一次) · [工作方式](#工作方式) · [安全边界](#安全边界) · [配置与开发](#配置与开发)

## 你会得到什么

| 你想解决的问题 | BOSS-CLI 的回答 |
| --- | --- |
| 让模型帮我查职位 | 结构化搜索参数、明确页码、保留分页事实，不自动扩大查询范围。 |
| 让模型继续做事 | 会话内串行工具、`steering`、`follow-up` 和可观察队列，状态可重启恢复。 |
| 不想重复执行招聘操作 | 工具调用有稳定身份、审批和结果未知边界；断连后不凭猜测重放外部副作用。 |
| 长会话越来越难控 | 上下文预算、冻结快照、手动摘要、来源切点和有界 JSONL 冷读。 |
| 希望换模型线路 | OpenAI Responses、Anthropic Messages 和 `none` 确定性模式共享同一内核契约。 |
| 想在桌面里操作 | Electron / React 工作台通过双向 stdio JSON-RPC 连接 Python 内核。 |

核心能力包括 14 个 allowlist 工具（13 个只读工具、1 个逐次审批的招聘者打招呼工具）、SQLite 索引与 append-only JSONL、事件回放、冻结快照、完整回合分支、技能上下文和重启恢复。能力发现不会自动增加工具权限；模型与普通 renderer 不接收平台 Cookie。

## 快速开始

需要 Node.js 24+、Python 3.12 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)。桌面端最低支持 macOS 12；内核本身声明支持 Python 3.10+。Electron 运行时会在安装时从官方源下载并校验，需要网络连接。模型线路和搜索筛选的配置细节见[使用指南](docs/USER_GUIDE.md)。

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e ./harness
npm ci
npx install-electron --no
npm run typecheck
npm run build
BOSS_HARNESS_PROVIDER=none npm run dev
```

`npm run build` 生成 Electron main、preload 和 renderer 源码构建产物；仓库目前没有独立安装包或签名发行流程。

## 试一次

桌面启动后，可以先在不请求模型的模式里检查交互：

1. 输入 `/tools`，查看当前允许的工具。
2. 配好 `boss-agent-cli` 后输入 `/search Python`，查看关键词搜索结果。
3. 配置模型后尝试：“上海 Python，20–50K，3–5 年，本科，先看第一页”。
4. 回合运行中发送新消息，选择转向当前回合，或排到后续回合。

`none` 只表示不调用模型；`/tools` 和 `/search` 仍可能调用配置的招聘 CLI。

<details>
<summary>展开一次职位查询的处理路径</summary>

```text
自然语言条件
    ↓
模型生成结构化搜索参数
    ↓
Harness 校验参数、页码和工具权限
    ↓
boss-agent-cli 查询指定逻辑页
    ↓
桌面展示结果与来源，用户决定下一步
```

系统不会自动翻页、放宽搜索条件或补取职位详情。
</details>

## 工作方式

| 你要做的事 | 交互方式 |
| --- | --- |
| 搜索职位或查看沟通列表 | 提交明确条件和页码；结果保留来源与分页状态。 |
| 调整正在进行的任务 | `steering` 在当前工具批次后生效；`follow-up` 等当前回合结束后排队执行。 |
| 管理较长的会话 | 原始记录保存在 append-only JSONL，SQLite 提供索引；可检查上下文预算、按匹配用量校准保留范围、生成摘要并恢复会话。 |
| 扩展当前回合的指引 | 从工作区选择技能文件作为提示上下文，不会因此增加工具权限。 |

```mermaid
flowchart LR
    U[桌面工作台<br/>Electron / React] <-->|stdio JSON-RPC| H[Agent Harness<br/>Python]
    H --> M[OpenAI / Anthropic / none]
    H --> G[工具 allowlist<br/>审批与暂停门禁]
    G --> B[boss-agent-cli<br/>招聘平台接入]
    H --> S[JSONL + SQLite + 快照]
    H --> Q[回合队列与恢复]
```

模型适配、会话编排和桌面交互属于本仓库；招聘平台能力由单独配置的 `boss-agent-cli` 提供。

## 交互式工作流

### 搜索：先给边界，再给结果

模型会把自然语言条件转换为结构化请求。每次只查询指定逻辑页；查看下一页时保留全部条件，只把 `page` 改为 `2`。`has_more=null` 仍表示未知，系统不会把本页数量当作全量结果。

```json
{
  "keyword": "Python",
  "city": "上海",
  "salary": "20-50K",
  "experience": "3-5年",
  "education": "本科",
  "page": 1
}
```

### 回合：让消息进入正确的位置

| 操作 | 何时生效 | 失败时发生什么 |
| --- | --- | --- |
| 直接发送 | 空闲回合立即开始 | 输入是否已保存会明确返回，不从 `error` 猜测执行事实。 |
| `steering` | 当前工具批次结束、下一次模型请求前 | 取消或持久化失败时保留事实，不自动重放。 |
| `follow-up` | 当前回合自然结束后按 FIFO 派发 | 并发、摘要或结算失败会保持 `queued` / `paused`，不误报为已执行。 |

### 上下文：可追溯地压缩，而不是删除历史

会话原始记录保留在 JSONL；模型看到的是经过摘要、编辑和预算校验的投影。手动摘要可生成、观察和取消，来源切点、usage、checkpoint 及重启结果都可追溯。冻结快照用于读取一致的历史切面，不会让模型重新执行已经完成的工具。

### 技能：只增加提示上下文，不增加权限

将技能放在 `.boss-cli/skills/<id>/SKILL.md`，在输入区选择后随单次直接发送提供上下文。目录发现最多返回 100 个可读取普通文件，每个文件最多 64 KiB；坏编码、超大文件、符号链接和 FIFO 会被跳过。技能内容不会执行目录脚本，也不会扩大 allowlist 或审批范围。

## 安全边界

- 当前内核提供 14 个 allowlist 工具：13 个只读工具，招聘者打招呼工具需要逐次审批。
- 读取列表不会自动回复、投递、导出简历或翻页；能力发现不会自动开放新权限。
- 超时或断连后，外部写操作可能处于结果未知状态；系统要求先核对，不会凭猜测重放。
- 模型与普通 renderer 不接收平台 Cookie。真实模型请求可能联网并产生费用。
- 代码交付不等于招聘平台操作授权；对外沟通、投递和批量操作需要用户明确授权。

首次运行建议使用临时工作区和只读工具。不要把凭据、Cookie 或真实招聘记录放入仓库、Issue、PR 或公开日志。

## 配置与开发

<details>
<summary>展开模型配置来源</summary>

桌面默认使用 OpenAI Responses。通过 `BOSS_HARNESS_PROVIDER` 选择 `openai`、`anthropic` 或 `none`。

| 模型线路 | 配置 |
| --- | --- |
| OpenAI Responses | 显式配置 `BOSS_HARNESS_OPENAI_BASE_URL`、`BOSS_HARNESS_OPENAI_API_KEY`，模型取命令行 `--model`，其次为 `BOSS_HARNESS_MODEL`。 |
| 本地 Codex profile | 显式 OpenAI 配置缺项时，读取 `BOSS_HARNESS_CODEX_CONFIG`、`CODEX_HOME/config.toml` 或 `~/.codex/config.toml`。读取 TOML 需要 Python 3.11+。 |
| Anthropic Messages | 使用 `ANTHROPIC_*` 环境变量。 |
| 无模型模式 | 设置 `BOSS_HARNESS_PROVIDER=none`；模型不会被调用，但招聘 CLI 工具仍可运行。 |
| 单次模型传输 | 默认总时限 600 秒，可用 `BOSS_HARNESS_MODEL_REQUEST_TIMEOUT_SECONDS` 设置为 1–3600 秒。详见[使用指南](docs/USER_GUIDE.md#单次模型请求期限)。 |

所有凭据都应保存在本地环境或安全的凭据管理工具中，不要写进配置样例、提交或日志。
</details>

<details>
<summary>展开验证命令</summary>

```sh
npm ci
npx install-electron --no
npm run typecheck
npm run build
python3 -m pip install build
python3 -m build ./harness
git diff --check
```

CI 会运行 npm 依赖审计、类型检查、桌面构建及 Python wheel / sdist 构建。真实模型、招聘平台和已签名安装包需要分别验收，源码构建不代表这些场景已经通过。
</details>

## 项目导航

- [模块边界](#模块边界)：桌面端、协议层、客户端和 Python 内核的职责分工。
- [使用指南](docs/USER_GUIDE.md)：模型配置、职位搜索、沟通列表、技能与任务队列。
- [内核与业务契约参考](docs/TECHNICAL_REFERENCE.md)：请求边界、恢复流程、上下文预算和模块接口。
- [贡献与验证](CONTRIBUTING.md)：开发约定、提交格式、PR 和发布流程。
- [上游吸收记录](UPSTREAM.md)：Pi 等参考项目的来源与适配差异。
- [版本变化](CHANGELOG.md)：各候选版本的功能与修复。
- [Issues](https://github.com/can4hou6joeng4/boss-cli/issues) · [Pull requests](https://github.com/can4hou6joeng4/boss-cli/pulls)

## 模块边界

| 路径 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 主进程、preload 和 React 工作台。 |
| `packages/protocol` | JSON-RPC、会话条目及通知契约。 |
| `packages/app-client` | 进程连接、双向请求、握手、超时和重连。 |
| `harness/src/boss_harness` | 执行循环、上下文、持久化、恢复和模型接入。 |
| `harness/src/boss_harness/tools` | 招聘提示、工具契约、CLI 适配及平台暂停规则。 |
