import { useCallback, useEffect, useRef, useState } from "react";
import type { AutoCompactionPolicy, TurnAutoCompactionOverride } from "@boss-cli/protocol";
import { readConfig } from "./harnessBridge";

export interface AutoCompactionDraft {
  enabled: boolean;
  triggerPercent: string;
  keepRecentTokens: string;
}
interface PendingOverride {
  threadId: string;
  policy: TurnAutoCompactionOverride;
}
const DEFAULT_DRAFT: AutoCompactionDraft = { enabled: true, triggerPercent: "80", keepRecentTokens: "20000" };
const draftFrom = (policy: Pick<AutoCompactionPolicy, "enabled" | "triggerPercent" | "keepRecentTokens">): AutoCompactionDraft =>
  ({ enabled: policy.enabled, triggerPercent: String(policy.triggerPercent), keepRecentTokens: String(policy.keepRecentTokens) });
const policyValue = (value: unknown): AutoCompactionPolicy | null => {
  const policy = value as AutoCompactionPolicy | undefined;
  if (!policy || typeof policy.enabled !== "boolean" ||
    !Number.isSafeInteger(policy.triggerPercent) || policy.triggerPercent < 1 || policy.triggerPercent > 100 ||
    !Number.isSafeInteger(policy.keepRecentTokens) || policy.keepRecentTokens < 1 || policy.keepRecentTokens > 1_000_000) return null;
  return policy;
};

/**
 * 下一回合自动压缩覆盖：草稿只影响「应用到下一回合」后的那一次发送。
 *
 * 覆盖值保存在 App 生命周期内，因此关闭面板不会丢失，但不会写入会话或全局配置；
 * 发送请求后立即消耗，无论回执是否已知都不再自动重发。
 */
export function useAutoCompaction(threadId: string | null, open: boolean, connected: boolean) {
  const [defaults, setDefaults] = useState<AutoCompactionPolicy>();
  const [override, setOverride] = useState<PendingOverride | null>(null);
  const overrideRef = useRef<PendingOverride | null>(null);
  const lastThread = useRef<string | null>(null);
  const seededFor = useRef<string | null>(null);
  const [draft, setDraft] = useState<AutoCompactionDraft>(DEFAULT_DRAFT);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { overrideRef.current = override; }, [override]);

  // 会话切换时回到内核默认草稿；已应用的覆盖只属于原会话。
  useEffect(() => {
    if (lastThread.current === threadId) return;
    lastThread.current = threadId;
    seededFor.current = null;
    const pending = overrideRef.current;
    setDraft(pending && pending.threadId === threadId ? draftFrom(pending.policy) : DEFAULT_DRAFT);
    setError("");
  }, [threadId]);

  // 打开面板时读取一次内核默认值；不覆盖已应用的本会话覆盖草稿。
  useEffect(() => {
    if (!open || !connected || !threadId) return;
    let cancelled = false;
    setReading(true);
    readConfig().then(config => {
      if (cancelled) return;
      const policy = policyValue(config.autoCompaction);
      if (!policy) {
        setError("当前内核未返回自动压缩默认值；仍可显式设置本回合覆盖。");
        return;
      }
      setDefaults(policy);
      setError("");
      // 首次读取才用默认值填充草稿；关闭再打开不覆盖用户尚未应用的编辑。
      if (seededFor.current !== threadId) {
        const pending = overrideRef.current;
        setDraft(pending && pending.threadId === threadId ? draftFrom(pending.policy) : draftFrom(policy));
        seededFor.current = threadId;
      }
    }).catch(() => {
      if (!cancelled) setError("读取自动压缩默认值失败；仍可显式设置本回合覆盖。");
    }).finally(() => {
      if (!cancelled) setReading(false);
    });
    return () => { cancelled = true; };
  }, [open, connected, threadId]);

  const trigger = Number(draft.triggerPercent), keep = Number(draft.keepRecentTokens);
  const valid = Number.isSafeInteger(trigger) && trigger >= 1 && trigger <= 100
    && Number.isSafeInteger(keep) && keep >= 1 && keep <= 1_000_000;

  const setEnabled = useCallback((enabled: boolean) => setDraft(previous => ({ ...previous, enabled })), []);
  const setTriggerPercent = useCallback((value: string) => setDraft(previous => ({ ...previous, triggerPercent: value })), []);
  const setKeepRecentTokens = useCallback((value: string) => setDraft(previous => ({ ...previous, keepRecentTokens: value })), []);

  const apply = useCallback(() => {
    if (!threadId) return;
    if (!Number.isSafeInteger(trigger) || trigger < 1 || trigger > 100) {
      setError("触发阈值必须是 1 到 100 的整数百分比。");
      return;
    }
    if (!Number.isSafeInteger(keep) || keep < 1 || keep > 1_000_000) {
      setError("近期保留目标必须是 1 到 1000000 的整数 token。");
      return;
    }
    const next = { threadId, policy: { enabled: draft.enabled, triggerPercent: trigger, keepRecentTokens: keep } };
    overrideRef.current = next;
    setOverride(next);
    setError("");
  }, [threadId, draft.enabled, trigger, keep]);

  const clear = useCallback(() => {
    overrideRef.current = null;
    setOverride(null);
    setError("");
    if (defaults) setDraft(draftFrom(defaults));
  }, [defaults]);

  /** 取出并消耗本会话待应用的覆盖；发送失败或回执未知时也视为已消耗。 */
  const take = useCallback((id: string): TurnAutoCompactionOverride | undefined => {
    const pending = overrideRef.current;
    if (!pending || pending.threadId !== id) return undefined;
    overrideRef.current = null;
    setOverride(null);
    return pending.policy;
  }, []);

  return {
    defaults, draft, reading, error, valid,
    active: override && override.threadId === threadId ? override.policy : undefined,
    setEnabled, setTriggerPercent, setKeepRecentTokens, apply, clear, take,
  };
}

export type AutoCompactionController = ReturnType<typeof useAutoCompaction>;
