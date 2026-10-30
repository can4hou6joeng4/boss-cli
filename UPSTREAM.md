# 上游吸收记录

## 第一百零九轮：被放弃分支摘要（第三步）

参考 Pi MIT 固定提交 `a14cdf90f0a76532f3e20bc3c01872837cef24ba` 的 `packages/coding-agent/src/core/session-manager.ts`：`branchWithSummary()` 移动 leaf 时为被放弃分支追加摘要条目，进入新分支上下文。本轮独立实现，不复制 Pi 源码或新增依赖。

适配差异：Pi 同步写入调用方提供的摘要；本项目复用压缩的可取消后台任务（`SummaryPlanner` 分片、隔离 provider、`before_request` 检查、用量记录、事件恢复与终态上限），仅换用分支专用系统提示。来源为原 leaf 沿回合树回溯至与目标共同祖先之前的回合条目（尊重上下文编辑排除）。摘要条目紧随本次 `leaf` 记录追加，提交时校验该记录仍是最新且其后无新回合，因此只投影在该分支；投影时置于目标回合之后，与压缩检查点不合并（检查点覆盖锚点时紧随摘要前缀），`compacted_request` 前缀校验同步包含。切换前完成模型线路、来源与并发预检，失败则不切换；指针移动后摘要失败 / 取消不回滚，任务运行期间会话按摘要占用处理。hook 提供摘要与 Electron 入口留待后续。

## 第一百零八轮：会话内分支端点枚举（第二步收尾子集）

参考 Pi MIT 固定提交 `a14cdf90f0a76532f3e20bc3c01872837cef24ba` 的 `packages/coding-agent/src/core/session-manager.ts`：`getTree()` / `getChildren()` 由条目 `parentId` 构建会话树供分支选择器使用。本轮独立实现，不复制 Pi 源码或新增依赖。

适配差异：不信任写入方 `parentId`，而是沿用第一步 `_active_entries()` 的规则，以每条记录追加时的投影尾部推导各回合的父回合（遗留无 `turnId` 条目按 `_item_owners()` 归属）；树只到回合粒度，不暴露条目级节点。`thread/branches/list` 只返回端点（无子回合的回合）并按首次出现顺序分页，游标绑定会话与端点视图；`capabilities.sessionBranchTree` 声明。`thread/fork` 指定当前分支外的已结束回合时，以内存中的临时 leaf 投影该分支后复制，不写入指针。`task/read`、线程列表元数据、分支视图快照分页与 branchWithSummary 留待后续步骤。

## 第一百零七轮：会话内分支展示投影（第二步子集）

参考 Pi MIT 固定提交 `a14cdf90f0a76532f3e20bc3c01872837cef24ba` 的 `packages/coding-agent/src/core/session-manager.ts`：`getBranch()` / `buildSessionContext()` 自 `leafId` 投影当前分支，界面与模型共用同一路径。本轮独立实现，不复制 Pi 源码或新增依赖。

适配差异：为兼容未感知分支的旧客户端，读取类 RPC 默认仍返回完整日志；客户端在 `capabilities.sessionBranchViews` 声明后可对 `thread/read`、`thread/turns/list`、`thread/items/list` 传 `view: "branch"`，复用第一步的 `_active_entries()` 投影条目与编辑状态，回合元数据取自索引并按当前分支回合过滤，`lastTurn` 改为当前分支末回合，并附 `thread/leaf/read` 同形的 `branch` 元信息。分支视图游标带视图作用域，与完整日志游标互不接受。冻结快照分页（`snapshot=true` / `snapshotId`）暂拒绝分支视图；`task/read`、线程列表元数据与分支端点列表留待后续步骤。

## 第一百零六轮：会话内分支 leaf 指针（第一步）

参考 Pi MIT 固定提交 `a14cdf90f0a76532f3e20bc3c01872837cef24ba` 的 `packages/coding-agent/src/core/session-manager.ts`：会话为 append-only 条目树，`leafId` 指向当前位置，`branch()` / `resetLeaf()` 只移动指针，`buildSessionContext()` 自叶节点沿 parent 链投影上下文，`branchWithSummary()` 另写被弃分支摘要。本轮独立实现，不复制 Pi 源码或新增依赖。

适配差异：Pi 的 leaf 只在内存中，重新加载即回到最后条目；本项目把指针持久化为 append-only `leaf` 记录（目标为某回合最后一条终态 `turn` 记录，或 `null` 表示回到首回合之前），重启后保持所选分支。投影不信任写入时的 `parentId`（并行工具与恢复修订可能并发追加），而按文件顺序为每条记录记下追加时的投影尾部再回溯；迟到的条目修订、工具批次、阶段与编辑按所属回合归入或排除，摘要检查点按 `throughTurnId` 是否在当前分支保留（与 #236 分支摘要规则一致）。没有 `leaf` 记录的旧会话原样返回，行为不变；伪造或指向未知条目的 `leaf` 记录 fail closed。投影目前只作用于模型上下文、预算/压缩、续接预检与 `thread/fork`；`thread/read`、条目列表与线程元数据仍展示完整日志，留待后续步骤。新增 `thread/leaf/read` 与 `thread/leaf/set`（仅在 `capabilities.sessionLeaf` 声明后可用）及可选通知 `thread/leafChanged`，协议仍为 `0.2.0`；切换要求会话空闲、无未结束回合、未决审批、投递中队列与持久化围栏，并在 SQLite 写锁内读写。

临时探针验证旧会话投影不变、切换分支后历史投影与新回合续写、切回原分支与重置到根、fork 仅复制当前分支、非法 / 运行中 / 伪造指针拒绝、压缩检查点在分支间的保留与排除、迟到修订归属、多线程并发切换与追加后日志可由另一 store 实例读取，以及一次 stdio JSON-RPC 端到端（能力声明、读写指针、`context/read` 消息数、续接预检在分支后返回 `CONTINUATION_NOT_LATEST`）；compileall、TypeScript typecheck、Electron 源码 build 与 `git diff --check` 通过。探针未提交；未调用真实模型、网络或招聘平台，未改 Electron 前端。

## 第一百零五轮：业务请求的受限 transformContext

参考 Pi MIT 固定提交 `a14cdf90f0a76532f3e20bc3c01872837cef24ba` 的 `packages/agent/src/agent-loop.ts`（`streamAssistantResponse` 在 `convertToLlm` 前调用 `transformContext(messages, signal)`）与 `types.ts` 的说明：宿主可在每次模型调用前裁剪或改写发送给模型的消息，持久消息不变。本轮独立实现，不复制 Pi 源码或新增依赖。

现状核对：工具结果截断与 content/details 分离（`tool_results.py` 的模型结果字节上限与分页读取）、回合/条目生命周期事件、`before_request` / `before_tool_call` / `after_tool_call` 均已具备；会话树内分支需改持久格式与前端，风险较高。缺口是宿主无法按自身策略缩减单次请求的历史投影，只能整体拒绝请求。

适配差异：Pi 可任意改写 `AgentMessage[]`；本项目 hook 只能读、不能改写事实，因此 `transform_context` 仅允许按内核划分的历史单元整体省略，最后一个单元（当前输入及其后的工具往返）不可省略，单元边界保证工具调用/结果配对与角色顺序；输入为有界脱敏元数据而非完整消息。仅作用于业务回合（摘要与连接检查不调用），在完整预算准备后、`before_request` 前执行，`before_request` 看到变换后的 `messageCount`；省略只会减小请求，故沿用已准备预算。失败按策略 hook 体例 fail closed，取消时不变换。

Python 3.14 临时探针覆盖整单元省略只影响请求、持久历史不变、`before_request` 观察到新消息数、返回 None 与无 hook 不变、异常/非法返回/省略当前单元拒绝请求且不调用 provider、取消、工具往返单元划分、摘要用途跳过、旧 hook 与 `config/read`；另以 `/tmp` 脚本化 provider 经真实 stdio JSON-RPC 跑三轮回合，第三轮模型只收到当前输入。`compileall`、TypeScript typecheck、Electron 源码 build 与 `git diff --check` 通过；探针未提交，未调用真实模型或招聘平台。

## 第一百零四轮：steering 投递模式 all / one-at-a-time

参考 Pi MIT 固定提交 `a14cdf90f0a76532f3e20bc3c01872837cef24ba` 的 `packages/agent/src/agent.ts`（`PendingMessageQueue`、`steeringMode`）与 `agent-loop.ts` 的投递点：`all` 一次注入全部排队消息，`one-at-a-time` 只注入最早一条，其余留待后续投递点。本轮独立实现，不复制 Pi 源码或新增依赖。

适配差异：Pi 默认 `one-at-a-time`，本项目默认 `all` 以保持既有行为，经 `BOSS_HARNESS_STEERING_MODE` 或 `ApplicationService(steering_mode=...)` 选择，非法值启动即报错且不回显原文；`config/read` 公开生效值。投递仍走持久队列 claim/commit，压缩后的追补在 `one-at-a-time` 下若本请求已含一条则跳过；回合结束或请求上限耗尽时剩余 steering 与原先一致转为 paused。follow-up 分派本就逐条进行，未改动。协议保持 `0.2.0`，持久格式不变，旧会话读取不受影响。

本地临时探针覆盖两种模式的注入条数与顺序、压缩追补、上限耗尽后剩余项暂停、非法配置与旧会话恢复；探针未提交，未调用真实模型或招聘平台。

## 第一百零三轮：Anthropic provider 补齐自动重试

参考 Pi MIT 固定提交 `a14cdf90f0a76532f3e20bc3c01872837cef24ba` 的 `packages/coding-agent/src/core/agent-session.ts`：`isRetryableAssistantError` 判断瞬时错误，`retryDelayMs` 指数退避，`auto_retry_start` / `auto_retry_end` 通知重试过程。本轮独立实现，不复制 Pi 源码或新增依赖。

现状核对：OpenAI Responses 已具备首个输出前重试、Retry-After、硬用量上限不重试及共享恢复预算（第九十八、一百零一轮），而 Anthropic provider 禁用了 SDK 内置重试却没有自己的重试循环，瞬时 429/529/连接失败直接让回合失败，两条线路行为不一致。本轮把退避参数、Retry-After 解析与延迟计算抽到 `models/retry.py` 由两条线路共用，Anthropic 按 OpenAI 同一规则拆成重试外层与单次尝试：只在尚未产出任何内容事件前重试；HTTP 408/409/429/5xx 与 Anthropic 529 可重试，SSE 内错误只认 errors.py 明确标为瞬时的 provider code；智谱 1308、配额类 code、上下文溢出及 `retryable=False` 不重试；后台流泵未确认收尾时停止重试；每次额外尝试先向回合共享 `ModelRecoveryBudget` 预留，耗尽时终态标为不可重试，退避期间取消释放预留。

适配差异：Pi 在会话层重试整条助手消息并发 `auto_retry_*` 事件；本项目重试位于 provider 内、首个输出前，对调用方静默，仅写 stderr，不新增通知或协议字段，因此已输出内容不会重复。

Python 3.14 临时探针用合成 SDK 客户端验证 429 带 Retry-After-Ms 与 529 后成功、尝试次数用尽、400 与智谱 1308 / billing_error 不重试、已输出文本后不重试、流内 overloaded 首输出前重试、连接失败重试、预算耗尽停止且标不可重试、成功重试只扣一次额度及退避期间取消退还额度；`compileall`、TypeScript typecheck、Electron 源码 build 与 `git diff --check` 通过。探针未提交；未调用真实模型、网络或招聘平台。

## 第一百零二轮：工具批次 sequential / parallel 调度模式

参考 Pi MIT 固定提交 `a14cdf90f0a76532f3e20bc3c01872837cef24ba` 的 `packages/agent/src/agent-loop.ts`：工具调用先按模型顺序逐个 prepare，批内任一工具为 sequential 则整批串行，全部为 parallel 时并发执行，结果按源顺序回填。本轮独立实现，不复制 Pi 源码或新增依赖。

适配差异：`ToolDefinition.execution_mode` 默认 `sequential`，非法值（含不可哈希值）报规范 `ValueError`，`requires_approval=True` 不得声明 parallel；默认 BOSS 工具共享上游 data_dir、浏览器与登录态，全部保持串行，不因只读自动并发。只有整批显式 parallel、无审批、宿主能提供独立工具桥时才并发。参数校验、生命周期策略与 start 持久化在回合主线程按模型顺序惰性进行，仅在有空闲槽位即将派发时才 prepare；有界线程池只并发 handler 调用；finish 持久化、暂停判定与通知在主线程按源顺序写入，历史重建与 live 结果一致。在途 handler 与工具桥数量均受 worker 上限约束，工具桥按需创建、批内复用、每个至多关闭一次，额外工具桥创建失败后本批不再重试；暂停、策略拒绝或取消后尚未 prepare 的调用与串行一致只经 `_skip_calls` 以 `not_executed` 收尾；prepare 或 finish 异常时先等待在途 handler 并按序收尾已 prepare 的调用，再原样传播。回退串行仅在首个独立工具桥不可用、尚无任何调用落库或启动时发生。

临时探针验证默认与混合批次串行、并行重叠且结果/持久化/历史按源顺序、取消与暂停后未启动项不执行、工具桥数量受限且各关闭一次、工具桥不可用时无副作用回退、策略拒绝第 k 项与串行持久化形态一致、prepare 异常不多留孤儿 start、额外工具桥工厂失败只再调用一次及非法模式报错；compileall、TypeScript typecheck、Electron 源码 build 与 `git diff --check` 通过。探针未提交；未调用真实模型、网络或招聘平台，也未启用任何并行业务工具。

## 第一百零一轮：共享 provider 与 agent 的有限恢复预算

