import type { SkillDescriptor } from "@boss-harness/protocol";

/** 技能菜单筛选：按 id、名称与描述做不区分大小写的包含匹配。 */
export function filterSkills(skills: SkillDescriptor[], query: string): SkillDescriptor[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return skills;
  return skills.filter(skill => [skill.id, skill.name, skill.description].join("\n").toLowerCase().includes(needle));
}
