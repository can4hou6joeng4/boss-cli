import type { SkillDescriptor, SkillProblem } from "@boss-harness/protocol";

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("zh-CN");

/** 技能菜单筛选：按 id、名称与描述做不区分大小写的包含匹配。 */
export function filterSkills(skills: SkillDescriptor[], query: string): SkillDescriptor[] {
  const needle = normalize(query).trim();
  if (!needle) return skills;
  return skills.filter(skill => normalize([skill.id, skill.name, skill.description].join("\n")).includes(needle));
}

/** 未加载项筛选：按目录名与可展示原因匹配，便于直接定位问题文件。 */
export function filterSkillProblems(problems: SkillProblem[], query: string): SkillProblem[] {
  const needle = normalize(query).trim();
  if (!needle) return problems;
  return problems.filter(problem => normalize(`${problem.id}\n${problem.reason}`).includes(needle));
}