参考 Pi MIT 开放 [Issue #9474](https://github.com/earendil-works/pi/issues/9474)，截至 2026-10-30 仍为 OPEN；核对 Pi `main@50d9f823e414eafb5f4459d16728a2464cd7939f`。该议题的单次传输总期限已由本项目 [Issue #205](https://github.com/can4hou6joeng4/boss-cli/issues/205) 覆盖，剩余缺口是 provider 重试与 agent 恢复各自计数、彼此叠加。本轮不复制 Pi 源码或新增依赖。

本项目 [Issue #237](https://github.com/can4hou6joeng4/boss-cli/issues/237) 固定基线 `main@382dbc2b43e9c1b836ce7d7893605379168baeb0`，为每个逻辑业务回合建立默认 8 次的运行时恢复预算。OpenAI Responses 仅在瞬时失败、尚未输出且后台传输清理确认后，为每次额外 transport attempt 预留一次额度；正常首次调用不计入。退避期间取消会释放预留额度，预算耗尽时不再等待或启动 transport，并将流终态标为不可重试。上下文溢出进入自动恢复前也消耗同一额度；恢复被预算阻止时回合错误明确带有 `recoveryBlocked=true`。因此 provider 多请求重试与一次 agent overflow recovery 不再分别拥有完整上限。

`ModelRequest.recovery_budget` 是运行时对象，不进入 session JSONL、RPC、模型请求、请求指纹或任务上下文身份。自动 compaction 的分片请求沿用触发它的业务回合预算，使摘要 provider 重试也扣同一额度；独立手动 compaction 使用自己的预算。Anthropic SDK 已禁用内置重试。每回合原有普通模型请求上限、摘要正常分片上限及每次传输时限继续独立生效；本轮不声称新增逻辑回合总墙钟期限，也不把正常请求/分片误记为 recovery。

Python 临时会话与合成 provider 探针验证跨 `stream()` 调用的 provider 预算共享、无预算直接调用保留原重试次数、退避取消归还额度、overflow 与 provider retry 共享额度、耗尽后不调用自动恢复、摘要片段继承运行时预算及 request copy 保留对象身份。`compileall`、TypeScript typecheck、Electron 源码 build、wheel/sdist build 与 `git diff --check` 通过。探针未提交；未调用真实模型、网络或招聘平台。真实 provider 长会话、Electron 桌面交互与用户验收仍未完成。

## 第一百轮：分支按摘要来源保留上下文检查点

本项目 [Issue #235](https://github.com/can4hou6joeng4/boss-cli/issues/235) 在主线 `382dbc2b43e9c1b836ce7d7893605379168baeb0` 上复现：父会话先保存 `throughTurnId=t1` 的摘要，再包含已结束回合 `t2`；父 `ContextService.history()` 正确显示摘要和 `t2` 尾部，但 `fork_thread(..., turn_id="t2")` 仅按物理 boundary 复制 JSONL，丢弃追加在边界后的 checkpoint，使 `t1` 原始用户和助手内容重新进入子会话模型上下文。此行为与本项目 [Issue #53](https://github.com/can4hou6joeng4/boss-cli/issues/53) 已记录的分支契约不符：上下文 checkpoint 及其来源字段应随对话历史保留。

分支现在按所选回合在完整 turn 序列中的位置筛选 checkpoint：来源 `throughTurnId` 位于所选回合之前或等于所选回合时，即使记录位于物理 boundary 后也纳入；覆盖更晚回合或引用未知来源回合的 checkpoint 不进入该分支。符合条件的多个 checkpoint 保持原记录顺序，现有 `_validated_checkpoint()` 继续负责来源校验；无效来源仍安全回退为完整原始历史。上下文编辑、工具修订、父历史和分支再分叉保持各自来源边界。本轮独立实现，不复制 Pi 源码或增加依赖。

合成离线 `SessionStore` / `ContextService` 探针覆盖 `t1→checkpoint(t1)→t2→t3→checkpoint(t2)`：fork `t1` 仅显示摘要 `t1`；fork `t2` 显示摘要 `t2`，不把被摘要覆盖的原始 `t1`/`t2` 文本重新带入；fork 后再 fork 继续保留正确摘要，父日志逐字不变。探针无模型、网络、招聘 CLI 或子进程调用，代码仅保留本地。

## 第九十九轮：等待 Harness 子进程完成优雅关闭

参考 Pi MIT [PR #11544](https://github.com/earendil-works/pi/pull/11544)，已合入 Pi main，合并提交 `a87b742ff4ce262c07b7830a25c73c1442dab41b`。该问题报告指出，客户端结束 daemon stdin 后立即发 `SIGTERM` 会跳过 EOF 收尾；PR 的 Unix daemon signal handling 不适用于本项目的 Python Harness，因此这里只采用“EOF 后给后端留出清理窗口”的生命周期原则，不复制 Pi 源码或增加依赖。本项目复现与修复基于 main `05ce291fb2670b78a107927b334836d3ef50e15f`。

本项目 `HarnessClient.dispose()` 在结束 stdin 后原等待 250ms 即发送 `SIGTERM`，而 `ApplicationService.close()` 对取消、worker、摘要、生命周期 hook、快照与资源收尾使用共享 2 秒期限。真实离线集成探针通过 `HarnessClient` 启动 CLI 与 `ApplicationService`，注入 650ms `kernel/shutdown` hook；旧等待时间只记录 hook `entered`，随后子进程被 `SIGTERM` 中断，50ms 对照正常退出。现在等待 2.5 秒后才发 `SIGTERM`，其后 1 秒仍发 `SIGKILL` 兜底；同一 650ms 场景约 677ms 正常结束，hook 完成且 CLI 返回 0。该结果证明关闭流程不再被 250ms 客户端计时器打断，不代表所有操作系统级故障或超出内核期限的回调都可完成。

本地 Python 应用并发探针另对照 Pi 开放 [Issue #10982](https://github.com/earendil-works/pi/issues/10982)：摘要 provider 被事件门控时，直接 `turn/start` 被拒绝，follow-up 保持 queued；摘要完成事件先于后续 `turn/started`，队列只交付一次。现有 thread admission 和 compaction owner 已覆盖该路径，无对应运行时代码改动。

另核对 Pi MIT 开放 [PR #9126](https://github.com/earendil-works/pi/pull/9126)，截至 2026-10-30 仍为 OPEN，目标为 `main@f1b2e77f5b13b2a199b1052cb79c235451afe7d7`。它报告活动工具尚未结算时 runtime disposal 先断开持久化；提议在 shutdown/dispose 前等待 `session.abort()`，作者注明等待没有超时，忽略取消的工具不在此改动范围内。该问题位于 session 持久化结算边界，与本 PR 延长 Harness 子进程 EOF 后宽限期的客户端生命周期边界不同，Pi 的无超时等待不直接适用于本项目的有界关闭策略。

本项目以真实 `ApplicationService` 和工具 handler 做了关机时序探针：handler 在 close 开始时已派发并阻塞 2.15 秒；`close()` 约 2.006 秒返回时 runtime job 与 state owner 仍存活。handler 约在 2.151 秒返回，随后 JSONL 先追加同一工具调用从 `executing/running` 到 `completed/completed` 的修订，再追加 `turn interrupted`；worker 约在 2.168 秒退出后 runtime job 归零并释放 state owner。重启后工具仍为 completed、回合仍为 interrupted，没有重放或第二次模型请求，handler/provider 各调用一次。超过内核等待期限时若进程在工具结算前退出，隔离对照恢复为 `failed / outcome_unknown / SESSION_INTERRUPTED`，同样不重放；因此本地证据验证的是 owner 在 worker 结束前不释放以及有界关闭内完成的工具结果可持久化，不承诺超出进程存活窗口的工具也能结算。

本轮 `npm run typecheck`、`npm run build`、Python `compileall`、wheel/sdist 构建、Source build、GitGuardian 与 `git diff --check` 通过。所有探针使用合成 provider、生命周期 hook 和临时状态，无真实模型或招聘平台请求；探针只保留于本地，不提交测试材料。真实 Electron 退出与用户界面验收尚未完成。

## 第九十八轮：停止重试智谱五小时硬用量上限

Pi MIT [Issue #11537](https://github.com/earendil-works/pi/issues/11537) 报告智谱/Z.ai 在五小时硬用量上限时返回 HTTP 429 与结构化 `code=1308`；消息含数小时后的重置时间，重复请求无法在当前窗口成功。Pi 已合并 [PR #11572](https://github.com/earendil-works/pi/pull/11572)，固定 merge commit `c719d5b08e5d9fb9bbcb1f1792281eea8b442812`，在 agent-level classifier 中精确识别 code 字段；该 PR 明确未调整 Pi provider-level 的 429 重试策略。上游实现仅作行为参考，本轮不复制源码或引入依赖。

本项目 OpenAI Responses 适配器会对 HTTP 429 及带瞬时标记的流内错误自动重试。共享错误分类器现在只把结构化 `code` 精确等于整数或字符串 `1308` 视为硬用量上限，并将 provider code 安全规范为字符串；HTTP 与流内重试决策遵从该明确的不可重试结果。未命中既有终态分类的其他 429、非结构化消息和相似数字仍保持原行为。适配器面向 OpenAI 兼容端点，因此匹配范围刻意收窄到该 code 字段，不按自由文本推断供应商或配额语义。

## 第九十七轮：JSONL 追加失败后的有界回滚

参考 Pi 已合并 [PR #11486](https://github.com/earendil-works/pi/pull/11486) 对会话写入失败状态分叉的修复，并核对其 [Issue #11460](https://github.com/earendil-works/pi/issues/11460)。Pi 的故障点是内存 leaf 已更新而文件 append 失败；BOSS-CLI 不保留同类内存 transcript，但直接追加 JSONL 后若出现短写或 `ENOSPC`，SQLite 事务回滚无法撤销已写入的文件后缀，严格读取会因此失败。本轮针对本项目的持久化边界独立实现，不复制 Pi 源码。

本项目 [Issue #229](https://github.com/can4hou6joeng4/boss-cli/issues/229) 通过临时 `SessionStore` 和半行 `ENOSPC` 故障注入复现：原日志增加残缺后缀，下一次 `read_entries()` 报 JSONL 损坏。现在共享 `_append_line()` 使用无缓冲文件描述符逐段写入，并记录起始 inode/长度和每次成功写入的字节数；追加或 `fsync` 失败时，只有目标身份、文件长度和已写后缀都与本次操作匹配才会尝试 `ftruncate` 回起点并再次 `fsync`。被替换、外部追加、回滚写入或回滚同步结果不确定时返回 `SessionAppendRollbackError`，不覆盖或假称未写入。普通会话追加和工具结果修订在写前校验当前索引切面，避免继续追加到已损坏日志；事件追加沿用事件日志 fingerprint 冷读校验。

故障探针覆盖短写、`fsync` 失败、回滚失败与目标文件替换/追加，以及会话条目、事件与工具修订的共享调用边界；成功回滚须恢复原字节且可继续读取，无法确认时必须明确失败。Python compileall、wheel/sdist、TypeScript、Electron 源码构建、产物扫描及 `git diff --check` 按最新 PR head 验证；探针和测试材料仅保留本地。

## 第九十六轮：删除清理复用严格事件 JSONL 解码

参考 Pi MIT main `f09d01b85e0384647fcab6779d35ab9dabe04be3` 的持久化恢复边界，并延续本项目 [Issue #221](https://github.com/can4hou6joeng4/boss-cli/issues/221) 的损坏日志约束：事件事实源在冷重建、读取和删除清理之间必须使用同一套可验证解析规则。本轮不复制 Pi 源码或引入依赖。

本项目 [Issue #227](https://github.com/can4hou6joeng4/boss-cli/issues/227) 发现 `_rewrite_events_for_deletion()` 仍直接调用 `json.loads`，因此删除会话可能接受重复对象键、非有限浮点、坏 UTF-8 或过深 JSON，而事件索引重建会拒绝同一输入。严格解码还会拒绝 JSON 转义表示的孤立 UTF-16 代理项，避免 Python 字符串无法重新编码为持久 UTF-8 的记录。现在删除重写按 64 KiB 块流式读取，复用带行号的严格事件对象解码器；空白行与索引重建一样跳过但保留，写回的每条记录恢复 LF 分隔，避免删除后事件行粘连。任何损坏在临时文件发布前都停止清理，不截断、修补、重放或发布部分日志，原有删除意图可继续用于恢复。

验证覆盖重复键、非有限浮点、孤立代理项、坏 UTF-8、过深结构、合法删除事件和损坏发生在目标事件前后的边界；网络、真实模型、招聘 CLI 和提交测试材料均为零。Python 编译、wheel/sdist、TypeScript、Electron 源码构建、`git diff --check` 与远程必需检查按最新 PR head 核对。

## 第九十五轮：上游 CLI JSON 信封的严格边界

本项目 [Issue #225](https://github.com/can4hou6joeng4/boss-cli/issues/225) 复现 `BossCliTool` 对 `boss-agent-cli --json` 输出使用宽松 `json.loads` 的缺口：重复键采用最后值，`NaN`/`Infinity` 和孤立代理项会进入 `ToolResult`，深层结构可能在后续投影才失败。该边界属于业务 CLI 进程契约，不把 Python 对象的合法性推断为上游信封合法。

现在适配器在七键集合与退出码校验前拒绝重复对象键、非有限浮点、超过 64 层的 JSON 和孤立 Unicode 代理项。JSON 语法错误继续返回 `CLI_ERROR`；语法可解析但违反严格信封完整性的内容返回固定 `CLI_CONTRACT_ERROR`，不持久化其数据、不回交模型，且暂停当前回合、后续工具与队列，不自动重试。若该错误来自已派发写工具，工具结果仍以 `outcome_unknown` 持久化并要求核对外部状态。保留 `raw`/分页投影及其他写操作未知结果语义；不修改 `boss-agent-cli` 或平台行为，不复制 Pi 源码或引入依赖。

离线假的子进程探针覆盖正常信封、重复键、`NaN`/`Infinity`、坏 Unicode、深度边界、失败退出码和下游错误投影；探针只使用合成 stdout，无真实进程、网络、模型或招聘平台调用。

## 第九十四轮：JSON-RPC 帧的严格解析与坏帧后继续服务

参考 Pi MIT main `f09d01b85e0384647fcab6779d35ab9dabe04be3` 的 RPC 输入循环，并结合本项目 [Issue #223](https://github.com/can4hou6joeng4/boss-cli/issues/223) 的本地边界复现。Python `json.loads` 默认会接受重复对象键的最后值、把 `1e999` 转为 `Infinity`，过深输入可能抛出未捕获 `RecursionError`；孤立代理项会在 handler 已执行后让响应 UTF-8 编码失败。审批响应中的重复 `approved` 键同样会被最后值覆盖。

本轮独立增加对象键唯一性、有限浮点、64 层深度及 Unicode 代理项校验。解析失败在派发前返回 `-32700` 并继续读取后续帧；handler 已执行但结果含非有限数值、过深结构、孤立代理项或不可 JSON 序列化对象时返回 `RESPONSE_INVALID`，不重放 handler，也不把编码失败误报为业务成功。帧大小和 LF framing 规则保持不变；不复制 Pi 源码或引入依赖。

内存 JSON-RPC 探针覆盖重复顶层/嵌套键、`1e999`、1500 层嵌套、孤立代理项、不可编码响应及每种坏帧后的正常请求；Python 编译、wheel/sdist、TypeScript 检查与 Electron 源码构建须以最新 PR head 为准。测试材料仅保留本地，未调用模型、招聘 CLI、网络或平台。
## 第九十三轮：共享附件容量与损坏日志的发布门禁

参考 Pi MIT main `f09d01b85e0384647fcab6779d35ab9dabe04be3` 的 `packages/coding-agent/src/extensions/mcp/tools.ts` 及开放 [Issue #11386](https://github.com/earendil-works/pi/issues/11386)：Pi 对发给模型的 MCP 文本输出设有 20 KiB 默认上限，该提案希望支持分层配置。BOSS-CLI 的附件属于跨会话持久对象，与单次工具输出不同；本轮只采用显式资源预算原则，独立实现，不复制代码或新增依赖。

本项目 [Issue #219](https://github.com/can4hou6joeng4/boss-cli/issues/219) 记录了单附件和单回合均受限、共享对象目录却可持续增长的缺口。附件存储现在默认限制为 512 MiB / 4096 个对象，允许配置正整数上限；按对象目录的逻辑长度和文件数计量，包括未引用的孤儿。内容去重复用可信对象，新增唯一内容在发布前检查配额；发布、引用追加与删除清理共用 SQLite 写锁，失败清理须确认全局无引用，中断临时对象在启动时按私有文件约束清理。

与 [PR #222](https://github.com/can4hou6joeng4/boss-cli/pull/222) 的严格 JSONL 校验组合时，离线探针发现：目标会话正文已损坏但头部有效，原附件路径会先追加引用，随后索引读取才报错。现在对象发布前在同一写锁内流式校验完整会话，预先存在的损坏不得改变日志或对象目录。容量扫描和这次日志校验都在写锁内执行；目录越大、会话越长，写入等待可能越久，当前未承诺恒定延迟。

隔离探针覆盖配额精确边界、去重、共享引用删除、孤儿计量、损坏头部及七种中间正文损坏，后者对共享与唯一内容分别验证日志和对象字节不变；跨两个 `SessionStore` 实例的并发新增和删除/共享新增各运行 16 轮通过。网络与子进程尝试为零；探针仅保留本地。Python 3.12 编译、wheel/sdist 构建及包内容核对通过；类型检查与桌面源码构建通过，真实模型、平台及桌面交互未做验收。

## 第九十二轮：损坏的持久 JSONL 必须显式失败

参考 Pi MIT main `f09d01b85e0384647fcab6779d35ab9dabe04be3` 的 `packages/coding-agent/src/core/session-manager.ts`：`loadEntriesFromFile()` 与 `parseSessionEntryLine()` 会跳过 JSON 解析失败的行。这种 salvage 行为适合 Pi 的会话加载契约；BOSS-CLI 的冻结恢复会报告 `itemCount` 并提供完整历史页，静默丢弃记录会把部分历史伪装成完整快照，因此不沿用该容错语义，也不复制 Pi 代码。

本项目 [Issue #221](https://github.com/can4hou6joeng4/boss-cli/issues/221) 在两条有效记录之间插入损坏行后，复现 `read_entries()` 与 `SnapshotBuilder` 都曾成功并忽略该行；删除 SQLite 索引后，重启还会静默隐藏无法重建的会话。

现在会话普通冷读、固定文件快照、冻结快照、工具结果幂等核对、附件引用扫描和事件索引重建共用严格 JSONL 校验。无效 UTF-8、JSON、重复对象键、非有限浮点数、重复 session header 或无效记录结构均报告日志类型与行号并停止；冻结快照不发布部分结果。已有 SQLite 条目时保留旧列表投影以便定位受损会话，读取会给出损坏行；没有可保留条目时，索引恢复明确失败。损坏的源日志不会被截断、自动修补或重放。

离线临时目录探针覆盖中间 JSON 损坏、坏 UTF-8、重复键、溢出浮点数、缺失 payload、重复 header、损坏事件日志、已有索引保留、无索引恢复失败和冻结快照不发布。Python 3.11 compileall、wheel/sdist 构建、npm audit、TypeScript 检查、Electron 源码构建以及 PR Source build / GitGuardian 均通过；没有新增依赖或提交测试材料。

## 第九十一轮：暴露有界运行资源 owner 快照

Pi MIT main `f09d01b85e0384647fcab6779d35ab9dabe04be3` 的开放 [Issue #11350](https://github.com/earendil-works/pi/issues/11350) 报告进程级 codemode worker 持有者不可见，使用户无法判断等待、转向或取消哪个长任务；其示例中的长脚本 worker 池与本项目的模型/摘要 owner 不同，且 BOSS-CLI 已有 FIFO follow-up 等待及新 turn 防插队逻辑。本轮只吸收 holder 可见性的诊断需求，不声称本项目缺乏公平调度、不改变准入算法，也不复制 Pi 源码。

本项目 [Issue #213](https://github.com/can4hou6joeng4/boss-cli/issues/213) 将当前 `RuntimeManager.jobs` 与 `active`、仍占用会话准入的摘要索引及容量等待 FIFO 合并成 `runtime/resources/read` 的有界只读快照。最多返回 32 个 owner 与 32 个 waiter，分别报告总量/截断、阶段、取消与 abort 状态以及单调时钟计算的进程内时长；waiter 位置遵从现有 FIFO。进入快照的是 live 内存 owner，不从历史 transcript 推断；无正文、工具参数、模型消息、自由异常或凭据，也不新增持久字段。

## 第九十轮：保留模型流传输错误 cause 的安全诊断

Pi MIT main `f09d01b85e0384647fcab6779d35ab9dabe04be3` 的开放 [Issue #10697](https://github.com/earendil-works/pi/issues/10697) 提供 undici SSE 复现：idle body timeout 与对端关闭都被归一成 `terminated`，底层 cause 分别是 `BodyTimeoutError / UND_ERR_BODY_TIMEOUT` 与 `SocketError / UND_ERR_SOCKET`，但终态和 retry 分类只能看到外层消息；核对时该 issue 为 OPEN，未发现关联 PR。Pi 开放 [Issue #11071](https://github.com/earendil-works/pi/issues/11071) 对应更通用的原则：将 provider 已识别的错误事实作为结构化终态 metadata 传递。本项目已具备 `ModelErrorInfo`，本轮在其传输错误范围内独立扩展，不复制 Pi 实现或引入依赖。

本项目 [Issue #208](https://github.com/can4hou6joeng4/boss-cli/issues/208) 复核发现 OpenAI 与 Anthropic SDK 的 `APIConnectionError` 会被报告为 `transport_error`，但原来传给分类器的是 `None`，因此无法区分 `ReadTimeout`、读取失败或协议错误。现在只沿最多八个异常的 Python exception cause/context 链，显式 cause 优先于 context，跳过被抑制的 context；按独立的 OS errno 与 DNS gaierror 命名空间，把已知异常基类归一为固定 transport cause；OS errno 仅保留 `ECONNABORTED`、`ECONNREFUSED`、`ECONNRESET`、`EHOSTUNREACH`、`ENETUNREACH`、`ETIMEDOUT`、`EPIPE`、`EAI_AGAIN` 与 `EAI_NONAME`。未知 cause 只报告 `unknown`，无 cause 省略字段；异常类型名和 cause 文本从不序列化。

新增的 `transportCause` / `transportCode` 通过 `session/error.errorInfo` 与 `model_error` 持久记录传递，并在普通会话错误消息中显示固定中文摘要，帮助区分等待超时、网络断开和协议失败。Anthropic 私有请求也只公开上述固定分类及 OS code，不公开 provider code、cause 原文或配置细节。SDK 未包装的 SSE 正文读取异常，仅按公开 `httpx.TransportError` / `httpx2.TransportError` 类型识别，覆盖两代 SDK 依赖；用固定文案和同一受控分类报告，不把一般异常冒充传输失败，也不新增该分支的自动重试。总时限超时没有 SDK cause，继续使用原有超时错误消息。传输 retryability、OpenAI attempt 重试、用户取消、回合重放及上下文溢出恢复保持不变；没有新增平台网络请求。

离线验证需使用合成嵌套 timeout、peer disconnect、unknown/no cause 与白名单外 errno，检查两个 provider 的事件、会话记录及私有 Anthropic 路径只出现受控枚举；并复核既有 overflow / retry 语义。真实模型服务和招聘平台行为未由此模拟。

## 第八十九轮：按可验证的模型用量校准摘要保留范围

参考 Pi MIT main `e7a0df27c09d11bf4161d3605246cbf57a129cb2` 及开放 [Issue #10583](https://github.com/earendil-works/pi/issues/10583) 对 CJK 内容字符估算与 provider usage 偏差的讨论。本项目 [Issue #202](https://github.com/can4hou6joeng4/boss-cli/issues/202) 在固定 main `020cc8b83541f5d79bca04648cf2305bd2c6e0e1` 上以六个合成 CJK 回合复现：字符估算的保留切点与合成 provider 的相邻请求 usage 差值明显不同。Pi 的 tokenizer/compaction 实现与本项目消息、工具和持久化契约不同；本轮不复制源码或增加依赖。

本项目只接受 `eligible=true`、provider/model 一致、usage 合法且完整请求指纹与当前投影消息前缀精确匹配的 `model_usage` 记录。相邻锚点的 input usage 差值按本地字符估算权重分配至消息，再映射到完整回合；摘要占位、编辑投影、附件/技能等造成序列或请求环境不匹配时，相应区间回退。最新锚点之后未被模型观察的尾部仍按字符估算。自动摘要使用业务 runner 的 provider 身份。计划可见估算方法与实际参与保留范围的锚点数，不代表 tokenizer 或账单精度。

固定隔离探针覆盖 CJK 差异、与字符估算相同但仍报告已校准、尾部回退、provider/model/system/tools/options/fingerprint 不匹配、重复消息数冲突、非法与非单调 usage、不可映射 owner、工具调用/结果配对、摘要 checkpoint 与上下文编辑回退；网络和外部进程尝试均为零。探针仅留忽略目录，未调用真实模型、招聘 CLI、招聘平台或桌面应用。

## 第八十八轮：技能目录发现与读取的资源边界

本项目 [Issue #199](https://github.com/can4hou6joeng4/boss-cli/issues/199) 在 main `6ae1c409db75e732602c7bb262cb467cb321417f` 复现了技能目录的独立资源问题：坏 UTF-8 候选占用前 100 名额后不会补位，`stat` 与读取之间的文件增长可绕过 64 KiB 检查，超大文件进入完整读取路径，且 `glob`/`sorted` 会先物化全部候选。合成 50,000 个目录、32 MiB 文件、FIFO、符号链接和竞态替换均在本地复现；网络、DNS 与子进程调用均为零。

参考 Pi MIT main `e7a0df27c09d11bf4161d3605246cbf57a129cb2` 的资源发现边界，以及 Pi Issue [#10062](https://github.com/earendil-works/pi/issues/10062) 对不可读 skills 目录诊断的讨论。本轮只吸收有界发现、无效资源隔离与 fail-closed 原则，不复制 Pi 源码、不新增依赖，也不改变本项目工具 allowlist、审批或招聘平台权限。

`SkillCatalog` 现在对空选择直接返回；目录用 `os.scandir` 保持候选内存有界，并按字典序批量扩大候选窗口以补足最多 100 个可读取技能。读取前后核对普通文件身份，使用 `O_NONBLOCK` 与可用的 `O_NOFOLLOW`，最多读取 `64 KiB + 1` 字节后再解码和计算摘要；坏编码、超限、FIFO、符号链接或竞态替换只跳过该候选，加载阶段的变化或不可读资源则明确失败，不执行目录脚本。Python 3.10 兼容语法、技能 frontmatter 和 JSON-RPC 形状保持不变。

固定离线探针覆盖空选择不扫描、坏 UTF-8 补位、32 MiB 拒绝、50,000 候选的 100 项上限、普通文件身份与外部调用计数；`compileall` 与 `git diff --check` 已通过。探针和临时状态只保留在忽略目录，未调用真实模型、招聘 CLI、招聘平台或桌面 UI。

## 第八十八轮：摘要切点先于上下文编辑投影

本项目 [Issue #197](https://github.com/can4hou6joeng4/boss-cli/issues/197) 在 main `e9a6973991aee68628402322fd4a2d80e5bcf6a4` 复现：两回合各有 user/assistant 条目，排除摘要来源第一回合的 user 后，count-only checkpoint 的 `sourceItemCount=2` 在历史投影中过滤 excluded 条目后才计算切点，错误覆盖了第一回合 assistant 与第二回合 user。摘要预览仍保留第二回合两条，但保存、重开、fork 后只剩第二回合 assistant；第三回合 provider request 缺少未摘要用户输入，估算从 1424 降到 396，request fingerprint 也变化。原始 transcript 和 checkpoint 仍完整，因此问题是模型上下文投影丢失事实，不是持久记录删除。

固定参考 Pi MIT main `e7a0df27c09d11bf4161d3605246cbf57a129cb2` 的 `packages/coding-agent/src/core/session-manager.ts` `buildContextEntries()`：以 entry ID 选择 compaction 切点，再对路径应用 context edit。本轮独立采用“来源位置先于编辑投影”的职责，不复制 Pi 代码、不改变协议或持久格式。

`ContextService._history_projection()` 现在先从未过滤的规范 item 序列解析 `sourceItemCount` / `sourceItemIds`，再移除摘要覆盖条目和 `contextEdit.excluded` 条目。显式 source IDs、摘要来源校验、fork、预算与摘要 digest 保持不变；没有排除项或仅排除摘要尾部时投影不变。

离线五场景探针覆盖 count-only source exclusion、预览与保存一致、重开/fork、旧 source IDs checkpoint、无排除/排除尾部及全排除来源；真实 ApplicationService edit→compact→第三回合 provider request 也验证未摘要用户消息存在，estimatedInput 1424、request fingerprint 与完整历史一致。原始 JSONL 保持四条，网络/DNS/子进程尝试均为零；未调用真实模型、招聘 CLI、平台或桌面 UI。
## 第八十七轮：持久记录的写入与重读预算一致性

本项目 [Issue #195](https://github.com/can4hou6joeng4/boss-cli/issues/195) 在 main `e9a6973991aee68628402322fd4a2d80e5bcf6a4` 以真实 `SessionStore` / `TurnRunner.finish_tool_call()` 复现：9 MiB 合成成功结果先向 JSONL 追加 9,446,225 字节，之后索引重读因 8 MiB 单行限制失败，工具修订对账也无法读取该行。重开时 SQLite 列表跳过整会话，恢复扫描不重放操作但也不会把它重新列出，原始 JSONL 仍保留。

固定参考 Pi MIT main `e7a0df27c09d11bf4161d3605246cbf57a129cb2` 的 `packages/coding-agent/src/core/session-manager.ts`：`_persist()` / `_rewriteFile()` 写 JSONL，`loadEntriesFromFile()` 按固定缓冲流读，并为 header 发现设置独立扫描预算。开放 [Pi Issue #11386](https://github.com/earendil-works/pi/issues/11386) 讨论 MCP 输出上限；它与本项目 CLI、结果记录及冻结快照不是同一协议。本轮采用“传输、持久记录与发现扫描须各有明确边界”的原则，32 MiB 预算及预写校验独立实现，不复制源码或新增依赖。

正文及快照 record 统一为 32 MiB，header/event 保留 8 MiB；按最终 UTF-8 JSON 字节计量，不含换行。追加在打开文件或补尾部 LF 前校验；新会话/分支先检查 header 和全部正文；checkpoint 在创建临时候选和复制来源前检查。工具修订的拒绝仍进入既有 `ToolRevisionPersistenceError(absent)` 与有界失败记录路径，保存成功结果后索引故障的对账也使用同一正文读预算。附件引用扫描同步正文预算，并继续独立验证 header，避免删除其他会话时错误移除共享附件。

预算不是“所有 16 MiB CLI 输出必定能保存”的保证：离线反例中，含 180 万个 `1e15` 的原始信封仅 9,000,109 字节，Python 归一化后的 data 已有 34,200,001 字节。该结果在写入前拒绝，工具只执行一次，以小型 `outcome_unknown` 失败终态暂停并要求核对；会话和重启恢复保持可读，无工具或模型重放。未采用数据截断或新增跨文件 blob 格式；序列化前宿主对象内存不受此记录预算约束。大于 8 MiB 的新合法记录需用兼容新内核，不能由旧版本重开。

两组完整结果验收覆盖 9 MiB 和接近 16 MiB 的 data，经工具完成、冷删索引重建、分支、真实 ApplicationService 冻结快照、结果引用/摘要/分段 RPC 与共享附件删除后逐字节一致，模型投影和 RPC 页仍有界。独立八组写入口探针覆盖精确 UTF-8/控制转义字节、32 MiB 接受与多一字节拒绝、无 LF 尾部不修改、header/body 分别校验、后续 entry 超限不发布、checkpoint 候选创建前拒绝、9 MiB 修订的写后故障对账、超限修订错误归属、event 原预算和附件 header 门禁。测试材料仅留忽略目录，网络、DNS 与子进程尝试均为零；未调用真实模型、招聘 CLI、平台或桌面 UI。

## 第八十六轮：业务回合的保留 owner 资源边界

本项目 [Issue #193](https://github.com/can4hou6joeng4/boss-cli/issues/193) 在 main `e9a6973991aee68628402322fd4a2d80e5bcf6a4` 由真实 `ApplicationService` 与隔离 provider/bridge 复现：`parallelThreads=1` 时，连续四次取消且 abort hook 阻塞，或四次成功但 bridge 清理阻塞，active 始终为 0，保留 jobs 与活跃收尾线程从 1 增至 4。owner 没有丢失，活动执行并发也没有超过 1；缺口是有意允许执行/收尾重叠后，没有单独限制保留资源总量。

参考 Pi Durable 开放 [Issue #11332](https://github.com/earendil-works/pi/issues/11332) 的持久状态与执行责任分离，以及开放 [Issue #11350](https://github.com/earendil-works/pi/issues/11350) 的资源持有与跨会话准入。固定 MIT main `e7a0df27c09d11bf4161d3605246cbf57a129cb2` 的 `scheduler.ts` invocation 责任持续到 run/abort 结束；其通用 task 与 codemode pool 和本地业务回合不同。本轮独立增加本地预算，不复制源码、增加依赖或引入通用调度器。

保留原 `parallelThreads` 活动上限，活动加通知/bridge/abort 收尾的 jobs 总量最多为其两倍，允许一批活动回合与一批收尾重叠。配置公开 `maxRetainedTurns`；新请求在 provider 工厂与输入写入前检查，底层 reserve 再原子复核，超限使用 `TURN_OWNER_LIMIT`。已知用户请求回执仍优先去重。follow-up 在领取前检查两项预算，竞争性超限退回 queued，不误报启动失败；额度退休后按 FIFO 唤醒。迟到 abort 可能在原 worker 的交接结束后才完成，因此增加锁外退休通知；关闭、工具审批与未知结果不重放契约不变。

独立审查发现，同步退休回调在 abort 线程启动失败时会运行于取消调用线程，不能在其中直接派发等待的 provider 工厂。现以初始化时预启动的一个受跟踪 worker 合并处理迟到退休唤醒，abort 完成只设置信号；关闭停止并等待该 worker，状态目录责任保留到其退出。启动失败时构造清理，不以无限 inline 工作补偿；已实际启动后包装器抛错仍保留 worker 责任。

五组隔离探针通过：abort/bridge 各两组 owner 满额后的第三请求零工厂/零持久化拒绝、满额去重回执、正常一批收尾加一活动重叠、迟到 abort 退休唤醒 B/C FIFO 与单次派发、关闭后不晚启动。探针等待真实 worker 完成交接，再检查等待队列，未以 active 清空代替收尾完成。网络和子进程尝试均为零；探针及合成状态只保留忽略目录，未调用真实模型、招聘 CLI、平台或桌面 UI。

另六项边界验收通过：领取后的容量拒绝退回 queued、未启动失败的通知与 bridge tail 占额度、abort 启动失败时取消不等待其他工厂、唤醒 worker 构造/启动失败清理、实际启动后包装器抛错保留责任、关闭期限耗尽后仍保留状态目录至 worker 真正结束。唤醒通知合并且 queued turn 只派发一次；网络、DNS 与子进程尝试均为零。

同时核对 Pi 已关闭 [Issue #11141](https://github.com/earendil-works/pi/issues/11141) 和落地主线的 `7e15f9601` afterRun 子任务。该实现先保存答案，再保持 generation 忙碌等待子任务。本项目异步、有界且可丢弃的 on_event 是观察机制；阻塞回调时同会话新回合仍可正常执行，不能据此承诺必达收尾。本地当前没有要求阻塞输入的收据归档消费者，普通审计可按 turnId/cursor 从持久日志派生，故暂不新增子任务或 finalizer API。若将来确需必需收尾，须先定义持久 intent、取消、幂等与重启人工复核契约。

## 第八十五轮：摘要并发额度跟随执行 owner 退休

本项目 [Issue #191](https://github.com/can4hou6joeng4/boss-cli/issues/191) 在 main `e9a6973991aee68628402322fd4a2d80e5bcf6a4` 由真实 `ApplicationService`、独立合成 provider 和临时状态复现：容量 1 时跨三个会话启动并取消摘要，worker 已结束而 abort hook 继续阻塞，status 均为 cancelled、running 计数为 0，但 owner/provider/活跃 abort worker 依次增长至 1、2、3。成功摘要的终态通知阻塞时也能启动第二任务。旧准入只计 running 状态，与已有 owner 退休条件不一致。

参考 Pi Durable 开放 [Issue #11332](https://github.com/earendil-works/pi/issues/11332) 的状态与执行责任分离，以及开放 [Issue #11350](https://github.com/earendil-works/pi/issues/11350) 的资源准入讨论；核对 MIT main `e7a0df27c09d11bf4161d3605246cbf57a129cb2` 的 `scheduler.ts` invocation 在 run/abort 执行结束前保留责任。Pi codemode worker pool 与本项目摘要池不同，本轮只吸收生命周期原则，不复制源码、引入 Pi 依赖或改变取消策略。

现在手动摘要按 `_compaction_by_thread` 的现有 owner 计入容量，直到 worker、终态通知与已认领 abort 全部结束后退休；终态缓存和重启恢复终态不占额度，带 turnId 的自动摘要继续受业务 turn 并发限制。超限仍返回 `COMPACTION_CONCURRENCY_LIMIT`，不创建 provider 或执行模型；没有自动等待或重试。七场景离线探针覆盖取消后 abort 阻塞、成功终态通知阻塞、abort 先结束/worker 后结束、正常完成回收、重启终态缓存、真实业务回合触发的自动摘要和 worker 未启动失败回收，全部通过。网络和子进程尝试为零；探针及合成状态只保留本地，未调用真实模型、招聘 CLI、平台或桌面 UI。

## 第八十四轮：finish checkpoint 失败的队列结算责任

参考 Pi Durable 开放 [Issue #11332](https://github.com/earendil-works/pi/issues/11332) 对持久任务、执行 owner 与输入准入分离的讨论；固定 MIT main `e7a0df27c09d11bf4161d3605246cbf57a129cb2` 的 `scheduler.ts` 将 run/abort invocation 的责任保留到执行结束。本项目独立延伸既有 queue pause 门禁，不引入 Pi 调度器、afterRun 子任务或恢复重放，也不复制源码。

本项目 [Issue #189](https://github.com/can4hou6joeng4/boss-cli/issues/189) 在 main `e9a6973991aee68628402322fd4a2d80e5bcf6a4` 的真实 `ApplicationService` 离线复现：容量 1、首回合活动时排入 follow-up，finish checkpoint 在写入前失败或写入后抛错均令首回合标为 `error / phasePersistenceFailure`，但已登记的容量 waiter 仍把 follow-up 执行为 delivered。此前队列结算基于 completed 只暂停 steering，新增阶段写入失败后未补全 follow-up 暂停责任。

现在阶段失败分支在释放执行槽位前调用全队列 pause；暂停写入同时失败时，既有 pending-pause 责任阻止后续 claim 与新准入，恢复存储后旧输入仍变为 paused。保持原回合错误原因、已落盘事实和跨会话 FIFO 容量唤醒，不重放模型或工具。六场景隔离探针覆盖 finish 写前/写后失败、暂停持续失败及恢复、既有 steering settlement 失败、正常 completed 与 B/self/C 等待顺序；修复后错误回合只执行 first，其他会话依次执行 B/C，正常回合仍继续 follow-up。网络与外部进程尝试为零，探针与合成状态只保留在忽略目录；未调用真实模型、招聘 CLI、招聘平台或桌面 UI。
## 第八十三轮：定点读取大型工具结果

本项目此前新增 `read_session_tool_result` 与 `thread/item/result/read`，但二者通过 `SessionStore.read_items()` 先解码并物化整份会话 JSONL，再按逻辑 item ID 搜索。即使结果只返回一个小分页，长会话仍令工具读取的峰值内存随历史大小增长；这是在采用 Pi `SessionManager` 增量读取原则后仍遗漏的查询投影边界，不等同于 Pi 提供了同样的结果 API。

现在 `SessionStore.read_item()` 从已固定长度的会话快照逐行投影，只保留目标 root item 的 `kind`、`result` 及当前仍映射到它的 revision aliases。保留原始 root ID、payload 合并和隐式 toolCall parent revision 语义；别名被另一个条目 ID 覆盖后不再将后续 revision 合入旧结果。重复 root/identity 冲突 fail closed；活动别名和匹配修订各最多 4,096 条，别名最长 128 字符且累计 UTF-8 不超过 64 KiB，超限返回稳定 `RESULT_HISTORY_LIMIT`。内核工具与桌面/RPC 分段读取共用此定点投影；SHA-256、游标、Unicode 码点分页和 `STALE_RESULT` 契约保持不变。

忽略目录离线探针覆盖直接结果、revision alias 链、隐式 parent revision、alias 被其他 root 覆盖、重复 root 冲突、重复别名修订数上限、过长 ID、累计别名字节上限、Unicode/control-character 分页、过期摘要，以及模型与 RPC 两种读取入口。60,001 条、49,200,362 字节合成会话的定点读取峰值为 301,045 字节；原 `read_items()` 列表路径为 87,735,649 字节。查询前后 session/event SHA-256 不变；未调用 provider、招聘 CLI、真实平台或桌面 UI。该 Python 分配测量不代表完整进程 RSS 或墙钟延迟。

## 第八十二轮：任务读取使用有界会话快照

本项目 [Issue #187](https://github.com/can4hou6joeng4/boss-cli/issues/187) 的只读任务归属视图参考 Pi Durable 开放 [Issue #11332](https://github.com/earendil-works/pi/issues/11332) 关于持久任务事实与进程执行责任分离的讨论。独立代码审查发现，PR #188 的 `task/read` 虽限制关系投影数量，却调用 `read_entries()` 将整个会话 JSONL 解码并保存在列表中，再多次扫描；超长会话仍会令查询峰值内存随历史总量增长。

现在 `SessionStore.open_entries_snapshot()` 在 writer lock 内验证会话并固定打开文件的 inode 与长度，之后由同一可回绕句柄按 64 KiB 块、32 MiB 会话正文单行上限逐次扫描固定前缀；会话头和事件日志仍各自保持 8 MiB 上限。`task/read` 将目标身份和冲突验证器直接应用于流式迭代器，不保留完整历史列表；会话追加不会改变当前查询切面。每会话准入锁覆盖扫描并阻止并发删除；全局 runtime/queue 锁只用于捕获运行时归属并打开快照，文件扫描期间已释放。该轮当时保留坏 JSON 跳过、坏 UTF-8 替换、通用换行与条目筛选语义和关系数量上限；第九十二轮改为损坏记录严格失败。

忽略目录的离线探针以 60,002 条记录、49,200,327 字节的合成会话对比：`task/read` 峰值 Python 分配为 308,017 字节，原 `read_entries()` 列表路径为 87,747,515 字节；打开快照后追加记录，两次回绕仍得到相同记录数且不包含新记录。另一探针暂停文件扫描时确认 runtime/queue 全局锁可被其他工作获取。查询前后 session 与 event 文件 SHA-256 相同；未调用 provider、招聘 CLI、真实平台或桌面 UI。数据只验证合成冷读路径，不代表完整应用进程 RSS 或墙钟延迟。

## 第八十一轮：回合阶段 checkpoint 与重启复核边界

本项目 [Issue #185](https://github.com/can4hou6joeng4/boss-cli/issues/185) 基于 main `08dcccd28158548ff2fd0f0ac4f55c2198fe7746` 核对。参考 Pi Durable MIT main `e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a` 的 `generation.ts` 分阶段执行、`live.ts` 持久运行态和 `harness-ownership.test.ts` / `harness-view-run.test.ts` 的崩溃重开覆盖；开放 Issue [#11332](https://github.com/earendil-works/pi/issues/11332) 仍讨论 task 所有权、abort 与 idle 边界。Pi 的实验性 Durable API 与本项目招聘回合、审批及外部工具副作用并不等价，本轮吸收的是“阶段状态须持久化并定义重启结果”的设计要求，不移植代码、不引入 Pi 依赖。

本项目已有 append-only session JSONL 和 SQLite 投影，业务回合与工具执行也保存终态及执行状态；但 `RuntimeManager.active/jobs`、TurnRunner 当前请求编号和工具批次责任只在进程内存。重启时 `SessionStore.recover()` 将 running turn/tool 标记为 interrupted/failed 并阻止副作用重放，却没有一条与 turn 对应的阶段记录来区分 admission、准备、模型请求、工具执行和 finish 中断位置。摘要任务已有独立持久终态恢复，但不能覆盖业务 turn 的运行边界。

现在回合以 `task_phase` 条目持久化 admission、prepare、model_request、tool_execution 与 finish 阶段，并记录受限的 attempt 和 restartLimit 字段。阶段记录只是恢复检查点，不授权自动恢复：restartLimit 当前固定为 0；启动时未收尾阶段若对应 turn 仍运行则收敛为 interrupted/manual，若 turn 终态已先落盘则按该权威终态关闭阶段。已有工具 executionState、审批及结果未知 review fence 继续决定外部效果的人工核对边界；provider 请求、工具和摘要均不会因 checkpoint 自动重放。fork 会排除 task_phase，因为阶段归属当前运行实例而不是对话历史。

隔离恢复探针覆盖 model_request 阶段崩溃、turn 终态先于阶段收尾、保留 attempt/restartLimit、分支排除阶段条目及恢复不调用 provider/工具；网络与外部进程尝试为零。该增量提供可审计的恢复位置，但暂不提供阶段续跑、自动 retry/backoff、task owner 树或 task 状态 RPC；这些需要在逐一划定幂等与外部效果契约后再引入。

## 第八十轮：模型请求的本地任务归属

Pi Durable 开放 [Issue #10845](https://github.com/earendil-works/pi/issues/10845) 希望 provider 能区分 generation 与 compaction 的发起任务；截至 2026-10-29 仍为 OPEN，维护者同时指出任务 ID 本身不能证明请求属于哪个用户。本轮核对固定 Pi commit `e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a`（MIT）的 `packages/durable/src/harness/generation.ts:283-290`、`compaction.ts:178-188,251-259` 与 `packages/ai/src/types.ts:252-269`：两类请求携带 sessionId，通用 metadata 可由 provider 解释，但没有统一固定任务归属。本项目采用显式请求归属原则，独立实现本地类型，不复制源码、不引入 Pi 或新增运行依赖，也不把上游未决提案视为授权或计费方案。

本地 main `f7832c70be77045225fb281b0f8b3dac20e86dc4` 的 `before_request` 已有 purpose、threadId、turnId、jobId 与 requestIndex，但三个 `provider.stream(request)` 入口只接收没有归属字段的 `ModelRequest`。同一 provider 包装器无法仅凭 request 区分招聘业务回合、后台摘要和连接检查；依赖“当前回合”的进程状态会丢失摘要自己的来源。

现在 `ModelRequest` 附加可选、不可变的 `ModelTaskContext`，包含用途、从零开始的逻辑请求编号及适用的 thread/turn/job ID。完整请求准备后由统一策略入口绑定，即使 preparer 重建请求或宿主未配置 hooks，也由执行 owner 覆盖归属；策略检查与 provider 使用同一身份。自动摘要使用 job 创建时固定的 turnId，各摘要分片按自身任务编号；手动摘要不推断 turnId，连接检查不借用会话身份。旧直接构造请求默认没有上下文，旧 provider 可忽略新增字段。内置 OpenAI/Anthropic HTTP 参数白名单、模型消息、预算及请求指纹不包含此对象；取消、拒绝、审批与传输重试行为不变，JSON-RPC 仍为 0.2.0。

本地 7 项 ApplicationService / ConnectionChecks 隔离集成验证与独立 10 项 TurnRunner 场景通过，覆盖手动/自动多分片摘要、发起回合固定、两次工具循环的三次模型请求编号、preparer 重建与伪造归属覆盖、有无 hooks、不可变性、策略拒绝及取消、HTTP 参数/预算/指纹相等；网络和外部进程尝试均为零。测试脚本与合成状态仅在 `/tmp`，不进入 Git 或 Python 产物；未调用真实模型、招聘平台或桌面 UI。

## 第七十六轮：删除意图落盘前保留摘要终态观察

## 第七十九轮：待处理队列的会话级资源边界

参考 Pi Durable 开放 [Issue #11350](https://github.com/earendil-works/pi/issues/11350) 对跨会话公平准入、等待者诊断和长期占用的讨论；核对时 Pi main 为 `e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a`，许可证 MIT。Pi 的 codemode worker pool 与本项目持久 follow-up/steering 队列不是同一资源，本轮只采用“等待工作必须有可解释的资源边界”这一原则，不复制 Pi 调度代码或增加依赖。

本项目 `TurnQueue.add()` 原先只限制单条输入 100000 字符；同一会话可以无限追加 `queued`/`delivering` 项，`queue/list`、领取和恢复每次都从会话 JSONL 重建完整状态。长期客户端因此可以让待处理输入和持久队列状态无界增长，容量公平检查只能限制并发回合，不能限制会话内排队资源。

现在每个会话最多保留 128 个待处理项，且这些项的 UTF-8 输入合计不超过 4 MiB；已完成、暂停或取消的历史记录不占用待处理预算，带相同 `clientUserMessageId` 的幂等重试仍先返回既有项目。超过任一上限时返回结构化 `QUEUE_LIMIT`，不写入部分队列记录、不改变已有项目或调度顺序；既有单项 100000 字符上限、FIFO、steering/follow-up 区分和恢复规则保持不变。

本地隔离探针覆盖 128 项数量上限、UTF-8 字节上限、幂等重试、暂停后释放预算、steering 与 follow-up 共用预算、拒绝时无追加记录及重开后的状态一致性；未调用真实模型、招聘平台或桌面 UI，探针和临时状态不进入 Git、wheel 或 sdist。

## 第七十八轮：会话 JSONL 冷读的有界流式解析

继续参考 Pi MIT 仓库当前 `main` `e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a` 的 `loadEntriesFromFile()`：固定 1 MiB 读取缓冲区配合增量解码和逐行解析。本项目此前 [Issue #103](https://github.com/can4hou6joeng4/boss-cli/issues/103) 只把原始 bytes 快照与 JSON 解码拆开，降低了解码额外峰值；`SessionStore.read_entries()` 仍先 `read_bytes()`，长期会话会把完整原始 JSONL 保留在内存。本轮延伸同一存储边界，不复制 Pi 源码或增加依赖。

`read_entries()` 当时在既有 `SessionStore` 锁内按 64 KiB 块解析会话文件，保留坏 JSON 行跳过、坏 UTF-8 替换、LF/CRLF/CR 行边界、尾部无换行和条目筛选语义；单行超过 8 MiB 时拒绝，避免损坏或外部追加的无界长行。第九十二轮改为损坏记录严格失败。事件索引冷重建共用同一有界解析器，事件仍使用原有 LF 语义与游标冲突校验。锁覆盖整个解析过程，维持一次读取对应稳定文件切面；所有写入仍通过 `SessionStore` 串行化。

独立复核发现，前置 `require_thread()` 原先仍会无界 `readline()` 并 JSON 解码首行，导致正文解析器的上限无法保护超长会话头。合成 16 MiB 有效头在旧实现产生约 32 MiB 的分配峰值。现在首行也复用同一字节上限与通用换行解析器，在 JSON 解码前拒绝超限头；只读取首行并立即关闭迭代器，空文件仍返回原有头损坏错误。对同类输入，修复后测得峰值为 9058344 字节；该测量只说明超限首行的资源边界，不代表完整会话投影的总内存恒定。

会话头专项独立探针 34 项与持久化回归 15 项通过，覆盖三条读取入口、LF/CRLF/CR/无换行、64 KiB 与 UTF-8 跨块边界、坏 UTF-8 替换、空/坏/错类型或错 ID 头、精确 8 MiB 接受及多一字节在 JSON 解码前拒绝、字节而非字符限制、文件关闭和未读取巨大尾部；固定旧提交 `8f046eed6bb4b5c3e91049e959d9b57bebb6441a` 的临时导出确认原实现接受 8388609 字节头且使用无界 `readline(-1)`。会话与事件冷读探针仍通过；网络和外部进程尝试均为零，测试材料不进入 Git 或产物。

本地隔离探针以大型会话冷读测量峰值分配，覆盖 LF/CRLF/CR、坏 UTF-8、坏 JSON、尾部无换行、条目投影与 8 MiB 超限拒绝；此前事件冷重建的分页、游标、坏尾行和超限验证保持通过。探针、合成状态和临时文件未进入 Git、wheel 或 sdist；未调用真实模型、招聘平台或桌面 UI。

## 第七十七轮：事件日志冷重建的有界流式解析

参考 Pi MIT 仓库当前 `main` `e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a` 的 `SessionManager` JSONL 增量解码路径（固定 1 MiB buffer）。Pi 的会话记录和本项目的共享 `events.jsonl` 不是同一格式，本轮只吸收“可重建日志不能按文件大小一次性进入内存”的解析边界，不复制 Pi 源码或增加依赖。

本项目基线 `f7832c70be77045225fb281b0f8b3dac20e86dc4` 的 `SessionStore._index_events()` 在 SQLite writer 事务内对 `events.jsonl` 调用 `read_text().split("\\n")`。事件日志会持久化文本与思考增量，长期文件可能远大于单次 8 MiB JSON-RPC 帧；索引丢失、修复或恢复时，整文件物化会让内存峰值随历史长度增长，并延长 writer 锁持有时间。既有会话 JSONL 解析优化没有覆盖该共享事件索引。

该轮以 64 KiB 固定块增量拆分事件行，单行上限为 8 MiB；超过上限的损坏或外部追加内容立即拒绝，避免任意长行重新制造无界分配。正常坏 JSON 行当时继续跳过；第九十二轮改为损坏记录严格失败。重复游标、线程校验、SQLite 单事务、checkpoint 指纹和事件顺序语义保持不变。`append_event()` 在写入前也拒绝超过该上限的记录，防止内核生成无法重建的事件。

本地隔离探针生成 2400 条事件后删除 SQLite 索引冷重建：事件分页、方法筛选、游标、坏尾行恢复和超限行拒绝均通过；`tracemalloc` 观测本轮重建峰值为 196196 字节，未随完整日志内容保留。探针、合成事件和临时状态未进入 Git、wheel 或 sdist；未调用真实模型、招聘平台或桌面 UI。

## 第七十七轮：限制冻结恢复快照的内存与缓存占用

本项目 [Issue #179](https://github.com/can4hou6joeng4/boss-cli/issues/179) 在 main `f7832c70be77045225fb281b0f8b3dac20e86dc4` 上确认：`thread/resume(snapshot=true)` 原先完整物化 JSONL item、context edit 与投影列表，并在 120 秒内保留最多 16 份快照而没有总字节限制。常规分页响应预算不能约束这些中间集合和并发快照。

该缺口属于本项目持久会话格式与 RPC 快照生命周期。本轮核对 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`（GitHub 未提供 SPDX 许可证标识）：开放 Issue #35/#34/#33/#32/#30/#27/#26/#23/#21/#20/#19/#16/#15/#4 及 PR #37/#29/#28/#25/#24/#22/#18/#12/#11/#8/#7/#6 聚焦招聘业务、平台登录、聊天和简历流程，没有对应的通用会话快照存储实现；本轮不复制其代码，也不增加依赖。Pi Durable 开放事项检索未发现对应分页快照内存管理的可直接采用议题。

新增私有 SQLite `SnapshotStore`，以固定 JSONL 文件描述符与大小构造不可见的临时快照，流式归并 revision alias、终态 toolCall、context edit、running live delta 和队列最新状态；分页、内容引用和队列读取按需查询磁盘。快照捕获事件日志的 cursor 高水位、turn 索引、队列历史、线程与运行状态。会话 JSONL 条目和对应事件仍沿用分开提交的既有协议：若条目恰在 cursor 采样前落盘、对应事件随后才提交，该事件会出现在 cursor 后的 `event/list` 中；桌面恢复先加载快照，再按 item ID 幂等归并游标后的事件。限制单记录 16 MiB、来源 JSONL 1 GiB、item 128 MiB、单快照 256 MiB、已登记缓存 512 MiB、并发构建 2 份、缓存 16 份与 TTL 120 秒；SQLite 最大页数、无回滚日志的临时数据库及队列序索引将构建文件和缓存数据库总量限制在 1 GiB 内。删除或关闭会使在建快照失效；超限失败不会发布部分内容，清理兼容移除旧 SQLite journal/WAL/SHM。

本地合成会话覆盖 20,003 条目与完整恢复 RPC，构建及端到端 `tracemalloc` 峰值均为约 0.89 MiB。独立检查 revision 与工具替换、最新 context edit、live delta、固定内容引用、构建期间追加后的 item/turn/queue 切点、JSONL 先于对应事件落盘时 cursor 后续事件可查询、队列顺序查询计划使用索引且无临时排序、逐页 1 MiB 响应、TTL/淘汰、超长记录、磁盘预算，以及删除/关闭与构建竞争；全部通过。探针仅位于 `/tmp`，网络和子进程尝试为零；未调用真实模型、招聘 CLI、平台或桌面 UI。## 第七十六轮：删除意图落盘前保留摘要终态观察
继续参考 Pi Durable 开放 [Issue #11332](https://github.com/earendil-works/pi/issues/11332) 对任务执行责任、会话忙状态与取消策略的讨论；核对时 Pi main 为 `e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a`，许可证 MIT。本项目已将摘要任务的持久可观察终态与当前进程的 worker 所有权分离，本轮延伸这一生命周期原则；具体删除缓存缺陷来自本地复现，不移植 Pi task API、实现或依赖。

本项目 [Issue #174](https://github.com/can4hou6joeng4/boss-cli/issues/174) 在固定 main `0cc2087a018d57b7cdf35f917803cd924af0f1c0` 上复现：真实 `ApplicationService` 从合成终态事件恢复任务后，`SessionStore._write_delete_intent()` 在落盘前发生合成 I/O 失败；会话、终态事件仍存在且没有删除标记，但删除入口已提前清除内存任务、终态 ID 与保留顺序，`context/compact/read` 因而返回 `COMPACTION_JOB_NOT_FOUND`，`context/read.compactionJob` 变为 `null`。正常重启后原任务又从事件完整恢复，没有模型请求或 checkpoint 重放。

`SessionStore.delete_thread()` 现在在删除索引与权威 `thread/deleted` 事件的事务提交后发出仅供应用内部使用的提交信号。应用只在该信号已发出或删除意图仍持久存在时退休目标摘要任务与容量 waiter；前者也覆盖最后移除 intent 后目录 `fsync` 失败、此时没有 intent 可查询但删除已经提交的边界，原始 `fsync` 错误仍向调用方返回。落盘前失败保留原任务字段、集合与顺序。已存在权威删除事件的幂等重复删除在查询事务结束后同样发出提交信号。忙碌摘要及已显示终态但 abort 尚在收尾的任务仍由既有 `THREAD_BUSY` 门禁保护，其他会话相对顺序及最近 64 条终态逐出规则不变；不修改持久格式、摘要生成、checkpoint 或容量等待实现。

本地隔离边界探针 9/9 通过：提交信号只在删除事务提交或已有权威删除事件时发出，缺失会话不发信号；连续三次落盘前故障保留 64 条终态与顺序，新终态只逐出最旧项；成功与重复删除只退休目标且删除事件恰一条；落盘后清理失败的显式重试及重启恢复均不恢复目标任务；提交后的最终目录 `fsync` 故障即使没有 intent 也退休目标任务且仍上抛原错误；真实摘要 worker 与阻塞的 abort 收尾期间拒绝删除，释放后可正常删除。Python 3.14 编译、类型检查、Electron 源码构建与 wheel/sdist 构建通过，45 个产品源码逐字节匹配候选，未发现额外测试或本地状态。探针使用临时状态和合成 provider，网络与外部进程尝试均为零；未调用真实模型、招聘 CLI 或平台，也未进行桌面 UI 验收。测试材料只保留本地。
## 第七十五轮：终态事件异常不丢失已受理的后续任务

Pi Durable 开放 [Issue #11332](https://github.com/earendil-works/pi/issues/11332)，讨论持久任务事实与进程执行责任之间的边界；固定核对 Pi main `e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a`（MIT）。本项目已有明确分离的回合持久结算、终态事件及后续队列 owner；本轮不引入 Pi 未决的 task API，也不复制上游代码。

本项目 [Issue #173](https://github.com/can4hou6joeng4/boss-cli/issues/173) 在 main `0cc2087a018d57b7cdf35f917803cd924af0f1c0` 使用真实 `ApplicationService` 与合成纯文本 gate provider 复现：同一会话 A 活动时排入 B，A 的成功回合状态、队列结算和释放槽位已持久化，EventHub 已追加一次 `turn/completed` 后向 observer 发布抛出普通 `OSError`。`_execute_turn()` 因事件异常未返回 `completed`；`_run_turn()` 虽完成 A 的 bridge/job 收尾，却跳过本会话 follow-up 唤醒，留下无 owner 的 queued B（active/jobs/waiters 均为 0，provider 仅调用 A 一次）。

现在只对权威持久结算之后的 `turn/completed` 与 `thread/updated` 分别做 best-effort 发布；任一失败不阻止尝试另一事件，随后返回已确定的真实终态，让既有 tail owner、provider/bridge 清理、FIFO drain 与同会话队列交接逻辑继续运行。每种事件最多追加/发布一次，不重放可能已落盘的事件；runner、turn 持久化和 queue settlement 的异常仍保持原有保守路径。取消仍可在结算锁内胜出，shutdown 的关闭门禁继续阻止新回合。

本地 13 项独立边界探针通过：容量 1/2 下两类终态事件在追加前失败或追加后发布失败；同会话多项和重复唤醒、跨会话 FIFO；回合终态及 steering pause 持久化故障；取消与 shutdown 竞争。另用真实 slow bridge 和 tracked abort 验证正常清理后 B 单次派发、关闭期间 B 保持 queued、状态目录 owner 直到 worker/abort 实际完成后才释放。所有合成 provider 调用和事件数量符合预期，网络与外部进程尝试为零。测试材料仅保留本地，不进入仓库或 Python 产物；未调用真实模型、招聘 CLI、招聘平台或桌面 UI。

同步核对 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70` 与 `can4hou6joeng4/boss-agent-cli` master `70840e79e8208aeaab7d20ac44646fc74168af6a`，近期开放 PR 聚焦招聘平台流程和业务接口，没有与本轮相同的通用终态发布及队列交接契约，不迁移其业务代码。

## 第七十四轮：OpenAI 响应终态之后不再接纳流事件

固定核对 Pi main `e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a`（MIT）。其 `packages/ai/src/api/openai-responses-shared.ts` 要求流见到终态，并在 toolUse 时拒绝未完成调用，但收到 completed/incomplete 后仍继续遍历；本轮不能把上游当作已经具备封口保护。本项目延伸已交付的 [Issue #154](https://github.com/can4hou6joeng4/boss-cli/issues/154) Anthropic 终态契约，独立加固 Responses，不复制 Pi 实现或增加依赖。Pi 新增的 Chord 依赖提案明确标为 Parked Until Resolved，本轮不引入其未决依赖模型。

本项目 [Issue #171](https://github.com/can4hou6joeng4/boss-cli/issues/171) 在 main `0cc2087a018d57b7cdf35f917803cd924af0f1c0` 上用官方 OpenAI SDK 3.41.0、HTTPX MockTransport SSE 与真实 TurnRunner 复现：`response.completed` 的权威 output 为索引 0 的文本，后续再交付相同索引的工具 added/done，原代码按索引筛选后保留后置工具，回合 completed、handler 调用一次并继续第二次模型请求。重复 completed 携带工具同样会派发，后置文本则覆盖已确认文本。

现在一旦已有 completed/incomplete response，后续任何 SDK 流事件在读取字段或修改缓冲之前即报协议错误；沿用现有不可重试 error 和响应 context manager 关闭路径，不产生 done，也不调用工具或审批。正常 EOF、SSE 注释与 `[DONE]` 保持 SDK 语义。终态对象自身的 status 兼容规则及终态前工具身份来源核对属于不同边界，本轮不修改。

本地八路径探针覆盖后置工具、重复 completed 携带工具、后置文本、重复终态、incomplete 后事件和正常文本/工具/长度耗尽；前五项 error 且 handler 为零，每项仅一次 SDK 请求，正常工具仍执行一次并续答。探针为 SDK 平台信息头提供合成值以避免 Python 元数据探测启动外部命令，协议解析使用未修改的官方 SDK；最终审计网络与子进程尝试均为零。脚本与替身只保留本地，未调用真实模型、招聘平台或桌面 UI。

独立十项边界验收进一步覆盖空终态后的临时错误、failed、usage 与未知事件，以及终态内合法工具之后的异常事件：请求仅一次、handler/审批为零，不生成可用终态 usage 或上下文恢复资格。响应恰关闭一次，近 1 MiB 前缀逐字保留并标为 failed，正常注释、`[DONE]` 和 EOF 不误报。独立代码审查无 finding；类型检查、Electron 源码构建、Python 编译与 wheel/sdist 构建通过，45 个产品源码逐字节匹配候选树，未打包测试或本地状态。版本未调整，不纳入尚未合并的 rc.15 release PR。

同步核对 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`，开放 PR 仍集中聊天分页、recruiter、凭据和简历业务；`can4hou6joeng4/boss-agent-cli` master 为 `70840e79e8208aeaab7d20ac44646fc74168af6a`。二者没有本轮相关的通用模型流终态实现，不迁移其业务代码。

## 第七十三轮：删除意图与容量等待者退休

继续参考 Pi Durable 开放 [Issue #11350](https://github.com/earendil-works/pi/issues/11350) 的跨会话公平准入原则；核对时 Pi main 为 `556860a386a03113eca146abd9cbb08e9391b7fb`，许可证 MIT。Pi 的 Codemode worker pool 与本项目模型回合容量不同，本轮只将已采用的 FIFO 原则延伸到本地删除生命周期，不复制 Pi 调度代码或引入依赖。

本项目 [Issue #169](https://github.com/can4hou6joeng4/boss-cli/issues/169) 在 main `0cc2087a018d57b7cdf35f917803cd924af0f1c0` 上通过真实 `ApplicationService` worker、容量 1 与合成 provider 复现：A 占用容量，B/C 的 follow-up 排队；B 的删除意图落盘后，附件清理发生合成 I/O 失败，RPC 返回 `THREAD_DELETE_INCOMPLETE`，B 已隐藏但仍在容量等待队列。A 以 error 退出后，调度器读取 B 时抛错并停止本轮唤醒，C 仍 queued、active 为 0，新的 D 回合因 `TURN_ADMISSION_WAITING` 被拒。

删除失败分支只有在确认删除事务已提交或持久删除标记仍存在时，才同步退休目标摘要终态并移除 waiter ID/deque 项；与成功删除使用相同的 follow-up admission/runtime 锁，保留其他会话的相对顺序。删除提交前失败不移除有效 waiter 或摘要观察，RPC 的删除未完成错误、重启继续清理和不可自动重放规则保持不变；不在调度层宽泛捕获损坏或 I/O 异常。修复后同一探针得到 C delivered、D accepted、等待队列清空，合成 provider 在 D 之前仅执行 A/C 各一次；网络和外部进程尝试均为零，探针仅保留本地。

独立 7 项边界探针通过：删除意图落盘前失败保留 B/C 的执行顺序；落盘后失败移除 B，C/D/E 仍按 FIFO 各执行一次，重复唤醒不重放；成功删除、归档和关闭均不启动对应工作；正常重开及稳定的运行中状态快照重开均继续完成删除，旧队列暂停、provider 调用为零，删除事件恰为一条。类型检查、Electron 源码构建、Python 编译和 wheel/sdist 构建通过，45 个包内产品源码文件逐字节匹配候选树，无额外测试或本地状态。独立代码审查未发现新锁序或有效工作丢失；测试材料未提交，未进行真实模型、平台或桌面 UI 验收。

## 第七十二轮：关闭期限覆盖 shutdown 事件锁等待

Pi Durable 开放 [Issue #11332](https://github.com/earendil-works/pi/issues/11332) 仍在讨论 shutdown、任务所有权与 idle 等待的分离；本轮不引入 Pi 的 task API，也不复制其实现。参考仍限于此前核对的 Pi main `14b4c56e5796e995706fec5b5124181a0f60bc35`（MIT）。

本项目 [Issue #165](https://github.com/can4hou6joeng4/boss-cli/issues/165) 在 #164 合并后的 `11142f7` 上复现：同步 `context/compactionStarted` 持有 `EventHub.lock` 并延迟事件持久化 2.15 秒时，启用 `on_event` hook 的 `close()` 会在工作等待期限耗尽后继续同步写 `kernel/shutdown`，实测总耗时 2.18 秒；hook 关闭诊断也通过同一事件锁。无 hook 时 close 按期限返回，且摘要 worker 不会晚启动。

`EventHub.emit_until()` 只在关闭路径内按共享绝对期限等待事件锁。`kernel/shutdown` 标记或 hook 失败诊断无法在期限内取得锁时跳过；常规事件写入行为不变，取得锁后的文件持久化仍是同步操作。无竞争路径继续持久化 shutdown 标记。本地探针覆盖阻塞和无竞争路径，不调用真实模型、招聘 CLI 或招聘平台；未复制 Pi 代码或增加依赖。

## 第七十一轮：shutdown 与摘要 worker 启动所有权

Pi Durable 开放 [Issue #11332](https://github.com/earendil-works/pi/issues/11332) 讨论输入准入、任务 abort 与 idle 等待应由独立策略表达；截至 2026-10-29 仍为 OPEN。Pi main 为 `14b4c56e5796e995706fec5b5124181a0f60bc35`，许可证 MIT。该议题还指出异步任务启动与恢复的责任边界。本项目手动摘要已有专用会话准入、显式取消和持久终态恢复，不需要引入通用 task API。

本项目新建 [Issue #163](https://github.com/can4hou6joeng4/boss-cli/issues/163) 在 main `42b4aeb` 上由同步屏障复现：`on_context_compact_start()` 登记摘要 job 后，在 worker 句柄进入 job 且启动前检查关闭状态之前释放运行时锁。并发 `close()` 可取消该 job、在 worker 仍为 `None` 时完成等待并返回；随后启动调用仍会发送 `context/compactionStarted` 并启动已取消 worker，形成 shutdown 后事件和线程。

本轮将摘要线程句柄在登记 job 前创建并一同写入运行时状态；开始事件发布后，启动方在运行时锁内再次检查关闭与取消标志，只有仍获准的 job 才能启动 worker。shutdown 使用既有共享期限等待未完成的启动决策，再等待可见的摘要与 abort worker。正常摘要、显式取消和 provider 终态协议不变；未复制 Pi 实现或增加依赖。

同步核对招聘业务上游 `boss-agent-cli` main `70840e79e8208aeaab7d20ac44646fc74168af6a`（MIT）：开放 Issue #485 询问规避账号封禁，开放 PR #480 明确外部写操作须逐次授权；两者都强化风控停止和授权边界，没有可迁移的 Harness 生命周期代码。`jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70` 的许可证字段为空，开放事项集中招聘、认证和平台行为，没有本轮相关通用任务实现，不复制其代码。

## 第七十轮：审批请求计时器启动失败时收敛 pending waiter

Pi 开放 [Issue #11433](https://github.com/earendil-works/pi/issues/11433) 报告子进程管道 reader/waiter 线程无法创建时请求挂起、取消失效且子进程残留。核对时 issue 仍为 OPEN；Pi main 为 `02a2b2532d8f6ea7b26da578a6844a1fcfd50e03`，仓库许可证为 MIT。本项目的问题范围不同：在 main `8f7f2158fc4d769b470fcd381ab7a9c54bbc4035` 上，故障注入使 `threading.Timer.start()` 失败后，`JsonRpcServer.request()` 已发出审批请求但把 future 留在 `_pending`，且调用方未能注册审批完成回调。两者共同揭示线程启动失败也必须结算对应的等待所有权；本轮不复制 Pi 的 Rust 子进程实现。

本项目独立收敛策略是在 timer 启动失败时立即通过既有 `cancel_request()` 完成 future 并移除 `_pending`，随后返回已完成的 `ServerRequest`。现有审批完成回调将其解释为超时/未批准，继续持久化工具终态而不派发 handler；晚到客户端响应按未知请求忽略。JSON-RPC 字段、正常超时、成功审批路径与依赖均不变。

本地临时故障注入覆盖 timer 在未启动和启动后抛错、pending 清理、future 失败、晚到审批回复忽略及正常 timer 路径；未调用真实模型、招聘 CLI 或平台。测试材料仅保留本地，不进入提交和 Python 产物。

## 第六十九轮：从持久事件恢复摘要任务终态而不重放

Pi Durable 开放 [Issue #11332](https://github.com/earendil-works/pi/issues/11332) 讨论任务执行所有权、是否阻塞新输入与是否响应 abort 应由独立属性表达；核对时 issue 仍开放。Pi 关闭 [Issue #11141](https://github.com/earendil-works/pi/issues/11141) 后增加 `afterRun` task，但 #11332 的 checkpoint 用例仍指出任务若只存在进程运行时，异常退出后缺少可恢复的可观察终态。本轮不引入 Pi 的 task API；仅沿用“持久任务状态与当前进程执行所有权分离”的设计目标。

本项目 [Issue #158](https://github.com/can4hou6joeng4/boss-cli/issues/158) 在 main `7c1828e04c4dbe950e14c0a44aaa8c6accd3a2df` 上由阻塞合成 provider 复现：手动摘要已持久化 `context/compactionStarted`，复制该稳定状态模拟崩溃并重开服务后，`context/read.compactionJob` 为 `null`，`context/compact/read` 返回 `COMPACTION_JOB_NOT_FOUND`；无 provider 重放。项目原有会话恢复修复 running turn 与工具终态，但摘要 job 注册表只在内存。

`SessionStore.events_after()` 增加有界方法筛选，SQLite 为 method/cursor 增加可重建查询索引。服务启动时分页读取摘要生命周期事件，恢复最近 64 条终态；进程退出留下的未终结 job 会检查同一会话是否存在带匹配 `summaryJobId` 的 `context_checkpoint`。若存在，补写 completed 恢复事件；否则补写 `failed / COMPACTION_INTERRUPTED`。恢复事件仅追加持久日志，不在 handshake 前发布通知；不会创建 provider、worker、取消句柄、重放模型请求或再次提交 checkpoint。原有会话占用、follow-up 队列和手动取消策略不变。

本地隔离探针通过克隆 gate provider 运行中的 state 模拟崩溃，分别验证无 checkpoint 时恢复 interrupted、有匹配 checkpoint 时恢复 completed、旧 jobId 与 `context/read` 可查询、恢复 provider 调用为零。测试材料保留在忽略的 `.local-tests/`，不进入 Git 或 Python 产物。

## 第六十八轮：并发容量暂满时保留并公平唤醒后续回合

Pi MIT 仓库开放 [Issue #11350](https://github.com/earendil-works/pi/issues/11350)，讨论共享 Codemode worker 池在长任务下的跨会话饥饿、等待者公平准入和占用诊断。核对时 Pi main 为 `ad702637fdf6fbd3f965c5dba0b14bae100b74eb`。Pi 的 worker 池与本项目模型回合容量不是同一种资源；本轮只参考“先等待的会话不应被后续新请求越过”这一调度原则，不移植 worker 实现。

本项目 [Issue #156](https://github.com/can4hou6joeng4/boss-cli/issues/156) 在 main `20cc7375cd606947d4e94512ad8d8340789124ce` 上以合成 provider 复现：RuntimeManager 容量占满时，第九个会话的 follow-up 被领取为 `delivering`，容量错误随后被写成 `paused / TURN_START_FAILED`；现有释放路径只唤醒原会话，空出的槽位不会重新尝试其他会话。默认容量是 8，隔离探针将其设为 1 以缩短复现。

`RuntimeManager.reserve()` 现在为容量限制提供 `TURN_CONCURRENCY_LIMIT` 与上限元数据。follow-up admission 由进程内 FIFO 等待队列串行调度：容量已满时不领取队列项，槽位释放后先派发更早的等待会话；若在并发竞争中已领取后才遇到容量错误，则把尚未启动的 delivery 退回 `queued`，不伪报真实启动失败。普通直接 `turn/start` 仍返回容量拒绝；存在可调度的更早等待项且槽位已空出时，先派发等待项。回合无论成功还是中断/失败结束，都会唤醒其他容量等待者；provider、bridge 或 worker 的真实启动失败继续使用 `TURN_START_FAILED`。去重身份、审批、工具副作用、重启时未知结果不重放规则均保持不变。

同步核对 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`，GitHub license 字段为空；其开放事项集中招聘业务、浏览器凭据与平台行为，没有可移植的通用模型回合 admission 实现，不复制其代码。

本地合成 provider 探针覆盖并发容量满载、多个跨会话 waiter 的 FIFO/单次启动、重复 client request ID、槽位释放时直接请求不得越过 waiter、同会话 follow-up FIFO、中断后唤醒、关闭时不启动 waiter、领取与关闭竞争时退回 `queued`、清空 waiter 并拒绝晚到唤醒、容量退回及 provider factory 真实启动失败，7 项集成用例通过；网络与子进程尝试为零。测试材料仅留在忽略的 `.local-tests/`，未加入 Git、wheel 或 sdist。

## 第六十七轮：拒绝 Anthropic 消息终态后的流事件

参考 Pi 已关闭 [Issue #11506](https://github.com/earendil-works/pi/issues/11506)，其场景是 Anthropic-compatible relay 在完整流终止前省略 `message_delta.stop_reason`；这与本轮发现相邻，但不是相同故障。核对时 Pi main 为 `ad702637fdf6fbd3f965c5dba0b14bae100b74eb`，许可证 MIT。Pi 当前 `anthropic-messages.ts` 检查了 `message_stop` 是否出现，但不会因此停止解析器向调用方传递后续 SSE 事件；本轮不复制实现，而是按本项目“工具只能来自完整 provider 终态”的契约独立加固。

本项目 [Issue #154](https://github.com/can4hou6joeng4/boss-cli/issues/154) 在 main `1151f7dd` 上通过合成 SDK stream 和真实 `TurnRunner` 复现：`message_start`、正常 `message_delta`、`message_stop` 之后追加完整 `tool_use` 时，provider 仍产出包含该调用的 `done`，回合返回 `completed` 并调用注册 handler。普通 Anthropic 流按 `message_stop` 收尾，不应继续含有新的消息内容块。

`AnthropicProvider.stream()` 收到 `message_stop` 后若迭代器再交付任何事件（包括重复 `message_stop`），立即按流处理错误结束。终态后的文本、思考或工具事件都不能修改响应，也不会产出 `done`；正常终态前的 block 顺序、usage 和工具回路不变。OpenAI Responses、JSON-RPC、审批规则、provider 重试及持久化格式均不变。

同步核对 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`，GitHub license 字段为空；近期开放事项仍集中招聘认证、Cookie、沟通、分页和 recruiter 业务，没有可移植的通用 provider stream terminal 契约，本轮不迁移其代码。

本地 `TurnRunner` 故障注入覆盖终态后追加工具、重复终态以及正常工具续回合：2 个探针用例 / 3 个路径通过，后置工具 handler 调用数为零，正常路径仍调用一次；既有 Anthropic thinking continuation 5 项回归通过。Python 编译、TypeScript 检查、Electron 源码构建、`uv build` wheel/sdist 与产物内容扫描、`git diff --check` 均通过。探针及模拟 SDK 仅保留本地，无真实模型、招聘平台或桌面 UI 验收。

## 第六十六轮：只覆盖默认系统提示身份段

参考 Pi 已关闭 [PR #11315](https://github.com/earendil-works/pi/pull/11315) 与开放 [Issue #11317](https://github.com/earendil-works/pi/issues/11317)：SDK 宿主希望改变 opening identity 时保留默认 tools、rules 和 docs sections。核对时 Pi main 为 `c3d8ce44d3231c7e46071d2d859f41ca7d39d21b`，许可证 MIT。本项目独立实现结构化默认招聘提示入口，不复制 Pi 的 prompt 组装代码。

本项目 [Issue #152](https://github.com/can4hou6joeng4/boss-cli/issues/152) 在 `f19746361ae9fc2b586bec3205ce0e21c9fbe7e1` 上复现：默认 `ToolBundle` 只有完整 `system_prompt`，宿主复制 bundle 后替换整段身份会丢失工具说明与十条招聘规则；显式传入复制 bundle 还会使 `ApplicationService` 判定为自定义组合，关闭默认平台检查与登录 host 能力。

`create_boss_bundle(prompt_preamble=...)` 现在将默认 `SYSTEM_PREAMBLE` 与不可变 `SYSTEM_INSTRUCTIONS` 分段组装；`ApplicationService(prompt_preamble=...)` 只在默认 bundle 路径启用该覆盖，因此保留默认工具、平台检查、登录、技能和只读后缀。身份文本必须非空、无控制字符且不超过 16 KiB；该文本只存在于内存中的最终请求 prompt，不写入会话或事件。自定义 `ToolBundle` 的任意完整 prompt 没有可推断的分段，同时传入覆盖参数时明确拒绝，避免静默丢失安全规则。

本地组合探针 5/5 通过：默认 prompt 逐字兼容、覆盖后工具说明/规则保留、默认 ApplicationService 仍保留平台能力、自定义 bundle 冲突拒绝和输入边界。网络与子进程尝试为零；类型检查、Python 编译、桌面构建、wheel/sdist 内容检查及 `git diff --check` 通过。未调用真实模型或招聘平台，测试材料仅保留本地。

同步核对 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`，GitHub license 字段为空；其开放 Issue/PR 聚焦招聘认证、Cookie、沟通、分页和 recruiter 业务，没有可移植的系统提示分段契约，本轮不迁移其业务代码。

## 第六十五轮：保留被拒摘要的终态用量归因

Pi 开放 [Issue #11090](https://github.com/earendil-works/pi/issues/11090) 要求为模型工具、压缩和分支摘要的每次物理调用保留 provider/model 归因；核对时 Pi main 为 `c3d8ce44d3231c7e46071d2d859f41ca7d39d21b`，许可证 MIT。当前项目成功摘要已经按分片保存 `context_summary_usage`，并在 checkpoint 中记录摘要 provider/model；本轮补齐“provider 已返回终态 usage、但摘要内容不合格”这一相邻缺口，不复制 Pi 代码或引入依赖。

本项目 [Issue #150](https://github.com/can4hou6joeng4/boss-cli/issues/150) 在 main `21734260cd2a7b30b3c41180bae5c0cdd12aa064` 上复现：`_stream_compaction()` 先验收 stop reason、工具调用、空文本和字符上限，`_generate_compaction()` 只有成功返回摘要后才追加 usage；合成 provider 每次返回 `Usage(input=100, output=5)` 时，`length`、空文本和 32001 字符摘要均已调用 provider，但没有任何 `context_summary_usage`。

现在终态 `AssistantMessage` 随摘要校验失败一起携带，若其中有 usage，则在抛出拒绝前保存与成功路径相同的 job、provider、model、fragmentIndex、requestFingerprint、budget、source digest 和 usage，并附受限的 `rejectedCode`。该记录始终 `eligible=false`，不会成为业务 usage anchor。摘要失败仍不写 checkpoint、不重试、不继续后续片段；provider error、流未完成或没有 usage 时不伪造 token 记录。成功摘要仍只写一次 usage，未改变摘要和上下文提交边界。

本地离线探针覆盖正常摘要、invalid stop reason、空摘要和超长摘要：4/4 通过；每个拒绝案例均只产生一条带 `Usage(input=100, output=5)` 的归因记录且没有 checkpoint。Python 编译、类型检查、桌面源码构建、wheel/sdist 内容检查和 `git diff --check` 通过；未调用真实模型、招聘平台或连接服务。测试材料仅保留本地。

同步核对 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`，GitHub license 字段为空；开放 Issue/PR 仍集中招聘认证、Cookie、沟通、分页和 recruiter 业务，没有可移植的模型用量归因契约，本轮不迁移其代码。

## 第六十四轮：连接与登录 worker 的启动失败责任

Pi 开放 [Issue #11433](https://github.com/earendil-works/pi/issues/11433) 报告 pi-env 在 pipe reader/waiter 线程创建失败时，调用方永久等待且子进程未被回收；核对时 Pi main 为 `c3d8ce44d3231c7e46071d2d859f41ca7d39d21b`，许可证 MIT。本项目的子进程输出与 I/O 线程失败已在第二十一轮覆盖，本轮以相同的“启动失败必须明确结算，真实运行任务仍需持有责任”原则审计连接服务，未复制 Pi 实现或引入依赖。

本项目 [Issue #148](https://github.com/can4hou6joeng4/boss-cli/issues/148) 在 main `974e760b6ce837cacd9083684051b67f7669d102` 上用合成 bridge 与线程故障注入复现：登录 worker 构造失败后 login 仍为 `saving`；实际启动前失败还会留下未启动的 active worker，取消与关闭后仍无法退休。普通连接检查及模型 abort 则在启动包装层已创建真实 worker 后抛错时过早释放责任，允许后续操作与旧任务重叠。

独立修复按 worker 是否已有 `ident` 区分启动事实。未启动的连接检查返回既有 `CHECK_FAILED`；未启动的登录保存返回固定 `LOGIN_SAVE_START_FAILED`，清理槽位并在连接锁外通知 idle，不返回原异常或 Cookie。已启动的检查、登录与模型 abort 保留原取消信号和所有权，直到实际 worker 清理结束，不自动重试。关闭或取消已被观察后，迟到返回的 bridge 工厂、可用性检查或本地认证结果不再触发后续 CLI 调用；已发生的登录保存不声称撤销。

本地专项 18/18 通过，覆盖登录构造/未启动失败、启动后抛错、取消和关闭，以及 local/model/platform 检查的三种启动状态、关闭期间不追加调用和慢模型 abort 的真实责任。另有独立 `ApplicationService` 所有权验收 7/7 通过，确认实际 worker 或 abort 未结束时新应用不能接管状态目录，完成后可接管。Python 3.13 编译、类型检查、桌面源码构建、wheel/sdist 构建与内容检查及 `git diff --check` 通过。故障注入仅使用合成登录字段、bridge/provider 和临时状态，网络与子进程尝试为零；这不证明真实系统线程资源耗尽、模型或平台登录已验收。测试材料仅保留本地。

同步检查 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`，GitHub license 字段仍为空；开放 Issue/PR 聚焦 Cookie/Keychain、认证、招聘沟通、分页和 recruiter 业务，没有对应的通用 worker 生命周期实现，本轮不迁移其登录或认证逻辑。

## 第六十三轮：保留 Anthropic extended thinking 签名续接元数据

本项目 [Issue #146](https://github.com/can4hou6joeng4/boss-cli/issues/146) 复现了 Anthropic extended thinking 在流式解析、工具续请求和重开会话时丢失 `signature` 的问题：模型返回的 thinking block 仍带有工具调用，但后续请求没有原样回放签名，服务端会拒绝请求；若继续执行工具，则可能在请求事实未被确认时产生外部副作用。

参考 Pi main `4ba356228c7fea1524413b1d56f9a31351329575`（MIT）。Pi 对跨模型或 provider 的 thinking 历史采取保守丢弃策略；本轮只吸收“签名属于 provider 私有、必须按兼容线路保留”的边界，不复制其消息转换实现。同步核对 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`：GitHub license 字段为空，开放 Issue/PR 仍集中招聘认证、Cookie、沟通、分页和 recruiter 业务，没有可移植的通用 provider continuation 契约。

官方 Anthropic Python SDK `2.3.0` 的 `ThinkingBlock.signature` 是 opaque 值，`signature_delta` 在 `content_block_stop` 前到达；重复 delta 按 SDK 语义替换而不是拼接。`redacted_thinking.data` 同样按原值回传。独立实现将这些字段放入内核私有 continuation metadata，并同时记录 block 顺序、内容摘要、工具调用 ID 和请求前缀 digest；metadata 不进入 RPC、事件、hook、摘要材料或工具结果投影。

同回合工具续请求、历史重建、关闭后恢复和 fork 均回放已核验的 signed thinking/redacted thinking。若含工具的 thinking 响应缺签名或出现不受支持的 fallback block，provider fail closed，不执行工具；前缀 digest 不一致时丢弃失效 thinking block，不发送其签名。崩溃恢复只补回已持久化的连续工具前缀，不猜测或重跑缺失工具。上下文编辑会拒绝带签名的工具回复，压缩摘要只保留可公开的尾部材料。

本地探针使用 Anthropic SDK `2.3.0` 的 `MockTransport`，覆盖流式捕获、signature 替换、同回合/重开/fork 续接、缺签名阻断、前缀失配、上下文编辑、压缩和崩溃恢复；公开 RPC/event/live/hook/摘要出口无私有 marker，HTTP 400 与 HTTP 200 SSE 错误回显也已脱敏。Python `compileall`、TypeScript 类型检查、Electron 构建、wheel/sdist 构建及 `git diff --check` 通过；探针仅保留本地，未调用真实模型或招聘平台。真实 Anthropic 服务、第三方网关跨模型兼容性和省略后缀 `tool_use` 的远端行为仍未验收。

## 第六十二轮：识别代理 HTTP 413 请求体上限

本项目 [Issue #144](https://github.com/can4hou6joeng4/boss-cli/issues/144) 基于文本附件/较长会话的字节体积复现：本地 token 估算仍在容量内时，前置代理仍可因 HTTP body 上限拒绝请求。Pi 开放 [Issue #10879](https://github.com/earendil-works/pi/issues/10879) 报告相同故障；核对时仍为 OPEN。Pi main `bdb68f750ed7724a7718237895b98604f7f2c114`（MIT）在 `packages/ai/src/utils/overflow.ts` 将通用 HTTP 413 文本和 Cerebras 无正文 400/413 都归为 overflow，范围比本项目允许的恢复信号更宽。

本项目 OpenAI Responses 与 Anthropic 适配器都在可信 HTTP 异常边界获得结构化响应体和状态码。共享分类器只接受状态码 413 且 `message` 不超过 512 字符、完整匹配 `Request body too large` 或 `payload too large`（忽略大小写，允许末尾句点）；不要求任何供应商专属 code。裸 413、其他响应文本、HTTP 400、HTTP 200 流内错误和传输错误均不分类。实现不复制 Pi 正则或增加依赖，现有无输出/未取消/预算足够/每回合一次恢复闸门保持不变。

## 第六十一轮：识别 LiteLLM HTTP 400 上下文窗口拒绝

本项目 [Issue #140](https://github.com/can4hou6joeng4/boss-cli/issues/140) 以 Pi Issue [#11492](https://github.com/earendil-works/pi/issues/11492) 的原始 LiteLLM 响应复现了上下文分类缺口：HTTP 400 的 `litellm.ContextWindowExceededError` 被 `openai_error_info()` 当作普通请求错误，因此现有自动摘要恢复无法处理。Pi [PR #11494](https://github.com/earendil-works/pi/pull/11494) 已合并，固定 merge commit `d3398f826ae2654b52a7988830d533a354754c13`；核对时 Pi main 为 `fa16851520f8c5edf930d14ca04cdb4cb71d7a67`，许可证 MIT。

Pi 通过宽泛短语匹配解决其 overflow detector 的问题。本项目只在可信 HTTP 400 响应中识别有界、以 `litellm.ContextWindowExceededError:` 开头且同时包含 `Context Window exceeded for given call.` 与 `Max Input Tokens=N, Got=M` 的错误消息，并要求 `N > 0` 且 `M > N`。HTTP 200 流错误、普通 400、其他状态、缺少数字事实、未超限和超长消息均不扩大为上下文溢出；未复制 Pi 代码或增加依赖。

分类仍受既有恢复闸门约束：请求未输出文本、思考或工具事件且未取消，自动摘要策略已启用、请求预算允许且本回合尚未恢复时，才会提交摘要并重试一次当前模型请求；不重放工具或审批。19 项临时离线检查通过：15 项覆盖 LiteLLM 顶层/嵌套错误、普通 400、错误标记/数字/超限关系、消息长度与 HTTP/SSE 状态，并确认结构化 OpenAI、llama.cpp 和 Anthropic 分类不回归；另 4 项通过完整 `TurnRunner` 路径核对一次恢复、请求预算耗尽、已输出文本与取消边界。测试材料仅保留本地。

## 第六十轮：工具终态宿主观察回调

参考 Pi 开放 [Issue #11043](https://github.com/earendil-works/pi/issues/11043) 的 `afterTool` 提案（Pi main `a92283056d915c758799fcd904948ff0cb42628c`，MIT）。本项目第五十二轮已吸收其中 `maxTurns` 请求上限，但有意未引入可改写工具结果的 `afterTool`。本轮重新按本项目招聘宿主需求限定为同步只读观察：嵌入工作台需要在每个工具终态后、下一次模型请求前记录工具实际执行状态；异步 `on_event` 的有限队列可能丢弃事件，而且白名单不暴露结果正文。

`LifecycleHooks.after_tool_call()` 在 `append_tool_revision()` 确认终态写入后调用一次，覆盖 handler 完成/失败、参数或策略拒绝、用户审批拒绝/超时、未知工具、派发前取消及 `_skip_calls()` 批次终止的未执行调用。取消时仍进入观察回调并传入 `signal.aborted=true`；内核可停止等待并写入取消诊断。若工具结果终态无法确认已持久化，则不声称已回调。宿主上下文默认只包含 thread/turn/item/tool 标识、状态、执行状态、成功标志和错误码；只有显式设置 `expose_tool_results_to_hooks=True` / `LifecycleHooks(expose_tool_results=True)` 才暴露完整结构化结果。结果可能含候选人个人信息，因此访问选择由嵌入端明确承担。

回调使用限时隔离 worker、统一在途上限和可选协作取消 signal。返回值被忽略，快照深只读；异常、超时、容量满和无效返回只记录 `kernel/hookError`，不会改写已持久化结果、审批或模型可见输出，也不重放工具/审批。完整结果快照复用策略上下文 JSON 边界；超大或非 JSON 结果拒绝交给回调并记录诊断。Pi 回调可以转换结果的行为没有照搬，以保留本项目对已发生外部事实的权威记录。未增加依赖。

## 第五十九轮：OpenAI Responses 流取消的句柄登记窗口

本项目 Issue [#136](https://github.com/can4hou6joeng4/boss-cli/issues/136) 在基线 `99a3249ad96374d1352a44327e9bf5b9d5f7b096` 上由隔离 `MockTransport` 复现：`OpenAIResponsesProvider._stream_once()` 只有在官方 SDK 的 `responses.create(..., stream=True)` context manager 返回后才登记 `_active_stream`，登记后也没有重新检查 `_abort_requested`。响应建立期间用户取消时没有可关闭句柄；响应随后返回仍会进入 body iterator，传输若等待数据会让回合 worker 和状态目录所有权滞留。

参考 Pi 开放 [Issue #11211](https://github.com/earendil-works/pi/issues/11211)（报告基于 `82432219a`，截至 2026-10-28 仍 OPEN；Pi 当前 main `a92283056d915c758799fcd904948ff0cb42628c`，许可证 MIT）。Pi 讨论 Anthropic SSE body 的 abort/finally 清理；本项目使用 Python OpenAI Responses SDK，结构不同，仅采用“响应句柄登记后要复查取消并关闭 body”的生命周期目标，不复制 Pi 代码或引入依赖。

本地使用 OpenAI SDK `3.35.1`、最低兼容 `3.35.0`、httpx2 `2.13.1/2.16.0` 和合成流验证：修复前 headers gate 取消后 250ms worker 仍存活、body 已读取且未关闭，事件只有 `start`；修复后两版本均立即得到 `start + error(reason=aborted)`，body 读取为 0、已关闭、活动句柄已清空。body 读取期间取消仍关闭流并终止，不触发 provider 重试；正常 Responses 文本流仍得到 `start/text_delta/text_end/done`。socket、连接建立和 DNS 尝试均为 0。探针仅留在 ignored 本地目录，未调用真实模型、招聘平台或外部进程。

本轮只在 context manager 返回后登记句柄并立即复查取消标志；上下文退出仍负责关闭响应，外层 `finally` 清空句柄。Anthropic 已由 Issue/PR [#105](https://github.com/can4hou6joeng4/boss-cli/pull/105) 覆盖相同登记窗口，未改动其线路。同步检查 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`（许可证接口不可用；开放事项为 Cookie/认证、沟通、分页和 recruiter 业务）没有可移植的 provider 流取消契约，本轮不采用其代码。Pi [Issue #11376](https://github.com/earendil-works/pi/issues/11376) 维护者于 2026-10-27 反馈无法复现，本项目也不发送 `tool_addition/tool_removal`，不纳入。

2026-10-29 复核：Pi Issue #11211 仍 OPEN；Pi main 更新为 `a87b742ff4ce262c07b7830a25c73c1442dab41`，许可证 MIT。当前本项目 main `11142f783e1751c066a0ea920469971b1e9f82ec` 的 Anthropic provider 在迭代前登记 SDK stream，`request_abort()` 调用其 `close()`；回合、摘要及连接检查消费者均在 `finally` 关闭流。使用本地 Anthropic 2.3.0、httpx2 2.16.0 和 `MockTransport` 验证：body 在提供 `message_start` 后阻塞等待下一帧，调用 `request_abort()` 后 SDK 调用 body `close()`，迭代器立即退出；畸形 SSE 在 SDK context manager 退出时同样关闭 body。无网络或模型请求。Pi 报告中的 caller-provided client 不受 abort signal 控制与本项目不同：`AnthropicProvider` 不公开注入 client 的配置入口。合成传输没有验证操作系统 socket 的唤醒行为，因此不据此推断网络栈所有故障都能立即取消；在本项目支持的接入路径中未复现可修复缺口，本轮不改运行时代码。

同日评估 Pi [PR #11545](https://github.com/earendil-works/pi/pull/11545)：核对时仍为 DRAFT/OPEN，feature commit `1a35b9c29dd37f66279dced4a64c3d5a6aa48687`、head `a33c171262590a0fe375e1e99bb617187be92240`，基于 Pi main `a87b742ff4ce262c07b7830a25c73c1442dab41`，许可证 MIT。该提案为 Anthropic message-threads beta 保存服务端 continuation，前缀不匹配或服务端拒绝时回退完整请求；文档声明 token 数和 prompt cache 行为不变，收益主要是减少重复请求载荷。本项目每次请求都从本地 append-only 历史重建完整上下文，`ModelRequest` 没有 session 身份，也没有跨请求 provider continuation 状态。直接采用还需明确 thread 与本地分支、上下文编辑、摘要 checkpoint、重启和删除之间的关联及并发恢复；上游的进程内 `cleanupSessionResources(sessionId)` 不等同于 provider 端线程删除，远端保留/删除契约尚未核实。当前没有本地长会话载荷或延迟测量证明该取舍有实际收益，因此暂不移植；若后续评估，先测量典型会话请求体并核实官方 endpoint 的远端状态清理语义。

同日复核 Pi main `edab3efa834709a5ecfa191db751003e21e0a596`（MIT）的近期已合并改动：[#11486](https://github.com/earendil-works/pi/pull/11486)（merge `807a5c051f86bcbe707c59d6b954e4529058bcef`）使写失败时 session memory 与文件一致；本项目不缓存内存 transcript/leaf，`last_entry_id()` 从 JSONL 读取，append 后重建索引，故无相同缓存失步路径。[#11540](https://github.com/earendil-works/pi/pull/11540)（merge `92c1da1f62a5fd2ba18c70f6f8691014793fd5fb`）处理 helper thread 启动失败后的 exec/pty 清理；本项目 `BossCliTool.call()` 已在输出线程启动失败时终止子进程并关闭未启动管道。[#11288](https://github.com/earendil-works/pi/pull/11288)（merge `ed76cca69b136931fd93198b4d44f5c3b59e684c`）将 fork session 写入收敛到单一 fd；本项目新 session 已先完整写临时 JSONL、fsync，再用硬链接原子发布。[#11482](https://github.com/earendil-works/pi/pull/11482)（merge `269afc66abfd5fdd37ff0eedfe2b749b6050a420`）向 branch summarization 传递 thinking level；本项目摘要使用独立 `SummaryPlanner` 和显式 summary effort，没有该分支摘要调用路径。[#11511](https://github.com/earendil-works/pi/pull/11511)（merge `88ffcdc734605d80bc383476950856b1242081fa`）将已删除工作目录的启动崩溃改为可读错误；本项目入口捕获 `ApplicationService` 构造时的 `OSError`，从已删除临时 cwd 启动的本地探针输出 `[harness] 启动失败（FileNotFoundError）` 并以状态码 2 退出，无回溯。[#11543](https://github.com/earendil-works/pi/pull/11543)（merge `b5fc6dc84f28a103f85db6f201f40c0a32ee76b3`）修复 Pi 终端 `stripAnsi` 对私有 CSI 前缀的处理；本项目没有 ANSI/终端渲染器，成功工具结果序列化为 JSON 后由 React 文本显示，控制字节不会执行。畸形错误摘要可能留下可见参数字符，但属于低风险展示瑕疵，不移植终端专用解析器。以上均有不同或已满足的本地契约，不移植上游代码或增加依赖。

## 第五十八轮：保护会话持久化文件 mode

本项目 Issue [#133](https://github.com/can4hou6joeng4/boss-cli/issues/133) 的本机合成复现发现：旧版 `0755` state 目录中，新 session JSONL、event JSONL、SQLite/WAL/SHM 会随 `umask 022` 以 `0644` 创建；附件则先以该 mode 创建再 chmod `0600`。此前的新目录权限修复无法约束旧 state 根目录内的文件。

参考 Pi [Issue #10770](https://github.com/earendil-works/pi/issues/10770) 对 owner-only 会话存储的目标。本轮新增不跟随链接的普通文件处理：新文件以 `0600` 创建；打开既有 state 时，只将当前用户拥有的普通 SQLite、事件、session JSONL 和附件文件收紧至 `0600`。目录 mode、文件内容与格式保持不变；链接、非普通文件及非当前用户文件不被跟随或改写。SQLite 主库先设为私有，确保 WAL/SHM 沿用其权限。未复制 Pi 代码或增加依赖。

## 第五十七轮：私有创建会话存储父目录

本项目 Issue [#131](https://github.com/can4hou6joeng4/boss-cli/issues/131) 复现了独立初始化 `SessionStore` 时的权限遗漏：会话目录显式为 `0700`，但 `state.sqlite3` 与 `events.jsonl` 位于其父目录；当该父目录也需要由递归 `mkdir` 新建时，它按宽松 `umask 022` 得到 `0755`，持久化文件则为 `0644`。Pi [Issue #10770](https://github.com/earendil-works/pi/issues/10770) 确认会话存储需要 owner-only 目录边界；本轮结合本地存储布局，将同一隐私默认扩展到新建的索引/事件目录。

`SessionStore` 现在先以 `mode=0o700` 确保新建数据父目录，再以相同权限创建会话子目录。`mkdir(..., exist_ok=True)` 不会改写已存在目录；SQLite、事件与 JSONL 文件的打开方式和模式、数据库格式、事件游标及恢复语义均不变。正式 `Harness` 已通过 `StateDirectoryOwner` 预建 state root，本修复也覆盖直接初始化 `SessionStore` 的调用方。未复制 Pi 源码或增加依赖。

## 第五十六轮：限制新会话目录权限

本项目 Issue [#129](https://github.com/can4hou6joeng4/boss-cli/issues/129) 记录招聘会话 JSONL 目录的权限边界。`SessionStore` 原先调用未指定 mode 的 `mkdir`；在 `umask 022` 下，本地真实初始化得到 `0755`，让同机其他用户能够枚举会话文件名及元信息。本轮只验证并收紧新目录权限，不对单个 JSONL 文件的权限作结论，也不改变其创建方式。

参考 Pi 开放 [Issue #10770](https://github.com/earendil-works/pi/issues/10770) 及其参考修复 head `256a8d3f9ea264cf23c5384482114beae3def710`（Pi main `a92283056d915c758799fcd904948ff0cb42628c`；MIT）。Pi 为新建默认、自定义及 fork 会话目录显式使用 `0700`，已存在目录权限保持原样。本轮采用相同的创建期隐私默认值，不自动修改既有用户目录，不复制源码或引入依赖。

`SessionStore` 现在以 `mode=0o700` 创建新根目录。JSONL 文件创建方式、权限模式、SQLite/事件格式均未在本轮改变；已有目录权限保持不变。

## 第五十五轮：摘要占用期间保留后续回合队列

本项目 Issue [#127](https://github.com/can4hou6joeng4/boss-cli/issues/127) 复现了摘要与后续消息之间的 admission 竞态：摘要运行时，`queue/add` 会尝试领取 `followUp`，随后 `turn/start` 因会话被摘要占用而拒绝；旧异常路径把这个暂时忙状态当成 `TURN_START_FAILED`，将队列错误暂停。摘要结束后又没有重新唤醒队列。

参考 Pi Issue [#10982](https://github.com/earendil-works/pi/issues/10982) 的会话忙状态边界（Pi main `a92283056d915c758799fcd904948ff0cb42628c`；MIT）。本轮只采用“异步消息等待当前会话占用释放”的职责，不复制 Pi 源码，不引入依赖，也不改变招聘工具或外部操作授权。

`_start_follow_up` 在领取队列项前检查摘要占用，使摘要期间的后续消息保持 `queued`。手动摘要和归档也在同一运行锁下拒绝仍处于队列交接、尚未进入 `active` 的后续回合，避免摘要与已领取但尚未预留的请求抢占会话。仅摘要成功提交 checkpoint 并释放占用后才唤醒正常队列派发；手动摘要失败或取消时暂停等待的 follow-up，避免未来另一条 queue/add 意外派发旧输入，用户须明确发起新任务。自动摘要失败仍由所属业务回合暂停队列。唤醒失败不改写摘要终态，也不把队列改成启动失败；已有工具结果、审批和未知外部动作不重放。

## 第五十四轮：以 OpenAI Responses 终态收敛流式输出块

本轮复核 Pi 开放 [Issue #11043](https://github.com/earendil-works/pi/issues/11043)（截至 2026-10-28 为 OPEN；Pi main `a92283056d915c758799fcd904948ff0cb42628c`；MIT）。该议题同时讨论 `afterTool` 与回合上限；本仓库已经在第五十二轮吸收回合上限，本轮继续处理执行循环依赖的 provider 终态事实，不引入 `afterTool` 扩展 API。

临时合成 Responses 流复现：`output_item.done` 先产生一个工具调用，随后流中还有文本块，但 `response.completed.response.output` 只保留文本块。原实现按流事件累积 `blocks`，终态只覆盖出现的索引；已撤回的工具调用会残留在 `AssistantMessage`，`TurnRunner` 随后可能把它派发给 handler。该问题只涉及 provider 到执行器的通用契约，不涉及招聘平台操作。

独立修复把 `response.completed` / `response.incomplete` 的 `output` 视为权威输出集合：以输出项 ID/索引建立终态集合，拒绝终态缺失、重复索引或重复 ID；终态没有的流式块会从最终消息中移除，终态异常则返回错误事件而不产生 `done`。仍在终态集合中的工具调用继续按原有参数来源一致性校验；Anthropic 线路和现有工具权限不变。未复制 Pi 源码或引入依赖。

本地离线探针覆盖撤回工具、缺失终态 output、重复终态索引和保留有效工具四种路径，4/4 通过；Python 源码编译和 `git diff --check` 通过。探针仅保留在临时目录，未调用真实模型或招聘平台。

## 第五十三轮：补齐摘要与连接检查的请求策略覆盖

本仓库 [Issue #121](https://github.com/can4hou6joeng4/boss-cli/issues/121) 复核 rc.10 引入的 Pi [Issue #11055](https://github.com/earendil-works/pi/issues/11055) 请求拒绝契约。以主线 `47238b2` 为基础，临时状态和合成 provider 复现：始终拒绝的策略仍会在业务请求准备中先生成一次阈值摘要并提交 checkpoint；手动摘要与模型连接检查也有未经过策略的 `provider.stream` 路径。已关闭的 `LifecycleHooks` 还会把策略跳过当作允许。第五十一轮的实现和验收只覆盖业务请求，不能支持对全部模型用量的预算或 kill switch。

独立实现统一的请求策略检查，业务请求、每个摘要分片和模型连接检查在各自完整预算准备后调用同一 `before_request`，以 `purpose=turn/compaction/connection_check` 和从零开始的 `requestIndex` 区分请求；只提供请求身份、provider/model、数量与预算，不提供正文、工具参数或凭据。业务与摘要拒绝的 code、脱敏原因及身份写入 `model_error`；摘要失败事件保留 `requestRejected=true`，自动/溢出摘要的拒绝透传为业务回合 `error`，不进入通用恢复失败或后续业务请求。任何分片拒绝都不会提交本次新 checkpoint，既有 checkpoint 与已完成的有界分片 usage 保留。连接拒绝通过 `failed` 报告保留策略 code、脱敏原因和该标记，后续显式检查清除旧标记。

策略正在关闭或已关闭时 fail closed，运行中回调的迟到允许也被忽略；取消优先，并沿用现有 worker/provider 所有权。`SessionErrorNotification`、`ContextCompactJob` 和 `ConnectionCheck` 补齐可选拒绝字段，业务错误通知携带实际被拒绝的摘要请求身份。provider/SDK 内部传输重试不重复进入策略；本轮未复制 Pi 源码或引入依赖。

本地扩展探针通过 106 项断言，覆盖首次与第二摘要分片拒绝、旧 checkpoint 保留、overflow 摘要拒绝、摘要/连接凭据脱敏、连接后续成功清除旧标记、关闭中迟到允许、取消优先，以及三种请求用途的超时和无效返回。原始审计探针同时确认阈值摘要、手动摘要、连接检查与 closed 策略的拒绝 provider 调用均为零，阈值摘要无新 checkpoint。Python 3.14 编译、TypeScript 类型检查、桌面源码构建及 Harness wheel/sdist 构建通过；两个 Python 产物包含新策略模块且不包含测试材料。所有状态位于临时目录，网络尝试为零，探针未提交；未验证真实模型或招聘平台。

## 第五十二轮：可配置的回合请求上限

参考 Pi 开放 [Issue #11043](https://github.com/earendil-works/pi/issues/11043)（截至 2026-10-28 为 OPEN；Pi main `a92283056d915c758799fcd904948ff0cb42628c`；MIT），其中 `HarnessSettings.maxTurns` 用来约束一次运行的模型轮次；同一议题的 `afterTool` 变化不在本轮范围。本项目已具备固定 6 次业务请求的停止边界，本轮独立实现可配置的宿主硬上限，未复制 Pi 源码或新增依赖。

`ApplicationService(max_model_requests=...)` 或启动环境变量 `BOSS_HARNESS_MAX_MODEL_REQUESTS` 接受 1–64，显式宿主值优先，默认仍为 6；`turn/start.maxModelRequests` 只能为本回合收紧宿主上限。请求参数在构造回合 provider、预留回合和保存输入前严格校验；运行器在开始时冻结实际上限，工具循环、steering 续答和 overflow retry 共同计数。provider/SDK 内部传输重试和独立摘要的 32 次生成上限不受其控制，队列后续回合恢复宿主默认值。

`config/read`、持久回合元数据和 `TURN_ROUND_LIMIT` 通知暴露可追溯的实际上限；耗尽仍为 `blocked`，已有结果保留，未投递队列暂停。最后一次正常最终文本可完成，但不投递无法响应的 steering；最后一次 overflow 不启动无业务请求额度的摘要。协议版本仍为 `0.2.0`，新增字段可选，旧历史继续读取。

本地 73 项离线断言覆盖默认/最小/最大值、环境与 RPC 类型拒绝、宿主硬上限、无输入/无回合副作用、1/3/6/64 次工具循环、最终正常响应、overflow 最后次数停止与可用额度恢复、队列暂停、单次覆盖后串行回合回到宿主上限和历史记录。使用合成 provider、工具和临时状态，未调用真实模型或招聘平台；探针仅保留本地。

## 第五十一轮：模型请求前策略拒绝

Pi 开放 [Issue #11055](https://github.com/earendil-works/pi/issues/11055)（截至 2026-10-28 为 OPEN；Pi main `a92283056d915c758799fcd904948ff0cb42628c`；仓库许可证 MIT）。该 issue 指出 `beforeRequest` 可以改写请求，却不能在 provider 调用前拒绝请求；用异常绕过会进入不清晰的 abort/重试路径，无法表达预算、账户策略或 kill switch 的明确终态。

本轮最初在现有嵌入式 `LifecycleHooks` 中增加 `before_request(context)`，沿用有界、深只读 JSON 策略输入和可选协作式 `signal`。它运行在完整业务 `request_preparer`（包括 system、消息、工具、thinking 与预算）之后、业务 provider stream 之前；返回 `HookDecision(False, code, message)` 时，运行器将拒绝原因脱敏后写入 `model_error` 并发出 `session/error`，以 `error` 终止当前回合，不调用该业务 provider、不执行工具、不申请审批，也不进入上下文恢复或自动重试。每个工具回路和 overflow 恢复后的业务重试重新经过该闸门；当时尚未覆盖准备/恢复中的摘要 provider 或独立连接检查，覆盖修复见第五十三轮。

拒绝上下文只包含 thread/turn、请求序号、provider/model、消息与工具数量及预算快照，不包含消息正文、工具参数或凭据。hook 错误、超时、并发耗尽、无效返回和输入越界均 fail closed；取消或迟到结果不会改写回合。兼容现有 `before_tool_call` 与一参数 hook，未复制 Pi 源码或引入依赖。

同步检查 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`：开放事项仍为招聘认证、Cookie/Keychain、沟通与 recruiter 业务，没有通用模型请求策略契约；本轮不迁移其业务代码。

当时的本地离线探针覆盖首次业务请求拒绝（provider 0 次）、工具循环第二请求拒绝（provider 1 次、handler 1 次、无审批），以及 overflow 恢复后的业务重试拒绝（provider 1 次、`recover_context` 1 次）；被拒绝的那次业务请求没有调用 provider，终态为 `error`，拒绝原因进入持久错误记录与通知。这些探针没有验证摘要 provider 或连接检查策略；未调用真实模型或招聘平台。

## 第五十轮：识别 llama.cpp 解码阶段的上下文耗尽

Pi 开放 [Issue #10885](https://github.com/earendil-works/pi/issues/10885)（截至 2026-10-28 为 OPEN；报告对应 llama.cpp `Context size has been exceeded.`；Pi main `a92283056d915c758799fcd904948ff0cb42628c`；仓库许可证 MIT）。该错误来自 llama.cpp 解码阶段 KV pool 耗尽，不带 `context_length_exceeded` 结构化 code，因此若只检查供应商 code，自动上下文恢复不会触发。

本项目的 OpenAI Responses 适配器也承接 OpenAI-compatible 端点。此前 `openai_error_info()` 只接受精确 `context_length_exceeded`，会把该有界上下文事实当作普通错误；Anthropic 的 typed 数字上下限规则保持不变。招聘业务上游 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70` 的开放 Issue/PR 仍为 Cookie、认证、沟通和 recruiter 业务，没有通用 provider 错误契约，本轮不迁移其代码。

独立实现仅在合法 OpenAI 错误来源（HTTP 400 或 HTTP 200 流内事件）且结构化 `message` 为不超过 512 字符、完整匹配 `Context size has been exceeded.`（允许大小写和末尾句点）时标记 `CONTEXT_OVERFLOW`；任意更长、带额外前后文或其他错误文本均不分类。现有“无输出/无取消时最多一次压缩恢复”、请求上限和错误脱敏边界不变，未复制 Pi 源码或增加依赖。

本轮离线验收覆盖 HTTP 400、HTTP 200 流内事件、精确大小写/句点兼容、额外文本和超长文本拒绝、原有结构化 code 兼容及来源状态拒绝；真实模型、llama.cpp 服务和招聘平台均未调用。

## 第四十九轮：按显式工具 schema 解码结构化字符串参数

Pi 开放 [PR #9569](https://github.com/earendil-works/pi/pull/9569)（截至 2026-10-28 为 OPEN；head `8746d6617b5349ed4fee3f5d3522f0cc46a79ae5`；Pi main `a92283056d915c758799fcd904948ff0cb42628c`；仓库许可证 MIT）。该 PR 报告部分 OpenAI-compatible 模型把嵌套 object/array 再编码为 JSON 字符串，导致 schema 类型检查失败；Pi 的处理只在 schema 要求结构类型且解析结果符合 schema 时解码，允许 string 的 union 保留原字符串。

本项目的 OpenAI Responses 与 Anthropic 适配器会解析工具参数的外层 object；通用 `ToolBundle` 允许嵌套 schema，但 `tool_schema.validated_arguments()` 原先对嵌套值严格按 JSON 类型拒绝。合成离线输入 `{"target":"{\"kind\":\"agent\"}"}` 可复现：schema 要求 `target` 为 object 时失败，原生 object 则成功。招聘内置工具当前参数基本扁平；本轮针对通用、显式注册的工具组合补足兼容能力，不改变招聘命令或参数授权。

独立实现只对 schema 选择的 object/array 结构字段各解码一层，先保持调用方输入不变，再对解码结构递归应用同一 schema 规则并重新完整校验；格式错误、错误结构、超限节点/深度和最终字节数仍拒绝。若输入已匹配允许 string 的 `anyOf` 分支则保留字符串。规范化参数在生命周期策略、审批请求、持久化和 handler 派发前统一传递；审批要求与 allowlist 不变。未复制 Pi 源码或增加依赖。

本地离线验收覆盖嵌套 object/array、`anyOf`、字符串 union、原始输入不可变、格式/类型拒绝、标量不转换、深度/节点上限及自定义校验器只读语义；合成 `ApplicationService` 与 `TurnRunner` 检查规范化值在策略 hook、审批、持久化与 handler 间一致，错误结构在 hook/handler 前拒绝。Python 3.11 `compileall`、Harness wheel/sdist 构建及 `git diff --check` 通过。探针只使用临时状态和合成 provider，不调用真实模型或招聘 CLI；探针代码仅在本地命令中运行，未提交。

检查 `can4hou6joeng4/boss-cli` 当前 main `641c147648f5ef280cc69f5efb5cf53a8f2bde96`（私有仓库、无开放 Issue；草稿 PR #109 是会话模型线路选择）及业务上游 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`（许可证字段为空）。后者开放 Issue #35/#34 等关于招聘认证与业务操作，开放 PR #37/#29 等关于沟通分页和 recruiter 功能；未发现通用工具 schema 参数规范化需求，不移植其业务逻辑或认证代码。

## 第四十八轮：为模型上下文限制大型工具结果

Pi 开放 [Issue #11386](https://github.com/earendil-works/pi/issues/11386)（截至 2026-10-28 为 OPEN；Pi main `85c2ee3e761e4fc4f901ff0ed584fb2465aa552e`；MIT）提出将 MCP 工具结果的固定 20 KiB 上限改为按工具/server/项目配置。议题主要关心单次模型输入预算与大 schema/tree/search 结果；Pi 尚无关联实现 PR。本项目没有 MCP server 配置，工具来自显式 `ToolBundle`；`jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70` 的许可证字段为空，当前开放 Issue/PR 仍集中招聘业务、平台权限、会话发送和认证，不存在可直接移植的通用工具结果预算实现。

本项目现有 64 KiB 限制只控制 Electron/RPC 内联传输；完整结果保存在工具条目，原先又把完整 `modelResult` 写入和回放到模型上下文。若照搬截断而不给模型补读通道，招聘职位或候选人数据会在模型侧不可见。现在 `ToolDefinition.max_model_result_bytes` 提供每工具 UTF-8 字节预算（默认 20 KiB，8 KiB–1 MiB），超限时仅向模型暴露明确省略标记、已有结果摘要和基于规范结果 JSON 的 SHA-256。规范结构化结果保持完整写入会话记录；重启历史、摘要材料与预算预览都重新按原工具预算投影。

新增的 Harness 内核工具 `read_session_tool_result` 只读当前会话中已持久化的工具结果，按 item ID、SHA-256 和绑定会话/条目的游标每次最多读取 8,192 个 Unicode 字符；不进入 `ToolBundle`、招聘 CLI allowlist 或审批清单，也不触发外部招聘操作。桌面仍通过现有 `thread/item/result/read` 独立读取原始结果。没有复制 Pi 源码或引入依赖；本地验收须覆盖完整结果不变、旧会话回放限额、分页原文还原、错误/跨会话引用拒绝及 fork 行为。

## 第四十七轮：保留结构化 provider 终态错误信息

本项目主线 `ccee00ca98aca9a80e9abe39cbd52c5e5de2d6b2` 已能在 OpenAI 与 Anthropic 适配器中识别特定上下文溢出，但其他 HTTP 状态、供应商错误 code 与瞬时错误判断会退化为脱敏文本；`session/error` 无法区分 401、503、额度耗尽及流内服务错误。此前 `ModelErrorInfo` 只描述 `CONTEXT_OVERFLOW`，流内结构化事实也没有完整穿过终态事件。

参考 Pi 开放 [Issue #11071](https://github.com/earendil-works/pi/issues/11071)（截至 2026-10-28 为 OPEN；Pi main `bb65e3e49710fbd14f10c7792d0eaa6e2b2c5923`；MIT）。该 issue 要求在终态消息边界保留 HTTP 状态、provider error code 和可选 retryability，特别指出临时限流、额度耗尽与 HTTP 200 流内错误不应只剩下自由文本。本项目采用现有 `StreamEvent.error_info`，并独立扩展 terminal `session/error` 事件与持久错误记录；不复制 Pi 的诊断接口或重试逻辑。

同步检查 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`（GitHub license 字段为空）：当前开放 Issue 与 PR 聚焦招聘业务、平台权限和认证，没有可移植的通用 provider 错误契约；本项目当前无开放 Issue，PR #109 是会话模型线路选择。本轮没有改动招聘业务操作或认证边界。

终态 `errorInfo` 只包含 provider、来源、有效 HTTP 状态、受限字符集且最长 128 字符的 provider code，以及可选请求级 `retryable`；流内 OpenAI 错误明确保留 HTTP 200。额度耗尽 code 明确为不可重试，已知暂时限流/服务端错误才标记可重试，含义不明的 429 不作猜测；`outputObserved` 独立记录是否已出现输出。自动 OpenAI 重试次数和 Anthropic 重试行为保持不变，`retryable` 不授权重放整回合；仅原有精确 `CONTEXT_OVERFLOW` 分类可触发上下文恢复。响应正文、请求、响应头和凭据不进入错误诊断。

## 第四十六轮：压缩 checkpoint 来源元数据增长

本项目主线 `6c2ceffc151b31f92ad525b40b9b6af41d8c548d` 的 `context_checkpoint` 原先把从会话开头到 `throughTurnId` 的所有 `sourceItemIds` 写入每条新 checkpoint。连续摘要时这些 ID 前缀重复留存在 append-only JSONL 中；`compaction_material()` 也将前一 checkpoint 原样放入下一次摘要模型输入，因此这部分 ID 会重复进入后续摘要请求。两者都会随会话增长；持久化副本还增加 JSONL 读取、来源校验和原子复制成本。

参考 Pi 开放 [Issue #11297](https://github.com/earendil-works/pi/issues/11297)（截至 2026-10-28 为 OPEN；Pi main `bb65e3e49710fbd14f10c7792d0eaa6e2b2c5923`；MIT）。该 issue 报告压缩摘要中的 `<read-files>` / `<modified-files>` 路径列表跨压缩无界累积，并进入后续模型上下文。本项目的问题相邻但机制与影响不同，因此只吸收“压缩元数据增长应保持有界”的目标，不移植其文件列表处理。

同步检查 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`（GitHub license 字段为 null）：当前开放 Issue #35、#34 等涉及招聘平台认证、沟通、分页和业务能力，开放 PR #37、#29 等也属于招聘业务；没有可移植到通用会话 checkpoint 的变更。本仓库当前无开放 Issue，草稿 PR #109 是会话模型线路选择，与本轮存储优化无直接关系。

新 checkpoint 只写 `sourceItemCount`；加载时按完整回合投影重建来源 ID，并同时校验覆盖条目数、完整前缀顺序及 checkpoint 写入前的原始来源。旧 `sourceItemIds` checkpoint 继续按原列表校验。传给摘要模型的 `previousCheckpoint` 将旧、新格式统一投影为 `sourceItemCount` 与摘要等必要元数据，避免发送来源 ID 列表；`context/read` 与 `context/compact/plan` 仍返回完整 `sourceItemIds`，保持接口兼容。这将新 checkpoint 的重复来源清单持久化成本从覆盖前缀大小降为常数，也限制了后续摘要请求中的元数据增长，但不会减少原始会话记录、整份 JSONL 读取或 checkpoint 原子复制成本。

## 第四十五轮：独立摘要模型与推理档位

在本项目主线 `b39b680ab3af51d22bd292729777853270b35ca7` 上，`CompactionPolicy` 原先只有启用状态、触发比例和保留 token 数；手动摘要通过会话 `_model_config()` 选择模型，自动及溢出摘要则复制业务回合配置。用户无法将摘要的成本、推理档位或上下文窗口与日常业务请求分开。

参考 Pi 开放 Issue [#7553](https://github.com/earendil-works/pi/issues/7553) 和开放 PR [#11255](https://github.com/earendil-works/pi/pull/11255)（head `8351961f89bad9e442c5c5cd2a5bd7a51118b840`；截至 2026-10-28 为 OPEN；Pi 当前 main `bb65e3e49710fbd14f10c7792d0eaa6e2b2c5923`；许可证 MIT）。PR 为 compaction 配置独立 provider/model/thinking level，并在摘要路径校验显式模型。这里只吸收其配置边界与显式解析原则，未复制源码或引入依赖；Pi 的 branch summary 在本项目没有对应路径。

同步检查 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70` 及当前开放 Issue/PR（GitHub license 字段为空）。其招聘分页、消息写入和 Cookie/Keychain 认证事项与通用摘要执行配置无直接关系，不移植业务代码或认证逻辑。

`BOSS_HARNESS_COMPACTION` 可为手动、阈值/预算自动和溢出恢复摘要设置 provider、model、effort；省略时延续原会话配置。显式 effort 只有在本机 `ModelCatalog` 为精确 provider/model 声明支持时才接受。摘要仍由独立 `provider_factory` 实例执行，使用摘要模型自己的容量与输入预算，不带招聘工具；摘要生成后继续用业务模型校验完整下一次请求预算，验证通过才写 checkpoint。任务状态与 checkpoint 持久化实际摘要 provider/model/effort，便于重启后审计。

本地验收覆盖配置解析与拒绝无效档位/线路、手动与自动摘要请求采用独立模型设置、保存中的业务 reasoning 不被跨 provider 手动摘要覆盖模型误判、业务会话 reasoning 未被修改、摘要模型预算准入，以及 checkpoint 按业务模型复核；全部使用合成 provider 和临时会话，不调用真实模型或招聘平台。测试材料仅保留本地。

## 第四十三轮：追加式会话上下文编辑

本项目 [Issue #107](https://github.com/can4hou6joeng4/boss-cli/issues/107) 对照主线 `4cd485e7a833a004d4be3eb88b49da0fe96211f`，确认上下文仅由普通逻辑条目与一个经来源核验的摘要 checkpoint 投影而成，不能针对单条历史文本调整后续模型可见内容。影响用户纠正过期事实、排除误输入，同时又要求保留原始审计记录的场景。

参考 Pi 固定 revision `d3398f826ae2654b52a7988830d533a354754c13`（MIT）中的 `ContextEditEntry`、`appendContextEdit()` 与 `buildSessionProjection()`：编辑以追加式记录绑定目标条目，最新编辑决定 branch-local 上下文投影，原始消息保持不变。独立实现为 user/assistant 文本编辑；拒绝活动回合、工具条目及摘要已覆盖条目。编辑投影同时参与模型历史、预算、摘要来源校验和材料，fork 仅复制所选历史目标对应的编辑。未复制 Pi 源码或新增依赖。

`context/edit/read` 返回原文、当前模型可见文本、是否排除及来源摘要；`context/edit` 在会话空闲时通过来源摘要 compare-and-append 替换或排除。快照仅公开已编辑状态，不返回替换正文；renderer 权限表仅开放这两个显式方法。原文替换恢复同一消息的原始内容；摘要覆盖范围不允许通过编辑逆转。桌面显示保留原始消息，并明确提示后续模型上下文的替换/排除状态。

本地隔离探针覆盖替换、排除、过期来源拒绝、摘要材料、检查点覆盖、保留尾部、fork 继承、重开恢复、工具目标拒绝及大小限制；所有检查均使用临时 JSONL，无模型、网络或招聘平台调用。完整 Harness、Electron 类型检查/构建与真实 UI 交互验收尚待本轮合并前完成；本记录的来源是设计与实现跟踪，不把模拟结果描述为远程 CI。

同步检查 `jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`（GitHub license 字段为 null）：其开放招聘业务 Issue/PR 不提供通用会话投影编辑机制。本轮采用 Pi 的架构概念并独立建模，不迁移业务流程或平台权限。

## 第四十二轮：策略 hook 的协作式回合取消

在主线 `4461a392b1f496aa5456a58a24b977b18687bd61` 上，真实 `TurnRunner` 配合合成 provider 和临时 `SessionStore` 可复现：模型产出工具调用后进入 `before_tool_call`，回合取消只能等到 hook 完成或超时，hook 本身也不知道取消已到达。该缺口位于内核策略等待与回合中断之间，不涉及招聘平台操作。

参考 Pi 开放 [Issue #10928](https://github.com/earendil-works/pi/issues/10928)（OPEN；报告涉及 `agent_before_settle` 缺少 abort signal）。复核 Pi 当前 `main` `b3a29f1111114fac696e2cfcd65acdb382a6ed5e`（MIT）：`packages/agent/src/types.ts` 为 `beforeToolCall` 与 `afterToolCall` 提供 `AbortSignal`。本项目问题发生在工具前置策略 hook，机制相邻但并非同一缺陷；独立定义 Python 只读 signal 与取消等待，不复制 Pi 源码或新增依赖。

同步检查 `jackwener/boss-cli` 当前 `main` `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`（GitHub license 字段为 null）：开放 [Issue #35](https://github.com/jackwener/boss-cli/issues/35)、[#34](https://github.com/jackwener/boss-cli/issues/34) 和 [PR #37](https://github.com/jackwener/boss-cli/pull/37)、[#29](https://github.com/jackwener/boss-cli/pull/29) 仍属于招聘业务、认证与分页，不提供可移植的通用 hook 取消契约；本轮不采用其代码。

`TurnRunner` 将当前回合取消事件交给 `LifecycleHooks`。宿主策略可选择在 `before_tool_call(context, *, signal)` 使用 `signal.aborted` 或 `signal.wait(timeout)` 协作收尾；原有 `before_tool_call(context)` 保持兼容。取消会在最多 25ms 的轮询间隔内唤醒内核等待，忽略迟到 allow/deny，并将当前工具以 `CANCELLED / not_executed` 持久化，不触发审批或 handler。若 callback 不合作，其线程仍运行到实际返回并继续占用在途名额，关闭期限、并发上限与现有迟到回调隔离保持不变；signal 不能强制终止 Python 线程。

本地 Python 3.12 离线运行器探针覆盖协作 hook 和旧式非协作一参数 hook：两种都令回合及时以 `interrupted` 结束，当前工具结果为 `not_executed`，handler 与审批均为 0；非协作 hook 的名额保持占用直至退出，迟到拒绝不改变已持久状态。探针使用合成 provider、工具、临时会话，无真实模型、网络或招聘平台调用；测试代码仅留本地 ignored 目录，没有提交测试文件。

## 第四十一轮：Anthropic SDK 流取消的句柄登记窗口

本项目主线 `587a9eca32b26547efee92de61a694fc2c386a0b` 的 `AnthropicProvider.stream()` 在 SDK context manager 返回 stream 后才登记 `_active_stream`。本地离线 `MockTransport` 将响应 handler 阻塞在句柄返回前，另一线程调用 `request_abort()` 时活动句柄为空；放行响应后，原实现仍进入 body 读取并阻塞。独立复现证明了本项目自己的竞态，不把外部 Issue 描述当作本地证据。

参考 Pi 开放 [Issue #11211](https://github.com/earendil-works/pi/issues/11211)（OPEN；报告基于 `82432219a`，2026-10-21），其讨论 Anthropic SSE body 提前结束时未取消及 abort 后结果不 settle。复核 Pi 当前 `main` `b3a29f1111114fac696e2cfcd65acdb382a6ed5e`，GitHub license 为 MIT。问题机制相邻但实现不同：本项目使用 Python 官方 SDK 的 stream context manager，独立在句柄登记后重查取消标志并于读取 body 前终止；未复制 Pi 源码或新增依赖。

同步检查 `jackwener/boss-cli` 当前 `main` `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70`（GitHub license 字段为 null）：开放 [Issue #35](https://github.com/jackwener/boss-cli/issues/35)（Cookie/Keychain 权限）、[Issue #34](https://github.com/jackwener/boss-cli/issues/34)（招聘沟通）及 [PR #37](https://github.com/jackwener/boss-cli/pull/37)、[PR #29](https://github.com/jackwener/boss-cli/pull/29)（分页与真实沟通写操作）均属于招聘业务和平台权限边界，与 provider 流取消无可移植契约；本轮不采用其代码。

生产修复在 stream 句柄登记后立即复查取消标志；若取消已到达，则返回 `aborted` 并退出 SDK context manager，让 response body 关闭，外层 `finally` 清空活动句柄。Anthropic SDK `1.15.0`（项目最低声明版本）与 `2.3.0`、`httpx2 2.16.0` 的离线竞态探针均验证：结果为 `start` + `aborted`，body 已关闭、句柄已清空，且没有开始读取 body。`npm run typecheck`、Python wheel/sdist build 与 `git diff --check` 通过。测试探针仅在本地运行，未加入仓库；未调用真实模型或招聘平台。

取消若发生在 SDK `stream_ctx.__enter__()` 仍等待响应 headers 时，调用方尚无 response handle 可关闭；该阶段仍受现有 30 秒 SDK timeout 限制。响应句柄返回后，新增检查会在 body 读取前结束已取消请求。

## 第四十轮：降低大型会话 JSONL 读取峰值内存

本项目 [Issue #103](https://github.com/can4hou6joeng4/boss-cli/issues/103) 在 `041b03b59b305b6ef009bc6d38196371563c2fca` 上，以 parser-only tracemalloc 测量复现单次 JSONL 全量读取的额外峰值：10,481,439 字节输入峰值 31,844,977 字节；52,426,470 字节输入峰值 159,275,712 字节。候选方案在锁内捕获原始 bytes snapshot，锁外通过标准 `TextIOWrapper` 逐行解码；两种尺寸峰值分别为 21,378,034 与 106,761,186 字节，约降低 33%。LF/CRLF/CR、坏 JSON、坏 UTF-8、尾部无换行、空行与类型筛选的记录投影相同；快照完成后追加及原子替换均不改变该次结果。

刷新 Pi 当前 `main` `b3a29f1111114fac696e2cfcd65acdb382a6ed5e`（MIT）：开放 Issue #11360 的子进程超限由本项目 #57 覆盖；#11433 的 pipe reader/waiter 创建失败属于进程管道生命周期，已在本项目完成线程启动故障注入清理验证，不是 JSONL parser 同类问题。没有找到直接对应的 Pi JSONL parser 内存 Issue/PR；本轮依据本地分配测量独立优化，不复制上游代码。`jackwener/boss-cli` main `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70` 的 GitHub license 字段为 null，开放事项仍属招聘业务认证与平台操作，本轮不采用其代码。

此优化保持 append-only JSONL、session header/entry 筛选、JSON 错行跳过和同一文件快照边界；不改变 JSON-RPC、checkpoint sourceDigest 或工具/队列语义。生产 `ApplicationService` 在 10,068,706 字节历史上的 `context/read` 峰值为 20,584,879 字节、恢复峰值为 20,604,349 字节，日志哈希、505 个条目 ID 和 checkpoint 前后相同。全量 Harness 339 项通过、4 项跳过；compileall、typecheck、desktop build、npm audit（0 漏洞）、Python wheel/sdist build 与 `git diff --check` 通过。探针和测试材料仅留在 ignored 本地目录。

## 第三十九轮：生命周期 hook 在途回调上限

本项目 [Issue #99](https://github.com/can4hou6joeng4/boss-cli/issues/99) 在当前主线 `a0cb3efd22cb50158c13a5221bf017abec45033c` 上，由真实 `ApplicationService.on_thread_start -> EventHub.emit -> LifecycleHooks` 离线探针复现：12 个 10ms 超时观察回调仍同时在途，峰值和 `_active` 均为 12，而等待队列已空。释放本地同步闸门并关闭应用后 callback 归零；socket、DNS、子进程尝试均为 0。`MAX_PENDING_EVENTS=256` 只限制尚未启动的事件队列，不限制超时后仍运行的 callback 线程。

对照 Pi 固定当前 `main` `b3a29f1111114fac696e2cfcd65acdb382a6ed5e`（MIT）：`packages/coding-agent/src/core/extensions/runner.ts` 的 `emitBoundary()` / `emit()` 对单次事件按序 await handler，没有 callback 线程池、超时或在途上限；单个挂起 handler 会阻塞该事件路径，因此不是此处“超时返回后继续启动线程”的同一机制。[Pi Issue #10928](https://github.com/earendil-works/pi/issues/10928)（OPEN）讨论 post-run hook 的取消 signal 与 abort/dispose 所有权，是相邻生命周期问题而非容量修复。`jackwener/boss-cli` 当前 `main` `9d38ed1a3a5f6c5c2f37b865b0748454234e7c70` 的认证、Cookie、沟通和分页 Issue/PR 属于业务接入边界，其 GitHub license 字段为空；没有可适用的通用 callback 并发修复。本轮独立实现，未复制外部代码或新增依赖。

生产修复为每个 `LifecycleHooks` 实例设置 16 个全局在途 callback worker 上限，并在同一条件锁内完成准入和 `Thread.start()`。超时不释放名额，callback 的 `finally` 才归还；线程启动失败会回滚。策略容量满时使用稳定 `HOOK_BUSY` 拒绝，审批和工具 handler 不运行；观察容量满时仅跳过观察回调并聚合诊断，不反压持久事件。所有测试与探针继续留在 ignored 本地目录。

## 第三十八轮：工具结果持久化对账与会话准入保护

[Issue #97](https://github.com/can4hou6joeng4/boss-cli/issues/97) 在当前主线 `ca53655251d43e36c83471bc0aeef182bbc9c4fe` 上由真实 `ApplicationService` 离线注入复现：已批准 handler 成功返回后，completed revision 追加前一次 `OSError` 会留下 `running / executing` 项；回合报错并暂停队列，但仍接受新的手动模型回合，模型 history 跳过该已派发工具，fork 被阻止。重启时现有恢复才补为 `outcome_unknown`。正常控制组与“结果行已追加后上层抛错”保持原结果，handler 均只执行一次。

参考 Pi 固定 main `842c73170a3658d4e3b39fcc84690211ed503e09`（MIT）的工具执行、结果消息与观察通知职责边界；Pi 没有被当作本地磁盘故障修复的证明。本问题由本地真实应用探针成立；`jackwener/boss-cli` 的认证、招聘业务和平台风控 Issue/PR 不属于此通用会话持久化缺口。本轮不复制上游实现、不新增依赖。

实现复用单个稳定 revision，在 `SessionStore` writer 锁内按完整 JSONL 行对账并 fsync；已落下的结果不重复追加，确认缺失时最多同结果重试一次。工具执行代码不会重跑 handler 或审批；成功恢复结果后阻止同批剩余工具并暂停回合/队列。若结果缺失且重试失败，追加 `outcome_unknown`；该记录也无法确认时，在释放活动回合前建立会话级内存 fence，手动回合、队列入列与 follow-up 领取均 fail closed。启动恢复依赖现有 JSONL `running` 条目转为未知结果。通知异常不改变已持久化工具事实。

验收使用真实 ApplicationService、合成 provider/bridge/handler、临时状态和一次性 JSONL 故障，覆盖正常、派发前失败、结果写前失败并恢复、结果行已写后抛错、成功结果通知失败、`outcome_unknown` 持久化后的通知失败、结果及 unknown 均无法落盘并重启恢复共七种路径。handler 写操作计数始终为 1；第二工具不派发、队列暂停；最坏路径在当前进程拒绝新手动/队列请求，但仍允许原请求去重且其他会话可运行。socket、DNS、子进程尝试均为 0。测试脚本和报告仅保留 ignored 本地目录；真实模型与招聘平台验收未执行。

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

## 永久删除会话

Pi Durable 开放 [Issue #11026](https://github.com/earendil-works/pi/issues/11026) 请求由存储后端永久删除 conversation，并拒绝活动 run；评论还明确提出 SQLite、JSONL、Memory 的一致性、fork 独立性以及不撤销外部工具副作用。核对的 Pi main 为 `97553d10f2cb8be11a4d0fda331fe06967139643`，许可证 MIT。该 Issue 是功能需求而非经过验证的删除实现；本项目未复制 Pi 代码或增加依赖。

本项目新增 host JSON-RPC `thread/delete({threadId})`。删除前持有线程准入、follow-up、runtime 与事件锁；活动回合、摘要、队列派发、worker 收尾和回执通知仍持有状态时返回 `THREAD_BUSY`。删除意图使用 owner-only sidecar，先隐藏目标线程，再幂等清除 session 与 checkpoint 临时文件、共享 `events.jsonl` 对应记录、SQLite turns/events/thread 投影、当前索引 WAL、修复备份中的 SQLite 副本以及没有存活 session/fork 引用的内容哈希附件。以稳定 event ID 追加不含正文的 `thread/deleted` 全局事件，维持游标前进；清理中断后启动恢复会继续处理，读取、列表和 event replay 都不会暴露 pending 线程。

fork 是完整历史前缀的独立副本，父会话删除不级联删除 fork；被 fork 或其他会话引用的附件继续保留。仅保证清除应用管理的当前逻辑副本与索引修复副本，不覆盖 APFS/SSD 旧文件块、Time Machine/文件系统快照、模型或宿主此前取得的副本，也不回滚招聘 CLI 已执行的外部操作。桌面 renderer 暂未开放此 RPC，直到有明确的用户确认界面与桌面验收。

## 第七十六轮：跨回合、队列与摘要的只读任务归属

Pi Durable 开放 [Issue #11332](https://github.com/earendil-works/pi/issues/11332) 继续讨论持久任务与输入准入、取消和 idle 的边界。采用显式区分任务身份、持久父子关系和进程执行 owner 的原则；不移植 Durable 源码、未合入的 `blocksInput` 方案，也不新增任务账本、调度器、自动重试或副作用恢复策略。

本项目 [Issue #187](https://github.com/can4hou6joeng4/boss-cli/issues/187) 增加只读 `task/read({threadId, kind, id})`，把已存在的 turn checkpoint、queue JSONL 与 compaction job/checkpoint 投影为单任务视图。每个读取按目标身份筛选有限数量的 turn、queue、revision alias 与关系，并通过既有 JSON-RPC 响应预算拒绝超限结果；不输出输入、模型正文或凭据。Follow-up 的 `turn.queueId` 与同回合 user message `queueId` 必须相互印证；queue 的 `turnId` 回执不能单独证明因果。Steering 只指向已有 turn；自动摘要仅通过自己的 `turnId` 归属，手动摘要独立于 turn，`throughTurnId` 仅为来源边界。重复身份、孤儿与互相矛盾的记录标记 conflict/unresolved，不推断 owner。

任务状态与运行时责任分别呈现。重启后 interrupted turn 保持人工复核；恢复读取不启动 provider、工具或 abort，不转换队列状态，也不写 session/event JSONL。摘要成功状态可从 durable checkpoint 读取，最近 64 个终态摘要 job 的缓存窗口仍用于没有 checkpoint 的失败/取消记录；较旧失败任务不保证可按 task ID 查询。Renderer 仅通过精确的只读 IPC allowlist 调用该方法，参数严格限定为 `threadId`、`kind`、`id`。

验证使用本地忽略目录内的合成 session 与探针，覆盖 follow-up、dedup receipt、steering、自动/手动摘要、冲突身份、恢复状态及读取零副作用；探针不进入 Git 或 Python 产物。桌面 GUI 验收仍待执行，不把协议、类型检查或源码构建当作 Electron UI 验收。
## 模型流不可重置总时限

参考 Pi 开放 [Issue #9474](https://github.com/earendil-works/pi/issues/9474)（2026-10-30 复核仍 OPEN，MIT main `f09d01b85e0384647fcab6779d35ab9dabe04be3`）：空闲读取超时会被周期 SSE 事件重置，无法限制一个始终不发终态的模型请求。Pi 讨论的是 Codex Responses transport；本项目使用同步 Python SDK，不能直接移植其实现。本轮独立实现、不复制 Pi 源码或增加依赖。

本项目通过官方异步 SDK 执行每次 transport attempt，并以有界事件队列桥接回既有同步 Provider 接口。事件循环独立计时，在期限到达时立即通知同步消费者并仅取消 producer 一次；超时或用户取消会清空尚未消费的 SDK 事件，让终态排在队首。默认 600 秒，可由 `BOSS_HARNESS_MODEL_REQUEST_TIMEOUT_SECONDS` 设置为 1–3600 秒，既有 30 秒 SDK idle timeout 保持。期限覆盖等待响应头及读取流，事件队列最多缓冲 64 项、总估算 4 MiB、单事件 2 MiB；队列满时对 SDK producer 施加背压，超限事件不进入队列并按本地输出预算失败。估算限制作用于 SDK 已解码事件，不能阻止 SDK 在交付前暂时构造单个超大 SSE 帧。计时依赖事件循环调度，同步 CPU 工作阻塞 loop 时信号可能延迟。关闭时最多等待 SDK 收尾 1 秒，不重复中断响应清理；每进程最多 8 个 pump 持有后台传输额度，只有 worker 和 SDK 清理结束后才释放。若底层协程拒绝取消，调用方仍按时收到终态，但该 pump 会继续占用一个额度；未确认清理的 OpenAI attempt 不会自动重试，达到容量上限的新请求会在发出前失败，不创建额外线程或传输。

超时映射为 `transport_error`；SDK 清理已完成时 `retryable=true`，否则为 `false` 并停止自动重试，不会使用 `aborted` 或 `CONTEXT_OVERFLOW`。显式用户取消仍映射 `aborted`。OpenAI 沿用“尚无可见内容时才重试”的既有 attempt 策略，每个 attempt 单独计时；Anthropic 不新增重试。Anthropic 的凭据类型与端点在 provider 创建时按 SDK 规则解析并冻结，异步请求不从后续环境变更重新选择凭据或端点。没有引入跨 provider、OpenAI 重试、fallback 或 Agent 层的共享 recovery budget，故不能把该单次时限理解为整轮任务总时限。

本地合成服务验证覆盖心跳注释持续到达、响应头延迟、两家 provider 正常终态与显式取消；心跳及响应头两种超时均在配置期限附近返回 retryable transport error，正常响应产出 `done`，用户取消产出 `aborted`。官方 SDK 组合 Anthropic 1.15.0 / OpenAI 3.35.1 和 Anthropic 2.3.0 / OpenAI 3.41.0 均通过。pump 探针另覆盖吞掉取消及无限期取消清理、8 个残留槽位与释放、SDK Pydantic 额外字段和大整数预算；凭据探针覆盖静态 key/token、请求头快照、动态凭据借用及最终关闭，重试探针确认清理未完成时不创建第二个 OpenAI 请求。测试和合成 server 代码仅在本地保留，不提交测试材料；未使用有效凭据、真实会话或招聘平台。Pi Issue #9474 的跨层恢复预算以及实时供应商验收仍未覆盖。

## 模型失败交付前的晚取消优先级

[Issue #211](https://github.com/can4hou6joeng4/boss-cli/issues/211) 面向招聘研究中断后的 provider 终态归属。在 [PR #210](https://github.com/can4hou6joeng4/boss-cli/pull/210) 固定 head `e4d1c047691f701947ac952dac745d572c88c556` 上，真实 provider 与 pump 的离线探针先消费部分文本，再等待后台 producer 已结束并排入 EOF 或异常，随后调用 `request_abort()`。pump 已完成，取消不会替换尚未消费的终态；provider 取消标志虽为真，OpenAI 仍返回缺少终态响应错误，Anthropic 返回普通流异常。此时序中 EOF 先于取消发生，证明的是失败交付前的取消优先级边界，不是取消导致 EOF 或普通桌面取消必然污染日志；回合消费者另有取事件前后的取消检查。

2026-10-30 复核 Pi [Issue #10856](https://github.com/earendil-works/pi/issues/10856) 与 [Issue #11211](https://github.com/earendil-works/pi/issues/11211) 仍 OPEN。固定 MIT main `f09d01b85e0384647fcab6779d35ab9dabe04be3` 的 `packages/ai/src/api/openai-responses-shared.ts` 在未见终态时抛 EOF，`openai-responses.ts` 的 catch 按 signal 设置停止原因但保留格式化异常；`anthropic-messages.ts` 的 SSE reader 在读取前检查 signal，并在 finally 释放 reader lock。前者提供取消诊断一致性的需求依据，后者讨论自定义 body 取消与清理；本项目 #210 已以 pump 标记覆盖活动传输取消。本轮不声称这两个 Pi 问题原样存在或已被上游修复，不复制源码或新增依赖。

本项目在两种内置 provider 的失败事件交付边界复查 `_abort_requested`。已经观察到取消时统一发送 `error(reason=aborted, error=请求已取消)`，不保留 SDK/EOF 错误及结构化诊断；OpenAI 同时清除可重试标志与退避信息。内层生成器由交付层 finally 关闭，保留 SDK/pump 的清理和额度责任；未取消失败与正常完成消息不改写。pump 的完成、取消和自动清理语义保持不变，JSON-RPC、持久格式与工具执行边界不变。

本地探针直接加载生产 provider/pump，只在 SDK 流边界使用内存替身；覆盖两家 provider 的 producer 已完成 EOF、排队 SDK/通用异常、活动及重复取消、未取消 EOF/异常、正常完成和完成交付后的取消，并覆盖 Anthropic thinking 签名及 redacted 数据。修复后连续三轮 90/90 通过，取消错误不含 `errorInfo` 或私密 opaque 数据，正常完成仍保留合法私密续接数据；每例仅一次传输创建，流与客户端清理结束，每进程 8 个额度全部归还，网络/DNS 尝试为零。探针和报告仅在本地 `/tmp` 保留，不进入提交；未验收真实 SDK 网络传输、真实模型、招聘平台或桌面 UI。

## 显式续接中断回合

本项目 [Issue #239](https://github.com/can4hou6joeng4/boss-cli/issues/239) 延续已关闭的 [Issue #216](https://github.com/can4hou6joeng4/boss-cli/issues/216)：重启恢复继续只把未完成阶段标记为人工复核；不会自动启动 provider、工具或招聘 CLI。借鉴 Pi Durable [Issue #11557](https://github.com/earendil-works/pi/issues/11557) 对 handoff 后延续任务身份的讨论，本实现独立建立 JSON-RPC 预检与显式续接流程，不复制 Pi 源码、不保存凭据或供应商远端会话状态，也不承诺供应商 exactly-once。

续接只接受最新、已中断且边界可验证的来源回合。请求边界、历史前缀摘要、模型/provider、系统提示、工具 schema、技能、附件来源、推理参数与工具策略必须仍匹配。完整工具批次会以持久开始/完成清单及调用 ID、模型响应条目和 request fingerprint 交叉核对；续接把原有工具结果重建为模型上下文，不再次调用 handler、审批、队列或招聘 CLI。未知副作用、未决审批、未完成批次、损坏/变化的来源、过期来源或冲突续接编号均拒绝，返回稳定错误码供 UI 显示。

每个来源仅能创建一个带 `continuedFromTurnId` 和 `continuationId` 的子回合；同一编号的并发重复请求返回同一个回合，其他续接会因已有子回合被拒绝。新回合沿用来源累计的模型请求上限，普通新回合重新从请求编号零开始。续接仍经过现有会话 owner、取消、队列暂停、审批、收尾和资源限制。Electron 在握手 capability 为真且只读预检通过后展示显式操作；内核拒绝时展示原因并重新预检，传输结果未知时不会自动重发。提示用户模型端可能已完成无持久终态的请求，因此续接可能重复调用并增加费用。

本轮使用真实 `ApplicationService`、临时 `SessionStore`、合成 provider/bridge 与虚构 handler 验证完整工具批次后中断、显式续接、相同续接编号的并发幂等，以及 handler 调用次数不增加；额外回归探针确认续接后的普通新回合从 request index 0 开始。Python 编译、TypeScript 检查、Electron 构建、wheel/sdist、npm audit 和 `git diff --check` 均通过。真实模型、招聘 CLI、招聘平台和默认 Electron profile 均未调用；桌面交互仍需单独人工验收。

## 模型自动重试的可观测通知

参考 Pi 固定 commit `a14cdf90f0a76532f3e20bc3c01872837cef24ba` 的 `packages/coding-agent/src/core/agent-session.ts`：`_prepareRetry` 在退避前发出 `auto_retry_start`（attempt、maxAttempts、delayMs、errorMessage），重试成功、最终失败或在等待中被取消时发出 `auto_retry_end`；交互模式据此显示重试提示。本项目 #242 后两条内置 provider 已共用首个输出前的自动重试，但重试过程只写 stderr，桌面与其他客户端只能看到长时间无输出。本轮独立实现、不复制 Pi 源码或新增依赖。

同时复核其他候选：工具调用前后钩子已由 `LifecycleHooks.before_tool_call` / `after_tool_call` 覆盖，且不能绕过逐次审批；会话分支与上下文变换涉及持久格式和前端交互，风险与改动面更大，留待后续。

Pi 在 Agent 层重放整轮请求；本项目重试仍留在 provider 内，只发生在尚未产出内容事件前，并受回合共享恢复额度约束。provider 在每次退避前产出不含内容的 `retry_start` 流事件；外层 `with_retry_outcome` 在首个非错误事件前补 `retry_end(success)`，在错误或取消终态前补失败的 `retry_end`，`reason` 取取消归一化之后的值。未发生重试的流不增加任何事件。`TurnRunner` 将二者映射为 `model/retryStarted` / `model/retryEnded` 通知，携带 threadId、turnId、尝试序号与脱敏错误说明，不写入会话条目，也不计入输出观测；摘要任务与连接检查的消费者忽略这两类事件。协议保持 `0.2.0`：新增的是可选通知，旧客户端按未知通知忽略，或经 `optOutNotificationMethods` 屏蔽；Electron 渲染层暂不展示。

本地临时探针（`/tmp`，不入库）在 Anthropic provider 的单次尝试边界注入内存替身，覆盖无重试、重试后成功、重试耗尽、重试后遇不可重试错误、退避期间取消与中途关闭生成器；并用真实 `TurnRunner` 与临时 `SessionStore` 确认成功与失败两种回合的通知顺序及 `session/error` 不变。OpenAI 线路共用同一辅助函数，仅经编译与类型检查覆盖。未调用真实模型、招聘 CLI、招聘平台或桌面 UI。
