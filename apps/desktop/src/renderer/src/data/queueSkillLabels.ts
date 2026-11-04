import type { SkillDescriptor } from "@boss-harness/protocol";

const LABEL_LIMIT = 10;
const ID_LIMIT = 200;

/** 只接受非空、有界的字符串 id；非法项不占用 10 项名额。 */
function skillId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= ID_LIMIT;
}

/**
 * 队列项技能的可读标签：优先显示目录中的名称，找不到或名称为空时回退 id。
 * 先校验、后计数：跳过非法 id，去重并最多 10 项；旧内核或畸形记录不产生伪技能。
 */
export function queueSkillLabels(skillIds: string[] | null | undefined, skills: SkillDescriptor[] = []): string[] {
  if (!Array.isArray(skillIds)) return [];
  const names = new Map(skills.map(skill => [skill.id, skill.name]));
  const labels: string[] = [];
  for (const id of skillIds) {
    if (labels.length >= LABEL_LIMIT) break;
    if (!skillId(id)) continue;
    const name = names.get(id);
    const label = typeof name === "string" && name.trim() ? name : id;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}
