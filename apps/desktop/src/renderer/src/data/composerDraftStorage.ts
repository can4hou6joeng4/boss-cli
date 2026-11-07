/**
 * 未发送草稿的本地持久化。
 *
 * 只保存正文与技能 id：附件原文按既有边界只留在内存，提交流程状态（submitting /
 * queueSubmission）也不落盘。存储键沿用 UI 命名空间，旧 `boss-cli.ui.*` 由启动迁移补齐。
 */
import { MAX_MESSAGE_TEXT_LENGTH, createComposerDraft, type ComposerDraft } from "./composerDraft";
import { UI_STORAGE_PREFIX } from "./uiStorage";

export const COMPOSER_DRAFT_STORAGE_KEY = UI_STORAGE_PREFIX + "composerDrafts";
/** 超过内核单条消息上限的草稿不持久化，避免重启后恢复成无法发送的内容。 */
export const MAX_DRAFT_TEXT_LENGTH = MAX_MESSAGE_TEXT_LENGTH;
/** 最多保留的会话草稿数量；超出时丢弃最久未修改的条目。 */
export const MAX_SESSION_DRAFTS = 20;
const MAX_SKILL_IDS = 50;
const STORE_VERSION = 1;

export interface PersistedComposerDraft {
  text: string;
  skillIds: string[];
  updatedAt: number;
}

export interface PersistedComposerDraftStore {
  home?: PersistedComposerDraft;
  sessions: Record<string, PersistedComposerDraft>;
}

/** 只需要本地存储的读取、写入与删除；不可用时传 null，草稿退回内存态。 */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): DraftStorage | null {
  try { return localStorage; } catch { return null; }
}

/** 校验单个条目；空正文且无技能、类型错误或超限都视为没有草稿。 */
function draftEntry(value: unknown): PersistedComposerDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { text?: unknown; skillIds?: unknown; updatedAt?: unknown };
  if (typeof record.text !== "string" || record.text.length > MAX_DRAFT_TEXT_LENGTH) return null;
  const skillIds = Array.isArray(record.skillIds)
    ? [...new Set(record.skillIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))].slice(0, MAX_SKILL_IDS)
    : [];
  if (!record.text.trim() && skillIds.length === 0) return null;
  const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) && record.updatedAt >= 0
    ? record.updatedAt
    : 0;
  return { text: record.text, skillIds, updatedAt };
}

/** 按最近修改保留有限条目；同时间戳按会话 id 排序，保证结果稳定。 */
function prune(store: PersistedComposerDraftStore): PersistedComposerDraftStore {
  const sessions = Object.entries(store.sessions)
    .sort(([idA, a], [idB, b]) => b.updatedAt - a.updatedAt || idA.localeCompare(idB))
    .slice(0, MAX_SESSION_DRAFTS);
  return { ...(store.home ? { home: store.home } : {}), sessions: Object.fromEntries(sessions) };
}

/** 解析已写入的草稿库；版本不符、结构错误或空值一律视为没有草稿。 */
export function parseComposerDraftStore(value: unknown): PersistedComposerDraftStore {
  const empty: PersistedComposerDraftStore = { sessions: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const record = value as { version?: unknown; home?: unknown; sessions?: unknown };
  if (record.version !== STORE_VERSION) return empty;
  const sessions: Record<string, PersistedComposerDraft> = {};
  if (record.sessions && typeof record.sessions === "object" && !Array.isArray(record.sessions)) {
    for (const [id, raw] of Object.entries(record.sessions)) {
      if (!id.trim()) continue;
      const entry = draftEntry(raw);
      if (entry) sessions[id] = entry;
    }
  }
  return prune({ home: draftEntry(record.home) ?? undefined, sessions });
}

export function loadComposerDraftStore(storage: DraftStorage | null = defaultStorage()): PersistedComposerDraftStore {
  const empty: PersistedComposerDraftStore = { sessions: {} };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    return raw === null ? empty : parseComposerDraftStore(JSON.parse(raw));
  } catch { return empty; }
}

/** 只取可持久化字段；附件、提交中与队列待核对状态都不进入本地存储。 */
function collectDraft(draft: ComposerDraft | undefined): { text: string; skillIds: string[] } | null {
  if (!draft) return null;
  if (draft.text.length > MAX_DRAFT_TEXT_LENGTH) return null;
  const skillIds = [...new Set((draft.skillIds ?? []).filter(id => typeof id === "string" && id.trim().length > 0))].slice(0, MAX_SKILL_IDS);
  if (!draft.text.trim() && skillIds.length === 0) return null;
  return { text: draft.text, skillIds };
}

function sameDraft(a: { text: string; skillIds: string[] } | null, b: PersistedComposerDraft | undefined): boolean {
  return Boolean(a && b && a.text === b.text && a.skillIds.length === b.skillIds.length
    && a.skillIds.every((id, index) => id === b.skillIds[index]));
}

/**
 * 保存首页与各会话草稿。内容未变的条目标记沿用原时间戳，避免别的会话的修改
 * 把未改动的草稿顶到前面；全空时删除存储键。存储不可用或超限时静默跳过，
 * 输入本身不受影响。
 */
export function saveComposerDrafts(
  home: ComposerDraft,
  sessions: Record<string, ComposerDraft>,
  storage: DraftStorage | null = defaultStorage(),
  now = Date.now(),
): void {
  if (!storage) return;
  try {
    const previous = loadComposerDraftStore(storage);
    const next: PersistedComposerDraftStore = { sessions: {} };
    const add = (id: string | null, draft: ComposerDraft | undefined, previousEntry: PersistedComposerDraft | undefined) => {
      const current = collectDraft(draft);
      if (!current) return;
      const entry = { ...current, updatedAt: sameDraft(current, previousEntry) ? previousEntry!.updatedAt : now };
      if (id === null) next.home = entry;
      else next.sessions[id] = entry;
    };
    add(null, home, previous.home);
    for (const [id, draft] of Object.entries(sessions)) {
      if (!id.trim()) continue;
      add(id, draft, previous.sessions[id]);
    }
    const pruned = prune(next);
    if (!pruned.home && Object.keys(pruned.sessions).length === 0) {
      storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
      return;
    }
    storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({ version: STORE_VERSION, ...pruned }));
  } catch {
    // 存储被禁用或配额已满：草稿仍保留在内存中，不阻断输入与发送。
  }
}

/** 恢复为可编辑草稿；每次恢复使用新的内部 id，避免与发送中的旧草稿串线。 */
export function restoreComposerDraft(entry?: PersistedComposerDraft): ComposerDraft {
  const draft = createComposerDraft();
  return entry ? { ...draft, text: entry.text, skillIds: entry.skillIds } : draft;
}

export function restoreSessionDrafts(store: PersistedComposerDraftStore): Record<string, ComposerDraft> {
  return Object.fromEntries(Object.entries(store.sessions).map(([id, entry]) => [id, restoreComposerDraft(entry)]));
}
