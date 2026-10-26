import React, { useState, useRef, useEffect } from "react";
import { IconCopy, IconThumbsUp, IconThumbsDown, IconRewind, IconSparkles, IconCheck, IconQuote, IconEdit, IconChevronDown, IconTerminal, IconHelp, IconClose, IconPanel, IconShield } from "../components/Icons";
import { DiffCard } from "./DiffCard";
import { Composer } from "./Composer";
import { RichMarkdown } from "../components/RichMarkdown";
import { ToolResultDetails } from "../components/ToolResultDetails";
import { QueuePanel } from "./QueuePanel";
import type { QueueItem } from "@boss-cli/protocol";
import type { SkillDescriptor } from "@boss-cli/protocol";
import { type MessageItem, type ConversationMode } from "../data/mockData";
import type { SkillCatalogState } from "../data/harnessBridge";
import { createComposerDraft, withDraftText, type ComposerDraft, type UpdateComposerDraft, type ComposerSend, type ComposerQueue, type CheckQueueSubmission } from "../data/composerDraft";

export interface ConversationAreaProps {
  messages: MessageItem[]; currentMode: ConversationMode; onModeChange: (mode: ConversationMode) => void;
  onSendMessage: ComposerSend;
  onQueueMessage?: ComposerQueue; onCheckQueueSubmission?: CheckQueueSubmission; queueItems?: QueueItem[]; onRemoveQueueItem?: (id: string) => Promise<boolean>;
  draft?: ComposerDraft; onDraftChange?: UpdateComposerDraft; simulateLocal?: boolean; running?: boolean; taskBlocked?: boolean;
  activeModelId?: string; onSelectModel?: (id: string) => void; onOpenSettings?: () => void; onInterrupt?: () => void;
  skills?: SkillDescriptor[]; skillCatalogState?: SkillCatalogState; onRefreshSkills?: () => void;
  configuredModelLabel?: string; readOnly?: boolean;
  loginGuide?: React.ReactNode; onLogin?: () => void;
  onApprovalDecision?: (approvalId: string, approved: boolean, toolName: string, remember: boolean) => void | boolean | Promise<boolean>;
  onReviewDiff?: () => void; onRevertDiff?: () => void; onOpenRewind?: () => void; onOpenCockpit?: () => void;
}
export const ConversationArea: React.FC<ConversationAreaProps> = ({
  messages: initialMessages, readOnly = false, currentMode, onModeChange, onSendMessage, onQueueMessage, onCheckQueueSubmission, queueItems = [], onRemoveQueueItem, simulateLocal = true,
  running = false, taskBlocked = false, draft, onDraftChange, activeModelId, configuredModelLabel, onSelectModel, onOpenSettings,
  onInterrupt, onApprovalDecision, onReviewDiff, onRevertDiff, onOpenRewind, loginGuide, onLogin,
  skills = [], skillCatalogState = "unavailable", onRefreshSkills,
}) => {
  const [messages, setMessages] = useState<MessageItem[]>(initialMessages);
  const [localDraft, setLocalDraft] = useState(createComposerDraft);
  const composerDraft = draft ?? localDraft;
  const updateDraft = onDraftChange ?? setLocalDraft;
  const inputText = composerDraft.text;
  const setInputText = (text: string) => updateDraft(previous => withDraftText(previous, text));
  const [approvalDrafts, setApprovalDrafts] = useState<Record<string, string>>({});
  const [approvalEditing, setApprovalEditing] = useState<Record<string, boolean>>({});
  const [rememberChoices, setRememberChoices] = useState<Record<string, boolean>>({});
  const [questionPicks, setQuestionPicks] = useState<Record<string, string[]>>({});
  const [planEditing, setPlanEditing] = useState<Record<string, boolean>>({});
  const [planDrafts, setPlanDrafts] = useState<Record<string, string>>({});
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, "up" | "down" | undefined>>({});
  const [approvalError, setApprovalError] = useState("");
  const [pendingApproval, setPendingApproval] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);
  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  useEffect(() => { setMessages(initialMessages); }, [initialMessages]);
  useEffect(() => { if (wasAtBottom.current) messagesEndRef.current?.scrollIntoView({ behavior: "auto" }); }, [messages, running]);
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    wasAtBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 120;
    setShowScrollBottom(!wasAtBottom.current);
  };
  const handleRetry = () => {
    if (running || taskBlocked) return;
    const last = [...messages].reverse().find(message => message.role === "user")?.content;
    if (last) onSendMessage(last);
  };
  const handleApproval = async (msgId: string, decision: "approve" | "deny") => {
    const target = messages.find(message => message.id === msgId);
    const approval = target?.approval;
    if (!approval || pendingApproval) return;
    const remember = !approval.consequential && (rememberChoices[msgId] || false);
    if (approval.approvalId) {
      setPendingApproval(msgId); setApprovalError("");
      const accepted = await onApprovalDecision?.(approval.approvalId, decision === "approve", approval.toolName, remember);
      setPendingApproval(null);
      if (accepted !== true) { setApprovalError("审批未被受理，请检查连接或等待状态刷新后重试。"); return; }
      if (!simulateLocal) {
        setMessages(previous => previous.map(message => message.id === msgId && message.approval
          ? { ...message, approval: { ...message.approval, submitted: true } } : message));
        return;
      }
    }
    setMessages(previous => previous.map(message => message.id === msgId && message.approval
      ? { ...message, approval: { ...message.approval, decision, remember } } : message));
  };

  // 处理提问卡选项点击
  const handleQuestionToggle = (msgId: string, option: string, allowMultiple = false) => {
    setQuestionPicks((prev) => {
      const current = prev[msgId] || [];
      if (!allowMultiple) {
        return { ...prev, [msgId]: [option] };
      }
      return {
        ...prev,
        [msgId]: current.includes(option)
          ? current.filter((o) => o !== option)
          : [...current, option],
      };
    });
  };

  const handleQuestionSubmit = (msgId: string) => {
    const picked = questionPicks[msgId] || [];
    if (picked.length === 0) return;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id === msgId && m.question) {
          return {
            ...m,
            question: {
              ...m.question,
              selected: picked,
              answered: true,
            },
          };
        }
        return m;
      })
    );
    // 模拟回传给 Agent
    onSendMessage(`回答：${picked.join("、")}`);
  };

  const firstUserMsg = messages.find((m) => m.role === "user")?.content;
  const threadTitle = firstUserMsg
    ? firstUserMsg.length > 28
      ? `${firstUserMsg.slice(0, 28)}…`
      : firstUserMsg
    : "招聘任务会话";

  return (
    <div className="thread-workspace">
      {/* 极简顶栏 (ThreadHeaderBar - 对齐 ChatGPT.app) */}
      <div className="thread-header-bar">
        <div className="thread-header-title" title={firstUserMsg || "会话详情"}>
          <span>{threadTitle}</span>
        </div>

        <div className="mode-segmented-control">
          <button
            className={`mode-segment-btn ${currentMode === "plan" ? "active" : ""}`}
            onClick={() => onModeChange("plan")}
            title="Plan 模式：只读调研并生成计划"
          >
            Plan
          </button>
          <button
            className={`mode-segment-btn ${currentMode === "ask" ? "active" : ""}`}
            onClick={() => onModeChange("ask")}
            title="Ask 模式：纯问答，不执行工具"
          >
            Ask
          </button>
          <button
            className={`mode-segment-btn ${currentMode === "agent" ? "active" : ""}`}
            onClick={() => onModeChange("agent")}
            title="Agent 模式：自主调用工具与执行"
          >
            Agent
          </button>
        </div>
      </div>

      {/* 消息滚动流 */}
      <div className="messages-container" ref={scrollerRef} onScroll={handleScroll}>
        <div className="messages-inner">
          {messages.map((item) => {
            if (item.role === "user") {
              return (
                <div key={item.id} className="msg-row-user" id={"message-" + item.id}>
                  <div className="user-bubble">{item.content}</div>
                  <div className="user-msg-footer">
                    <button
                      className="user-msg-action-btn"
                      type="button"
                      title="编辑消息"
                      onClick={() => setInputText(item.content || "")}
                    >
                      <IconEdit size={12} />
                    </button>
                    <button
                      className="user-msg-action-btn"
                      type="button"
                      title="从此节点回溯 (Rewind)"
                      onClick={onOpenRewind}
                    >
                      <IconRewind size={12} />
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div key={item.id} className="msg-row-agent">
                {/* 思考过程计时器 */}
                {item.thinkingTime && (
                  <details className="thinking-block">
                    <summary className="thinking-summary">
                      <IconSparkles size={12} style={{ color: "var(--accent-color)" }} />
                      <span>{item.thinkingTime}</span>
                    </summary>
                    {item.thinkingContent && (
                      <div className="thinking-content">{item.thinkingContent}</div>
                    )}
                  </details>
                )}

                {item.plan && (
                  <div className="plan-card">
                    <div className="plan-head"><div className="plan-title"><IconPanel size={14} /><span>{item.plan.title}</span></div><span className="plan-status-badge">{item.plan.status === "approved" ? "已批准" : item.plan.status === "rejected" ? "已驳回" : "待确认"}{simulateLocal ? " · 示例" : ""}</span></div>
                    <details open={planEditing[item.id] || undefined}>
                      <summary className="plan-disclosure">查看执行计划</summary>
                      {planEditing[item.id] ? <textarea className="approval-edit-textarea" aria-label="编辑示例计划" rows={8} value={planDrafts[item.id] ?? item.plan.content} onChange={event => setPlanDrafts(previous => ({ ...previous, [item.id]: event.target.value }))} /> : <div className="agent-markdown"><RichMarkdown content={item.plan.content} /></div>}
                      <div className="plan-options-grid">{item.plan.options.map(option => <label className={`plan-option-label ${item.plan?.selectedOption === option.id ? "active" : ""}`} key={option.id}>
                        <input type="radio" name={`plan-${item.plan?.slug}`} checked={item.plan?.selectedOption === option.id} disabled={!simulateLocal} onChange={() => setMessages(previous => previous.map(message => message.id === item.id && message.plan ? { ...message, plan: { ...message.plan, selectedOption: option.id, status: "submitted" } } : message))} />
                        <div><strong>{option.label}</strong><p>{option.desc}</p></div>
                      </label>)}</div>
                      {simulateLocal && <div className="approval-actions">
                        <button className="approval-btn approve" onClick={() => { setMessages(previous => previous.map(message => message.id === item.id && message.plan ? { ...message, plan: { ...message.plan, content: planDrafts[item.id] ?? message.plan.content, status: "approved" } } : message)); setPlanEditing(previous => ({ ...previous, [item.id]: false })); }}>保存示例计划</button>
                        <button className="approval-btn secondary" onClick={() => setPlanEditing(previous => ({ ...previous, [item.id]: !previous[item.id] }))}>{planEditing[item.id] ? "取消编辑" : "编辑"}</button>
                        <button className="approval-btn deny" onClick={() => setMessages(previous => previous.map(message => message.id === item.id && message.plan ? { ...message, plan: { ...message.plan, status: "rejected" } } : message))}>驳回</button>
                      </div>}
                      {simulateLocal && <p className="plan-preview-note">仅修改示例计划，不执行招聘操作。</p>}
                    </details>
                  </div>
                )}

                {/* 工具调用块 */}
                {item.toolUse && (
                  <details className="tool-block">
                    <summary className="tool-summary">
                      <IconTerminal size={12} />
                      <span>调用工具: <strong>{item.toolUse.name}</strong></span>
                    </summary>
                    <div className="tool-code-preview">{item.toolUse.input}</div>
                    {item.toolUse.source && <div className="tool-source-reference"><span>来源编号</span><code>{item.toolUse.source.ref}</code><span>查询于 {new Date(item.toolUse.source.queriedAt).toLocaleString()}</span></div>}
                    {item.toolUse.result && (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 12,
                          color: "var(--text-muted)",
                          padding: "4px 8px",
                          background: "rgba(255, 255, 255, 0.02)",
                          borderRadius: 4,
                        }}
                      >
                        {item.toolUse.result}
                      </div>
                    )}
                    <ToolResultDetails output={item.toolUse.output} resultRef={item.toolUse.resultRef} />
                  </details>
                )}

                {/* 结构化提问卡 QuestionCard */}
                {item.question && (
                  <div className="question-card">
                    <div className="question-prompt">
                      <IconHelp size={14} />
                      <span>{item.question.prompt}</span>
                    </div>

                    <div className="question-options-row">
                      {item.question.options.map((opt) => {
                        const isPicked =
                          (questionPicks[item.id] || item.question?.selected || []).includes(
                            opt
                          );
                        return (
                          <button
                            key={opt}
                            className={`question-opt-btn ${isPicked ? "picked" : ""}`}
                            disabled={item.question?.answered}
                            onClick={() =>
                              handleQuestionToggle(
                                item.id,
                                opt,
                                item.question?.allowMultiple
                              )
                            }
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>

                    {!item.question.answered ? (
                      <div className="approval-actions">
                        <button
                          className="approval-btn approve"
                          onClick={() => handleQuestionSubmit(item.id)}
                          disabled={(questionPicks[item.id]?.length ?? 0) === 0}
                        >
                          提交
                        </button>
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: "var(--accent-green)", display: "flex", alignItems: "center", gap: 4 }}>
                        <IconCheck size={12} />
                        <span>已提交</span>
                      </div>
                    )}
                  </div>
                )}

                {/* 智能体文本段落 (ChatGPT.app 级富文本与代码高亮排版) */}
                {item.paragraphs && item.paragraphs.length > 0 && (
                  <RichMarkdown content={item.paragraphs.join("\n\n")} />
                )}

                {/* 工具审批卡 ApprovalCard */}
                {item.approval && (
                  <div className="approval-card">
                    <div className="approval-head">
                      <IconShield size={14} />
                      <span>
                        敏感操作审批：<b>{item.approval.toolName}</b>
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {item.approval.description}
                    </div>

                    {approvalEditing[item.id] ? (
                      <textarea
                        className="approval-edit-textarea"
                        rows={5}
                        value={
                          approvalDrafts[item.id] ??
                          JSON.stringify(item.approval.params, null, 2)
                        }
                        onChange={(e) =>
                          setApprovalDrafts({
                            ...approvalDrafts,
                            [item.id]: e.target.value,
                          })
                        }
                      />
                    ) : (
                      <pre className="approval-payload">
                        {JSON.stringify(item.approval.params, null, 2)}
                      </pre>
                    )}

                    {item.approval.decision ? (
                      <div
                        style={{
                          fontSize: 12,
                          color:
                            item.approval.decision === "approve"
                              ? "var(--accent-green)"
                              : "var(--accent-error)",
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        {item.approval.decision === "approve" ? (
                          <>
                            <IconCheck size={12} />
                            <span>已批准</span>
                          </>
                        ) : item.approval.decision === "expired" ? (
                          <span>等待超时，已按未批准处理</span>
                        ) : (
                          <>
                            <IconClose size={12} />
                            <span>已拒绝</span>
                          </>
                        )}
                      </div>
                    ) : (
                      <>
                        <label className="approval-remember-label">
                          <input
                            type="checkbox"
                            disabled={Boolean(item.approval.consequential)}
                            checked={rememberChoices[item.id] || false}
                            onChange={(e) =>
                              setRememberChoices({
                                ...rememberChoices,
                                [item.id]: e.target.checked,
                              })
                            }
                          />
                          <span>{item.approval.consequential ? "对外操作需要逐次确认" : "本次会话记住选择"}</span>
                        </label>

                        <div className="approval-actions">
                          {approvalEditing[item.id] ? (
                            <>
                              <button
                                className="approval-btn approve"
                                onClick={() => {
                                  setApprovalEditing({
                                    ...approvalEditing,
                                    [item.id]: false,
                                  });
                                  handleApproval(item.id, "approve");
                                }}
                              >
                                修改并批准
                              </button>
                              <button
                                className="approval-btn secondary"
                                disabled={Boolean(item.approval.approvalId)}
                                title={item.approval.approvalId ? "当前请求参数只读；请拒绝后重新发起" : "编辑示例参数"}
                                onClick={() =>
                                  setApprovalEditing({
                                    ...approvalEditing,
                                    [item.id]: false,
                                  })
                                }
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="approval-btn approve"
                                disabled={pendingApproval === item.id || item.approval.submitted}
                                onClick={() => void handleApproval(item.id, "approve")}
                              >
                                {item.approval.submitted ? "已提交，等待确认" : "批准"}
                              </button>
                              <button
                                className="approval-btn secondary"
                                disabled={Boolean(item.approval.approvalId)}
                                title={item.approval.approvalId ? "当前请求参数只读；请拒绝后重新发起" : "编辑示例参数"}
                                onClick={() =>
                                  setApprovalEditing({
                                    ...approvalEditing,
                                    [item.id]: true,
                                  })
                                }
                              >
                                改参数
                              </button>
                              <button
                                className="approval-btn deny"
                                disabled={pendingApproval === item.id || item.approval.submitted}
                                onClick={() => handleApproval(item.id, "deny")}
                              >
                                拒绝
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* 变更卡片 DiffCard */}
                {item.showDiffCard && item.diffSummary && (
                  <DiffCard
                    fileCount={item.diffSummary.fileCount}
                    additions={item.diffSummary.additions}
                    deletions={item.diffSummary.deletions}
                    initialFiles={item.diffSummary.initialFiles}
                    extraFiles={item.diffSummary.extraFiles}
                    onReviewChanges={onReviewDiff}
                    onRevertChanges={onRevertDiff}
                  />
                )}

                {/* 消息底部快捷工具栏 (ChatGPT.app 纯图标紧凑交互) */}
                <div className="msg-action-toolbar">
                  <button
                    className="msg-action-btn"
                    title="复制"
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(
                        item.paragraphs?.join("\n\n") || item.content || ""
                      );
                    }}
                  >
                    <IconCopy size={13} />
                  </button>
                  <button
                    className="msg-action-btn"
                    title="引用"
                    type="button"
                    onClick={() => {
                      const quote = item.paragraphs?.[0] || item.content || "";
                      setInputText(`> ${quote.slice(0, 100)}...\n\n`);
                      textareaRef.current?.focus();
                    }}
                  >
                    <IconQuote size={13} />
                  </button>
                  <button
                    className="msg-action-btn"
                    title="重试此轮对话"
                    type="button"
                    onClick={() => handleRetry()}
                  >
                    <IconRewind size={13} />
                  </button>
                  <button
                    className={`msg-action-btn ${feedback[item.id] === "up" ? "active" : ""}`}
                    title="有帮助"
                    type="button"
                    style={feedback[item.id] === "up" ? { color: "var(--accent-green)" } : undefined}
                    onClick={() =>
                      setFeedback((prev) => ({
                        ...prev,
                        [item.id]: prev[item.id] === "up" ? undefined! : "up",
                      }))
                    }
                  >
                    <IconThumbsUp size={13} />
                  </button>
                  <button
                    className={`msg-action-btn ${feedback[item.id] === "down" ? "active" : ""}`}
                    title="需要改进"
                    type="button"
                    style={feedback[item.id] === "down" ? { color: "var(--accent-error)" } : undefined}
                    onClick={() =>
                      setFeedback((prev) => ({
                        ...prev,
                        [item.id]: prev[item.id] === "down" ? undefined! : "down",
                      }))
                    }
                  >
                    <IconThumbsDown size={13} />
                  </button>
                </div>
              </div>
            );
          })}
          {running && <div className="agent-running-indicator" role="status"><span /><span /><span /><p>正在处理任务…</p></div>}
          {!messages.length && !running && <div className="conversation-empty"><IconSparkles size={25} /><p>开始这个聊天</p><span>在下方输入你的招聘任务。</span></div>}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* 悬浮回到底部按钮 (ChatGPT.app 交互规范) */}
      {showScrollBottom && (
        <button
          className="scroll-to-bottom-btn"
          type="button"
          title="回到底部"
          onClick={scrollToBottom}
        >
          <IconChevronDown size={14} />
        </button>
      )}

      <div className="thread-composer-wrapper">
        <div className="thread-composer-inner">
          {!simulateLocal && <QueuePanel items={queueItems} onRemove={onRemoveQueueItem ?? (async () => false)} />}
          {loginGuide}
          {approvalError && <div className="composer-notice" role="alert">{approvalError}</div>}
          <div className="thread-composer-input"><Composer ref={textareaRef} value={inputText} onChange={setInputText} onSend={onSendMessage} onQueue={simulateLocal ? undefined : onQueueMessage} onCheckQueueSubmission={simulateLocal ? undefined : onCheckQueueSubmission} draft={composerDraft} onDraftChange={updateDraft} skills={skills} skillCatalogState={skillCatalogState} onRefreshSkills={onRefreshSkills}
            readOnly={readOnly} isRunning={running} blocked={taskBlocked} onInterrupt={onInterrupt} preview={simulateLocal}
            currentMode={currentMode} onModeChange={onModeChange} activeModelId={activeModelId} configuredModelLabel={configuredModelLabel}
            onSelectModel={onSelectModel} onOpenSettings={onOpenSettings} onLogin={onLogin} /></div>
        </div>
      </div>
    </div>
  );
};
