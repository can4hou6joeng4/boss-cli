import type { SkillDescriptor } from "@boss-harness/protocol";

/** 输入区最多展示的已选技能；与每回合可选 10 项技能保持一致。 */
export const SKILL_CHIP_LIMIT = 10;
const NAME_LIMIT = 60;
const DESCRIPTION_LIMIT = 200;

export interface SkillChip {
  id: string;
  name: string;
  /** 当前目录中没有该 id：仍展示，但标注不可用，不静默丢弃。 */
  stale: boolean;
  description?: string;
}

function compact(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

/** 把草稿里的技能 id 映射为输入区标签；未知 id 保留、重复 id 只显示一次、最多 10 项。 */
export function skillChips(ids: readonly string[], skills: readonly SkillDescriptor[]): SkillChip[] {
  const byId = new Map(skills.map(skill => [skill.id, skill]));
  const seen = new Set<string>();
  const chips: SkillChip[] = [];
  for (const raw of ids) {
    if (chips.length >= SKILL_CHIP_LIMIT) break;
    const id = compact(raw, NAME_LIMIT);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const skill = byId.get(id);
    if (!skill) {
      chips.push({ id, name: id, stale: true });
      continue;
    }
    const description = compact(skill.description, DESCRIPTION_LIMIT);
    chips.push({ id, name: compact(skill.name, NAME_LIMIT) || id, stale: false, ...(description ? { description } : {}) });
  }
  return chips;
}
