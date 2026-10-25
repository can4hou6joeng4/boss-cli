/**
 * BOSS Agent (招聘垂直领域 Agent Harness) 仿真数据
 */

import type { ToolResultReference } from "@boss-cli/protocol";

export type ConversationMode = "plan" | "ask" | "agent";
export type EffortLevel = "Auto" | "Max" | "High" | "Medium" | "Low" | "Off";

export interface StrategyDomain {
  id: string;
  name: string;
  icon: string;
  badge: string;
  desc: string;
  defaultPrompt: string;
}

export const STRATEGY_DOMAINS: StrategyDomain[] = [
  {
    id: "precision-match",
    name: "精准对齐",
    icon: "",
    badge: "深度画像 · 履历归因",
    desc: "候选人画像深度比对，跨履历真实性校核与核心能力归因",
    defaultPrompt: "请对已获取的 15 位资深后端候选人简历进行多维度画像对齐，严格核查高并发与微服务项目实操细节：",
  },
  {
    id: "compliance-gate",
    name: "严谨门禁",
    icon: "",
    badge: "职位拆解 · 门槛核查",
    desc: "招聘 JD 深度拆解、硬性门槛核查与招聘风险合规审查",
    defaultPrompt: "请深度拆解当前「大模型算法专家」岗位 JD，梳理出必备能力与加分项，并生成结构化候选人筛选门禁：",
  },
  {
    id: "batch-outreach",
    name: "批量触达",
    icon: "",
    badge: "个性邀约 · 节奏可控",
    desc: "定制个性化打招呼沟通话术、分批次触达节奏与意向跟进",
    defaultPrompt: "请为通过初筛的候选人定制针对其技术履历的个性化打招呼邀约话术，按每批 5 人平稳触达：",
  },
  {
    id: "pipeline-insights",
    name: "全景复盘",
    icon: "",
    badge: "流程引导 · 漏斗分析",
    desc: "全景招聘漏斗复盘、人才市场行情评估与招聘交付策略指引",
    defaultPrompt: "请分析本周核心产研团队招聘全流程交付漏斗，评估从初筛、打招呼到面试邀约的转化率与优化方向：",
  },
];

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  badge?: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "deepseek-v4", name: "Adaptive Router: DeepSeek-V4", provider: "DeepSeek", badge: "推荐" },
  { id: "deepseek-v3", name: "DeepSeek-V3", provider: "DeepSeek" },
  { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", provider: "Anthropic" },
  { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
];

export interface SessionItem {
  toolPolicy?: "readOnly" | "approval";
  /** 内核回报的当前/最近回合，用于界面重载后恢复停止控制。 */
  turnId?: string;
  id: string;
  title: string;
  timeAgo: string;
  updatedAt?: string;
  status: "idle" | "running" | "completed";
  projectId: string;
}

export interface ProjectFolder {
  id: string;
  name: string;
  sessions: SessionItem[];
}

export const MOCK_PROJECT_FOLDERS: ProjectFolder[] = [
  {
    id: "proj-core-rd",
    name: "核心产研团队招聘",
    sessions: [
      { id: "s-algo", title: "大模型算法专家精准初筛与邀约", timeAgo: "刚刚", status: "running", projectId: "proj-core-rd" },
      { id: "s-arch", title: "分布式架构师简历深度比对", timeAgo: "2小时前", status: "completed", projectId: "proj-core-rd" },
      { id: "s-frontend", title: "前端团队负责人 JD 拆解与画像制定", timeAgo: "昨天", status: "completed", projectId: "proj-core-rd" },
    ],
  },
  {
    id: "proj-pool",
    name: "日常人才库盘点与激活",
    sessions: [
      { id: "s-reactivate", title: "Q3 沉淀高潜候选人自动打招呼触达", timeAgo: "3天前", status: "completed", projectId: "proj-pool" },
      { id: "s-tagging", title: "人才库候选人技能标签批量丰富与清洗", timeAgo: "5天前", status: "completed", projectId: "proj-pool" },
    ],
  },
  {
    id: "proj-campus",
    name: "2026 届应届生秋季校招",
    sessions: [
      { id: "s-campus-ai", title: "AI 专项博士生简历匹配评分", timeAgo: "1周前", status: "completed", projectId: "proj-campus" },
    ],
  },
];

export interface DiffFile {
  name: string;
  additions: number;
  deletions: number;
}

export interface ApprovalData {
  toolName: string;
  /** 涉及对外沟通等操作必须逐次确认。 */
  consequential?: boolean;
  description: string;
  params: Record<string, unknown>;
  /** `expired` 是内核在等待超时后给的结论：按未批准处理。 */
  decision?: "approve" | "deny" | "expired";
  submitted?: boolean;
  remember?: boolean;
  /** 内核给出的审批 id；仿真数据没有它，因此仿真卡片不会真的发给内核。 */
  approvalId?: string;
}

export interface PlanData {
  slug: string;
  title: string;
  content: string;
  options: { id: string; label: string; desc: string }[];
  selectedOption?: string;
  status: "submitted" | "approved" | "rejected";
}

export interface QuestionData {
  id: string;
  prompt: string;
  options: string[];
  allowMultiple?: boolean;
  selected?: string[];
  answered?: boolean;
}

export interface MessageItem {
  id: string;
  turnId?: string;
  role: "user" | "agent";
  content?: string;
  paragraphs?: string[];
  bullets?: string[];
  thinkingTime?: string;
  thinkingContent?: string;
  toolUse?: {
    name: string;
    input: string;
    result?: string;
    source?: { ref: string; tool: string; queriedAt: string };
    output?: string;
    resultRef?: ToolResultReference;
  };
  approval?: ApprovalData;
  plan?: PlanData;
  question?: QuestionData;
  showDiffCard?: boolean;
  diffSummary?: {
    fileCount: number;
    additions: number;
    deletions: number;
    initialFiles: DiffFile[];
    extraFiles: DiffFile[];
  };
}

export const MOCK_DIFF_DATA = {
  fileCount: 4,
  additions: 146,
  deletions: 18,
  initialFiles: [
    { name: "profiles/大模型算法专家_JD.md", additions: 45, deletions: 12 },
    { name: "prompts/候选人初筛匹配门禁.ts", additions: 52, deletions: 2 },
    { name: "templates/个性化打招呼邀约话术.txt", additions: 31, deletions: 0 },
  ],
  extraFiles: [
    { name: "configs/招聘策略_精准对齐.json", additions: 18, deletions: 4 },
  ],
};

export const MOCK_CONVERSATION_THREAD: MessageItem[] = [
  {
    id: "msg-1",
    role: "user",
    content: "请帮我针对核心产研团队的「大模型算法专家」岗位展开全流程推进：先拆解职位门禁，然后从候选人池中初筛 15 位人选并准备沟通话术。",
  },
  {
    id: "msg-2",
    role: "agent",
    thinkingTime: "思考过程 · 岗位画像拆解 · 1m 12s",
    thinkingContent: "1. 读取招聘需求与团队技术栈（PyTorch / DeepSeek / RLHF / vLLM 推理加速）；\n2. 评估候选人学历年限与开源项目经验；\n3. 设计两套筛选推进策略（方案 A：偏重端到端训练专家；方案 B：偏重高并发推理部署工程专家）。",
    paragraphs: [
      "已完成目标岗位 [大模型算法专家 JD 细则](https://bosszhipin.com/job/llm-expert) 的全维度能力拆解。为保证招聘交付的精准与高效，制定了分波执行计划：",
    ],
    plan: {
      slug: "plan-llm-recruiting",
      title: "大模型算法专家交付计划与分波策略",
      content: `### 招聘执行计划路线图
\`\`\`mermaid
flowchart TD
  A[岗位画像与JD门禁提取] --> B[候选人池向量比对与硬性筛选]
  B --> C[技术深度交叉核验]
  C --> D[个性化邀约触达与意向沟通]
\`\`\`

#### 核心筛选项
1. **理论与架构**：熟悉 Transformer 架构、FlashAttention、RoPE 等关键机制。
2. **实操经验**：具备十亿以上参数模型全流程 Pretrain 或 Post-train (SFT/DPO/PPO) 落地实操。
3. **推理工程**：掌握 TensorRT-LLM / vLLM 或分布式推理加速。`,
      options: [
        { id: "opt-1", label: "方案 A：兼顾理论与工程实操（建议，覆盖面广）", desc: "重点考察多机多卡训练稳定性与微调交付速度" },
        { id: "opt-2", label: "方案 B：纯研发方向（聚焦核心算法机理创新）", desc: "重点考察顶会论文 (NeurIPS/ICLR) 与架构创新能力" },
      ],
      selectedOption: "opt-1",
      status: "approved",
    },
  },
  {
    id: "msg-3",
    role: "agent",
    toolUse: {
      name: "search_candidates",
      input: JSON.stringify({ keywords: ["LLM", "RLHF", "DeepSeek", "vLLM"], minExpYears: 5, limit: 15 }, null, 2),
      result: "成功检索到 15 位符合基本画像的资深候选人，已提取履历关键段落。",
    },
    paragraphs: [
      "深度比对时发现一位高潜候选人 @候选人:李*明（前大厂算法专家），曾作为核心贡献者提交 [来源: vllm-project/vllm (GitHub ↗)](https://github.com/vllm-project/vllm) 显存管理 PR [1]，但毕业仅 4 年（JD 门禁要求 5 年）：\n\n```json\n{\n  \"name\": \"李*明\",\n  \"current_title\": \"资深推理引擎工程师\",\n  \"github\": \"https://github.com/vllm-project/vllm\",\n  \"top_contributions\": [\"PagedAttention V2 显存优化\", \"RoPE 算子融合\"],\n  \"match_score\": 96.8\n}\n```",
    ],
    question: {
      id: "q-exp-relax",
      prompt: "是否对该高潜候选人放宽年限门禁，纳入初筛批次？",
      options: ["放宽限制，优先看重开源项目贡献", "严格遵守 5 年硬性门禁，跳过该候选人", "作为备选保留，待首批触达后再评估"],
      allowMultiple: false,
      selected: ["放宽限制，优先看重开源项目贡献"],
      answered: true,
    },
  },
  {
    id: "msg-4",
    role: "agent",
    paragraphs: [
      "已根据 @候选人:李*明 的开源技术沉淀生成定制邀约，沟通意向将自动同步至 [BOSS 人才管理系统](https://bosszhipin.com/recruitment/pipeline)。操作涉及敏感平台写接口，请确认：",
    ],
    approval: {
      toolName: "send_greeting_message",
      consequential: true,
      description: "向候选人「李*明」发送岗位打招呼邀约",
      params: {
        candidateId: "cand_98214_liming",
        position: "大模型算法专家",
        greetingText: "李先生您好！关注到您在开源社区关于 vLLM 显存优化的核心 PR，与我们核心团队当前探索的分布式推理业务高度契合。诚邀您交流团队核心发展空间！",
      },
    },
    showDiffCard: true,
    diffSummary: MOCK_DIFF_DATA,
  },
];

export interface GoalState {
  active: boolean;
  title: string;
  currentTurn: number;
  maxTurns: number;
  elapsedSeconds: number;
  budgetRemaining: number;
  paused: boolean;
}

export const MOCK_GOAL_STATE: GoalState = {
  active: false,
  title: "定向初筛 15 位算法专家并发送定制邀约",
  currentTurn: 3,
  maxTurns: 10,
  elapsedSeconds: 42,
  budgetRemaining: 7,
  paused: false,
};

export const MOCK_COCKPIT_DATA = {
  summary: {
    model: "Adaptive Router: DeepSeek-V4",
    domain: "深度画像 · 精准对齐",
    totalTokens: "84.2k",
    cacheHitRate: "98.2%",
    totalCost: "$0.0142",
    turns: 6,
  },
  safety: {
    doomLoopDetected: false,
    riskSignals: ["sensitive_tool_greeting: approved"],
    activeHooks: ["compliance_check_passed", "contact_rate_limiter_active"],
    sandboxMode: "完全授权 (沙箱隔离)",
  },
  verify: {
    redGateStatus: "GREEN",
    evidenceScore: "96 / 100",
    deliveryReadiness: "就绪 (可推进下一批次触达)",
  },
  model: {
    inputTokens: "74,210",
    cacheReadTokens: "72,880",
    cacheCreateTokens: "1,330",
    outputTokens: "2,410",
    speculativeDecodeRate: "72.4%",
    routerPath: "DeepSeek-V4 (Direct Fast Lane)",
  },
  context: {
    currentTokens: 74210,
    maxTokens: 200000,
    percentUsed: 37,
    pinnedAnchors: 4,
    compactionCount: 0,
  },
  trace: [
    { turn: 1, type: "input", name: "User Prompt", latency: "12ms", status: "ok" },
    { turn: 1, type: "plan", name: "Generate Plan", latency: "1.4s", status: "ok" },
    { turn: 2, type: "tool", name: "search_candidates", latency: "640ms", status: "ok" },
    { turn: 2, type: "question", name: "ask_user_decision", latency: "user", status: "ok" },
    { turn: 3, type: "approval", name: "send_greeting_message", latency: "waiting", status: "pending" },
  ],
  mcp: [
    { name: "boss-platform-api", status: "connected", toolsCount: 8, ping: "28ms" },
    { name: "talent-graph-search", status: "connected", toolsCount: 14, ping: "14ms" },
    { name: "resume-pdf-parser", status: "ready", toolsCount: 3, ping: "2ms" },
  ],
  advisory: {
    rendered: 18,
    adopted: 16,
    dismissed: 2,
    efficiencyScore: "94%",
  },
};
