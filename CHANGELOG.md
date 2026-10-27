# 变更记录

## 未发布

### 新功能

- 为自动、手动及溢出恢复摘要增加独立 provider、model、effort 配置；未配置时沿用会话设置。显式推理档位需由模型容量目录声明支持，摘要任务和 checkpoint 记录实际配置，并在提交前继续按业务模型校验完整请求预算。
- 参考 Pi 的 hook 取消信号边界，为 `before_tool_call` 增加可选协作式 `signal`，并在回合取消时立即结束内核等待；旧的一参数 hook 保持兼容，迟到决策不触发审批或工具派发。
- [Issue #107](https://github.com/can4hou6joeng4/boss-cli/issues/107)：增加追加式会话上下文编辑，允许替换或排除已结束回合中的用户/助手文本；原始日志不变，编辑参与请求预算与摘要来源，并按 fork 历史继承。

### 修复

- [Issue #99](https://github.com/can4hou6joeng4/boss-cli/issues/99)：为生命周期 hook callback 增加 16 个在途 worker 上限；超时线程在实际退出前继续占用容量，策略容量耗尽时以 `HOOK_BUSY` 拒绝工具调用，观察事件过载则跳过并合并诊断。
- [Issue #97](https://github.com/can4hou6joeng4/boss-cli/issues/97)：工具结果追加异常时按稳定条目身份对账，确认缺失后最多重试同一结果一次；不重跑 handler 或审批。恢复写入会停止当前工具批次，结果无法确认时记录 `outcome_unknown`，连未知状态也无法持久化时阻止该会话继续请求模型。
- [Issue #95](https://github.com/can4hou6joeng4/boss-cli/issues/95)：摘要 checkpoint 在同一写锁内重新核验来源，并先同步完整临时日志再原子发布；公开前失败保留原文件与旧摘要，公开后故障明确区分已提交与替换结果不确定，避免后续上下文静默采用写入失败的摘要。
- [Issue #85](https://github.com/can4hou6joeng4/boss-cli/issues/85)：会话执行状态追加失败时将工具明确记为未派发并暂停当前回合；终态或队列结算持久化失败时保守报告错误、尽力补记并暂停后续队列，避免运行通知与重启恢复给出相反结论。
- [Issue #87](https://github.com/can4hou6joeng4/boss-cli/issues/87)：队列暂停持久化失败时保留待暂停范围，在接受新任务或领取队列前完成补写，避免旧 follow-up 被后续成功回合派发。
- [Issue #89](https://github.com/can4hou6joeng4/boss-cli/issues/89)：严格验证 Anthropic 和 OpenAI Responses 的最终工具参数是完整 JSON object；截断、非对象、非标准 JSON 常量或终态来源冲突时不派发工具，保留合法空对象调用。
- [Issue #91](https://github.com/can4hou6joeng4/boss-cli/issues/91)：Anthropic 与 OpenAI Responses 的工具参数在增量、初始值和终态快照入口按 UTF-8 原始字节检查；每项和每次模型响应合计上限均为 1 MiB。超限、终态缺失或来源冲突时整轮报错，不派发工具且错误不回显输入。
- [Issue #93](https://github.com/can4hou6joeng4/boss-cli/issues/93)：将每响应文本与思考合计限制为 1 MiB UTF-8，超限在持久化前报错并阻止工具与队列继续；拆分增量事件，并用内容引用和冻结快照分段恢复大 Agent 字段。

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
