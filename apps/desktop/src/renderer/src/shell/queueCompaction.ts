import type { QueueItem } from "@boss-cli/protocol";

type QueueCompaction = NonNullable<QueueItem["autoCompaction"]>;

/** 队列项只显示最重要的一个事实；完整字段放进 title。 */
export const compactionLabel = (policy: QueueCompaction): string => {
  if (policy.enabled === false) return "压缩关闭";
  if (policy.triggerPercent !== undefined) return `压缩 ${policy.triggerPercent}%`;
  if (policy.enabled === true) return "压缩开启";
  return "压缩覆盖";
};

export const compactionTitle = (policy: QueueCompaction): string => {
  const facts: string[] = [];
  if (policy.enabled !== undefined) facts.push(policy.enabled ? "启用自动压缩" : "关闭自动压缩");
  if (policy.triggerPercent !== undefined) facts.push(`触发阈值 ${policy.triggerPercent}%`);
  if (policy.keepRecentTokens !== undefined) facts.push(`保留最近 ${policy.keepRecentTokens} token`);
  return facts.length ? facts.join("；") : "本回合沿用内核默认自动压缩策略";
};
