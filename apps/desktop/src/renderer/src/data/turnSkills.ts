import type { QueueItem, TurnListResponse, TurnSummary } from "@boss-harness/protocol";

const SKILL_LIMIT = 10;
const ID_LIMIT = 200;
const MAX_CURSOR_LENGTH = 2048;
/** 回合列表分页上限：技能标签只是辅助信息，异常内核不能让它无限翻页。 */
export const TURN_SKILL_PAGE_LIMIT = 20;

/** 先校验、后计数：跳过空值、非字符串与超长 id，去重并限 10 项。 */
function normalizeSkillIds(value: unknown): string[] {
  const ids: string[] = [];
  if (!Array.isArray(value)) return ids;
  for (const id of value) {
    if (ids.length >= SKILL_LIMIT) break;
    if (typeof id === "string" && id.length > 0 && id.length <= ID_LIMIT && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 从回合摘要提取「本次注入的技能」映射。
 * 旧内核或畸形记录不产生伪技能，也不会挤掉后面的合法 id。
 */
export function collectTurnSkillIds(turns: TurnSummary[] | null | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!Array.isArray(turns)) return result;
  for (const turn of turns) {
    if (!turn || typeof turn.turnId !== "string" || !turn.turnId) continue;
    const ids = normalizeSkillIds(turn.skillIds);
    if (ids.length) result[turn.turnId] = ids;
  }
  return result;
}

/**
 * 从队列页提取可以直接信任的「已投递回合技能」。
 * 去重回执（deduplicated）关联的是已有请求，队列项记录的是本次请求携带的技能，
 * 未必等于该回合实际注入的技能；与直接发送路径一致，交给回合列表核对，不写入标签。
 */
export function deliveredTurnSkills(items: readonly QueueItem[] | null | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!Array.isArray(items)) return result;
  for (const item of items) {
    if (!item || item.status !== "delivered" || item.deduplicated === true) continue;
    if (typeof item.turnId !== "string" || !item.turnId) continue;
    const ids = normalizeSkillIds(item.skillIds);
    if (ids.length) result[item.turnId] = ids;
  }
  return result;
}

/**
 * 校验一页 `thread/turns/list` 响应并提取技能映射。
 * `turns` 不是数组或游标形状不符时返回 null，交由调用方按读取失败处理；
 * 回合内容沿用 `collectTurnSkillIds` 的逐项过滤。
 */
export function turnSkillPageOf(response: TurnListResponse | null | undefined):
  { skills: Record<string, string[]>; nextCursor: string | null } | null {
  if (!response || !Array.isArray(response.turns)) return null;
  const next = response.nextCursor ?? null;
  if (next !== null && (typeof next !== "string" || !next || next.length > MAX_CURSOR_LENGTH)) return null;
  return { skills: collectTurnSkillIds(response.turns), nextCursor: next };
}
