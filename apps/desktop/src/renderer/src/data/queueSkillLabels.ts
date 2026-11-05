import type { SkillDescriptor } from "@boss-harness/protocol";

const LABEL_LIMIT = 10;
const ID_LIMIT = 200;

/** 只接受非空、有界的字符串 id；非法项不占用 10 项名额。 */
function skillId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= ID_LIMIT;
}

/**
 * 队列项技能的可读标签：优先显示目录中的名称，找不到或名称为空时回退 id。
 * 先校验、后计数：跳过非法 id，按 id 去重并最多 10 项；目录不要求名称唯一，
 * 同名不同 id 是两个技能，不得按显示名合并。
 */
export function queueSkillLabels(skillIds: string[] | null | undefined, skills: SkillDescriptor[] = []): string[] {
  if (!Array.isArray(skillIds)) return [];
  const names = new Map(skills.map(skill => [skill.id, skill.name]));
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const id of skillIds) {
    if (labels.length >= LABEL_LIMIT) break;
    if (!skillId(id) || seen.has(id)) continue;
    seen.add(id);
    const name = names.get(id);
    labels.push(typeof name === "string" && name.trim() ? name : id);
  }
  return labels;
}
