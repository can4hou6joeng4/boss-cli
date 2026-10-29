# 变更记录

## 未发布

### 修复

- [Issue #173](https://github.com/can4hou6joeng4/boss-cli/issues/173)：回合与队列权威结算后，终态事件分别尽力发布；某类事件持久化或发送异常不再跳过另一事件，也不再丢失已排入后续回合的交接责任。事件不会重放，执行与队列结算异常仍按原路径处理。
- [Issue #163](https://github.com/can4hou6joeng4/boss-cli/issues/163)：将摘要 worker 句柄与启动决策纳入 shutdown 所有权；关闭期间取消的摘要不会晚启动，正常启动仍由共享期限内的关闭流程等待收尾。
- [Issue #165](https://github.com/can4hou6joeng4/boss-cli/issues/165)：关闭时的 `kernel/shutdown` 标记与 hook 失败诊断按共享期限等待 EventHub 锁；期限内无法取得时跳过该可选事件，不让诊断持久化延长关闭。

### 兼容与验证

- Issue #173 离线真实 `ApplicationService` 故障注入覆盖容量 1/2 下 `turn/completed` / `thread/updated` 的写入前失败与持久化后发送失败、同会话 FIFO/重复唤醒、跨会话 FIFO、终态与 queue settlement 持久化失败、取消、关闭、慢 bridge 和慢 abort。通知各最多尝试一次，已落盘事件不重写；正常后续回合只派发一次，关闭仍冻结派发并保留状态目录 owner。网络与进程尝试为零，探针仅保留本地。
- Issue #163 离线并发屏障探针覆盖 shutdown 与摘要开始事件并发、取消后不启动 worker，以及无竞争时正常启动并由 close 收尾。Python 3.14 编译、TypeScript 检查、Electron 源码构建、Python wheel/sdist 构建、产物内容扫描和 `git diff --check` 均通过；探针使用合成对象，未调用真实模型、招聘 CLI 或招聘平台，测试代码未提交。
- Issue #165 临时故障探针在 Started 事件持有 EventHub 锁超过关闭期限时验证 `close()` 有界返回、hook 收尾和取消后的摘要 worker 不启动；空闲锁下 shutdown marker 仍持久化。Python 编译与 `git diff --check` 通过；探针未调用真实模型、招聘 CLI 或招聘平台，测试代码未提交。

## 0.2.0-rc.14 - 2026-10-29

第十四次私有源码与 Python 内核候选发布，累计纳入 rc.13 后合入的十四项功能与修复，并补足持久摘要任务的崩溃恢复状态。

### 新功能

- 参考 Pi Durable [Issue #11026](https://github.com/earendil-works/pi/issues/11026)：新增宿主 JSON-RPC `thread/delete`，可恢复地清理会话 JSONL、共享事件、SQLite 投影、索引修复备份及无引用附件；活动或收尾中的会话拒绝删除，父会话分支保持独立。
- [Issue #152](https://github.com/can4hou6joeng4/boss-cli/issues/152)：`ApplicationService(prompt_preamble=...)` 只覆盖默认招聘提示的身份段，保留工具说明、招聘规则、技能与只读后缀；默认工具组合和平台检查/登录 host 能力继续启用。自定义 `ToolBundle` 不猜测提示分段，不能同时传入该参数。
- [Issue #138](https://github.com/can4hou6joeng4/boss-cli/issues/138)：增加同步 `after_tool_call` 宿主回调，覆盖已持久化的成功、失败、拒绝、未执行和结果未知工具终态；结果内容默认隐藏，需嵌入端显式 opt-in，回调只读且不能改写执行事实。

### 修复

- [Issue #158](https://github.com/can4hou6joeng4/boss-cli/issues/158)：从持久事件日志恢复摘要任务状态；重启时将无 checkpoint 的未终结任务收敛为 `COMPACTION_INTERRUPTED`，若 `summaryJobId` 已写入 checkpoint 则恢复为 completed。只恢复可查询状态，不重放 provider 请求或 checkpoint。
- [Issue #156](https://github.com/can4hou6joeng4/boss-cli/issues/156)：并发会话容量暂满时保留 follow-up 队列项为 `queued`，在槽位释放后按等待顺序唤醒；直接新回合不会越过已等待队列，真实 provider/worker 启动失败仍按 `TURN_START_FAILED` 结算。
- [Issue #154](https://github.com/can4hou6joeng4/boss-cli/issues/154)：Anthropic 流到达 `message_stop` 后拒绝任何额外事件，避免终态之后追加的工具调用进入已完成响应并派发；正常终态前的响应处理不变。
- [Issue #150](https://github.com/can4hou6joeng4/boss-cli/issues/150)：摘要 provider 已返回终态并带有 token usage、但摘要内容因停止原因、空文本、工具调用或超长被拒绝时，仍保存不可用但可追溯的 `context_summary_usage`（含拒绝 code）；不写检查点、不重试，也不伪造没有终态或 usage 的记录。
- [Issue #148](https://github.com/can4hou6joeng4/boss-cli/issues/148)：登录保存 worker 未启动时返回 `LOGIN_SAVE_START_FAILED` 并回收忙状态；连接检查、登录和模型 abort 的启动包装层在实际启动后抛错时保留真实 worker 所有权。已观察取消的桥接任务不追加后续 CLI 调用，不自动重试登录保存。
- 参考 Pi 开放 [Issue #11433](https://github.com/earendil-works/pi/issues/11433)：JSON-RPC 审批请求已发出但超时计时线程无法启动时，立即失败关闭并退休本地 waiter；晚到响应不再匹配请求，工具按未批准结算。
- [Issue #146](https://github.com/can4hou6joeng4/boss-cli/issues/146)：保留 Anthropic extended thinking 的 opaque `signature` 与 `redacted_thinking` 数据，支持同回合工具续请求、历史重建、关闭后恢复和 fork；含工具响应的签名缺失或出现不受支持的 fallback block 时 fail closed，不执行工具，前缀 digest 不一致时丢弃失效 thinking block，不发送其签名。
- [Issue #144](https://github.com/can4hou6joeng4/boss-cli/issues/144)：仅将可信 HTTP 413 中不超过 512 字符且完整匹配 `Request body too large` / `payload too large` 的错误分类为上下文溢出；裸 413、其他消息及非 HTTP 错误来源不触发恢复。
- [Issue #142](https://github.com/can4hou6joeng4/boss-cli/issues/142)：将工具派发认领与回合中断放在同一运行时锁下，关闭工具状态持久化期间接受中断后仍调用 handler 的竞态；取消先于派发认领时记为 `CANCELLED / not_executed`。
- [Issue #140](https://github.com/can4hou6joeng4/boss-cli/issues/140)：识别 LiteLLM 有界 HTTP 400 上下文窗口拒绝，使符合条件的无输出请求进入现有单次摘要恢复；普通请求错误和非 HTTP 400 不触发恢复。
- [Issue #136](https://github.com/can4hou6joeng4/boss-cli/issues/136)：OpenAI Responses 流在响应句柄登记前收到取消时，登记后立即复查取消标志并退出 SDK context manager，避免已取消回合继续读取响应 body。

### 兼容与验证

- npm 工作区统一为 `0.2.0-rc.14`，Python 内核为等价 PEP 440 版本 `0.2.0rc14`；JSON-RPC 保持 `0.2.0`。
- 本地永久删除探针覆盖 session、intent 和 events 硬链接崩溃窗口恢复，以及意外外部硬链接拒绝；逐会话准入并发探针通过。PR #161 的 Source build、GitGuardian 与合并后 main Build 均通过。
- Issue #158 恢复探针 4 项通过，覆盖未提交 checkpoint、已提交 checkpoint、最近 64 个终态及已移除会话；重启不重放 provider、网络或子进程。现有本地内核回归 45 项通过。
- 类型检查、Electron 源码构建、Python wheel/sdist 构建及 `git diff --check` 通过；PR #159/#160/#161 的 GitGuardian 与 Source build，以及相关合入 main 后的 Build 均通过。离线探针保留在本地，未调用真实模型或招聘平台，也未进行桌面 UI 验收。
- OpenAI 与 Anthropic 共享相同的窄 HTTP 413 消息分类；既有无输出、未取消、自动压缩启用、预算足够及每回合只恢复一次的条件不变。Pi Issue #10879 的通用 413 检测不直接移植。
- Anthropic `message_stop` 后的后续事件令本次 provider stream 失败，不产生 `done`，因此不会调用工具或申请审批；JSON-RPC、OpenAI Responses 流与重试策略不变。
- Anthropic thinking continuation metadata 仅用于兼容请求重建，不进入 RPC、event、hook、摘要材料或工具结果投影；签名按官方 SDK 语义替换而非拼接。离线探针覆盖流式捕获、同回合/重开/fork 续接、缺签名工具阻断、前缀失配、上下文编辑、压缩尾部和崩溃后的连续工具前缀恢复。真实 Anthropic 服务、第三方网关跨模型兼容性及省略后缀 `tool_use` 的远端行为未验收。
- 本地 7 项离线探针覆盖两个 provider 的精确匹配、裸/其他/超长 HTTP 413、其他状态和错误来源、既有结构化 overflow，以及 TurnRunner 的单次恢复、输出、取消和请求上限门禁。Python 3.11 编译、类型检查、Electron 源码构建、wheel/sdist 构建及 `git diff --check` 通过；wheel/sdist 仅含 Harness 产品源码。探针只保留本地，未调用真实模型或招聘平台。
- OpenAI Responses 正常事件、回合终态和重试边界保持不变；Anthropic 流协议与现有 prompt 窗口分类保持不变。本轮未执行真实服务、招聘平台或桌面 UI 验收。

## 0.2.0-rc.13 - 2026-10-28

第十三次私有源码与 Python 内核候选发布，修复摘要期间的后续回合派发竞态，并完善会话存储目录、文件及 macOS ACL 的隐私保护。

### 修复

- [Issue #127](https://github.com/can4hou6joeng4/boss-cli/issues/127)（[PR #128](https://github.com/can4hou6joeng4/boss-cli/pull/128)）：摘要运行期间排入的后续回合保持 `queued`，不再因会话暂时占用被误判为 `TURN_START_FAILED`；摘要与已领取但尚未启动的后续回合互斥，成功后恢复派发，手动摘要失败或取消则暂停旧输入。
- [Issue #129](https://github.com/can4hou6joeng4/boss-cli/issues/129)（[PR #130](https://github.com/can4hou6joeng4/boss-cli/pull/130)）：新建会话目录限制为 owner-only `0700`，不随宽松 umask 暴露目录项。
- [Issue #131](https://github.com/can4hou6joeng4/boss-cli/issues/131)（[PR #132](https://github.com/can4hou6joeng4/boss-cli/pull/132)）：独立初始化 `SessionStore` 时，私有创建承载 SQLite 索引和事件日志的新父目录。
- [Issue #133](https://github.com/can4hou6joeng4/boss-cli/issues/133)（[PR #134](https://github.com/can4hou6joeng4/boss-cli/pull/134)）：新建会话持久化文件限制为 `0600`，清除 macOS 继承 ACL；启动时收紧当前用户拥有的旧文件，覆盖 SQLite/WAL/SHM、checkpoint、附件、repair 备份、manifest 和状态锁。已有目录 mode/ACL 保持不变，不安全的目录或不支持的权限平台在创建状态前拒绝初始化。

### 兼容与验证

- npm 工作区统一为 `0.2.0-rc.13`，Python 内核为等价 PEP 440 版本 `0.2.0rc13`；JSON-RPC 保持 `0.2.0`。状态文件权限后端支持 Linux 与 macOS；Windows 和其他平台需要独立的权限后端，当前拒绝创建状态。
- 本地 Python 3.14/APFS 探针覆盖新旧文件、继承 ACL、可搜索目录拒绝、checkpoint、活跃 WAL/SHM、repair 备份与 manifest、状态锁、符号链接/FIFO 和不支持平台；内容 hash 与已有目录权限保持不变。类型检查、桌面源码构建、Python 编译及 wheel/sdist 构建通过；功能 PR #128/#130/#132/#134 的 Source build 与 GitGuardian 检查通过。
- 探针只保留本地；未调用真实模型或招聘平台，未进行桌面 UI 验收，不含独立桌面安装包。

## 0.2.0-rc.12 - 2026-10-28

第十二次私有源码与 Python 内核候选发布，收敛 OpenAI Responses 流式输出与权威终态之间的差异，避免执行已撤回的工具调用。

### 修复

- 参考 Pi Issue [#11043](https://github.com/earendil-works/pi/issues/11043)，OpenAI Responses 适配器现在以 `response.completed` / `response.incomplete` 的权威 `output` 集合收敛最终内容；流中出现但终态撤回的工具调用不会再进入执行器，缺失或重复终态集合会返回错误并停止派发。

### 兼容与验证

- npm 组件统一为 `0.2.0-rc.12`，Python 内核为等价 PEP 440 版本 `0.2.0rc12`；JSON-RPC 保持 `0.2.0`。
- 本地离线终态一致性探针覆盖撤回工具、缺失 `output`、重复索引和有效工具保留四种路径，4/4 通过；Python 3.14 编译、类型检查、桌面源码构建、Harness wheel/sdist 构建和 PR #125 的 Source build、GitGuardian 检查通过。
- 未调用真实模型或招聘平台；候选交付私有源码与 Python wheel/sdist，不含独立桌面安装包。

## 0.2.0-rc.11 - 2026-10-28

第十一次私有源码与 Python 内核候选发布，提供宿主控制的回合请求上限，并补齐摘要与连接检查的模型请求策略。

### 新功能

- 参考 Pi Issue [#11043](https://github.com/earendil-works/pi/issues/11043)，宿主可通过 `max_model_requests` 或 `BOSS_HARNESS_MAX_MODEL_REQUESTS` 设置每回合 1–64 次业务请求硬上限，默认仍为 6；`turn/start.maxModelRequests` 只能为本回合收紧。工具循环、steering 和上下文恢复共享额度，耗尽后保留结果并暂停队列。

### 修复

- [Issue #121](https://github.com/can4hou6joeng4/boss-cli/issues/121)：`before_request` 统一覆盖业务请求、每个摘要分片和模型连接检查；摘要拒绝不调用对应 provider、不提交新 checkpoint、不继续业务请求。持久错误、终态通知与连接报告保留脱敏原因和请求身份，已关闭策略和迟到允许结果保持拒绝，取消优先。

### 兼容与验证

- npm 组件统一为 `0.2.0-rc.11`，Python 内核为等价 PEP 440 版本 `0.2.0rc11`；JSON-RPC 保持 `0.2.0`，新增协议字段可选。业务请求上限不统计 provider/SDK 内部传输重试，摘要仍有独立的 32 次生成上限。
- 本地请求上限、策略拒绝、持久化异常、取消及队列专项探针通过；Python 3.10/3.12 编译、Python 3.10 专项验证、类型检查、桌面源码构建与 wheel/sdist 构建通过。功能 PR #122/#123 的 Source build 与 GitGuardian 均成功；探针只保留本地。
- 未调用真实模型或招聘平台；候选交付私有源码与 Python wheel/sdist，不含独立桌面安装包。

## 0.2.0-rc.10 - 2026-10-28

第十次私有源码与 Python 内核候选发布，增加模型请求前策略拒绝闸门。

### 新功能

- 参考 Pi Issue [#11055](https://github.com/earendil-works/pi/issues/11055)，嵌入宿主可通过 `before_request` 在完整业务请求预算准备后拒绝模型请求。拒绝以 `error` 终止当前回合，保留脱敏原因，不调用该业务 provider、不执行工具、不申请审批，也不进入上下文恢复或自动重试。

### 验证与限制

- 本地离线探针覆盖首次请求、工具循环第二轮和上下文恢复重试；Python 3.14 编译、Harness wheel/sdist 构建、TypeScript 类型检查、桌面源码构建及产物内容检查通过。
- 未调用真实模型或招聘平台；本候选继续交付私有源码与 Python wheel/sdist，不含独立桌面安装包。
- rc.10 的 `before_request` 仅覆盖业务模型请求；摘要和模型连接检查的覆盖缺口在 rc.11 的 Issue #121 修复中补齐。

## 0.2.0-rc.9 - 2026-10-28

第九次私有源码与 Python 内核候选发布，补齐 OpenAI-compatible llama.cpp 解码阶段上下文耗尽的恢复分类。

### 修复

- 参考 Pi Issue [#10885](https://github.com/earendil-works/pi/issues/10885)，识别 OpenAI-compatible llama.cpp 在解码阶段返回的有界 `Context size has been exceeded.`，使上下文恢复路径能够处理 KV pool 耗尽，而不扩大对任意错误文本的匹配。

### 验证与限制

- 本地离线分类探针、Python 3.13 编译、Harness wheel/sdist 构建及包内容检查通过；PR #117 的 Source build、GitGuardian 与合并后 main Build 均通过。
- 未调用真实模型、llama.cpp 服务或招聘平台；本候选继续交付私有源码与 Python wheel/sdist，不含独立桌面安装包。

## 0.2.0-rc.8 - 2026-10-28

第八次私有源码与 Python 内核候选发布，修复模型将嵌套 object/array 参数额外编码为 JSON 字符串时的工具调用兼容性。

### 修复

- 参考 Pi PR [#9569](https://github.com/earendil-works/pi/pull/9569)，按显式工具 schema 解码被额外 JSON 编码的嵌套 object/array 参数；解码结果仍须通过同一 schema 校验，且 schema 允许字符串时保留原字符串。

### 验证与限制

- 本地离线 schema 边界探针、Python 3.11 编译、Harness wheel/sdist 构建及包内容检查通过；PR #115 的 Source build 与 GitGuardian 检查通过。
- 未调用真实模型或招聘平台；本候选继续交付私有源码与 Python wheel/sdist，不含独立桌面安装包。

## 0.2.0-rc.7 - 2026-10-28

第七次私有源码与 Python 内核候选发布，限制模型上下文中的大型工具结果，并持续完善会话摘要、provider 错误诊断与内核可靠性。

### 兼容变化

- npm 组件统一为 `0.2.0-rc.7`，Python 内核为等价 PEP 440 版本 `0.2.0rc7`；JSON-RPC 保持 `0.2.0`。
- `ToolDescriptor.maxModelResultBytes` 为可选字段；自定义工具默认使用 20 KiB 模型结果预算，可设置 8 KiB 至 1 MiB。

### 新功能

- 按工具配置模型可见结果的 UTF-8 字节预算，完整结果仍持久化；超限时向模型提供省略提示、摘要和 SHA-256，并新增只读 `read_session_tool_result` 内核工具分段读取，确保省略数据可按会话、条目和摘要校验后继续读取。
- 模型终态错误通过 `session/error.errorInfo` 和持久错误记录保留经过筛选的 provider、来源、HTTP 状态、provider code 与可选请求级 retryable；终态事件同时区分是否已观察到输出。原始响应和响应头不持久化，retryable 不授权重放整回合，自动重试策略保持不变。
- 新 checkpoint 以 `sourceItemCount` 持久化已覆盖前缀长度，避免每次摘要重复写入全部来源条目 ID；摘要请求也不再重复携带旧 checkpoint 的 ID 列表。旧 checkpoint 格式仍可读取，`context/read` 和 `context/compact/plan` 的 `sourceItemIds` 响应保持兼容。
- 为自动、手动及溢出恢复摘要增加独立 provider、model、effort 配置；未配置时沿用会话设置。显式推理档位需由模型容量目录声明支持，摘要任务和 checkpoint 记录实际配置，并在提交前继续按业务模型校验完整请求预算。
- 参考 Pi 的 hook 取消信号边界，为 `before_tool_call` 增加可选协作式 `signal`，并在回合取消时立即结束内核等待；旧的一参数 hook 保持兼容，迟到决策不触发审批或工具派发。
- [Issue #107](https://github.com/can4hou6joeng4/boss-cli/issues/107)：增加追加式会话上下文编辑，允许替换或排除已结束回合中的用户/助手文本；原始日志不变，编辑参与请求预算与摘要来源，并按 fork 历史继承。

### 修复

- 手动摘要的单次 `model` 覆盖只按摘要线路解析；当业务会话保存的推理档位不被跨 provider 摘要模型支持时，不再错误地按业务模型拒绝摘要请求。
- [Issue #99](https://github.com/can4hou6joeng4/boss-cli/issues/99)：为生命周期 hook callback 增加 16 个在途 worker 上限；超时线程在实际退出前继续占用容量，策略容量耗尽时以 `HOOK_BUSY` 拒绝工具调用，观察事件过载则跳过并合并诊断。
- [Issue #97](https://github.com/can4hou6joeng4/boss-cli/issues/97)：工具结果追加异常时按稳定条目身份对账，确认缺失后最多重试同一结果一次；不重跑 handler 或审批。恢复写入会停止当前工具批次，结果无法确认时记录 `outcome_unknown`，连未知状态也无法持久化时阻止该会话继续请求模型。
- [Issue #95](https://github.com/can4hou6joeng4/boss-cli/issues/95)：摘要 checkpoint 在同一写锁内重新核验来源，并先同步完整临时日志再原子发布；公开前失败保留原文件与旧摘要，公开后故障明确区分已提交与替换结果不确定，避免后续上下文静默采用写入失败的摘要。
- [Issue #85](https://github.com/can4hou6joeng4/boss-cli/issues/85)：会话执行状态追加失败时将工具明确记为未派发并暂停当前回合；终态或队列结算持久化失败时保守报告错误、尽力补记并暂停后续队列，避免运行通知与重启恢复给出相反结论。
- [Issue #87](https://github.com/can4hou6joeng4/boss-cli/issues/87)：队列暂停持久化失败时保留待暂停范围，在接受新任务或领取队列前完成补写，避免旧 follow-up 被后续成功回合派发。
- [Issue #89](https://github.com/can4hou6joeng4/boss-cli/issues/89)：严格验证 Anthropic 和 OpenAI Responses 的最终工具参数是完整 JSON object；截断、非对象、非标准 JSON 常量或终态来源冲突时不派发工具，保留合法空对象调用。
- [Issue #91](https://github.com/can4hou6joeng4/boss-cli/issues/91)：Anthropic 与 OpenAI Responses 的工具参数在增量、初始值和终态快照入口按 UTF-8 原始字节检查；每项和每次模型响应合计上限均为 1 MiB。超限、终态缺失或来源冲突时整轮报错，不派发工具且错误不回显输入。
- [Issue #93](https://github.com/can4hou6joeng4/boss-cli/issues/93)：将每响应文本与思考合计限制为 1 MiB UTF-8，超限在持久化前报错并阻止工具与队列继续；拆分增量事件，并用内容引用和冻结快照分段恢复大 Agent 字段。

### 验证与限制

- 本地 Python 3.10/3.12 编译、TypeScript 类型检查、桌面源码构建、干净 Git archive wheel/sdist 构建和结果预算专项探针通过；PR #113 的 Source build 与 GitGuardian 检查通过。探针未加入仓库。
- 未调用真实模型或招聘平台。此候选继续交付私有源码与 Python wheel/sdist，不含独立桌面安装包；签名/公证、完整 Python 依赖锁及真实模型/平台完整验收仍未完成。

## 0.2.0-rc.6 - 2026-10-27

第六次私有源码与 Python 内核候选发布，加入真实会话上下文预算与手动摘要、会话级推理档位和内核生命周期 hooks，并完善回合取消、应用关闭及跨入口队列状态收尾。

### 兼容变化

- npm 组件统一为 `0.2.0-rc.6`，Python 内核为等价 PEP 440 版本 `0.2.0rc6`；JSON-RPC 保持 `0.2.0`。
- 生命周期 hooks 仅由嵌入宿主显式注入；默认不配置时维持原行为，策略 hook 只能拒绝且不能绕过逐次审批。

### 新功能

- [Issue #76](https://github.com/can4hou6joeng4/boss-cli/issues/76)：桌面接入真实会话上下文预算、近期完整回合保留计划和显式手动摘要，展示进度、取消与终态并读取对账；`context/read` 增加可选的轻量任务引用，区分仍在收尾、本进程无记录和旧服务未知。打开或规划不调用模型、工具或隐式中断，失联和未知回执不自动重复开始。
- [Issue #78](https://github.com/can4hou6joeng4/boss-cli/issues/78)：参考 Pi 的会话级 `thinkingLevel` 生命周期，增加可恢复的会话推理档位设置和桌面菜单；模型能力表显式声明可选档位，设置不改全局配置，预算、后续回合和摘要请求使用同一有效档位，能力变更后显示不受支持并允许恢复继承配置。
- [Issue #80](https://github.com/can4hou6joeng4/boss-cli/issues/80)：增加由嵌入宿主显式注入的内核生命周期 hooks，支持有界异步事件观察和工具执行前拒绝策略；事件投影过滤消息正文与工具参数，策略失败按拒绝处理且不能绕过逐次审批，不扫描工作区或动态加载插件。

### 修复

- [Issue #82](https://github.com/can4hou6joeng4/boss-cli/issues/82)：策略 hook 不再复用会截断/脱敏的事件观察投影；策略收到有界完整 JSON 深只读快照，超出字节/深度/节点限制时在工具派发和审批前 fail closed。
- [Issue #73](https://github.com/can4hou6joeng4/boss-cli/issues/73)：统一直接发送与后续排队的会话内请求身份，重复请求关联原回合并结算队列收据；已执行失败不再误标未执行，明确未启动或证据未知时保留暂停。拒绝跨入口输入冲突、身份歧义及绕过排队/暂停/撤回的重复发送，恢复时只补充关联，不重放动作。
- [Issue #71](https://github.com/can4hou6joeng4/boss-cli/issues/71)：后续回合未启动时保留安全失败关联、已保存输入和请求幂等，将队列暂停并显示“启动失败，未执行”；实际已启动的 worker 继续持有模型、bridge 和状态目录责任。失败通知在运行锁外发布，排队响应返回结算后的最新状态，暂停项可撤回且不自动重试。
- [Issue #70](https://github.com/can4hou6joeng4/boss-cli/issues/70)：取消接受与回合终态在同一运行锁边界结算；终态提交前已确认取消时以 `interrupted` 收尾并暂停现有后续队列，保留已产生的文本和工具结果，避免模型刚完成时取消仍自动续跑。
- [Issue #68](https://github.com/can4hou6joeng4/boss-cli/issues/68)：手动回合/摘要取消先确认请求，再在 RPC 和全局运行锁外独立分发中止；重复取消与关闭共用中止责任。旧 worker 与 abort 都结束前保留模型实例及任务所有权，防止迟到 abort 影响复用实例的新请求。
- [Issue #66](https://github.com/can4hou6joeng4/boss-cli/issues/66)：应用关闭先为业务回合、摘要任务和连接检查统一置位取消，再异步分发各自的中止；所有 worker 共享同一个两秒等待期限。任务在 worker、终态通知和对应 abort 全部收尾前继续保留 provider、bridge 与状态目录所有权；重复关闭和非协作 provider 不会重复中止或伪造收尾。

### 验证与限制

- 独立功能 PR 均在最新 head 通过源码构建和 GitGuardian 检查后合并；当前 `main` Build `40480080146` 成功。
- 本地 Harness 回归 335 passed、4 skipped、889 个子断言通过；hooks 专项验收 14/14。此类测试材料仅留在忽略目录，不属于 GitHub 源码构建 CI。
- `npm run typecheck`、`npm run build`、Python 3.10 `compileall`、干净 Git archive wheel/sdist 构建和 `git diff --check` 通过。
- 未调用真实模型或招聘平台；桌面独立安装包、签名/公证、完整 Python 依赖锁及真实模型/平台完整验收仍未完成，仓库保持私有。

## 0.2.0-rc.5 - 2026-10-26

第五次私有源码与 Python 内核候选发布，加入长会话自动压缩、桌面任务队列和技能选择，并完善输出预算、模型任务收尾与摘要来源一致性。

### 兼容变化

- npm 组件统一为 `0.2.0-rc.5`，Python 内核为等价 PEP 440 版本 `0.2.0rc5`；JSON-RPC 保持 `0.2.0`。
- 嵌入方 provider 工厂须返回独立于主实例、业务 worker 与运行摘要的模型实例；临时实例须等旧 worker 完全结束后才能串行复用。
- 压缩计划的来源 digest 升为 v2，绑定选中条目和旧 checkpoint；旧 v1 计划应重新读取，合法已持久化 v1 checkpoint 继续可用。

### 新功能

- [Issue #55](https://github.com/can4hou6joeng4/boss-cli/issues/55)：桌面输入区接入运行时技能目录、刷新及单次直接发送，覆盖新会话与已有会话；队列带技能时明确阻止提交并保留草稿。
- [Issue #51](https://github.com/can4hou6joeng4/boss-cli/issues/51)：桌面端支持运行中转向、后续回合排队、队列状态展示和未投递项撤回。
- [Issue #45](https://github.com/can4hou6joeng4/boss-cli/issues/45)：在每个完整请求预算阈值或超限时自动压缩旧完整回合，支持启动策略及每回合覆盖；保留当前工具结果、思考和 steering，并对可信、零输出的上下文溢出最多压缩恢复一次，仍遵守 6 次业务请求上限。
- [Issue #43](https://github.com/can4hou6joeng4/boss-cli/issues/43)：压缩计划支持按估算 token 保留近期完整回合；长历史和超长单条结果按预算连续分段摘要，最多 32 个无工具生成阶段，全部成功后仅提交一次 checkpoint，并报告字符进度与逐段 usage。

### 修复与兼容

- [Issue #62](https://github.com/can4hou6joeng4/boss-cli/issues/62)：历史与上下文读取复用摘要来源校验；已覆盖记录发生修订时回退最新原文，避免旧摘要隐藏修正事实，并继续应用完整请求预算。
- [Issue #61](https://github.com/can4hou6joeng4/boss-cli/issues/61)：关闭内核时取消并等待模型连接检查，以任务身份隔离超时、中止和迟到响应，避免检查残留或旧回调覆盖新检查。
- [Issue #58](https://github.com/can4hou6joeng4/boss-cli/issues/58)：拒绝模型工厂复用应用主实例或仍被业务 worker/摘要持有的 provider，避免一个会话的中断影响另一个；拒绝前不预留回合、不保存输入，也不中断原 owner。
- [Issue #57](https://github.com/can4hou6joeng4/boss-cli/issues/57)：业务 CLI 的 stdout/stderr 合计限制为 16 MiB 原始字节，超限停止进程组并暂停任务；已派发写操作记为结果未知，保留大 stdin、超时/取消与初始化失败清理。
- [Issue #53](https://github.com/can4hou6joeng4/boss-cli/issues/53)：会话分支不再复制执行队列状态，避免继续子会话时投递原会话任务；保留历史、附件及上下文 checkpoint，原队列不受影响。
- [Issue #49](https://github.com/can4hou6joeng4/boss-cli/issues/49)：可用 `BOSS_HARNESS_BROWSER_SOURCE` 为业务 CLI 进程显式覆盖浏览器来源，并在连接诊断中展示；未设置时继承上游配置。
- [Issue #47](https://github.com/can4hou6joeng4/boss-cli/issues/47)：限制摘要任务并发和终态记录保留，截断超长终态错误；淘汰旧 `jobId` 时保留会话 checkpoint、usage 与事件历史。
- 模型错误新增可选结构化溢出分类，保持旧事件兼容；输出截断、限流、普通字节超限和网络错误不会触发业务恢复。自动摘要独立 provider、取消与 worker 所有权沿用既有边界。
- 来源 digest v2 同时冻结原始条目与旧 checkpoint，拒绝摘要覆盖倒退；旧 v1 计划需要重新读取。提交前检查默认业务模型的摘要及保留上下文完整预算，取消和中途失败不写新 checkpoint。
- 模型摘要正确标记来源；桌面 RPC 的摘要读取与取消接受协议规定的 `jobId`，并校验压缩选择参数。
- 拒绝沿用覆盖记录已被修订的旧摘要；统一擦除摘要失败消息中的配置凭据，提交后的读取或通知异常保持任务已完成状态。

### 验证与限制

- 本地内核全套 339 项中 335 通过、4 跳过；连接关闭 23 项专项与 12 项独立边界、摘要来源 21 项专项与 3 项独立验证通过。测试仅保留本地，远程 CI 执行源码构建与安全检查。
- TypeScript 类型检查、桌面源码构建与干净 Git 源码的 Python wheel/sdist 构建通过。桌面队列和技能入口已有隔离 Electron 验收；本候选仍交付源码与 Python 内核，不包含独立桌面安装包。
- 自动压缩会增加模型用量，token 仍为估算；取消依赖 provider 协作，摘要语义无损和真实服务窗口不作保证。已覆盖来源变化时回退原文，失效摘要的自动重建仍待实现。
- 本地验证使用合成状态，未调用真实模型或招聘平台。独立安装包、签名/公证、完整 Python 依赖锁及真实模型/平台完整验收仍待完成，仓库继续保持私有。

## 0.2.0-rc.4 - 2026-10-26

第四次私有源码与 Python 内核候选发布，完善模型请求预算、工具组合、上下文压缩与 provider 隔离。

### 兼容变化

- npm 组件统一为 `0.2.0-rc.4`，Python 内核为等价 PEP 440 版本 `0.2.0rc4`；JSON-RPC 继续保持 `0.2.0`。
- 嵌入式应用生成模型摘要时必须提供能够创建独立实例的 `provider_factory`。

### 新功能

- [Issue #36](https://github.com/can4hou6joeng4/boss-cli/issues/36)：增加可取消的模型摘要后台任务 `context/compact/start`、`context/compact/abort` 与 `context/compact/read`；摘要请求不携带招聘工具或 bridge，完成前重新校验来源 digest，并将摘要 usage 单独持久化。
- [Issue #34](https://github.com/can4hou6joeng4/boss-cli/issues/34)：增加只读 `context/compact/plan` 和可选 `sourceDigest` 校验；摘要来源变化时拒绝写入 checkpoint。
- [Issue #32](https://github.com/can4hou6joeng4/boss-cli/issues/32)：成功模型响应的 input usage 现在绑定 provider、模型、完整请求指纹和消息前缀；匹配时只将 usage 基线与新增尾部估算合并，变化或不明时继续使用保守估算。
- 增加显式 `ToolDefinition` / `ToolBundle` 及应用组合入口；默认保留 14 个招聘工具，自定义 bundle 不继承平台登录能力。
- [Issue #30](https://github.com/can4hou6joeng4/boss-cli/issues/30)：自定义工具 bridge 可实现同步 `close()` 或 `dispose()`；临时运行器、连接检查与应用退出按所属生命周期释放资源，重复关闭安全。
- 新增精确供应商/模型容量配置和完整请求预算，统一运行前准入及 `context/read` 预览/活动快照；按模型上限裁剪输出，持久化预算并标注未知容量假设，超限暂停且不请求模型。
- 新增求职者沟通列表工具 `boss_chat`，仅接受正整数页码并读取指定逻辑页；保留来源及未知分页，明确未读数、最近消息占位与关系发起方的含义，不补消息、回复、导出或自动翻页。

### 修复

- [Issue #40](https://github.com/can4hou6joeng4/boss-cli/issues/40)：关闭时等待摘要 worker 完成终态通知和资源收尾，避免提前释放状态目录所有权；线程启动失败时清理任务索引。
- [Issue #38](https://github.com/can4hou6joeng4/boss-cli/issues/38)：要求摘要使用独立 provider 实例；未提供 provider factory 或工厂复用主 provider 时拒绝启动摘要。
- 校验工具 handler 的结构化结果与暂停策略回调；无效结果也会完成持久化收尾，已派发写操作记为结果未知并暂停后续任务。拒绝复用仍存活的 bridge，避免探针与并发回合共享取消状态。
- steering 在下一模型请求通过预算检查后才确认投递；预算失败时暂停，避免转向未送达模型却显示已应用。
- 回合收尾与 steering 入队检查共用运行锁，关闭队列清扫后仍接受旧回合转向的竞态。
- 模型输出截断时拒绝执行整批工具并保留未执行配对记录，文本截断也以错误收尾；用尽 6 次回合模型请求且仍需续跑时暂停后续队列，不再误记为正常完成或无响应地投递最后到达的 steering。
- 明确工具派发、逻辑页面和业务 CLI 内部网络尝试的区别；工具描述、领域提示与贡献说明不再把单页或无 Harness 重试当作首次限制即停的保证，记录认证刷新及最终成功信封的可见范围。
- 招聘沟通列表已取得但最近消息补取触发平台停止码时，保留部分数据并暂停当前回合；阻止同批后续工具及自动模型续跑。
- 只识别固定命令和元数据路径的既有停止码，使用安全固定提示；保留原始 hints、分页与上游信封事实，不从候选人文本推断平台状态，不自动补批或重试。

### 验证与限制

- 本地离线套件通过：116 项 Python 用例、60 项桌面/客户端用例，以及 stdio 冒烟、TypeScript 类型检查和桌面构建；provider 隔离与关闭收尾回归包含在本地用例中。
- PR #39、PR #41 的 Source build、GitGuardian 及合并后 main Source build 均通过。未调用真实模型或招聘平台；候选包须从最终 tag 的干净 Git 源码构建，随发布资产提供构建信息与 SHA-256 清单。
- 当前不自动触发压缩；单次摘要请求超出模型输入预算时明确失败，按 cut point 保留近期上下文的分段压缩仍待实现。独立桌面安装包、签名与公证、完整 Python 依赖锁及真实平台验收也未完成。

## 0.2.0-rc.3 - 2026-10-25

第三次私有源码与 Python 内核候选发布，加入经验/学历集合查询及完整显式模型配置的文件隔离。

### 兼容变化

- npm 组件统一为 `0.2.0-rc.3`，Python 内核为等价 PEP 440 版本 `0.2.0rc3`；JSON-RPC 保持 `0.2.0`，原有单标签搜索保持兼容。

### 新功能

- 职位经验、学历条件兼容单标签并支持非空无重复枚举数组；固定顺序传给业务 CLI，同一组条件可用于下一页，不展开组合或自动补详情。
- 工具声明与执行校验同步支持集合，拒绝空数组、重复项、未知标签与隐式类型转换；城市、薪资继续单选，原始数组保留在会话中供追溯。

### 修复

- 完整的 OpenAI 端点、凭据和模型显式配置不再访问 Codex 文件，避免 Python 3.10 被无关 TOML 阻塞；可选推理强度仅取显式环境值。
- 命令行 `--model` 在配置解析前参与优先级判断，完整命令行/环境配置保持同一独立路径。
- 需要文件补全时对不可读、非文件路径或损坏 TOML 给出不含配置原文的明确错误；保留直接调用 loader 的缺省兼容行为。

### 验证与限制

- 242 项本地离线用例、stdio 冒烟、类型检查及桌面构建通过；其中搜索集合套件在实际 Python 3.10.20 / 3.12.13 各通过 28 项，独立审查另覆盖 2,020 种有效排列与 54 种无效输入。
- 实际 Electron 43.8.3 的实时、重载及重连验收通过，原始数组留在会话，下一页仅改页码。合成 provider、模拟 CLI 及固定业务管线验证未调用真实模型或招聘平台，不证明平台严格集合筛选或个人资格。
- 多标签依赖平台过滤；城市、薪资继续单选。部分模型配置需读取 TOML 时仍要求 Python 3.11+；完整显式 OpenAI 参数的启动在 Python 3.10 / 3.12 验证。
- 继续作为私有源码与内核候选版；独立桌面安装包、签名、公证、公开许可证、Python 完整依赖锁及真实平台验收仍待完成。测试材料仅保留本地，远程 CI 执行源码构建及 npm 依赖审计。

## 0.2.0-rc.2 - 2026-10-25

第二次私有源码与 Python 内核候选发布，继续验证招聘工具原语及大结果恢复。

### 兼容变化

- npm 组件统一为 `0.2.0-rc.2`，Python 内核为等价 PEP 440 版本 `0.2.0rc2`；JSON-RPC 保持 `0.2.0`，新增只读结果分段方法和可选引用字段。

### 新功能

- 职位搜索支持明确的城市、薪资、经验、学历与页码；保留关键词查询兼容，下一页可沿用同一组条件，单次工具调用只读取一页。
- 搜索参数在执行前校验类型、枚举和未知字段；提示区分平台标签、粗筛结果及资格判断，不自动放宽条件或补取详情。

### 修复

- 大结果恢复不再重复传输模型文本；超过 64 KiB 的工具结果改用绑定会话、条目和版本的引用，桌面支持手动分段查看完整 JSON。
- 条目与事件分页同时限制编码大小，游标按实际返回条目推进；超大响应返回有界错误，避免 stdio 内核退出或重连循环。
- 大失败结果的通知仅展示错误预览，完整失败信息仍可通过结果引用读取，模型和持久历史保持完整。

### 验证与限制

- 200 项本地离线验证、stdio 冒烟、类型检查和桌面构建通过；实际 Electron 的大结果手动分段、Unicode 边界、重载及重连通过。验证未调用真实模型或招聘平台，测试材料继续仅保留本地。
- 单条超大非工具记录返回明确错误，尚无通用分块阅读器；结果按既有会话存储加载，尚无流式磁盘索引。
- Python 3.10 下完整 OpenAI 环境参数仍可能被已有 Codex TOML 的解析阻塞，后续单独修复；本版运行及安装验收使用 Python 3.12。
- 继续作为私有源码与内核候选版；独立桌面安装包、签名、公证、公开许可证和 Python 完整依赖锁仍待完成。

## 0.2.0-rc.1 - 2026-10-25

首次私有源码与 Python 内核候选发布；尚无可独立安装的桌面应用。

### 兼容变化

- Electron 的最低 macOS 从 11 提高到 12；源码开发与运行验收前使用 `npx install-electron --no` 下载并校验官方运行时。
- npm 组件统一为 `0.2.0-rc.1`，Python 内核使用等价 PEP 440 版本 `0.2.0rc1`；JSON-RPC 协议保持 `0.2.0`。

### 修复

- 保留上游工具分页信息，贯通模型上下文、结果详情与重启历史；区分本页数量、分页结束和未知状态，避免将单页结果当作全部结果。
- 限制实时工具详情的内联大小，大结果保留分页摘要及省略提示，完整结果保存到会话历史。
- 将 Electron / electron-vite / Vite 固定到 43.8.3 / 4.0.1 / 6.4.4，清除本次 npm 依赖审计发现的 5 项受影响包。

### 交付与文档

- 建立私有仓库、独立 Issue / PR、源码构建与 npm 依赖审计 CI；提交和 squash 合并保留单行中文主题及空正文。
- 增加可独立阅读的 README、贡献说明、PR 模板和上游采用记录；测试、离线 provider、夹具及测试专用配置仅保留本地。
- 候选资产包括从干净 Git 树构建的 Python wheel、sdist 与 SHA-256 校验清单。

### 验证与限制

- 本地 170 项离线验证及 stdio smoke 通过；真实 Electron 43 的 IPC、多窗口/重连、构建后 renderer/历史恢复和离线登录隔离验收通过；远程源码构建与安全检查通过。
- 运行验收环境为 macOS arm64、Node.js 24、Python 3.12。未完成真实招聘平台的全面验收、独立桌面安装包、签名或公证。
- Python SDK 依赖当前使用版本下界约束，尚未提供完整依赖锁；候选发布不等于所有安装环境已验证。
- 仓库保持私有；公开开源许可尚未确定。当前 GitHub 套餐不支持私有仓库服务端分支保护，合并采用核对最新 head 检查及 commit 匹配的流程门禁。
