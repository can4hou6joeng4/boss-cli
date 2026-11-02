import type {
  AutoCompactionPolicy, ThreadUsageBucket, ThreadUsageSummaryJob, ThreadUsageTurn,
} from "@boss-cli/protocol";

const COUNT_KEYS = ["requests", "verifiedRequests", "unverifiedRequests", "promptTokens",
  "uncachedInputTokens", "outputTokens"] as const;
const NULLABLE_KEYS = ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;

export const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function bucketOf(value: unknown): ThreadUsageBucket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!COUNT_KEYS.every(key => isCount(raw[key])) || !NULLABLE_KEYS.every(key => raw[key] === null || isCount(raw[key]))) return null;
  const reasons = raw.unverifiedReasons;
  if (!reasons || typeof reasons !== "object" || Array.isArray(reasons)) return null;
  const unverifiedReasons: Record<string, number> = {};
  for (const [reason, amount] of Object.entries(reasons as Record<string, unknown>).slice(0, 20)) {
    if (!isCount(amount)) return null;
    unverifiedReasons[reason.slice(0, 40)] = amount;
  }
  // 新内核才返回 unreportedRequests（未上报 usage，unverifiedRequests 的子集）；旧内核缺省视为不区分。
  const unreported = raw.unreportedRequests;
  if (unreported !== undefined && (!isCount(unreported) || unreported > (raw.unverifiedRequests as number))) return null;
  const bucket = {} as ThreadUsageBucket;
  for (const key of COUNT_KEYS) bucket[key] = raw[key] as number;
  for (const key of NULLABLE_KEYS) bucket[key] = raw[key] as number | null;
  if (unreported !== undefined) bucket.unreportedRequests = unreported;
  // 费用不展示：内核当前无可信价目来源，界面固定标注“未计价”。
  return { ...bucket, unverifiedReasons, costUsd: null, costSource: "unavailable" };
}

const strings = (value: unknown, limit: number): string[] | null => Array.isArray(value) && value.every(item => typeof item === "string")
  ? (value as string[]).slice(0, limit).map(item => item.slice(0, 120)) : null;

const POLICY_KEYS = ["enabled", "triggerPercent", "keepRecentTokens", "provider", "model", "effort"] as const;
const POLICY_PROVIDERS = new Set(["anthropic", "openai", "codex"]);
const POLICY_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const POLICY_MAX_TOKENS = 1_000_000;
const POLICY_MAX_MODEL = 200;

/**
 * 与内核 verified_policy 一致：只保留记录中实际存在且合法的字段；
 * 空对象、未知字段或任一非法值都按“未记录”处理，返回 undefined。
 * 非法策略只影响这个可选字段，不丢弃整页用量。
 */
function compactionPolicyOf(value: unknown): Partial<AutoCompactionPolicy> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.some(key => !(POLICY_KEYS as readonly string[]).includes(key))) return undefined;
  if ("enabled" in raw && typeof raw.enabled !== "boolean") return undefined;
  const trigger = raw.triggerPercent;
  if ("triggerPercent" in raw && !(typeof trigger === "number" && Number.isInteger(trigger)
    && trigger >= 1 && trigger <= 100)) return undefined;
  const keep = raw.keepRecentTokens;
  if ("keepRecentTokens" in raw && !(typeof keep === "number" && Number.isInteger(keep)
    && keep >= 1 && keep <= POLICY_MAX_TOKENS)) return undefined;
  const provider = raw.provider;
  if ("provider" in raw && provider !== null
    && (typeof provider !== "string" || !POLICY_PROVIDERS.has(provider))) return undefined;
  const model = raw.model;
  if ("model" in raw && model !== null
    && (typeof model !== "string" || !model.trim() || model.length > POLICY_MAX_MODEL || /\s/.test(model))) return undefined;
  const effort = raw.effort;
  if ("effort" in raw && effort !== null
    && (typeof effort !== "string" || !POLICY_EFFORTS.has(effort))) return undefined;
  const policy: Partial<AutoCompactionPolicy> = {};
  for (const key of POLICY_KEYS) if (key in raw) (policy as Record<string, unknown>)[key] = raw[key];
  return policy;
}

export function turnOf(value: unknown): ThreadUsageTurn | null {
  const bucket = bucketOf(value);
  if (!bucket) return null;
  const raw = value as Record<string, unknown>;
  const providers = strings(raw.providers, 8), models = strings(raw.models, 8);
  if (typeof raw.turnId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.turnId) || !providers || !models) return null;
  const compactionPolicy = compactionPolicyOf(raw.compactionPolicy);
  return { ...bucket, turnId: raw.turnId, providers, models,
    ...(compactionPolicy ? { compactionPolicy } : {}) };
}

const idOrNull = (value: unknown): string | null | undefined => value === null ? null
  : typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;

export function summaryJobOf(value: unknown): ThreadUsageSummaryJob | null {
  const bucket = bucketOf(value);
  if (!bucket) return null;
  const raw = value as Record<string, unknown>;
  const providers = strings(raw.providers, 8), models = strings(raw.models, 8);
  const jobId = idOrNull(raw.jobId), turnId = idOrNull(raw.turnId);
  const kind = raw.kind === null ? null : raw.kind === "compaction" || raw.kind === "branchSummary" ? raw.kind : undefined;
  const reason = raw.reason === null ? null
    : raw.reason === "threshold" || raw.reason === "budget" || raw.reason === "overflow" ? raw.reason : undefined;
  const origin = raw.origin === null ? null : raw.origin === "user" || raw.origin === "model" ? raw.origin : undefined;
  const active = raw.active === undefined ? undefined : typeof raw.active === "boolean" ? raw.active : null;
  const throughTurnId = raw.throughTurnId === undefined ? undefined
    : raw.throughTurnId === null ? null
      : typeof raw.throughTurnId === "string" && raw.throughTurnId.length > 0 && raw.throughTurnId.length <= 128
        ? raw.throughTurnId : null;
  if (!jobId || !providers || !models || kind === undefined || turnId === undefined
    || reason === undefined || origin === undefined || active === null
    || (raw.throughTurnId !== undefined && throughTurnId === null)) return null;
  return { ...bucket, jobId, kind, turnId, reason, origin, providers, models,
    ...(throughTurnId !== undefined ? { throughTurnId } : {}),
    ...(active ? { active: true } : {}) };
}
