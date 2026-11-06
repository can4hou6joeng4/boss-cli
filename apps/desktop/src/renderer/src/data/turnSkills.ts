import type { TurnListResponse, TurnSummary } from "@boss-harness/protocol";

const SKILL_LIMIT = 10;
const ID_LIMIT = 200;
const MAX_CURSOR_LENGTH = 2048;
/** 回合列表分页上限：技能标签只是辅助信息，异常内核不能让它无限翻页。 */
export const TURN_SKILL_PAGE_LIMIT = 20;

/**
 * 从回合摘要提取「本次注入的技能」映射。
 * 先校验、后计数：跳过空值、非字符串与超长 id，去重并限 10 项；
 * 旧内核或畸形记录不产生伪技能，也不会挤掉后面的合法 id。
 */
export function collectTurnSkillIds(turns: TurnSummary[] | null | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!Array.isArray(turns)) return result;
  for (const turn of turns) {
    if (!turn || typeof turn.turnId !== "string" || !turn.turnId || !Array.isArray(turn.skillIds)) continue;
    const ids: string[] = [];
    for (const id of turn.skillIds) {
      if (ids.length >= SKILL_LIMIT) break;
      if (typeof id === "string" && id.length > 0 && id.length <= ID_LIMIT && !ids.includes(id)) ids.push(id);
    }
    if (ids.length) result[turn.turnId] = ids;
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
