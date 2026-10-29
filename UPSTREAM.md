# 上游吸收记录

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

删除失败分支只有在确认持久删除标记存在时，才同步移除目标 waiter ID 和 deque 项；与成功删除使用相同的 follow-up admission/runtime 锁，保留其他会话的相对顺序。删除意图落盘前失败不移除有效 waiter，RPC 的删除未完成错误、重启继续清理和不可自动重放规则保持不变；不在调度层宽泛捕获损坏或 I/O 异常。修复后同一探针得到 C delivered、D accepted、等待队列清空，合成 provider 在 D 之前仅执行 A/C 各一次；网络和外部进程尝试均为零，探针仅保留本地。

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
