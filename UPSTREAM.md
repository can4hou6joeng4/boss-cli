# 上游吸收记录

## 职责与采用方式

- **业务接入**：`boss-agent-cli` 的 argv / v1 七键 JSON 信封。保留进程边界，不 import 上游实现；工具权限由本地允许清单和审批控制。
- **架构参考**：[Pi](https://github.com/earendil-works/pi)，涉及机制时先阅读对应包，固定 commit 并记录差异。当前执行器独立实现，不新增 Pi 依赖。
- **补充问题来源**：[jackwener/boss-cli](https://github.com/jackwener/boss-cli) 的 Issue / PR。该项目的 `recruiter` 命令和 HTTP client 与当前适配契约不同，不直接替换。

2026-10-25 核对 `jackwener/boss-cli` main 为 `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`，tag `v0.3.6` 指向 `60c0a0595611f37526808fc7476d63af29506460`；当时无 GitHub Release。其 `pyproject.toml` 声明 Apache-2.0，main 根目录未发现 LICENSE / NOTICE；如后续复制代码，须先确认许可范围并保留必要声明。本轮只独立实现问题所需行为。

## 第一轮：工具分页贯通

**招聘场景**：模型查看某页职位或候选人后，需要判断是否还有后续页，以及 `total` 表示全量还是仅本页条数。缺失这些信息可能产生不完整的筛选结论。

问题来源：

- [PR #37](https://github.com/jackwener/boss-cli/pull/37)，核对时 OPEN，head `bee4a290df69da581520e566e3f46488885b53a3`：贡献者报告聊天请求不传 `page` 时返回空数据。
- [PR #28](https://github.com/jackwener/boss-cli/pull/28)，核对时 OPEN，head `04de8dd179a9b9ac5b80c338198971ad90248b48`：贡献者报告旧候选人接口重复重排，并提出按职位分页及保留 `hasMore`。
- 当前业务上游 `boss-agent-cli` commit `bdc7034df563f1ea458d3af5bb4b40e8ea4603a8` 的 search / recommend 将 `pagination` 独立返回，包括 `has_more` 的 true / false / null 和 `total_kind=returned_page_count`。适配层原先校验该字段后丢弃，已在本地复现。

该业务 commit 是本机检出的 [PR #479](https://github.com/can4hou6joeng4/boss-agent-cli/pull/479) head，核对时 PR 仍为 OPEN，不作为已发布兼容基线。当前适配继续依赖明确的 argv 及 v1 七键信封，而非导入这份检出的源码。

采用方式：

- 给通用 `ToolResult` 尾部追加可空 `pagination`，保留既有位置参数兼容；旧结果按无分页处理。
- 将分页原样传入模型、持久结果和重启后的模型历史，不推算下一页或更改 `total` 语义。
- 工具摘要先展示分页，再截断数据预览。正常大小的实时详情与恢复详情一致；超过 64 KiB 的结果仅向实时通知发送摘要及明确省略标记，完整结果仍保存在会话历史，避免撑大协议帧。
- 提示中说明 true / false / null 的边界，以及本页数量与全量总数的区别。工具保持单次调用，不新增自动翻页或批量采集。

Pi 参考固定为 `5ba1cbaf3d96d204d847c84ce235c62dae23e0fd` 的 `packages/agent/README.md`、`src/agent-loop.ts`、`src/types.ts`：工具完成事件、结构化详情和模型可见内容分别处理。本项目将上游分页同时放入通用结果与模型文本，保留领域适配和执行机制边界；继续串行处理会话内工具，未采用 Pi 默认并行模式，未复制其实现。

兼容影响为新增可空字段；JSON-RPC 仍为 0.2.0。外部 PR 的接口与实测仅作为问题来源，没有将其端点或平台验证结论移植到本项目。

## 第二轮：明确搜索条件与单页查询

本项目 [Issue #7](https://github.com/can4hou6joeng4/boss-cli/issues/7) 的场景是按用户指定的城市、薪资及岗位要求查询职位，再保持同一组条件读取下一页。增加 `boss_search` 的 `page`、`city`、`salary`、`experience`、`education`，保持原有关键词查询与工具允许清单。

来源与采用差异：

- [jackwener/boss-cli PR #8](https://github.com/jackwener/boss-cli/pull/8)，核对时 OPEN，head `a0b6bdaa4803d86d69ac8cb882e1c97c58f5c700`，提出 URL 查询及筛选多选，并指出硬编码标签映射可能过期；[PR #6](https://github.com/jackwener/boss-cli/pull/6)，核对时 OPEN，head `8e0002a36242e5c0b4df87e6d5dbe95554c1c644`，则报告经验与职位类型映射错误。这些问题要求固定来源并验证映射，不把任意标签静默当作有效条件。本轮按 Issue #7 交付单标签契约；URL、多选、行业、公司规模等能力后续按独立场景扩展，并非由本轮定义为不可支持。
- 业务上游固定 `bdc7034df563f1ea458d3af5bb4b40e8ea4603a8`：读取 `commands/search.py`、`search_filters.py`、`wizard/actions.py` 及 `api/boss.yaml`，使用该版本已有的 40 个城市、7 个薪资、6 个经验和 4 个学历标签。仅记录标签事实并独立实现 argv 与校验，不复制上游执行实现或新增依赖；上游许可证为 MIT。
- `search_cmd → execute_candidate_search → run_search_pipeline → search_jobs` 对这些参数执行单页列表查询，不要求详情补取。薪资预筛只排除返回上限低于请求下限的职位，经验/学历未知值可能保留，因此工具结果须区分平台字段、匹配判断和未知项。
- [业务上游 #442](https://github.com/can4hou6joeng4/boss-agent-cli/issues/442) 已关闭；[#451](https://github.com/can4hou6joeng4/boss-agent-cli/pull/451) 与 [#452](https://github.com/can4hou6joeng4/boss-agent-cli/pull/452) 已合并。#452 的 merge 为 `785b60c9ac95b133fe374cbcc47ba6fbd94fd392`，记录部分活跃度档位需要详情且曾触发平台错误。活跃度和福利涉及不同请求行为，留作单独能力评估。

工具输入只接受声明字段与明确类型/枚举，固定顺序生成独立 argv，关键词始终位于 `--` 后。旧的关键词调用保持原 argv，未传页码时使用上游默认第 1 页；显式页码和筛选原样传给上游。不自动补详情、翻页、移除参数或放宽条件，不修改通用执行内核、会话模型和 JSON-RPC 版本。

验收采用本地模拟 CLI、脱敏结果及临时会话，验证下一页保留条件、分页 true / false / null、无效输入拒绝、中断/暂停和旧 CLI 拒参；业务上游真实管线的离线替身验证用于核对逻辑列表与详情调用数，不能代替真实平台验收。测试与夹具只保留本地。

## 第二轮：大结果读取与恢复

本项目 [Issue #9](https://github.com/can4hou6joeng4/boss-cli/issues/9) 来自本地恢复复现：5 MiB 的工具结果在持久条目中同时保留 `result` 与 `modelResult`，旧的 `thread/read` 和单项快照页重复传输两份正文，超过 8 MiB 帧限制并使 stdio 进程退出；100 条约 90 KiB 的事件也能越过计数分页的帧上限。第一轮的实时通知省略未覆盖恢复路径。

先阅读 Pi 固定 `5ba1cbaf3d96d204d847c84ce235c62dae23e0fd` 的 `packages/coding-agent/docs/rpc.md`、`docs/session-format.md`、`src/core/session-manager.ts`，结合前述 `agent-loop.ts` 中 `tool_execution_end` 与工具结果消息的边界，采用持久事实、模型上下文和 RPC 呈现分离的职责划分。分段引用与字节预算是本项目独立协议，没有复制 Pi 实现，也不声称 Pi 提供了相同 API。

持久结果和 `modelResult` 不变；RPC 投影排除模型重复文本，超过 64 KiB 的结果携带 `resultRef`，实时完成与恢复条目使用相同引用。新增只读 `thread/item/result/read`，必须提供预期 SHA-256，按 Unicode 码点分段，游标绑定会话、条目、摘要与下一偏移。摘要和字节数基于 `ensure_ascii=False`、紧凑分隔符、拒绝非有限数值的 JSON 文本 UTF-8 编码；结果修订返回明确 `STALE_RESULT`，冻结快照保留旧引用，不悄悄切换内容。桌面只按用户点击读取一段，校验每次响应的引用和段边界。

条目/事件页另受约 1 MiB 编码预算约束，游标不跳过未返回项；单项无法传输时明确报错。超大普通 RPC 响应转为有界 `RESPONSE_TOO_LARGE`，不重跑处理器、不关闭连接。大错误通知限制重复错误预览，完整错误仍包含在可读取的结果内。JSON-RPC 版本保持 `0.2.0`，旧小结果及无引用通知继续兼容；业务 CLI 契约、模型历史、工具权限和审批不变。

验收使用独立临时状态和合成 Unicode / 控制字符数据，覆盖真实 stdio 重启、冻结快照、全量分段重建与 UTF-8 哈希、跨会话/版本拒绝、按字节分页无丢失重复及后续连接可用；桌面另验证实际 preload / IPC / renderer 的分段导航与重载。测试和研究材料只保留本地，不作为远程 CI 或真实招聘平台验收。

## 第三轮：显式模型配置独立于本地文件

本项目 [Issue #13](https://github.com/can4hou6joeng4/boss-cli/issues/13) 已在实际 Python 3.10.20 复现：完整环境参数在配置路径不存在时成功，但创建一个无凭据 TOML 后反而因缺少 `tomllib` 失败。命令行 `--model` 在解析后覆盖，也无法使完整显式线路免于该问题。

先阅读 Pi 固定 `5ba1cbaf3d96d204d847c84ce235c62dae23e0fd` 的 `packages/ai/README.md` Auth / Environment Variables、`src/env-api-keys.ts` 及 `packages/coding-agent/src/core/model-registry.ts`。采用显式参数可决定请求、配置/认证解析与实际模型请求分离、必要配置损坏时明确失败的职责边界。本项目继续使用既有环境优先契约；Pi 中持久凭据拥有 provider、优先于环境的策略不直接移植。本轮独立实现，不复制代码或增加依赖。

模型由 `--model` 或 `BOSS_HARNESS_MODEL` 明确指定，且 `BOSS_HARNESS_OPENAI_BASE_URL` 与 `BOSS_HARNESS_OPENAI_API_KEY` 非空时，不调用文件 loader；可选 effort 只取环境，否则为 None。CLI 在解析前合入模型值，不再解析后替换。部分显式配置仍使用文件 profile 补全，并启用严格文件错误；loader 的直接调用缺省保持损坏文件返回 None 的兼容行为。不存在文件或不完整 profile 保留既有缺参/默认模型规则，不扩大认证、provider 或协议支持。

验收使用实际 Python 3.10 与 3.12、隔离临时配置和虚构参数，观察文件读取并禁止网络；覆盖完整/部分来源、损坏/不可读文件、CLI 优先级、别名、可选参数及错误不含凭据。测试材料仅保留本地。未调用真实模型或招聘平台；Python 下限、JSON-RPC、SDK 和业务工具契约不变。

## 待评估问题

| 来源 | 证据与采用边界 |
| --- | --- |
| [Issue #35](https://github.com/jackwener/boss-cli/issues/35)、[PR #36](https://github.com/jackwener/boss-cli/pull/36) | 只读工具隐式读取浏览器凭据；#36 已合并，显式 CDP 导入限定 loopback。继续核对普通诊断与专用登录通道隔离，不把导入凭据纳入自动健康检查。 |
| [PR #29](https://github.com/jackwener/boss-cli/pull/29) | OPEN；贡献者报告旧 greet 缺少真实发送动作。继续要求逐次审批与上游确认，不能从 HTTP 200 或姓名输出推断送达。 |
| [PR #25](https://github.com/jackwener/boss-cli/pull/25) | OPEN；沟通列表、消息读取与回复状态需分别建模；新增只读能力不连带授权回复或交换联系方式。 |
| [PR #24](https://github.com/jackwener/boss-cli/pull/24) | OPEN；材料缓存应有来源、保留策略及用户授权，先评估显式导入快照，不整包引入采集流程。 |

本项目远程目标经用户确认为私有仓库 [can4hou6joeng4/boss-cli](https://github.com/can4hou6joeng4/boss-cli)。`boss-agent-cli` 的 Issue / PR 仅作业务参考，不冒充本项目工作项。每轮重新读取本仓库及参考仓库的最新状态，按可复现性、招聘价值和兼容风险排序，并通过本项目 PR 记录采用及未采用理由。


## 第四轮：经验、学历集合查询

本项目 [Issue #15](https://github.com/can4hou6joeng4/boss-cli/issues/15) 的场景是一次读取“3–5 年或 5–10 年、本科或硕士”的指定页，并能沿用同一组条件查看下一页。`experience`、`education` 保留原枚举字符串，新增非空、无重复的枚举字符串数组；城市与薪资继续单选。

2026-10-25 再次核对 [jackwener PR #8](https://github.com/jackwener/boss-cli/pull/8) 为 OPEN、head `a0b6bdaa4803d86d69ac8cb882e1c97c58f5c700`，其多选和未知标签报错作为问题来源；[PR #6](https://github.com/jackwener/boss-cli/pull/6) 为 OPEN、head `8e0002a36242e5c0b4df87e6d5dbe95554c1c644`，其经验码表与本机业务表不同。本项目只传业务 CLI 标签，不复制外部码表、URL 或 HTTP/recruiter 实现，不声称已核验平台当前映射。

业务来源仍固定为开放 PR #479 head `bdc7034df563f1ea458d3af5bb4b40e8ea4603a8`，并非已发布的最低版本承诺。阅读 `commands/search.py`、`search_filters.py`、`wizard/actions.py`、`api/client.py` 和 `api/boss.yaml`：已有逗号经验/学历解析，分别传入平台的 `experience` / `degree`。数组仅在 argv 投影中按固定枚举顺序合为一个选项，单元素与原单标签一致，原始工具参数留在历史；不展开组合、不自动翻页、补详情或删条件重试。普通查询至多一次指定列表页、零详情，缓存命中可为零次列表请求，业务 CLI 仍可维护本地缓存及 hooks。

多标签在当前上游顺序粗筛中属于未知组合，因而依赖平台过滤，不能保证返回严格属于集合或求职者符合资格。薪资逗号值的本地解析只取首区间且结果依赖顺序，因此不开放薪资数组；城市只支持单标签。无效类型、空数组、重复、未知标签和原始逗号字符串均在执行前拒绝；不放宽其他工具的契约。

机制参考先读 Pi 固定 `5ba1cbaf3d96d204d847c84ce235c62dae23e0fd` 的 `packages/ai/README.md` “Validating Tool Arguments”及 `src/utils/validation.ts`。采用执行前按工具声明校验的边界，独立扩展当前允许清单所需的 `anyOf`、数组项、长度和唯一性校验。Pi 使用 TypeBox 并可转换类型、移除可选 null；本项目保留严格类型、拒绝 null 且不改写原始参数，不新增依赖或复制源码。执行循环、会话模型、工具权限和 JSON-RPC 版本不变。

验收使用本地模拟 CLI、合成会话与固定业务管线替身，覆盖旧字符串、数组规范化、无效输入、同条件下一页、暂停/中断及历史和桌面实时/恢复表示。测试、夹具及研究仅保留本地；离线参数贯通与界面验收不能代替真实招聘平台筛选正确性验证。


## 第五轮：聊天部分成功中的平台停止信号

本项目 [Issue #18](https://github.com/can4hou6joeng4/boss-cli/issues/18) 关注已有 `boss_hr_chat`：沟通列表成功，但最近消息补取遇到平台限制时，不应继续同批工具或模型自动续跑。2026-10-25 再读业务 `boss-agent-cli@bdc7034df563f1ea458d3af5bb4b40e8ea4603a8` 的 `commands/recruiter/chat.py`、`platforms/zhipin_recruiter.py`、输出契约：`_enrich_chat_summaries` 将补取停止码写入 `hints.summary_sources.last_messages_error_code`，`recruiter_chat_cmd` 随后仍发送成功 v1 信封及 exit 0。该固定来源仍是开放 PR #479 head，非已发布最低版本。

问题来源还包括 [jackwener Issue #32](https://github.com/jackwener/boss-cli/issues/32)、[#27](https://github.com/jackwener/boss-cli/issues/27)、[#23](https://github.com/jackwener/boss-cli/issues/23) 的风控报告，以及 [PR #25](https://github.com/jackwener/boss-cli/pull/25) 对沟通动作边界的区分（核对时 OPEN，head `2b44ba5c438965d622267c387936736a53d10a9b`）。只吸收问题场景，不采用其 HTTP/消息协议、规避方式或账号验收结论；继续独立实现，不复制源码或增加依赖。

使用实际固定业务 Click 命令、真实错误映射和 v1 输出，配合合成列表与惰性 I/O，离线复现 `RATE_LIMITED`、`ACCOUNT_RISK`、`AUTH_REQUIRED`、`ENVIRONMENT_RISK` 四码：列表保留，顶层仍成功。真实子进程适配和执行器此前将该信封当作普通成功，继续后续 `boss_search` 并再次请求模型。测试禁止 socket/DNS，未读取真实账号或沟通记录。

采用方式是在原 v1 七键及退出码校验之后，仅对实际 argv 的 `hr chat`、输出 command 为 `recruiter-chat`、顶层成功且固定元数据字典/字符串形状正确的情况，识别既有 `PAUSE_CODES`。本地结果改为 `ok=false`，用固定安全信息说明部分结果、消息补取未完成及用户恢复步骤；保留 `data`、`hints`、分页，适配对象 `raw` 继续保留原成功信封。会话持久化本地状态和部分字段，不宣称持久化了原始 raw。顶层失败优先；未知码、普通摘要错误、错形状及其他命令保持原语义，不递归扫描候选人文本、任意 code 或自由文本，不执行 hints 中的命令。

机制先读 Pi 固定 `5ba1cbaf3d96d204d847c84ce235c62dae23e0fd` 的 `packages/agent/README.md` 和 `src/agent-loop.ts`：参考结果后处理、完成事件、模型工具结果分别保留的边界。Pi 的 `terminate` 只在整批所有结果均设置时阻止自动模型续跑，不是本项目的暂停规则。本轮继续复用既有串行工具和任一平台停止码即阻断剩余调用的本地机制，不修改通用循环或移植 Pi terminate 行为，也不增加 Pi 依赖。

兼容变化限定于已确认的部分成功停止形状；工具输入、允许清单、审批和 JSON-RPC `0.2.0` 不变，原单页列表/消息补取预算不变。不补批、翻页、删参、重试或自动状态探测。验收覆盖精确停止码/负例、真实子进程到执行器的 blocked 与后续 NOT_EXECUTED、原始部分字段及模型历史恢复，另使用实际 Electron 核对实时和恢复显示。所有测试与合成材料只保留本地，不作为真实平台或远程 CI 已执行的证据。

## 第六轮：请求尝试与认证刷新边界

本项目 [Issue #20](https://github.com/can4hou6joeng4/boss-cli/issues/20) 在评估求职沟通原语时发现：“一个工具调用/指定页”只限定 Harness 的业务派发，不能作为业务 CLI 底层请求次数或首次限制即停的保证。本轮只修正现有文档、工具描述和领域提示，不新增工具、参数、权限或请求策略，也不改变执行/暂停机制。

2026-10-25 固定业务来源仍为 `bdc7034df563f1ea458d3af5bb4b40e8ea4603a8`（开放 PR #479 head，非发布最低版本，MIT）。审查根命令/配置、各工具命令、平台和客户端，以及 `api/_base_client.py`、`api/browser_client.py`、`api/browser_source.py` 和端点 effect/replay_safe 声明。以下是对该提交的来源审查，不是对任意 `BOSS_CLI_BIN` 或用户实际账号、配置的运行保证。

| 当前工具 | 已核对调用范围与内部行为 |
| --- | --- |
| `boss_search`、`boss_recommend` | 指定逻辑列表页；search 当前允许条件不要求详情补取，可命中缓存。对应客户端列表接口使用浏览器通道，不进入 HTTP 限流/刷新循环；浏览器 `request` 对 replay_safe 读取仍可能在执行上下文销毁后恢复并重放一次；这不是整个工具的尝试上限。 |
| `boss_detail` | 命令先使用显式或缓存 `job_id` 读取详情；无 `job_id`、详情为空或非风险失败时可取职位卡片，不能把“查看详情”当作固定一次请求。`job_card` 路径可先 HTTP、异常后浏览器，名称带 browser 的命令 helper 本身不证明强制单通道。 |
| `boss_status`、`boss_stats`、`boss_list_tools` | 当前 Harness argv 不传 status 的 `--live`，因此该命令默认仅本地检查；三者命令分别读取本地登录/健康/锁、本地统计和静态能力目录，不主动请求平台 API。根初始化及 TokenStore 等仍可维护目录、日志或本地认证状态，不能称完全无本地副作用。 |
| `boss_hr_jobs`、`boss_hr_jobs_detail`、`boss_hr_recommendations`、`boss_hr_candidates` | 进入业务请求基类；默认 auto 的 HTTP 路径对相应 replay_safe 读取可重试和刷新认证。候选人页码仅改变逻辑查询条件，不控制底层尝试数。 |
| `boss_hr_chat` | 列表后还可读取页面摘要，并按来源分组、分批补取最近消息，沿用业务预算；列表和消息请求均可进入上述 HTTP 重试路径。默认最多补前 100 个缺失会话、每批 50，但按来源分组会改变批次数，不能照抄注释把总量固定为两次。显式摘要停止码由第五轮适配暂停，无法追溯被上游隐藏的较早事件。 |
| `boss_hr_resume` | 旧简历端点标记 effect=unknown/replay_safe=false，默认 HTTP 路径不按安全读取自动重试/刷新；browser-only 遇明确旧接口下线还可能使用官方页面 viewer。业务只读工具标签不是底层端点 effect 的担保，页面动作总请求量不能由工具次数推算。 |
| `boss_hr_greet` | 审批后调用业务首次沟通写操作，不能从工具调用或 HTTP 成功推断真实送达；保持既有逐次审批和未知结果不重放规则。本轮不更改发送、确认或认证路径。 |

默认 auto、未进入 browser-only 的 replay_safe HTTP 路径最多 3 次重试，共 4 次尝试；限流可冷却后继续，明确 token 过期可 `force_refresh` 后继续。最终成功 v1 信封不保留这些中间事件，外层 Harness 不能据此恢复首次限制、证明没有刷新，或保证在首次不可见限制后停止。此处的 4 次是单个固定路径的上限，不是整个工具的网络预算。

离线证据分两层：真实求职 chat Click → 平台/客户端 → 基类重试 → v1 输出，合成 HTTP/认证/等待替身分别得到成功 1 次、限流后成功 2 次且顶层成功、持续限流 4 次后失败、明确过期后成功 2 次及 1 次刷新、账号风控 1 次失败；真实招聘客户端的候选人搜索和 friend_list 请求层也复现 2/4 次。后者不冒充完整 CLI 验证。探针隔离 HTTP、认证和等待并禁止真实 socket/DNS，不使用真实账号或平台；求职命令探针另记录零网络尝试，招聘客户端探针仅保存了拦截守卫而未记录尝试计数。这些结果只证明所述控制流，不证明平台返回完整性。

当前根 CLI 的 `--browser-source` 只有 `auto`、`existing-browser`、`stored-cookie`，另有独立 `--cdp-url`；它们是会话来源和通道选择，不是无重试开关。auto 允许存储凭据、探测 CDP、创建 context 和 headless；existing-browser 仅 CDP、不读存储凭据、不创建或启动浏览器，但允许探测；stored-cookie 仅用户指定 CDP、允许存储凭据、不探测/新建/启动。显式来源/CDP 可避开 HTTP 重试循环，但浏览器 `request` 对 replay_safe 读取仍有一次上下文恢复重放，建立/选页/导航也不等于零网络。本轮不会静默切换来源来代替请求控制。

未发现适用于这些普通工具的全局 `--no-retry`、`--no-refresh`、重试次数或环境变量契约。crawl/wizard 的同名重试参数不适用于此路径；节奏、等待或共享预算也不等于首次限制即停。真正的严格控制需要业务 CLI 明确、可验证的接口和中间事件契约；不能靠修改用户共享配置、注入 Python 模块或解析任意自由文本伪造。该上游缺口继续保留，不把本轮说明修正描述为已实现严格控制。

参考问题来自 [jackwener Issue #32](https://github.com/jackwener/boss-cli/issues/32)、[#27](https://github.com/jackwener/boss-cli/issues/27)、[#23](https://github.com/jackwener/boss-cli/issues/23) 的风险场景，以及 PR #25 的沟通动作边界（OPEN，head `2b44ba5c438965d622267c387936736a53d10a9b`）；只吸收问题，不采用其 HTTP/消息实现或账号结果。Pi 继续作为既有架构参考，本轮未修改通用机制或新增 Pi 依赖。

后续工具接入须记录逻辑调用、底层尝试、认证来源、部分结果与未知信息，保持停止、授权及恢复约束；如果用户场景要求首次限制即停或禁止刷新，应先解决对应业务契约。普通有限页只读原语仍可独立评估，但不得附带无重试保证、回复/导出权限或隐藏浏览器切换。全部研究/探针只保留本地，文档与模型可见描述同步交付；工具数量、schema、handler、argv、JSON-RPC 和审批规则保持原样。

## 第七轮：求职者沟通列表指定页

本项目 [Issue #22](https://github.com/can4hou6joeng4/boss-cli/issues/22) 新增有限只读原语 `boss_chat(page)`，用于查看用户当前业务 CLI 配置上下文中的指定页沟通概览。它与招聘者 `boss_hr_chat` 分开：不读取消息正文、不回复、不标记已读、不交换联系方式、不请求简历、不导出、不自动翻页，也不因上游能力发现而扩大本地允许清单。

业务来源固定为 `boss-agent-cli@bdc7034df563f1ea458d3af5bb4b40e8ea4603a8`（MIT；本机 checkout 与开放 PR #479 head 相同，仍不是已发布最低兼容版本）。该提交 `src/boss_agent_cli/commands/chat.py:27-58` 中，`chat --page` 默认 1，普通命令调用一次 `platform.friend_list(page=page)`，成功后从 `result` / `friendList` 取列表；导出和快照在后续独立分支，仅显式 `--export` 才进入。Harness 固定 argv 为 `chat --page=N`，不传 `--from`、`--days`、`--export`、`--output`、`--role`、任意位置参数或浏览器/凭据选项。关键词、列表文字和 `hints` 始终是数据，不能构成额外操作授权。

根 CLI 在 `main.py` 从用户 `config.json` 解析默认角色（缺省 candidate），但该工具不覆盖 `--role`，也不验证已登录账户身份。工具描述中的“求职者模式”表示这是 `chat` 候选人 CLI 原语，不代表实际账号身份已核验；调用沿用用户配置的业务二进制、平台和状态目录。

普通 v1 信封不提供分页对象，Harness 保留 `pagination=null`，不能由空列表或行数推断查完。命令在 `chat.py:93-108` 将缺失/空最近消息变为 `last_msg="-"`，将缺失/null/真实零未读数折叠为 `unread=0`；`initiated_by` 由关系类型生成，不代表最近发言方；`msg_status` 使用上游标签且当前代码的 `isinstance(status, int)` 也会把 bool 当整数处理。适配保留来源值，不推算“已读”“没有消息”或“待我回复”，不试图恢复命令层已丢弃的字段。普通非导出分支不调用快照/渲染导出函数；完整 CLI 仍可能初始化本地目录、读取认证并维护其状态，故工具 `readOnly` 只表示不暴露业务写操作或导出。

适配方法通过共享 `validate_arguments` 对直接调用再次执行精确整数/最小值检查（拒绝 bool、浮点、null 和字符串），然后只投影 `--page=N`。工具由现有注册表派生为只读，无逐次审批；其他 13 个工具契约与唯一 `boss_hr_greet` 写操作审批不变。最终上游错误继续服从通用 `PAUSE_CODES` / blocked 机制；本工具成功结果即使含与 recruiter 相似的 `summary_sources` hints，也不会命中第五轮严格绑定 `hr chat` argv 与 `recruiter-chat` 信封的部分停止投影。无自动 provider 续跑或执行 hints 命令。

问题参考：jackwener/boss-cli [PR #37](https://github.com/jackwener/boss-cli/pull/37)（本次核对为 OPEN，head `bee4a290df69da581520e566e3f46488885b53a3`）报告 chat 页码缺省问题；[PR #25](https://github.com/jackwener/boss-cli/pull/25)（OPEN，head `2b44ba5c438965d622267c387936736a53d10a9b`）区分消息列表、消息读取与回复；[PR #8](https://github.com/jackwener/boss-cli/pull/8) 和 [PR #6](https://github.com/jackwener/boss-cli/pull/6) 分别提供筛选 URL/多选与标签映射风险背景。只吸收问题边界，不复用其 HTTP、消息或账号实现，也不把其运行声明当作本项目验收。

请求次数和认证刷新继续服从第六轮固定来源分析：一次 `boss_chat` 是一次子进程及逻辑页派发，不是总 wire 请求承诺；默认 HTTP 客户端可能因限流重试或认证过期后刷新，成功信封会隐藏此前事件。若用户要求首次限制即停或禁止刷新，当前适配不能保证，不能偷偷换浏览器来源或添加未知参数。本轮不修改 Pi 执行机制，也不新增依赖。

验收边界：本地合成测试覆盖参数、精确 argv、只读权限、停止门禁、不套用 recruiter hints 转换以及持久历史和分页 null；固定 Click 命令使用惰性 AuthManager 与平台替身，禁止并计数所有 socket/DNS 尝试。stdio 重启和 Electron 重载/重连只使用合成列表，验证不自动重跑；大结果继续使用已有用户手动分段读取能力。离线或静态证据不代表真实平台结果、实际账户身份或全 CLI 零副作用。

## 第八轮：内核停止边界与后续建设

本项目 [Issue #24](https://github.com/can4hou6joeng4/boss-cli/issues/24) 处理模型输出截断和回合请求预算耗尽。招聘任务在连续读取职位、候选人或准备沟通参数时，不能执行可能被截断的参数，也不能把尚需模型续答的状态标成任务完成。

架构来源固定为 Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT），先阅读 `packages/agent/README.md`、`src/agent-loop.ts` 和 `src/types.ts`。其 `length` 分支整批拒绝工具调用，避免流式参数虽可解析但内容不完整；`finishTurn` 明确异常硬退出与队列检查顺序。本轮独立实现这些约束，不复制 Pi 源码或新增依赖。

采用方式与差异：

- `length` 响应中的全部已解析调用以原 call id 记录失败结果，`executionState=not_executed`，不申请审批、不调用 handler。文本保留为不完整回复；无工具的截断同样以 `error` 收尾，并发出 `MODEL_OUTPUT_TRUNCATED`。
- Pi 可回填拒绝结果后继续生成；本项目停止当前回合并暂停未投递队列，要求用户核对并明确继续。不会自动启动 follow-up 或重试本次响应。
- 既有上限实际为 6 次模型请求，包含工具回路及 steering 续答。第 6 次工具批次按既有审批、中断及平台规则执行；如果仍需下一次请求，以 `blocked` 和 `TURN_ROUND_LIMIT` 暂停，保留已取得结果。
- 第 6 次正常最终文本仍可完成，但不再投递需要第 7 次响应的 steering；应用将未投递项暂停。会话内串行、批次边界 steering、独立 follow-up 回合及未知副作用不重放规则不变。

JSON-RPC 维持 0.2.0；终态枚举、14 个招聘工具、参数、业务 argv 和审批清单不变。原因码放在既有 `session/error` 可选 `code` 字段中，并持久化恢复提示；旧客户端仍可显示消息。6 次上限暂未配置化。验证使用合成 provider、工具及临时会话，从运行器和正式应用入口覆盖无执行/无审批、结果配对、队列暂停、重启无重放与正常完成回归；测试只保留本地，不代表真实模型或平台验收。

本轮停止边界是内核强化的第一阶段，以下仍待实现：

1. **模型能力与完整请求预算**：窗口/输出上限随模型变化，统一计入 system/技能、工具 schema、thinking 和消息；`context/read` 与实际准入保持一致。usage 校准需绑定 provider/model、system/tools 和检查点，不能沿用陈旧用量。已阅读同一 Pi commit 的 `packages/ai/src/types.ts`、`src/api/simple-options.ts` 和 `src/utils/estimate.ts`；采用能力声明与每次请求准备的职责，暂不引入 Pi 模型库。
2. **显式工具组合接口**：统一工具定义与不可变 bundle，显式注入应用及每运行器 bridge factory；拒绝重复名或缺 schema/handler，保留只读策略与逐次审批。已阅读 coding-agent 的 `src/core/sdk.ts`、`resource-loader.ts`、`extensions/loader.ts` 及 `agent-session.ts`；参考 customTools/factory/active allowlist。技能继续仅提供显式上下文，不自动执行目录插件或扩权。
3. **可追溯压缩与生命周期接口**：从统一投影生成保留完整工具配对、最近回合和旧摘要来源的压缩计划，再接可取消、无工具权限的摘要请求；失败不写 checkpoint、不重放业务工具。已阅读 coding-agent 的 `session-manager.ts`、`compaction/compaction.ts`、`agent-session.ts` 及 agent 的 `prepareRequest`/`finishTurn`。先完成预算与稳定边界，再引入有限自动恢复；不采用实验性的 `packages/durable` 恢复语义。
