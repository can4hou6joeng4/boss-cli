import { safeSlice } from "@boss-harness/shared";
import type { SkillDescriptor } from "@boss-harness/protocol";

/** 输入区最多展示的已选技能；与每回合可选 10 项技能保持一致。 */
export const SKILL_CHIP_LIMIT = 10;
const NAME_LIMIT = 60;
const DESCRIPTION_LIMIT = 200;

export interface SkillChip {
  /** 与草稿及内核目录完全一致，用于查找、去重与移除；不截断。 */
  id: string;
  name: string;
  /** 当前目录中没有该 id：仍展示，但标注不可用，不静默丢弃。 */
  stale: boolean;
  description?: string;
}

/** 仅用于展示：折叠空白并按上限安全截断，不改变 id。 */
function compact(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return safeSlice(value.replace(/\s+/g, " ").trim(), limit);
}

/** 把草稿里的技能 id 映射为输入区标签；未知 id 保留、重复 id 只显示一次、最多 10 项。 */
export function skillChips(ids: readonly string[], skills: readonly SkillDescriptor[]): SkillChip[] {
  const byId = new Map(skills.map(skill => [skill.id, skill]));
  const seen = new Set<string>();
  const chips: SkillChip[] = [];
  for (const raw of ids) {
    if (chips.length >= SKILL_CHIP_LIMIT) break;
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const skill = byId.get(raw);
    const displayId = compact(raw, NAME_LIMIT) || raw;
    if (!skill) {
      chips.push({ id: raw, name: displayId, stale: true });
      continue;
    }
    const description = compact(skill.description, DESCRIPTION_LIMIT);
    chips.push({ id: raw, name: compact(skill.name, NAME_LIMIT) || displayId, stale: false, ...(description ? { description } : {}) });
  }
  return chips;
}
