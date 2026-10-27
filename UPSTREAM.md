# 上游吸收记录

## 第三十七轮：摘要 checkpoint 原子发布

[Issue #95](https://github.com/can4hou6joeng4/boss-cli/issues/95) 来自真实 ApplicationService 的离线故障注入：完整 checkpoint 行已经 flush、随后 fsync 抛错，任务报告失败，但历史读取、重开存储及下一显式回合仍采用该新摘要。自动路径当前回合已阻塞，问题在后续上下文；有旧 checkpoint 时也会被未确认的新摘要替换。

参考 Pi 固定 main `842c73170a3658d4e3b39fcc84690211ed503e09`（MIT）的 SessionManager 与上下文投影职责，以及开放 [Issue #11460](https://github.com/earendil-works/pi/issues/11460) 对会话写入失败的审查。本项目不是其 orphan-parent 缺陷，也不采用实验性 durable 恢复。核对 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70` 的开放认证、沟通和分页事项后，没有可移植的通用 checkpoint 协议；本轮未认定该业务仓库的许可证或复制其代码。实现独立完成，无新增依赖。

新 checkpoint 在既有 SQLite writer 锁内重新校验 sourceDigest，逐字节流式复制旧日志并追加到同目录临时文件；候选成功 flush/fsync 后才原子替换原路径。替换前按已同步候选 inode 与元数据复核临时路径，替换后再次核对目标 inode；替换抛错时根据目标 inode 区分已公开、未公开及结果不确定，不能用单纯内容可读性代替同步确认。提交回调发生在公开之后、索引及结果读取之前，后续错误不能撤销已提交事实。所有会话写入必须经由 `SessionStore` 的 SQLite writer 锁；非协作进程直接修改 JSONL 不属于保证范围。普通 append、旧 checkpoint 格式、来源 digest、工具/审批及队列权限不变。

范围为本地文件系统的进程级公开一致性。每次摘要需 O(日志大小) 额外写入与临时空间；保留 POSIX mode 与 group，拒绝符号链接及额外硬链接，不保证 ACL/xattr 复制或任意断电持久性。所有验收使用临时合成状态，测试与证据仅保留 ignored 本地；真实模型和招聘平台验收仍未完成。

## 第三十六轮：文本与思考的持久化及恢复预算

[Issue #93](https://github.com/can4hou6joeng4/boss-cli/issues/93) 沿 #91 的资源边界审计发现独立缺口：工具参数已受限，但 provider 文本/思考可先累积到会话与事件日志，再因 8 MiB RPC 帧限制发送失败。真实离线 ApplicationService 复现单个 5 MiB LF 增量与 96 个各 100 KiB 增量：已持久化正文无法通过 1 MiB 条目或事件分页恢复。问题由本项目代码与合成探针确认，外部 Issue 标题不作为复现证据。

方向参考 Pi 固定 MIT commit `db14038bd847c5bad57de217e0ac0c5ad1ae60ba` 及开放 [Issue #11360](https://github.com/earendil-works/pi/issues/11360)、[Issue #11386](https://github.com/earendil-works/pi/issues/11386) 的输出与通知边界。前者的子进程问题已有本项目 #57 处理，后者的 MCP transport 在本项目不可达；这里只采用逐层检查资源预算的思路，独立实现，不复制代码或新增依赖。`jackwener/boss-cli` 的登录、Cookie 与招聘平台风控议题仍属于业务接入，未移入通用 provider。

本次在 provider 与执行器两层于追加、合并和通知前限制每响应 text+thinking 合计 1 MiB 原始 UTF-8 字节，权威快照保留高水位。超限整轮错误、关闭流，不审批或执行该响应工具、不自动重试或续跑队列，保留已接受前缀为 failed。持久增量拆为 32 KiB；64 KiB 以上 Agent 字段投影为引用，新增只读 `thread/item/content/read`，按 Unicode 码点分页、SHA-256 与长度核验。冻结快照绑定其原文；完成事件存引用，实时通知保留预算内全文与原 eventId/eventCursor。桌面在快照展示前恢复内容，迟到读取不覆盖新快照或事件，失败可见。

协议仍为 `0.2.0`，内容引用是新增可选字段；自定义恢复客户端需实现新读取方法。新响应内容在最坏 JSON 字符串转义下仍能通过 8 MiB RPC 帧，但不承诺单个 SSE 解码、provider 元数据、事件总数量或进程 RSS 的全局上限。历史超预算事件可能仍需通过快照恢复，原始历史不重写。最终离线回归 339 项中 335 通过、4 跳过；真实 stdio 10/10、应用矩阵 18/18 通过。官方 SDK MockTransport 经 ApplicationService 的两套组合（Anthropic 1.15.0 / OpenAI 3.35.1，与 2.3.0 / 3.39.0）各 35/35，覆盖 standard/beta、精确边界、初始/终态快照、取消和异常 SSE 关闭；两套 socket、DNS、子进程尝试均为 0。独立复审 20 项覆盖保留通道合计预算、跨类型索引、权威替换、重复 ID 拒绝、终态工具零执行及 renderer 迟到读取和无效引用。Electron 43.8.3 生产 main/preload/renderer 与隔离 stdio 后端的内容恢复 8/8 通过，覆盖历史引用、Unicode/摘要、9 项 IPC 拒绝、实时完成、重连、失败提示、重开恢复及超限前缀；该桌面探针运行 2 次合成 provider、2 个计划内本地后端进程，后端网络、DNS 和业务子进程尝试为 0。typecheck/build、compileall、npm audit（0 漏洞）及 diff 检查通过。测试、夹具和报告仅保留本地 ignored 目录，远端 CI 只运行源码构建；以上不是实际模型或招聘平台验收。

## 第三十五轮：provider 工具参数字节预算

[Issue #91](https://github.com/can4hou6joeng4/boss-cli/issues/91) 在 #89 修复完整性后继续核查资源边界：Anthropic SDK 先把 `partial_json` 累积并局部解析，OpenAI Responses 则可能从 added、delta、arguments.done 或 item.done 提供完整参数；事后 schema 检查仍允许超大原始输入进入持久层。固定参考 Pi 当前 main `db14038bd847c5bad57de217e0ac0c5ad1ae60ba`（MIT），开放 Issue [#11112](https://github.com/earendil-works/pi/issues/11112) 讨论工具参数解析失败钩子，[#11360](https://github.com/earendil-works/pi/issues/11360) 讨论子进程大输出边界，[#11386](https://github.com/earendil-works/pi/issues/11386) 讨论 MCP 输出限制。Pi issue 是问题来源，不复制实现；本项目 CLI 子进程 16 MiB 上限已由 #57 覆盖。当前 `jackwener/boss-cli` 开放 Issue 仍聚焦招聘业务、认证、平台权限与风控，没有通用 provider 参数预算契约可移植。

Anthropic 使用官方 SDK `messages.create(stream=True)` / beta raw event stream，在 partial JSON SDK accumulator 之前检查工具参数；按协议逐事件保留文本、思考、停止原因及 usage，要求工具块关闭后严格解析完整 JSON object。OpenAI Responses 对 added 初始参数、delta、arguments.done、item.done 和 completed/incomplete response output 快照执行同一字节预算；一致的终态快照不重复扣预算，冲突则拒绝整轮。两家 provider 的工具参数每项及每次模型响应合计 UTF-8 wire budget 均为 1 MiB；超过时关闭流，发出不可重试错误，不产生成功终态，也不回显 SDK 异常所含的原始模型输入。Anthropic beta fallback 仍使用官方 beta messages 路径。

原始 1 MiB 限制新增了对超多空白/JSON 转义的兼容边界，与既有 schema 对规范化 JSON 的 1 MiB 限制不同。已解码的初始对象采用有界结构预扫描，精确计算紧凑 JSON UTF-8 字节，再序列化；权威快照保留字节高水位、不退还预算。raw stream 不能阻止网络层先解码一个完整 SSE 帧，因此不声称硬 RSS 上限；文本/思考及完整 RPC 投影预算仍需独立处理。

离线合成 `ApplicationService` 验收覆盖 40 种场景：Anthropic 恰好 1 MiB 合法 UTF-8 参数仍派发；超限、多字节越限拒绝且畸形大参数错误不回显；OpenAI added、delta、arguments.done、item.done 超限、多个工具合计超限、completed 快照超限/冲突、终态后 delta、无初始项 delta、重复输出索引及缺少 item.done 均整轮报错且 handler=0；合法空参数、完整 delta 回退和匹配快照保持兼容。网络、DNS 和 subprocess 尝试均为 0。独立复审另有 107 组 UTF-8/转义精确边界通过。官方 Anthropic SDK 标准/beta 与 OpenAI Responses 经 MockTransport → ApplicationService 的 26 项独立验收通过：17 项超限均仅请求一次、关闭底流、审批/handler/工具落盘项为 0，原文不进入状态或协议；3 项取消均 interrupted 并关闭流，正常文本/思考和工具对照通过。网络、DNS 和子进程尝试均为 0；OpenAI SDK 用户代理平台探测以合成内存值固定。预算专项 5 组验证初始快照在 dumps 前拒绝、高水位不退款、精确字节、非法 Unicode 诊断与深 JSON 受控错误。所有测试、脚本和报告仅留 ignored `.boss-cli/provider-tool-arguments-audit-20261027/` 与 `.boss-cli/provider-output-budget-20261027/`。

## 第三十四轮：provider 工具参数完整性

[Issue #89](https://github.com/can4hou6joeng4/boss-cli/issues/89) 复核本项目 Anthropic/OpenAI 流式适配：不完整 JSON 可能被局部解析为可用字典，或最终工具项参数未被读取，导致未经完整性证明的参数进入 handler。参考 Pi 开放 [Issue #11112](https://github.com/earendil-works/pi/issues/11112) 对原始参数解析失败边界的讨论，独立实现，不复制代码或增加依赖。`jackwener/boss-cli` 当前开放 Issue/PR 仍聚焦招聘业务、平台权限与认证，没有通用 provider 工具参数流协议可移植。

Anthropic 适配现在逐 content index 累积原始 `partial_json`，等流块完整结束后用标准 JSON 解析器校验为 object，完全不信任 SDK 的 partial snapshot；截断、无效 JSON、非 object 或未闭合工具块会令整轮返回错误事件。OpenAI Responses 在 `output_item.done` 核对最终 `item.arguments` 和 `function_call_arguments.done`；单一最终来源可用，两个来源都出现时要求解析后对象一致，否则失败。合法空对象仍接受；空参数保持无参调用兼容，空白、非 object、无效常量和非标准 JSON 数值拒绝。失败响应不产生 `done`，应用不会派发工具。

离线 `ApplicationService` 验收覆盖 18 种 Anthropic/OpenAI 参数形状，合法调用正常完成，异常或冲突调用均为 0 次 handler 派发且回合报错；外部网络、DNS 与子进程守卫为 0。provider 事件映射 10 项通过，并单独验证 OpenAI 最终 item 缺少参数字段时可安全使用完整 delta。全量 Harness 339 项通过、4 项跳过；compileall 与 `git diff --check` 通过。测试脚本和报告仅保留在 ignored `.boss-cli/provider-tool-arguments-audit-20261027/`。

## 第三十三轮：队列暂停写失败的派发门禁

[Issue #87](https://github.com/can4hou6joeng4/boss-cli/issues/87) 复现了队列暂停追加失败后，旧 follow-up 留在 `queued`，并在后续手动回合成功时被自动派发。参考 Pi 开放 [PR #10016](https://github.com/earendil-works/pi/pull/10016)，固定审阅 head `bbab759c832a8708f31d7049074ccffa8d4e5999`（仓库 MIT）；该 PR 跟踪显式 wake follow-up 在 abort 后仍需送达的责任。这里仅借鉴明确保留待处理队列责任的审查视角，不移植其 abort/resume 行为或源码，因为本项目故障发生在暂停状态无法持久化。

`TurnQueue` 在写暂停状态前登记内存中的待暂停范围，并在新回合、入队、状态变更和领取前先补齐；部分写入失败后保留未结算范围，持续存储失败则拒绝继续派发。终态为 `error` 的 steering 暂停失败会升级为暂停该会话的全部旧任务。只读查询不触发补写；进程重启后由既有恢复流程将未结算队列转为暂停，不重放输入。JSON-RPC 和持久格式不变，不新增依赖。

离线 ApplicationService 故障注入覆盖写前/写后失败、部分成功、持续故障 admission、请求幂等、只读查询、重启、会话隔离及归档；11/11 通过。Python 3.12 Harness 全量回归 339 项通过、4 项跳过；`npm run typecheck`、`npm run build`、compileall 与 `git diff --check` 通过。测试与报告仅保留在本地忽略目录，没有真实模型、网络或招聘平台调用。

## 第三十二轮：显式会话生命周期 hooks

[Issue #80](https://github.com/can4hou6joeng4/boss-cli/issues/80) 将 Pi 的 AgentSession 生命周期事件与具体交互模式分离的思路接入招聘内核。当前 Pi main 固定为 `6c384aa30f619d7b28963f2bab24d8dacbe73cb6`；核对 `packages/coding-agent/src/core/agent-session.ts` 的会话/工具/压缩事件、`src/core/event-bus.ts` 的订阅边界及 `docs/extensions.md`。Pi extension runtime 可动态注册工具、命令和 UI；本项目只实现宿主显式注入的生命周期观察与工具前拒绝策略，不复制代码、不引入运行依赖，也不加载 workspace 插件。

`ApplicationService` 接受可选 `LifecycleHooks` 或 hook 对象序列。持久事件写入后进入容量 256 的有序队列，由独立 worker 分发，不在 EventHub 锁、JSON-RPC 调用线程或 runtime 锁中执行。观察上下文采用字段白名单，剔除消息/思考正文、参数、工具结果和审批细节；hook 故障以不递归观察的 `kernel/hookError` 事件记录。队列拥塞同样明确诊断，不反压模型流或丢弃底层持久事件。

`before_tool_call` 在 schema 校验后、审批和 handler 之前运行。hook 只能拒绝；`allow` 不授予权限，写操作仍经过原审批闸门。hook 错误、无效返回或超时都 fail closed，调用记录为 `not_executed`，回合暂停，不调用 handler 或模型自动重试。每个回调在隔离 daemon worker 中受限等待，迟到响应不能修改回合状态；正常应用关闭等待观察队列及 hook close，但服从应用既有共享关闭 deadline。hooks 为可信宿主代码，不是沙箱；上下文限长和凭据形态脱敏不替代宿主对个人数据访问的授权。

Issue #82 修正策略输入边界：`before_tool_call` 不能复用事件观察器的脱敏/截断投影。策略获取完整、深只读 JSON 副本；策略上下文紧凑 JSON 的 UTF-8 编码总量限制 1,052,672 字节，并限制 32,784 节点和 66 层，超限或非 JSON 在回调前明确拒绝并诊断。事件观察仍保留独立脱敏白名单，不向观察器暴露工具参数。

验证以真实 ApplicationService/RPC 和合成宿主 hook 检查：无 hook 兼容行为、持久事件顺序、正文投影隔离、工具拒绝/审批保持、策略异常与超时、慢观察不阻塞另一会话、关闭收尾和 hookError 不递归。测试、夹具和脚本仅保留本地；无模型、招聘平台或网络调用。

## 第三十轮：真实会话上下文预算与手动摘要桌面闭环

[Issue #76](https://github.com/can4hou6joeng4/boss-cli/issues/76) 接通既有内核预算、计划和后台摘要接口，让招聘会话用户核对长工具结果的上下文占用、保留近期完整回合，再显式整理较早历史。原 Cockpit 的其余运行指标继续标记示例；真实面板不把草稿外的默认预算称为下一请求完整预览。

阅读 Pi 固定 commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）的 `packages/coding-agent/docs/compaction.md`、`src/core/agent-session.ts` 手动 `compact()` 和 `getContextUsage()`、`src/modes/interactive/interactive-mode.ts` 的 `/compact` 交互。采用手动与自动触发分责、明确用户动作、近期历史保留、进度和写入后刷新。独立适配既有 Python/JSON-RPC/Electron 生命周期，不复制源码或新增依赖。Pi 手动入口先 abort，本项目继续要求空闲，打开面板不隐式中断任务；不引入自定义摘要 hook 或实验性 durable 恢复。

预算沿用完整请求分类估算与 usage 前缀校准，并展示容量与估算来源。规划不调用模型或工具；显式摘要绑定用户核对的范围和来源 digest，来源过期不绕过校验自动重试。成功追加 checkpoint 后重新读取当前预算，保留原始记录和工具、审批事实，不把摘要当作语义无损或操作授权。

JSON-RPC 保持 `0.2.0`。`context/read` 仅增加可选非递归 `compactionJob` 引用，从现有有界任务缓存和会话占用索引定位活动或最近任务。`active` 表示执行责任，终态但收尾未结束时仍为真；空引用与旧服务缺字段分别表示本进程无保留记录和未知。详情按既有 jobId 读取并核对会话归属，完成结果中的预算只是历史快照。引用不构造 provider、不改变调度或持久化，不承诺跨进程恢复任务。

桌面保存会话级已确认及未知开始责任，切换、关闭、晚到响应与断连不重复 start。开始回执和事件均丢失时通过新鲜引用及详情对账，旧终态任务不能冒充本次开始；重启或缓存淘汰只刷新持久事实，不重建摘要或重放外部动作。main 通过可序列化信封传递明确的 start RPC 拒绝，由 renderer bridge 解码，使过期来源拒绝与传输结果未知保持不同状态；自动摘要由业务回合控制，与手动取消明确区分。再次核对本仓库及 `jackwener/boss-cli` Issue/PR 后未发现重复开放事项；该业务上游的认证、沟通与分页事项继续作为独立边界，不移植到通用上下文执行器。

本地验证：`npm run typecheck`、`npm run build`、`npm audit --audit-level=moderate`（0 漏洞）、Python `compileall` 和 `git diff --check` 通过；隔离 Python 3.12 环境运行 Harness 全套 339 项，339 通过、4 跳过。Electron 43.8.3 真实 main/preload/renderer 与隔离 stdio 后端通过 8 项流程验收，覆盖预算/计划、回执和事件丢失对账、会话隔离、终态收尾、过期来源拒绝、重启/无模型状态和 480px 布局；只有合成摘要请求（2 次），真实模型、平台、网络和业务子进程调用均为 0。测试、脚本及报告仅保留本地。独立桌面安装包、签名/公证、真实模型和招聘平台完整验收仍在后续范围。

## 第三十一轮：会话级推理档位与模型能力边界

[Issue #78](https://github.com/can4hou6joeng4/boss-cli/issues/78) 补齐会话在简单职位检索与复杂候选人比较之间调整推理预算的控制面。当前 provider 已接受 `ModelRequest.effort`，但 `turn/start` 只能选择模型，推理强度仍来自启动环境或 Codex profile；用户无法在不改全局配置的情况下调整并恢复某个招聘会话。

阅读 Pi 固定 commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）`packages/coding-agent/src/core/agent-session.ts` 的 `setThinkingLevel()`、`thinking_level_change` transcript 记录和模型切换后的能力 clamp；当前 Pi main `6c384aa30f619d7b28963f2bab24d8dacbe73cb6` 保持该会话级职责。Pi 的 `PromptOptions` 没有把 maxTokens 或 thinkingLevel 作为单次用户回合字段，因此本轮不新增孤立的 per-turn max token 覆盖，也不复制 Pi 源码或引入运行依赖。

本项目独立增加 `thread/reasoning/read` 与 `thread/reasoning/set`，`null` 表示继承启动配置。设置作为 `thread_info.reasoningEffort` 追加到 append-only 会话历史，分叉继承创建时的设置，不写入环境变量或 Codex profile。有效档位必须来自部署者显式提供的 `ModelCapabilities.reasoningEfforts`；未知模型的兼容容量不会顺便猜测推理能力。活动回合与摘要任务持有的模型能力集合和会话模型取交集，设置失败时不写历史；已准备或正在传输的请求保持旧档位，下一次请求准备边界读取最新设置。

每次完整请求的预算、请求 fingerprint、自动/手动摘要的每个无工具片段和 provider 适配都使用同一有效 effort。摘要任务在每个片段开始前读取会话值，资源收尾期间仍保留摘要模型的能力交集；worker 与 abort 都结束后，桌面重新读取并放宽档位列表。重启能力表移除已保存档位时，read 返回 `supported=false`，桌面提示并可恢复继承配置，不静默降级。

桌面通过生产 preload/main/renderer 暴露的安全方法读取和保存会话设置。设置回执丢失时先读取状态、不重复写入；切换会话后旧读取响应被丢弃；设置菜单保留错误提示和重试入口。验证：隔离内核 22/22 通过，覆盖 provider 参数构造、预算/fingerprint、活动回合、分段摘要、重启/分叉、能力过期、并发模型交集和关闭边界；Electron 43.8.3 生产链路 10/10 通过，合成 provider 3 次、工具 1 次，真实模型、招聘平台、网络和业务子进程均为 0。测试材料、脚本和报告仅保留本地。

## 第二十九轮：跨入口请求身份与队列关联

[Issue #73](https://github.com/can4hou6joeng4/boss-cli/issues/73) 处理同一会话的直接发送与后续排队使用同一请求编号时，旧回合虽被去重但新队列长期停在 `delivering` 的既有缺口。`ce5a9c6` 与 `ecb0e50` 均有离线复现；旧回合仍运行、执行失败、仅有回合记录，以及反向从排队转为直接发送也需要按实际身份和持久事实处理，不能只修复正常完成分支。

阅读 Pi 固定 commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）的 `packages/agent/src/agent.ts` 队列与运行准入、`packages/coding-agent/src/core/session-manager.ts` 条目身份/历史投影，以及 `docs/rpc.md` 接受请求与执行结束的区别。本项目独立实现持久身份解析和受限收据补偿；Pi 没有相同的 `clientUserMessageId` 持久跨入口契约，不宣称复用其幂等实现，不复制源码或新增依赖。

身份范围为 `(threadId, clientUserMessageId)`，原始输入精确比较，旧 turn digest 只证明输入文本，不扩大到模型、技能或附件配置。统一解析完整条目快照中的用户输入、合并回合和最新队列，按既有 owner 规则识别旧记录；输入冲突、steering 类型冲突或多个不同回合的歧义在新增请求和构造 provider 前拒绝。已保存输入的旧运行/终态回合只关联为已投递，不合成旧生命周期事件；明确未启动失败继承真实失败信息，未知执行证据暂停待核对。尚无回合的旧队列请求通过稳定错误与安全状态数据返回，不虚构 `turnId` 或越过队列顺序。

队列只追加可选的去重关联字段，JSON-RPC 保持 `0.2.0` 和 `TurnStartResponse.turnId` 必填约定。恢复仅对未结算队列补充可证关联，不自动执行模型、工具或审批，也不恢复暂停/撤回项；旧输入、工具结果、审批和未知外部动作事实原样保留。桌面区分已关联旧回合、明确启动失败及需核对的未知记录；直接发送当前每次生成新请求编号，原有未知回执读取会话的行为继续保留。

本地完整回归 339 项中 335 通过、4 跳过，独立服务/RPC/真实 stdio 验收 48/48 通过，含同脚本 `ecb0e50` 基线对照；基线失败项包含本轮新增的明确拒绝策略，不能全部视为旧功能回归。生产 Electron 43.8.3 main/preload/renderer、隔离 stdio 后端及真实后端重启验证关联、未知提示、撤回、普通队列和 480px 显示。通知及最终响应读取都保留逻辑目录责任，无变化重试不重复写日志或事件。验证均为合成状态，无真实模型或招聘平台调用，测试、脚本及报告仅保留本地；未知/矛盾旧数据仍须人工核对，完整请求配置指纹不在本轮范围。

## 第二十八轮：后续回合启动失败与真实执行责任

[Issue #71](https://github.com/can4hou6joeng4/boss-cli/issues/71) 来自隔离故障注入：队列已标记投递后，线程构造或启动前异常会使外层再次暂停时报错，掩盖原始异常，且缺少终态通知；启动调用已经创建真实 worker 后再抛错时，原路径还会提前释放执行和状态目录责任。输入追加或事件发布也可能先提交再抛错，不能把异常简单解释为“没有发生”。基线 `ce5a9c6` 保留这些缺口。

参考 Pi 固定 commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）的 `packages/agent/src/agent.ts` 中队列、`activeRun`、`runWithLifecycle()` / `finishRun()` 职责，独立实现本项目的 Python 线程启动与持久化补偿，不复制源码或新增依赖。以稳定的线程启动事实分流：实际启动后保持原 `turnId` 和真实 worker 的完整责任；尚未启动时追加安全固定失败元数据，将当前投递项暂停，保留已保存输入，并用用户请求编号与输入 digest 防止失败重放。失败通知逐类 best-effort 尝试一次，不重发可能已持久化的事件，原启动异常仍为主要错误。

队列 claim 到回合准入的分发段、失败通知及 bridge 收尾都继续持有状态目录责任；启动失败通知在所有外层运行锁之外执行。同会话只允许一个分发段，快速回合完成时将后续唤醒交回尚未返回的分发者，保留正常串行队列顺序。JSON-RPC 保持 `0.2.0`，队列只新增可选关联字段，无新状态或自动恢复接口；旧记录不推断可重试。桌面展示输入已保存、尚未保存或需要核对的区别，暂停项可撤回，由用户核对后明确发起新任务。重新核对 `jackwener/boss-cli` 开放 Issue/PR 后，仍将认证、分页和真实沟通问题作为独立业务契约，不直接移植到通用执行器。

本地完整回归 339 项中 335 通过、4 跳过，独立服务/RPC/真实 stdio 验收 33/33 通过。生产 Electron 43.8.3 main/preload/renderer 与隔离 stdio 后端验证输入保存三态、失败撤回、启动后异常、普通队列及 480px 显示；使用合成故障、无模型模式和专用假 CLI，无真实模型或招聘平台调用。永久存储及通知失败仍只能 best-effort，不承诺无法写入的状态已持久化；测试和报告仅保留本地。跨直接回合与队列入口使用同一请求 ID 后留下 delivering 的既有问题独立记录为 [Issue #73](https://github.com/can4hou6joeng4/boss-cli/issues/73)。

## 第二十七轮：回合取消与终态提交边界

[Issue #70](https://github.com/can4hou6joeng4/boss-cli/issues/70) 来自真实 `TurnRunner` 已返回完成结果、应用尚未持久化终态时的确定性竞争：中断返回 `interrupted=true` 且取消已置位，原回合仍记为 `completed`，现有 follow-up 自动执行。原始 `736e56b` 与合并后 `3edbd5a` 均可复现，属于既有提交边界缺口；合成 provider 和隔离状态验证无网络、真实模型、平台或外部业务进程调用。

参考 Pi 固定 commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）`packages/agent/src/agent.ts` 的 `activeRun`、`runWithLifecycle()` / `finishRun()` 和事件收尾职责，独立在本项目的运行锁内统一取消接受、终态写入、队列暂停与执行槽位释放。runner 已返回但取消先于终态提交时，优先以 `interrupted` 结算；既有文本、工具结果、审批及外部动作事实不删除、不重放，也不声称被撤销。终态先完成后，旧 `turnId` 不能影响后续 owner，正常完成继续合法 follow-up；之后显式新任务不复活已暂停队列。

本轮不改变 JSON-RPC `0.2.0`、异步中止分发和 provider/worker/bridge/目录收尾契约，无代码复制或新增依赖。队列启动失败恢复仍由独立 [Issue #71](https://github.com/can4hou6joeng4/boss-cli/issues/71) 跟踪。

最终 Python 3.12 完整依赖环境回归 339 项中 335 通过、4 跳过；独立应用/RPC/真实 stdio 验收 14/14 通过，同批基线 `3edbd5a` 为 9 失败、5 通过。覆盖完成/取消先后、无 factory 与独立 factory、12 路并发取消、关闭共享预算与目录责任、合成写工具及审批结果保留、重启不重放，以及终态后的显式新任务不复活暂停队列。父子验收网络、真实模型、平台及业务进程调用均为零，仅 1 个专用测试子进程；测试与证据仅保留本地 ignored 目录。

## 第二十六轮：手动取消分发与中止所有权

[Issue #68](https://github.com/can4hou6joeng4/boss-cli/issues/68) 来自独立取消审计：`turn/interrupt` 在全局运行锁内同步等待 provider abort，合成慢 hook 使另一会话的启动也等待；手动摘要 worker 已结束而 abort 尚未完成时，provider 被第二摘要复用，迟到中止命中新流。复现使用真实 `ApplicationService` / `JsonRpcServer` dispatch、隔离状态与合成 provider，不证明默认 SDK 必然发生同样时序，也不将独立线程下可完成的读取夸大为全部 RPC 都被运行锁阻塞。

继续参考 Pi 固定 commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）`packages/agent/src/agent.ts` 的 `abort()`、`waitForIdle()` 与 `runWithLifecycle()`：取消请求与等待运行/事件收尾分责。独立复用本项目的 `TrackedAbort` 认领记录，手动回合及摘要取消先在锁内置位全部相关 cancel，再在锁外和 RPC 线程外分别分发；关闭复用同一记录，不重复调用 hook。模型执行、终态通知、bridge 和已分发 abort 完成前继续保留 provider/job/index；实际取消仍依赖 provider 协作，不强杀 Python 线程。

无 factory 的主 runner 同样检查完整业务 job 所有权。正常 follow-up 改为在旧模型及资源收尾后派发，保留串行主实例兼容；尾部派发单独跟踪状态目录责任，关闭仍按共享 deadline 等待它完成，不因让渡 provider 而提前释放目录。直接 `TurnRunner.interrupt()` 的同步嵌入接口与 JSON-RPC `0.2.0` 保持原有约定，无代码复制或新增依赖。

最终本地完整回归 339 项中 335 通过、4 跳过；独立应用/RPC/真实 stdio 验收 14/14 通过，同批旧基线 `736e56b` 为 11 失败、3 通过。慢 abort 未放行时，stdio 取消和后续请求约 9.5ms 内返回；故障探针 5/5、无 factory follow-up、关闭尾部目录 owner 及启动失败登录锁序回归通过。合成验收父子进程网络、真实模型和平台调用均为零，专用测试子进程 1 个；全部测试与证据仅保留 ignored 本地目录。默认 SDK、真实平台及独立桌面安装包仍未验收。

## 第二十五轮：应用关闭预算与取消分发

[Issue #66](https://github.com/can4hou6joeng4/boss-cli/issues/66) 来自关闭竞态复现：业务回合和摘要各自等待两秒会串行延长退出时间，首个阻塞的 provider abort 还会延迟其他任务的取消；worker 结束但终态通知或 abort 仍在进行时提前释放状态目录，也会允许第二个应用取得错误的 owner。

参考固定的 Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）`packages/agent/src/agent.ts` 的 `abort()` 与 `waitForIdle()` 职责分离，以及 `packages/coding-agent/src/core/agent-session.ts` 的会话收尾边界。本项目独立实现 `TrackedAbort`、共享 deadline 和应用级取消编排：先冻结准入并置位所有取消，再在锁外异步派发业务、摘要和连接 abort，最后让所有 worker 共用同一最多两秒的等待期限。不把 Pi 的两秒政策或其代码引入本项目。

业务 job、摘要 job 与连接检查在对应 worker、abort 和终态通知都完成前保持 provider、bridge、摘要索引及状态目录所有权；重复 close 只认领一次 abort，线程构造/启动失败也不会同步执行可能阻塞的 provider hook。关闭和 idle 回调遵循登录路径的 `connections.lock → runtimes.lock` 顺序，避免反向嵌套。同步 base bridge `close()` 仍依赖嵌入方快速返回的既有约定，不能宣称任意嵌入 hook 都具备严格 wall-clock 上限。

独立审查补充直接启动及嵌套 follow-up 的 worker 启动失败与登录并发验证：应用尚未关闭时，idle 回调提前返回，避免在调用方仍持有运行锁时获取连接锁；进入关闭后继续二次校验所有任务和资源所有权。

验证使用真实 `ApplicationService` worker、合成 provider/bridge 和隔离状态目录：应用验收 9/9 通过，混合任务关闭约 2.010 秒，四 worker 约 2.002 秒；Harness 全套 339 项中 335 项通过、4 项跳过，专项 94/94 通过。网络、真实模型和招聘平台调用均为零；验收脚本和故障探针仅保留 ignored 本地目录。

## 第二十四轮：摘要来源有效性与历史投影

[Issue #62](https://github.com/can4hou6joeng4/boss-cli/issues/62) 来自合法 append-only revision 复现：`read_items()` 已显示修正后的远程岗位偏好，`history()` 仍用旧现场办公摘要隐藏修订；同一来源的摘要 planner 已正确拒绝。较新完整回合的 fork 和重新打开会话后仍复现，普通桌面 UI 的晚期修订触发路径未证明，影响结论限定于存储、嵌入、恢复及分支兼容。

阅读 Pi 固定 `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）`packages/coding-agent/src/core/session-manager.ts` 的 `buildContextEntries()` 与 `core/compaction/compaction.ts` 的 `prepareCompaction()`，采用历史和摘要规划共享来源投影的职责划分。本项目独立提取 checkpoint 校验，从同一次 entries 快照验证完整来源前缀、回合终态和摘要写入前后覆盖条目的规范投影；不迁移 Pi 树路径/firstKeptEntryId 或拆分回合机制，无代码复制或新增依赖。

history/read 对失效摘要回退最新完整逻辑原文，`checkpoint=null`，不改写记录或自动重建摘要；显式 planner 继续明确拒绝不一致来源。只检查已摘要前缀，正常活动用户/工具尾部与未覆盖修订兼容。回退原文后继续完整请求预算和 usage 指纹门禁，不借过期摘要绕过限制；已发出的模型请求无法追溯撤回，后续历史投影使用修订后的事实。JSON-RPC 0.2.0 无新增公共字段，业务工具与审批权限保持既有约定。

21 项本地专项通过，覆盖用户/工具结果修订、严格 metadata 变化、fork/reopen、多摘要、正常活动尾部、坏来源/字段、原文预算阻断及 usage anchor 失效。另有 3 项独立验证覆盖合法 v1 checkpoint/活动尾部、read 单快照一致性，以及累计摘要修订后不同 fork 的原文回退。测试、脚本与证据仅留本地，使用合成状态，网络、模型和招聘平台调用均为零。

## 第二十三轮：模型连接检查关闭与任务隔离

[Issue #61](https://github.com/can4hou6joeng4/boss-cli/issues/61) 来自连接诊断生命周期复现：旧 `close()` 只设取消事件，模型 worker 未收到 abort 或等待，取消又使 timeout 提前退出，报告可持续为 checking。审查还发现旧 timer 和异常路径可覆盖新检查或已经提交的取消状态。参考 Pi 固定 `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）`packages/agent/src/agent.ts` 的 active-run 取消与 `waitForIdle`，以及 `packages/ai/src/api/openai-responses.ts` 的 SDK signal 所有权；独立实现 Python 诊断任务收尾，无代码复制或新增依赖。

每个模型检查使用独立身份关联 provider、worker、超时与中止，终态在同一锁内提交。关闭将 checking 转为 failed/CANCELLED，先到的 CHECK_TIMEOUT 保持不变；关闭期间工厂晚返回不进入 stream。模型迭代器由消费 worker 关闭，中止任务在锁外执行并与检查共享两秒关闭等待预算；未完全收尾前保留所有权，防止旧 abort 影响重试实例。CLI/login 沿用既有取消与 bridge 关闭顺序。同步 provider 中止及 SDK 建连仍是协作式，不宣称可以强杀任意阻塞实现。

本轮再次只读核对 `jackwener/boss-cli` 开放 Issue/PR：Issue #35 的来源策略边界已有独立交付，PR #37 页码及其他招聘、认证变更未出现适合本诊断修复的新增差异；不移植不同 CLI 的认证或自动沟通代码。业务工具允许清单、审批及 JSON-RPC 0.2.0 保持既有契约；验证使用本地替身与隔离目录，测试及证据仅留本地。

23 项本地专项和 12 项独立边界验证通过，含 60 轮关闭/超时竞争、工厂晚返回、旧 timer、慢 abort、stream.close 异常、线程构造/启动失败及重试；独立应用 shutdown 验证确认任务收尾后同一状态目录可以由新应用接管。原有连接/bridge/组合隔离回归继续通过，不把这些未提交的本地测试描述为远程 CI 内容。

## 第二十二轮：模型工厂实例运行所有权

[Issue #58](https://github.com/can4hou6joeng4/boss-cli/issues/58) 来自嵌入式并发审查：自定义 `provider_factory` 返回同一对象时，两个回合共用实例级流/abort 状态；双 Gate 替身复现中断 A 后 A interrupted、B error。默认内建工厂创建新实例，缺口属于嵌入方工厂的准入契约。参考 Pi 固定 `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）`packages/agent/src/agent.ts` 的运行级 AbortController 和 `packages/ai/src/api/openai-responses.ts` 的 SDK signal 传递职责，独立实现 Python 实例所有权检查，无代码复制或新增依赖。

在运行锁内检查非空工厂返回值，拒绝应用主 provider、仍在 `runtimes.jobs` 中的 worker（含释放 active 槽位后的通知/收尾阶段）或运行摘要持有的实例。业务回合检查在 reserve、turn 记录和用户输入写入之前；只释放新建 bridge，不对已有 owner 调用 abort/close。手动与自动摘要也统一检查 jobs，避免收尾期借用同一实例。旧 worker 完全结束后的临时实例串行复用、未提供工厂的旧串行路径、返回 None 的无模型并发均保持兼容。JSON-RPC 0.2.0 和业务/审批边界不变。

11 项独立离线验证覆盖主实例、活动/收尾业务 owner、摘要冲突、拒绝时无持久化/无新回合、仅新 bridge 清理，以及正常独立实例并发中断隔离；手动和自动摘要在旧 worker 收尾期均拒绝复用，旧 worker 完全结束后可正常生成摘要。测试材料仅本地保留；不调用真实模型或招聘平台。模型连接检查的关闭收尾和摘要来源修订后的历史有效性属于另行复现的后续工作，不把本轮修复描述为所有生命周期缺口已经完成。

## 第二十一轮：CLI 子进程输出预算

[Issue #57](https://github.com/can4hou6joeng4/boss-cli/issues/57) 来自子进程传输入口审查：原 `communicate()` 完整缓冲 stdout/stderr 后才校验信封，后续 RPC 帧限制及结果分段不能保护内核内存。隔离基线中 17 MiB stdout、9+9 MiB 两管道及小信封加 17 MiB stderr 都被接纳，Python 分配峰值约 47–54 MB。补充问题来源为核对时 OPEN 的 [Pi Issue #11360](https://github.com/earendil-works/pi/issues/11360)；阅读固定 `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）`packages/coding-agent/src/core/exec.ts`，它也按字符串累积输出。本项目独立实现原始字节预算，不复制其代码或异常处理，不新增依赖。

每个 CLI 子进程的两路输出共用 16 MiB 限额，独立 reader 和 stdin writer 保持背压。超一字节就终止既有进程组，返回固定 `CLI_OUTPUT_LIMIT`，不把任何截断内容作为信封或 raw 返回；上限内再严格解码 UTF-8 并校验既有 v1 七键。EOF 与子进程退出都确认后才接受结果，检查完成竞态再次核对限额。线程部分启动失败或读取失败也先停止生产者，再关闭未启动管道并回收 I/O worker。

本地超限独立于上游平台停止码，不扩大 hr/chat 元数据匹配。执行器暂停同批后续调用、模型续跑和 follow-up；已派发写操作明确记为 `outcome_unknown`。16 项合成进程/应用验收和 4 项异常边界通过，覆盖精确上限、两管道合计、Unicode、大 stdin、取消/超时、后代持管道、线程启动失败及提前 EOF。测试与证据仅保留本地，真实模型/招聘平台调用为零；既有 JSON-RPC、业务 argv、审批和上限内大结果读取保持不变。

## 第二十轮：桌面显式选择运行时技能

[Issue #55](https://github.com/can4hou6joeng4/boss-cli/issues/55) 补齐已有 `skills/list`、`turn/start.skillIds` 与桌面输入区的交互缺口。阅读 Pi 固定 `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）的 `packages/coding-agent/docs/skills.md`，采用技能目录发现与显式调用分离的职责。本项目只加载工作区 `.boss-cli/skills/*/SKILL.md`，经现有 RPC 显式选择最多 10 项，全文仅用于当前直接发送回合的提示上下文；不采用 Pi 的自动模型选择、脚本执行或全局目录加载。全部独立实现，无代码复制或新增依赖。

目录提供未连接、加载中、空、失败重试和刷新状态。新会话和已有会话都将所选 ID 原样传给 `turn/start`，成功转交后清空；失效选择阻止直接发送。队列协议暂不携带技能，运行中不允许新增选择，已有选择会明确阻止排队并提供清除入口，不静默忽略。保持 JSON-RPC 0.2.0、业务 CLI、工具允许清单和审批权限不变。再次复核 `jackwener/boss-cli` 开放 Issue/PR 后，本轮选择通用 Harness 缺口，没有移植其认证或自动沟通方案。

Electron 43.8.3 使用生产 main/preload/renderer、合成工作区与独立用户/会话目录，验证两条发送路径的后端 turn 技能元数据、单次清空、刷新、队列阻止与显式清除、480px 菜单边界。目录错误与断连由 IPC 故障注入；无模型模式与假 CLI 的 Python socket 审计为零，未调用真实模型或招聘平台。测试脚本与证据仅保留本地，源码 CI 不运行这些材料。

## 第十九轮：会话分支隔离执行队列

[Issue #53](https://github.com/can4hou6joeng4/boss-cli/issues/53) 来自本地会话生命周期审查：此前 `fork_thread` 复制所有扩展记录，再暂停子会话队列，导致原会话消息可随分支重新进入投递范围。参考 Pi 固定 `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）的 `session-manager.ts` 历史分支与 `agent-session.ts` 运行队列职责分离；本项目使用独立 append-only 队列协议，在深拷贝历史时过滤全部 `queue` 记录，移除子队列暂停操作，不复制 Pi 代码或新增依赖。

普通消息、已投递输入、附件、上下文 checkpoint 及其来源字段继续保留；父引用按保留记录重连，原会话文件和队列不变。保持已结束回合及完整工具批次边界，重启恢复也不会生成子队列。本轮不改变 JSON-RPC 0.2.0、业务 CLI 或权限。离线验证覆盖五种队列状态和重启，未调用真实模型或招聘平台；测试材料仅保留本地。

## 第十五轮：自动压缩与有限溢出恢复

[Issue #45](https://github.com/can4hou6joeng4/boss-cli/issues/45) 继续参考 Pi `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）的 `packages/agent/README.md`、`src/agent-loop.ts` 请求准备/工具完成顺序，及 coding-agent 的 `docs/compaction.md`、`docs/settings.md`、`agent-session.ts` 中 `_checkCompaction`、`_runAutoCompaction`。采用在下一次业务模型请求前准备上下文、独立摘要、来源冻结后提交和一次溢出恢复的职责划分，全部独立实现，无新增依赖或代码复制。

适配采用完整请求 `inputBudget` 使用率阈值（默认80%），已扣输出储备和4096安全余量；不照搬只按上下文窗口减reserveTokens的公式。启动环境及每回合参数可关闭或覆盖阈值/近期保留目标。默认保留20000估算token；只压缩旧完整回合，当前活动回合及其工具配对始终原样保留。替换前严格核对历史投影前缀，实时消息尾部沿用原对象，不从持久化条目重新构造而丢失思考或暂存steering。准备后更新运行内存，避免下一工具轮次恢复旧全文；摘要期间新到steering在业务请求前再领取一次并重新预算。

固定Pi的 `packages/ai/src/utils/overflow.ts` 包含广泛错误表达式、413、usage超窗及部分length启发式。本项目仅在可信OpenAI精确错误code或Anthropic带数字上下限的typed prompt拒绝处添加可选 `ModelErrorInfo`；不解析普通错误文本、截断或usage来推断恢复。只有当前请求无任何文本/思考/工具事件时最多压缩重试一次，失败与重试同计6次业务请求；第6次错误不启动无后续请求额度的摘要。先前成功工具结果完整保留，不重跑工具/runner/审批，也不复制Pi对失败历史的删除或省略策略。

自动摘要同步由业务worker持有，通过现有任务索引、独立provider与分段生成器报告reason/turnId、逐片usage和进度；中断同时取消业务与摘要流，worker退出前继续持有状态目录所有权。全流程核对active owner、取消与source digest，最终使用当前精确system/技能/附件/tools/消息/输出储备准入。checkpoint成功后的观察异常不撤回已提交状态；取消后不自动续跑。无可压缩前缀且仍在预算内可继续，已启动摘要失败则暂停并保留队列。

本轮只读刷新 `jackwener/boss-cli`：Issue #35 的隐式Cookie/Keychain访问及 #32/#27/#23 风控问题仍作为边界约束；PR #28 recommend分页、#29真实greet、#24简历同步均不直接进入通用内核。相关状态会变化，未采信外部自述的live-test作为本项目验收，也未调用真实招聘平台。

## 第十七轮：显式传递业务 CLI 浏览器来源

本项目 [Issue #49](https://github.com/can4hou6joeng4/boss-cli/issues/49) 处理招聘工具调用与上游浏览器来源策略之间缺少宿主级控制的问题。上游 `boss-agent-cli@bdc7034df563f1ea458d3af5bb4b40e8ea4603a8` 的 `status` 默认只读 TokenStore，但 `auto` 来源下的部分认证恢复会自动探测 CDP 或启动 headless。此结论只对应固定源码，不是任意 `BOSS_CLI_BIN` 的运行保证；jackwener/boss-cli Issue #35 仅提供隐式本机凭据访问的安全问题背景，两项目命令实现不同。

新增可选进程变量 `BOSS_HARNESS_BROWSER_SOURCE`，允许 `auto`、`existing-browser`、`stored-cookie`，值正规化后作为全局 `--browser-source` 参数传入每次业务 CLI 子进程。未设置时完全不增加 argv，原样继承上游配置；无效值在创建工具桥时拒绝。若显式来源被较旧或自定义 CLI 拒绝，既有单次子进程协议只返回失败，不会删参后重试。连接报告暴露 `browserSourcePolicy=inherit|auto|existing-browser|stored-cookie`，桌面连接页显示所选值。

这是来源策略控制，不是无重试或零副作用保证：`auto` 仍允许上游浏览器选择；`existing-browser` 可探测/复用现有 CDP；`stored-cookie` 依赖本地保存凭据及上游显式 CDP 配置，并在不可用时失败。Harness 不读取浏览器数据库、调用 Keychain 或改写共享 `config.json`。来源来自 Pi 的职责分离原则（运行配置由宿主显式组合），不复制 Pi 或上游代码，无 JSON-RPC 主版本变化；协议只新增可选诊断字段。

## 第十八轮：桌面端 steering 与 follow-up 生命周期

本项目 [Issue #51](https://github.com/can4hou6joeng4/boss-cli/issues/51) 补齐已存在的 `turn/steer`、`queue/add/list/remove` 内核 RPC 与桌面 Composer 之间的交互缺口。固定 Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283` 的 `packages/agent/src/agent-loop.ts` 及 coding-agent 交互层区分 steering（工具批次结束后进入下一模型请求）与 follow-up（当前运行自然结束后再继续），并将 interrupt 作为独立动作。本项目沿用已持久化队列、`expectedTurnId` 和 JSON-RPC，不复制 Pi 代码或引入依赖。

桌面运行态输入提供显式两态选择；队列面板显示最近 20 项类型和真实状态，允许撤回处于 `queued` 或恢复后处于 `paused` 的未投递项目。快照/事件用于恢复和同步队列；每次队列写入使用客户端请求 id 幂等。回执未知时保留原草稿和请求 id；通过 `queue/list` 核对到已受理项目时清除草稿而不重放；核对成功但不存在时才允许按新请求提交，查询失败则保留原请求关联。停止仍调用 `turn/interrupt`，不假设 steering 会中断正在执行的工具。本轮只扩展 TypeScript 协议客户端类型和 renderer，无 RPC 版本变化。

## 第十六轮：摘要任务资源保留上限

[Issue #47](https://github.com/can4hou6joeng4/boss-cli/issues/47) 针对自动与手动摘要反复运行后进程内任务注册表无界增长。参考 Pi 固定 commit `d5b3de22d0e24a3e9c38a9410d3329b099717283` 的 coding-agent 对手动/自动摘要分别持有 AbortController、完成或失败时清除 controller 的生命周期（`agent-session.ts` 的 `_clearManualCompactionState`、`abortCompaction` 和 `_runAutoCompaction`），以及 [Pi Issue #11297](https://github.com/earendil-works/pi/issues/11297) 提出的长期压缩状态有界目标。Issue #11297 本身讨论的是 Pi 文件列表累积，本项目没有对应 fileOps 数据，因此只采用“长期状态须有界”的设计提示，不复用其业务数据方案。

本项目有独立的后台 `jobId` 轮询/取消协议，区别于 Pi 的单 controller。手动摘要运行数限定为 `parallelThreads`，自动摘要仍由业务回合并发槽位约束；活跃任务永不淘汰，最近64条终态公开状态在进程内保留。任务进入终态时释放 provider、含密钥配置、worker 和取消事件；淘汰的 `jobId` 以结构化 `COMPACTION_JOB_NOT_FOUND` 返回。会话中的 append-only checkpoint、usage 与通知事件不受内存淘汰影响。内核重启仍不恢复摘要任务；无持久调度器或协议版本变化。该实现独立完成，无代码复制或新增依赖。

## 第十四轮：保留近期回合的分段摘要

[Issue #43](https://github.com/can4hou6joeng4/boss-cli/issues/43) 面向大工具结果导致摘要请求自身超限的长招聘会话。固定参考 Pi `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）的 `packages/coding-agent/src/core/compaction/compaction.ts` 中 `findCutPoint`、`prepareCompaction`、`generateSummaryWithUsage`，以及 `utils.ts` 的序列化。采用先准备统一投影、冻结范围、无工具摘要、成功后提交 checkpoint 的职责划分，全部独立实现，无新增依赖或代码复制。

适配差异：Pi 可在 assistant 边界拆分回合并另生成 turn-prefix summary，本项目只在完整回合之间切点，保留工具配对及明确的招聘任务状态。`keepRecentTokens` 默认参考 20000，但只是字符估算目标；整回合保留可能超过目标，小窗口需显式降低目标。自动阈值触发和 overflow 恢复仍是后续范围。

该固定 Pi 版本将摘要输入中的工具结果截为 2000 字符。本项目保留完整原始条目、来源与 `executionState`，将包括单条超长结果的全文按 Unicode 码点连续分段；每个无工具请求携带上一步临时摘要、字符范围、全文 digest 和字符限额，重新做完整预算准入。临时摘要只在内存中滚动，最多 32 个 provider.stream 生成阶段，provider 内部传输重试不计为新阶段；逐步 usage 不参与业务 usage 校准。任意片段失败、取消、非法响应或最终预算不足均不写新 checkpoint；只有全部片段成功，且默认业务模型的 system/tools/保留尾部预算通过时一次提交。不存在工具重放，也不宣称模型摘要语义无损。

来源 digest v2 同时绑定原始前缀和最新 checkpoint 的 id/payload，拒绝倒退覆盖以及只改变旧摘要的过期计划；已被旧摘要覆盖的原文后来被修订时拒绝继续压缩。v1 digest 必须重新读取；省略 digest 的旧用户摘要调用继续兼容。任务进度按已处理 Unicode 码点和生成阶段数报告，原始 JSONL 与来源引用不删除。模型摘要与用户摘要的标签分别标明来源。所有失败路径擦除配置凭据；checkpoint 成功追加即标记任务完成，后续读取或事件通知异常不改成失败。

验证使用合成 provider、空工具组合、虚构记录和临时状态；覆盖大单条用户/工具结果、完整近期工具批次、每次预算、最坏 JSON 转义、取消和中途失败、旧 checkpoint 冲突、32 次请求上限与最终业务模型预算。本地测试、脚本和夹具不提交；不以源码 CI 通过替代真实模型或招聘平台验收。

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
3. **可追溯压缩与有限自动恢复**：从统一投影生成保留完整工具配对、最近回合和旧摘要来源的压缩计划，再接可取消、无工具权限的摘要请求；失败不写 checkpoint、不重放业务工具。Bridge 的同步关闭接口已由应用、运行器和连接检查按资源所有权收尾；该接口独立于 Pi 的会话压缩与扩展 shutdown 事件。已阅读 coding-agent 的 `session-manager.ts`、`compaction/compaction.ts`、`agent-session.ts` 及 agent 的 `prepareRequest`/`finishTurn`。不采用实验性的 `packages/durable` 恢复语义。

## 第十一轮：按请求前缀校准模型 usage

[Issue #32](https://github.com/can4hou6joeng4/boss-cli/issues/32) 收敛 provider usage 的使用边界。当前请求预算仍以 `characters/2+message-overhead` 为保守 fallback；成功响应现在额外保存 provider、model、完整请求指纹和消息前缀长度。

固定 Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）的 `packages/ai/src/utils/estimate.ts` 使用适用于当前前缀的最近成功 usage 作为基线，只估算后续新增消息。本项目独立实现请求指纹和 provider 归一化，不复制 Pi 代码或引入 tokenizer 依赖。OpenAI `input_tokens` 已包含 cached tokens，Anthropic 的 `input_tokens`、`cache_read_input_tokens` 和 `cache_creation_input_tokens` 按各自语义合并。

只有成功且带有可验证 usage 的响应才可成为锚点；provider、模型、system、tools、options、消息前缀或 checkpoint 变化都会使锚点失效。匹配时将 usage 基线与新增尾部的字符估算合并，并标记 `usageApplied=true`；否则保持原估算和 `usageApplied=false`。usage 原始记录仍可读取，不宣称精确 tokenizer、计费或跨 provider 可比性。

## 第十二轮：可追溯压缩计划与来源校验

[Issue #34](https://github.com/can4hou6joeng4/boss-cli/issues/34) 在自动摘要前先冻结压缩来源。新增只读 `context/compact/plan`，按已收尾回合返回 source item IDs、范围边界、条目数和 SHA-256；`context/compact` 可接受同一 `sourceDigest`，来源变化时在追加 checkpoint 前拒绝。旧客户端省略 digest 仍兼容原用户摘要流程。

Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）的 coding-agent compaction preparation 先冻结 projection/cut point，再在摘要成功且来源未变化时追加 compaction entry。本轮独立实现只读计划和提交前校验，不复制代码，不调用摘要模型，不引入 `packages/durable` 或自动阈值恢复。完整工具调用/结果配对、原始 JSONL 和摘要来源 hash 保持可追溯。

## 第十三轮：可取消的模型摘要任务

[Issue #36](https://github.com/can4hou6joeng4/boss-cli/issues/36) 将第十二轮的来源计划接入独立摘要执行。新增 `context/compact/start`、`context/compact/abort` 和 `context/compact/read`：任务在后台运行，按冻结的 through-turn 与 source digest 构造单条摘要输入，模型请求不携带招聘工具、bridge、技能执行或业务回合条目。

摘要请求只接受非空纯文本和正常 `stop`，任何 tool call、截断、错误、取消或超长响应都以失败收尾；provider 的 `request_abort()` 与任务取消事件同时生效。成功响应的 usage 以 `context_summary_usage` 单独落库，`eligible=false`，不会成为普通回合的 usage 基线。追加 checkpoint 前在运行锁内重新生成计划并核对 digest，来源变化时不写入；原始条目和既有摘要仍保留。

这轮参考 Pi 固定 commit `d5b3de22d0e24a3e9c38a9410d3329b099717283` 的 `generateSummaryWithUsage`、AbortSignal 和成功后追加 compaction entry 的顺序，独立实现 Python provider/JSON-RPC 生命周期，不复制源码或引入 `packages/durable`。自动阈值触发、overflow 一次性恢复和正式桌面摘要界面仍另立范围。

## 第九轮：模型能力与完整请求预算

[Issue #26](https://github.com/can4hou6joeng4/boss-cli/issues/26) 继续内核强化。招聘任务加载技能/材料、增加工具结果或切换模型后，原固定 200k 预算无法反映实际请求：工具 schema 和 thinking 未计入，`context/read` 还省略 system。

来源仍固定 Pi `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）：先读 `packages/ai/README.md`、`src/types.ts` 的 `Model.contextWindow/maxTokens`、`src/utils/estimate.ts`、`src/api/simple-options.ts`，以及 agent README 与 `src/agent-loop.ts` 的 `prepareRequest`。本轮采用模型容量独立于供应商传输、完整请求前准备和分类估算的职责；独立实现，不复制源码、不引入 Pi 或新增运行依赖。

采用方式：

- 不可变 `ModelCapabilities` / `ModelCatalog` 按精确 provider/model 解析容量，默认从唯一环境变量 `BOSS_HARNESS_MODEL_LIMITS` 读取严格限量 JSON；嵌入方可注入目录。未知模型显式采用 200000/64000 本地兼容假设，不猜测别名或实际网关能力，也不读取认证文件和动态模型目录。
- `TurnRunner.request_preparer` 在完整 `ModelRequest` 形成后准入，覆盖 system/技能、材料/消息、thinking、工具 schema/调用/结果及请求选项。保留旧 `context_check` 供嵌入兼容，正式应用只使用完整路径。
- 输出取用户请求与声明模型上限的较小值，另保留 4096 安全余量。与 Pi 可随输入缩小输出不同，本项目不因输入增长静默压缩回复额度；超限记录预算、返回 `blocked` 与 `CONTEXT_BUDGET_EXCEEDED`，不调用 provider、不自动启动 follow-up。
- steering 先转 `delivering` 作为排他认领，但不写用户条目或发 Applied。下一请求预算成功且检查取消后才确认投递；失败由既有收尾暂停，无隐式重试。此前已经完成的工具不会因预算不足而重放。
- 终态记录、队列清扫与释放回合占用使用和入队相同的运行锁，防止清扫后仍接受指向旧回合的 steering 而留下悬挂项；事件在锁外发布，保持释放占用后通知的约定。
- 运行中复用已准备快照，保留裁剪前请求输出值；空闲预览复用相同提示、技能/附件、只读工具投影和模型配置。每请求持久 `context_budget`，`context/read.lastBudget` 在重启后可查；预算只保存计数/来源，不保存额外私密正文。
- 主动模型连接检查的小请求使用同一容量准入，并将裁剪后的输出上限同时交给 factory/config 和 request；预算不足不构造供应商。它是独立诊断，不写会话预算历史，不扩大现有网络触发授权。

兼容与限制：JSON-RPC 维持 0.2.0，新增响应字段和 TypeScript 契约；工具、领域 argv、审批及平台暂停不变。未知模型请求输出超过 64000 会按兼容假设裁剪，需要明确更高容量时配置覆盖。`context/read` 活动回合不能同时请求下一回合预览；普通空闲读取针对默认下一回合，若要包含一次性技能和附件须明确提供相同参数。旧直接调用 `ContextService.read/check` 仍保留历史估算接口，正式 RPC 不走省略工具的旧路径。

本项目继续标记字符估算，尚未接入模型 tokenizer。Pi 可使用适用 usage 与尾部增量校准；本轮 `usageApplied=false`，仅独立展示历史 usage，避免模型/工具/检查点变化后的陈旧用量影响准入。自动摘要、阈值恢复和更完整生命周期接口仍待后续阶段。

验收使用合成 provider/工具、临时状态与真实 ApplicationService/RPC/持久化入口，覆盖容量切换、输出裁剪、大窗口高输出、完整预算与预览一致、schema/输入/结果/steering 越限、并发隔离、队列暂停及重启不重放。测试只在本地保留，源码 CI 只负责构建及依赖审计；没有真实模型、平台或安装包验收。

## 第十轮：显式工具组合与 bridge 隔离

[Issue #28](https://github.com/can4hou6joeng4/boss-cli/issues/28) 将统一执行器与招聘领域工具的组合职责分开。应用现在可通过 `ToolDefinition`、`ToolBundle` 显式配置工具 schema、handler、逐次审批分类、system prompt、暂停策略、bridge 描述和可选离线回复；`ToolRegistry` 从不可变定义导出工具和只读投影。默认 `create_boss_bundle()` 只从唯一招聘 `TOOLS` 表派生，维持原 14 项顺序、schema、handler、参数兼容、唯一写工具审批及平台停止规则。

架构参考仍是 Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`（MIT）。阅读 `packages/coding-agent/docs/extensions.md`、`src/core/sdk.ts` 的 `customTools`、`src/core/extensions/loader.ts` 的 `registerTool`、`src/core/agent-session.ts` 的 active allowlist 和显式工具 projection。采用其“注册与执行清单分离”的职责；本项目使用同步、进程内 Python host callbacks，不复制代码或引入依赖。schema 使用有界受限 JSON 子集并在注册时拒绝未支持关键字；不支持自动目录加载、动态导入、热重载、名称覆盖或插件市场。handler、暂停策略及 bridge 描述回调属于可信嵌入方代码，不提供沙箱隔离。

`ApplicationService` 接受 `tool_bundle` 与显式 `bridge_factory`；所有生成的 bridge 须可弱引用并支持独立 `cancel_event`。在共享 runtime lock 下用弱引用记录仍存活 bridge 的身份，避免模型回合和 host connection check 获得同一对象并覆盖取消信号，也避免保留对象本身。自定义 bundle 无论其 id 如何命名，local/platform 检查及平台登录 RPC 均 disabled/`NOT_SUPPORTED`；模型连接探针仍走本轮预算。默认招聘 bundle 保持既有 local/platform/login 行为。初始化描述回调的返回值须是有界 JSON 且不能覆盖工具清单或 bundle id，失败可重试握手。

Bridge 按 [Issue #30](https://github.com/can4hou6joeng4/boss-cli/issues/30) 可选实现同步且应快速返回的 `close()`；未实现时可提供同步 `dispose()`。两者并存时只调用 `close()`。每回合临时 runner、连接检查/登录流程和应用级共享实例分别由其所有者在工作结束或全部运行退出后收尾；关闭请求先取消并等待相关工作。每个实例最多调用一次关闭钩子，异常只记录类型名，不覆盖已确定的工具或回合结果。Bridge 工厂仍须为每个运行器返回独立、可弱引用且支持 `cancel_event` 的实例。

工具结果在持久化/暂停策略前按严格 JSON `ToolResult` 校验。callback 异常、非法 envelope 或非法暂停策略统一成为 `TOOL_ERROR`；已派发写工具持久化为 `outcome_unknown` 并暂停后续队列，不再自动重放。只读会话 projection 和执行入口共用注册表，恶意猜测写工具名或参数不合法均不产生审批或副作用。`requires_approval` 是宿主安全分类，嵌入方必须把有副作用操作设为 `True`。

本轮只读核对 `jackwener/boss-cli` 最近相关开放事项（2026-10-26 快照）：[Issue #34](https://github.com/jackwener/boss-cli/issues/34) 请求候选人搜索页自动打招呼；[PR #29](https://github.com/jackwener/boss-cli/pull/29)，head `a32839b`，改为真实 `/chat/start` 写操作；本项目继续让写工具逐次审批，不照搬其流程。[PR #37](https://github.com/jackwener/boss-cli/pull/37)，head `bee4a290df69da581520e566e3f46488885b53a3`，为 `boss chat` 显式提供页码，属于本项目已处理的问题来源。[Issue #35](https://github.com/jackwener/boss-cli/issues/35) 指出只读命令可能读取浏览器 Cookie/Keychain；这支持把平台凭据与普通工具组合隔离。上述事项没有提供可移植的通用 Harness composition 实现，故本轮 Pi 固定 commit 是接口架构来源，Boss CLI issues/PRs 仅作为业务与权限边界证据。

验证使用真实 `ApplicationService`、JSON-RPC、临时会话、合成 provider 和虚构 handler。默认 bundle 14 项完整投影/兼容和参数接受性验证通过；工具/schema 套件 23 项、bundle 应用 11 项、Application/Connection 回归 37 项、预算 10 项、停止边界 5 项、平台宿主隔离 8 项、工具结果读取 10 项及 Python-host IPC 7 项通过。`npm test` 的 Python/桌面/IPC 60 项、TypeScript 检查、桌面构建、smoke，以及 Python 3.10 下 application 37 项、schema 23 项、host 隔离 8 项通过。干净 Git 源 wheel/sdist 构建和 wheel 独立安装通过；安装产物保留 14/13/1 工具投影且不包含 tests 或 scripted provider。所有测试、测试辅助与负控仅在本地忽略目录，不进入 Git 提交。未调用真实模型、招聘平台或默认 Electron profile。
