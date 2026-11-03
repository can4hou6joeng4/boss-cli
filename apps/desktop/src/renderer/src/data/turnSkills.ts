import type { TurnSummary } from "@boss-harness/protocol";

/**
 * 从回合摘要提取「本次注入的技能」映射。
 * 只接受非空字符串 id 并去重、限 10 项；旧内核或畸形记录不产生伪技能。
 */
export function collectTurnSkillIds(turns: TurnSummary[] | null | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!Array.isArray(turns)) return result;
  for (const turn of turns) {
    if (!turn || typeof turn.turnId !== "string" || !turn.turnId || !Array.isArray(turn.skillIds)) continue;
    const ids: string[] = [];
    for (const id of turn.skillIds.slice(0, 10)) {
      if (typeof id === "string" && id.length > 0 && id.length <= 200 && !ids.includes(id)) ids.push(id);
    }
    if (ids.length) result[turn.turnId] = ids;
  }
  return result;
}
