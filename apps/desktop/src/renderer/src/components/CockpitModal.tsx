import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PendingApproval, RuntimeResourceOwner, RuntimeResourcesReadResponse } from "@boss-harness/protocol";
import { ModalSurface } from "./ModalSurface";
import { configuredModels, harnessErrorText, listPendingApprovals, listQueue, listTools, readConfig, readRuntimeResources, readTaskStatus } from "../data/harnessBridge";
import { parseTaskRead, taskCheckErrorText, taskCheckLines, taskLocatorForOwner, type TaskCheckState } from "../data/taskCheck";
import { approvalRemainingText, approvalUrgency } from "../data/pendingApprovals";
import { compactionSourceLabel } from "../data/compactionSettings";
import {
  compactionSummary,
  durationText,
  ownerKindLabel,
  ownerStateLabel,
  queueSummaryText,
  readCockpitConfig,
  readCockpitModels,
  readCockpitQueue,
  readCockpitResources,
  readCockpitTools,
  shortId,
  shouldRefreshCockpit,
  type CockpitConfig,
  type CockpitModel,
  type CockpitQueue,
  type CockpitTool,
} from "../data/cockpitData";

export interface CockpitModalProps {
  isOpen: boolean;
  onClose: () => void;
  harnessUp: boolean;
  /** 当前会话；首页、预览或无活动会话时为 null。 */
  threadId: string | null;
}

type CockpitTab = "overview" | "turns" | "approvals" | "catalog";

const TABS: { key: CockpitTab; label: string }[] = [
  { key: "overview", label: "概览" },
  { key: "turns", label: "回合" },
  { key: "approvals", label: "审批" },
  { key: "catalog", label: "工具与模型" },
];

const APPROVAL_LIMIT = 100;
const REFRESH_DEBOUNCE_MS = 350;
const NUMBER = new Intl.NumberFormat("en-US");

interface CockpitSnapshot {
  config?: CockpitConfig;
  resources?: RuntimeResourcesReadResponse;
  approvals?: PendingApproval[];
  tools?: CockpitTool[];
  models?: CockpitModel[];
  queue?: CockpitQueue;
}

type CockpitErrors = Partial<Record<keyof CockpitSnapshot, string>>;

function numberText(value: number | undefined, suffix = ""): string {
  return value === undefined ? "未提供" : `${NUMBER.format(value)}${suffix}`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="cockpit-fact"><span className="cockpit-fact-label">{label}</span><span className="cockpit-fact-value">{value}</span></div>;
}

function SourceError({ label, error }: { label: string; error?: string }) {
  return error ? <p className="cockpit-error" role="status">{label}读取失败：{error}</p> : null;
}

function OwnerRow({ owner, check, onCheck }: {
  owner: RuntimeResourceOwner;
  check?: TaskCheckState;
  onCheck: () => void;
}) {
  const flags = [owner.cancelRequested ? "已请求取消" : "", owner.abortPending ? "中止待完成" : ""].filter(Boolean).join(" · ");
  const phase = [owner.phase, owner.phaseStatus].filter(Boolean).join(" · ");
  const key = `${owner.kind}:${owner.id}`;
  const checkable = taskLocatorForOwner(owner) !== null;
  const lines = check?.task ? taskCheckLines(check.task) : [];
  return (
    <div className="cockpit-row">
      <div className="cockpit-row-main">
        <div className="cockpit-row-title">{ownerKindLabel(owner.kind)} · {shortId(owner.id)}</div>
        <div className="cockpit-row-sub">
          会话 {shortId(owner.threadId)} · {ownerStateLabel(owner.state)} · 已运行 {durationText(owner.ageSeconds)}
        </div>
        {flags ? <div className="cockpit-row-sub cockpit-row-alert-text">{flags}</div> : null}
        {checkable ? <div className="cockpit-row-actions">
          <button type="button" className="cockpit-refresh" disabled={check?.loading === true} onClick={onCheck}>
            {check?.loading ? "核对中…" : check?.task || check?.error ? "重新核对持久记录" : "核对持久记录"}
          </button>
        </div> : null}
        {lines.map((line, index) => <div className="cockpit-row-sub" key={`${key}:${index}`}>{line}</div>)}
        {check?.error ? <div className="cockpit-row-sub cockpit-row-alert-text" role="status">{check.error}</div> : null}
      </div>
      {phase ? <span className="cockpit-badge">{phase}</span> : null}
    </div>
  );
}

