import type { MessageItem } from "./mockData";

/**
 * 会话区本地消息与父级下发消息的合并。
 *
 * 审批、提问与计划卡的操作先写本地副本；内核确认前，父级可能因流式事件、刷新、
 * 续接或分支切换重新下发整组消息。直接替换会丢掉这些标记：已提交的审批卡重新变成
 * 可提交，已回答的问题与已保存的计划回退。这里以新消息为准，只保留新数据尚未给出
 * 结果的本地操作；新数据已经带有结论时让位，避免旧状态盖住内核结果。
 *
 * 只遍历新数组并按消息 id 取本地副本：父级已移除的消息不会复活，新消息原样使用。
 */
export function mergeLocalMessageState(incoming: MessageItem[], previous: MessageItem[]): MessageItem[] {
  if (!previous.length) return incoming;
  const localById = new Map(previous.map(message => [message.id, message]));
  return incoming.map(message => {
    const local = localById.get(message.id);
    return local ? mergeMessage(message, local) : message;
  });
}

function mergeMessage(incoming: MessageItem, local: MessageItem): MessageItem {
  let merged = incoming;

  const approval = incoming.approval;
  const localApproval = local.approval;
  // 同一张审批卡才合并；内核给出结论（包括超时）后一律以新数据为准。
  if (approval && localApproval && approval.approvalId === localApproval.approvalId && approval.decision === undefined) {
    if (localApproval.decision !== undefined) {
      merged = { ...merged, approval: { ...approval, decision: localApproval.decision,
        ...(localApproval.remember !== undefined ? { remember: localApproval.remember } : {}) } };
    } else if (localApproval.submitted === true) {
      // 真实模式已送达但尚无结论：保留提交标记，避免审批卡重新可点、重复提交。
      merged = { ...merged, approval: { ...approval, submitted: true } };
    }
  }

  const question = incoming.question;
  const localQuestion = local.question;
  if (question && localQuestion && question.id === localQuestion.id
    && question.answered !== true && localQuestion.answered === true) {
    merged = { ...merged, question: { ...question, answered: true, selected: localQuestion.selected } };
  }

  const plan = incoming.plan;
  const localPlan = local.plan;
  // 计划卡只在示例模式可编辑；新数据仍为待确认时保留本地已保存的结论与正文。
  if (plan && localPlan && plan.slug === localPlan.slug) {
    if (plan.status === "submitted" && localPlan.status !== "submitted") {
      merged = { ...merged, plan: { ...plan, status: localPlan.status, selectedOption: localPlan.selectedOption, content: localPlan.content } };
    } else if (plan.selectedOption === undefined && localPlan.selectedOption !== undefined) {
      merged = { ...merged, plan: { ...plan, selectedOption: localPlan.selectedOption } };
    }
  }

  return merged;
}
