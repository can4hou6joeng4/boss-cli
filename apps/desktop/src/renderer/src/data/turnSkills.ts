import type { TurnSummary } from "@boss-harness/protocol";

const SKILL_LIMIT = 10;
const ID_LIMIT = 200;

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
