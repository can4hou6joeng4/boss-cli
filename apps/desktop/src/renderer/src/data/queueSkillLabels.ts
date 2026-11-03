import type { SkillDescriptor } from "@boss-harness/protocol";

/**
 * 队列项技能的可读标签：优先显示目录中的名称，找不到时回退 id。
 * 只接受非空、有界的字符串 id，去重并最多 10 项；旧内核或畸形记录不产生伪技能。
 */
export function queueSkillLabels(skillIds: string[] | null | undefined, skills: SkillDescriptor[] = []): string[] {
  if (!Array.isArray(skillIds)) return [];
  const names = new Map(skills.map(skill => [skill.id, skill.name]));
  const labels: string[] = [];
  for (const id of skillIds.slice(0, 10)) {
    if (typeof id !== "string" || !id || id.length > 200) continue;
    const label = names.get(id) ?? id;
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}
