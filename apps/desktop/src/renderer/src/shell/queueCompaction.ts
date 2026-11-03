import type { AutoCompactionPolicy } from "@boss-harness/protocol";

/** 队列覆盖只有前三个字段；回合策略还可能带摘要线路。 */
type CompactionFacts = Partial<AutoCompactionPolicy>;

/** 只显示最重要的一个事实；完整字段放进 title。 */
export const compactionLabel = (policy: CompactionFacts): string => {
  if (policy.enabled === false) return "压缩关闭";
  if (policy.triggerPercent !== undefined) return `压缩 ${policy.triggerPercent}%`;
  if (policy.enabled === true) return "压缩开启";
  return "压缩覆盖";
};

export const compactionTitle = (policy: CompactionFacts): string => {
  const facts: string[] = [];
  if (policy.enabled !== undefined) facts.push(policy.enabled ? "启用自动压缩" : "关闭自动压缩");
  if (policy.triggerPercent !== undefined) facts.push(`触发阈值 ${policy.triggerPercent}%`);
  if (policy.keepRecentTokens !== undefined) facts.push(`保留最近 ${policy.keepRecentTokens} token`);
  if (policy.provider || policy.model || policy.effort) {
    const route = `${policy.provider || "默认线路"} / ${policy.model || "默认模型"}`;
    facts.push(`摘要线路 ${route}${policy.effort ? ` · ${policy.effort}` : ""}`);
  }
  return facts.length ? facts.join("；") : "本回合沿用内核默认自动压缩策略";
};