function ApprovalRow({ approval }: { approval: PendingApproval }) {
  const urgency = approvalUrgency(approval.deadline);
  const badge = urgency === "expired" ? "已过期" : urgency === "soon" ? "即将到期" : "待处理";
  return (
    <div className={`cockpit-row ${urgency === "expired" || urgency === "soon" ? "cockpit-row-attention" : ""}`}>
      <div className="cockpit-row-main">
        <div className="cockpit-row-title">{approval.toolName}</div>
        {approval.summary ? <div className="cockpit-row-sub">{approval.summary}</div> : null}
        <div className="cockpit-row-sub">会话 {shortId(approval.threadId)} · {approvalRemainingText(approval.deadline)}</div>
      </div>
      <span className={`cockpit-badge ${urgency === "expired" || urgency === "soon" ? "cockpit-badge-warn" : ""}`}>{badge}</span>
    </div>
  );
}

export const CockpitModal: React.FC<CockpitModalProps> = ({ isOpen, onClose, harnessUp, threadId }) => {
  const [activeTab, setActiveTab] = useState<CockpitTab>("overview");
  const [snapshot, setSnapshot] = useState<CockpitSnapshot>({});
  const [errors, setErrors] = useState<CockpitErrors>({});
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [taskChecks, setTaskChecks] = useState<Record<string, TaskCheckState>>({});
  const epoch = useRef(0);
  const checkEpoch = useRef(0);

  useEffect(() => { checkEpoch.current += 1; setTaskChecks({}); }, [isOpen, threadId]);
  const runTaskCheck = useCallback(async (owner: RuntimeResourceOwner) => {
    const params = taskLocatorForOwner(owner);
    if (!params) return;
    const key = `${owner.kind}:${owner.id}`;
    const run = checkEpoch.current;
    setTaskChecks(previous => ({ ...previous, [key]: { loading: true } }));
    try {
      const task = parseTaskRead(await readTaskStatus(params), params);
      if (run === checkEpoch.current) setTaskChecks(previous => ({ ...previous, [key]: { loading: false, task } }));
    } catch (cause) {
      if (run === checkEpoch.current) setTaskChecks(previous => ({ ...previous, [key]: { loading: false, error: `核对失败：${taskCheckErrorText(cause)}` } }));
    }
  }, []);

  const load = useCallback(async (initial: boolean) => {
    const run = ++epoch.current;
    if (!harnessUp) {
      setSnapshot({});
      setErrors({});
      setLoading(false);
      setLoadedOnce(true);
      setUpdatedAt(null);
      return;
    }
    if (initial) {
      setSnapshot({});
      setErrors({});
      setLoadedOnce(false);
      setUpdatedAt(null);
    }
    setLoading(true);
    const results = await Promise.allSettled([
      readConfig().then(readCockpitConfig),
      readRuntimeResources().then(readCockpitResources),
      listPendingApprovals(APPROVAL_LIMIT),
      listTools().then(readCockpitTools),
      configuredModels().then(readCockpitModels),
      threadId ? listQueue(threadId) : Promise.resolve(null),
    ] as const);
    if (run !== epoch.current) return;
    const [configResult, resourcesResult, approvalsResult, toolsResult, modelsResult, queueResult] = results;
    const next: CockpitSnapshot = {};
    const failures: CockpitErrors = {};
    if (configResult.status === "fulfilled") next.config = configResult.value;
    else failures.config = harnessErrorText(configResult.reason);
    if (resourcesResult.status === "fulfilled") next.resources = resourcesResult.value;
    else failures.resources = harnessErrorText(resourcesResult.reason);
    if (approvalsResult.status === "fulfilled") next.approvals = approvalsResult.value;
    else failures.approvals = harnessErrorText(approvalsResult.reason);
    if (toolsResult.status === "fulfilled") next.tools = toolsResult.value;
    else failures.tools = harnessErrorText(toolsResult.reason);
    if (modelsResult.status === "fulfilled") next.models = modelsResult.value;
    else failures.models = harnessErrorText(modelsResult.reason);
    if (queueResult.status === "fulfilled") {
      const queue = readCockpitQueue(queueResult.value);
      if (queue) next.queue = queue;
    } else failures.queue = harnessErrorText(queueResult.reason);
    setSnapshot(next);
    setErrors(failures);
    setLoading(false);
    setLoadedOnce(true);
    setUpdatedAt(Date.now());
  }, [harnessUp, threadId]);

  useEffect(() => {
    if (!isOpen) { epoch.current += 1; return; }
    void load(true);
  }, [isOpen, load]);

  useEffect(() => {
    if (!isOpen || !harnessUp) return;
    const api = window.boss;
    if (!api) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = api.onNotification(raw => {
      if (!shouldRefreshCockpit(raw?.method)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void load(false); }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [isOpen, harnessUp, load]);

  if (!isOpen) return null;

  const { config, resources, approvals, tools, models, queue } = snapshot;
  const configKnown = !errors.config && config !== undefined;
  const approvalsKnown = !errors.approvals && approvals !== undefined;
  const toolsKnown = !errors.tools && tools !== undefined;
  const modelsKnown = !errors.models && models !== undefined;
  const queueKnown = !errors.queue && queue !== undefined;
  const approvalRequiredCount = toolsKnown ? tools.filter(tool => tool.requiresApproval).length : undefined;
  const configuredModelCount = modelsKnown ? models.filter(model => model.configured).length : undefined;
  const updatedText = updatedAt === null ? "" : new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false });

  return (
    <ModalSurface title="运行状态" onClose={onClose} className="cockpit-dialog">
      <div className="cockpit-toolbar">
        <div className="cockpit-tabs-row" role="tablist" aria-label="运行状态分区">
          {TABS.map(tab => (
            <button key={tab.key} className={`cockpit-tab-btn ${activeTab === tab.key ? "active" : ""}`}
              onClick={() => setActiveTab(tab.key)} type="button" role="tab" aria-selected={activeTab === tab.key}>
              {tab.label}
            </button>
          ))}
        </div>
        <button className="cockpit-refresh" type="button" disabled={!harnessUp || loading}
          onClick={() => { void load(false); }}>{loading && loadedOnce ? "刷新中…" : "刷新"}</button>
      </div>
      <div className="cockpit-body">
        <p className="dialog-note cockpit-notice">
          {harnessUp
            ? `数据来自本地内核只读接口${updatedText ? ` · ${updatedText} 更新` : ""}，回合、审批与队列变化时自动刷新。当前版本不接入 MCP；不展示成本、缓存命中率、沙箱或死循环指标。`
            : "本地内核未连接，无法读取运行状态。重新连接后打开此面板即可刷新。"}
        </p>
        {loading && !loadedOnce ? <p className="cockpit-empty" role="status">正在读取内核状态…</p> : null}

        {activeTab === "overview" && (
          <div className="cockpit-grid">
            <section className="cockpit-card">
              <h3>内核线路</h3>
              {errors.config ? <p className="cockpit-error">配置读取失败：{errors.config}</p> : config ? (
                <div className="cockpit-facts">
                  <Fact label="Provider" value={config.provider ?? "未提供"} />
                  <Fact label="模型" value={config.model ?? "未提供"} />
                  <Fact label="协议" value={config.protocolVersion ?? "未提供"} />
                  <Fact label="工具包" value={config.toolBundleId ?? "未提供"} />
                  <Fact label="上下文窗口" value={config.contextWindow === undefined ? "未提供"
                    : `${NUMBER.format(config.contextWindow)} token${config.capacityIsEstimate ? "（估算）" : ""}`} />
                  <Fact label="最大输出" value={config.modelMaxOutputTokens === undefined ? "未提供"
                    : `${NUMBER.format(config.modelMaxOutputTokens)} token`} />
                  <Fact label="推理档位" value={config.reasoningEfforts?.length ? config.reasoningEfforts.join(" / ") : "未提供"} />
                  <Fact label="能力来源" value={config.capabilitySource ?? "未提供"} />
                </div>
              ) : <p className="cockpit-empty">尚未读取配置。</p>}
            </section>

            <section className="cockpit-card">
              <h3>运行资源</h3>
              {errors.resources ? <p className="cockpit-error">资源读取失败：{errors.resources}</p> : resources ? (
                <div className="cockpit-facts">
                  <Fact label="并发业务回合" value={`${NUMBER.format(resources.activeTurnCount)} / ${NUMBER.format(resources.turnCapacity)}`} />
                  <Fact label="保留回合" value={`${NUMBER.format(resources.retainedTurnCount)} / ${NUMBER.format(resources.maxRetainedTurns)}`} />
                  <Fact label="运行中 owner" value={`${NUMBER.format(resources.ownerCount)}${resources.ownersTruncated ? `（可见 ${resources.owners.length}）` : ""}`} />
                  <Fact label="容量等待" value={`${NUMBER.format(resources.waiterCount)}${resources.waitersTruncated ? `（可见 ${resources.waiters.length}）` : ""}`} />
                </div>
              ) : <p className="cockpit-empty">尚未读取运行资源。</p>}
            </section>

            <section className="cockpit-card">
              <h3>待办与目录</h3>
              <div className="cockpit-facts">
                <Fact label="待审批" value={errors.approvals ? "读取失败" : approvals
                  ? `${NUMBER.format(approvals.length)}${approvals.length >= APPROVAL_LIMIT ? "（已达显示上限）" : ""}`
                  : "未提供"} />
                <Fact label="工具" value={errors.tools ? "读取失败" : tools ? `${NUMBER.format(tools.length)}（需审批 ${numberText(approvalRequiredCount)}）` : "未提供"} />
                <Fact label="模型线路" value={errors.models ? "读取失败" : models ? `${NUMBER.format(models.length)}（当前配置 ${numberText(configuredModelCount)}）` : "未提供"} />
                <Fact label="当前会话队列" value={errors.queue ? "读取失败" : threadId === null ? "未选择会话"
                  : queueKnown ? queueSummaryText(queue ?? null) : "未提供"} />
              </div>
            </section>

            <section className="cockpit-card">
              <h3>调度与策略</h3>
              {errors.config ? <p className="cockpit-error">配置读取失败：{errors.config}</p> : config ? (
                <div className="cockpit-facts">
                  <Fact label="审批策略" value={config.approvalPolicy ?? "未提供"} />
                  <Fact label="审批期限" value={config.approvalTimeoutSeconds === undefined ? "未提供" : `${durationText(config.approvalTimeoutSeconds)}`} />
                  <Fact label="转向投递" value={config.steeringMode ?? "未提供"} />
                  <Fact label="并行线程" value={numberText(config.parallelThreads)} />
                  <Fact label="单回合模型请求上限" value={numberText(config.maxModelRequests)} />
                  <Fact label="自动压缩" value={compactionSummary(config)} />
                  <Fact label="压缩策略来源" value={compactionSourceLabel(config.autoCompactionSource)} />
                </div>
              ) : <p className="cockpit-empty">尚未读取配置。</p>}
            </section>
          </div>
        )}

        {activeTab === "turns" && (
          <div className="cockpit-stack">
            <SourceError label="运行资源" error={errors.resources} />
            {resources ? (
              <>
                <h3 className="cockpit-subheading">运行中或收尾中的 owner（{NUMBER.format(resources.ownerCount)}）</h3>
                <p className="dialog-note">可逐个 owner 经 task/read 核对持久记录；核对为只读，不恢复、不重放、不取消任务。</p>
                {resources.ownersTruncated ? <p className="dialog-note">明细已按内核上限截断，仅显示 {resources.owners.length} 项。</p> : null}
                {resources.owners.length === 0
                  ? <p className="cockpit-empty">当前没有运行中或收尾中的回合与摘要任务。</p>
                  : <div className="cockpit-list">{resources.owners.map((owner, index) => <OwnerRow key={`${owner.kind}:${owner.id}:${index}`} owner={owner}
                    check={taskChecks[`${owner.kind}:${owner.id}`]} onCheck={() => { void runTaskCheck(owner); }} />)}</div>}
                <h3 className="cockpit-subheading">容量等待（{NUMBER.format(resources.waiterCount)}）</h3>
                {resources.waitersTruncated ? <p className="dialog-note">等待明细已按内核上限截断，仅显示 {resources.waiters.length} 项。</p> : null}
                {resources.waiters.length === 0
                  ? <p className="cockpit-empty">当前没有等待业务回合容量的会话。</p>
                  : <div className="cockpit-list">{resources.waiters.map((waiter, index) => (
                    <div className="cockpit-row" key={`${waiter.threadId}:${waiter.position}:${index}`}>
                      <div className="cockpit-row-main">
                        <div className="cockpit-row-title">第 {waiter.position} 位 · 会话 {shortId(waiter.threadId)}</div>
                        <div className="cockpit-row-sub">已等待 {durationText(waiter.waitingSeconds)}</div>
                      </div>
                    </div>
                  ))}</div>}
              </>
            ) : !errors.resources ? <p className="cockpit-empty">尚未读取运行资源。</p> : null}
          </div>
        )}

        {activeTab === "approvals" && (
          <div className="cockpit-stack">
            <SourceError label="待审批列表" error={errors.approvals} />
            {approvals ? (
              approvals.length === 0
                ? <p className="cockpit-empty">当前没有待审批的调用。写操作仍会逐次请求批准。</p>
                : <>
                  <div className="cockpit-list">{approvals.map(approval => <ApprovalRow key={approval.approvalId} approval={approval} />)}</div>
                  {approvals.length >= APPROVAL_LIMIT
                    ? <p className="cockpit-empty">审批清单最多显示 {APPROVAL_LIMIT} 条；其余请求仍以内核待审批状态为准。</p>
                    : null}
                </>
            ) : !errors.approvals ? <p className="cockpit-empty">尚未读取审批列表。</p> : null}
          </div>
        )}

        {activeTab === "catalog" && (
          <div className="cockpit-stack">
            <h3 className="cockpit-subheading">工具（{toolsKnown ? tools.length : "未读取"}）</h3>
            <SourceError label="工具清单" error={errors.tools} />
            <p className="dialog-note">
              工具来自当前 ToolBundle（{configKnown ? config.toolBundleId ?? "标识未提供" : "配置未读取"}）；只读工具无需批准，写操作逐次批准。
              当前版本不接入 MCP，本面板不展示不存在的服务器状态。
            </p>
            {tools && tools.length > 0 ? (
              <div className="cockpit-list">{tools.map(tool => (
                <div className="cockpit-row" key={tool.name}>
                  <div className="cockpit-row-main">
                    <div className="cockpit-row-title">{tool.name}</div>
                    {tool.description ? <div className="cockpit-row-sub">{tool.description}</div> : null}
                  </div>
                  <div className="cockpit-badges">
                    <span className={`cockpit-badge ${tool.readOnly ? "" : "cockpit-badge-warn"}`}>{tool.readOnly ? "只读" : "写操作"}</span>
                    {tool.requiresApproval ? <span className="cockpit-badge cockpit-badge-warn">逐次审批</span> : null}
                    {tool.executionMode === "sequential" ? <span className="cockpit-badge">串行</span> : null}
                  </div>
                </div>
              ))}</div>
            ) : tools && tools.length === 0 ? <p className="cockpit-empty">内核未返回工具条目。</p> : null}

            <h3 className="cockpit-subheading">模型（{modelsKnown ? models.length : "未读取"}）</h3>
            <SourceError label="模型目录" error={errors.models} />
            {models && models.length > 0 ? (
              <div className="cockpit-list">{models.map(model => (
                <div className="cockpit-row" key={`${model.provider}:${model.id}`}>
                  <div className="cockpit-row-main">
                    <div className="cockpit-row-title">{model.id}</div>
                    <div className="cockpit-row-sub">
                      {model.provider}
                      {model.contextWindow === undefined ? "" : ` · ${NUMBER.format(model.contextWindow)} token 上下文`}
                      {model.maxOutputTokens === undefined ? "" : ` · 最大输出 ${NUMBER.format(model.maxOutputTokens)}`}
                      {model.reasoningEfforts?.length ? ` · 推理 ${model.reasoningEfforts.join(" / ")}` : ""}
                    </div>
                  </div>
                  <div className="cockpit-badges">
                    {model.configured ? <span className="cockpit-badge">当前配置</span> : null}
                    <span className={`cockpit-badge ${model.available ? "" : "cockpit-badge-warn"}`}>{model.available ? "线路可用" : "线路缺失"}</span>
                    {model.capacityIsEstimate ? <span className="cockpit-badge">容量估算</span> : null}
                  </div>
                </div>
              ))}</div>
            ) : models && models.length === 0 ? <p className="cockpit-empty">内核未返回模型条目。</p> : null}
          </div>
        )}
      </div>
    </ModalSurface>
  );
};
