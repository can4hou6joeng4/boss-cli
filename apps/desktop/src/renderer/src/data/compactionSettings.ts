import type { AutoCompactionPolicy, AutoCompactionSetParams, AutoCompactionSource } from "@boss-harness/protocol";

export interface CompactionSettingDraft {
  enabled: boolean;
  triggerPercent: string;
  keepRecentTokens: string;
}

/** 把内核返回的策略映射为可编辑草稿；任一字段非法时返回 null，不用默认值掩盖未知。 */
export function compactionDraft(value: unknown): CompactionSettingDraft | null {
  const policy = value as AutoCompactionPolicy | undefined;
  if (!policy || typeof policy.enabled !== "boolean" ||
    !Number.isSafeInteger(policy.triggerPercent) || policy.triggerPercent < 1 || policy.triggerPercent > 100 ||
    !Number.isSafeInteger(policy.keepRecentTokens) || policy.keepRecentTokens < 1 || policy.keepRecentTokens > 1_000_000) {
    return null;
  }
  return { enabled: policy.enabled, triggerPercent: String(policy.triggerPercent), keepRecentTokens: String(policy.keepRecentTokens) };
}

/** 校验草稿并生成请求参数；只有三个字段都合法才返回，避免把部分设置发给内核。 */
export function compactionFields(draft: CompactionSettingDraft): AutoCompactionSetParams | null {
  const triggerPercent = Number(draft.triggerPercent);
  const keepRecentTokens = Number(draft.keepRecentTokens);
  if (!Number.isSafeInteger(triggerPercent) || triggerPercent < 1 || triggerPercent > 100) return null;
  if (!Number.isSafeInteger(keepRecentTokens) || keepRecentTokens < 1 || keepRecentTokens > 1_000_000) return null;
  return { enabled: draft.enabled, triggerPercent, keepRecentTokens };
}

/** 设置页展示的策略来源；未知或旧内核如实说明，不假装是内置默认值。 */
export function compactionSourceLabel(source: AutoCompactionSource | undefined): string {
  switch (source) {
    case "environment": return "由环境变量 BOSS_HARNESS_COMPACTION 管理";
    case "stored": return "已保存到本机内核配置";
    case "default": return "使用内核内置默认值";
    case "explicit": return "由当前内核调用方显式指定";
    default: return "旧内核未提供来源";
  }
}
