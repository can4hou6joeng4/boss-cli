import type { SkillDescriptor } from "@boss-harness/protocol";
import type { SkillCatalogState } from "./harnessBridge";

/**
 * 从回合技能标签跳转时，目录就绪后再决定聚焦目标。
 * 找到返回 id；目录已给出终态但不存在时返回空并结束等待；
 * 仍在读取时保持 pending，等下一次目录更新。
 */
export function resolveSkillFocus(focusId: string | null | undefined, skills: SkillDescriptor[], state: SkillCatalogState): { selectedId: string | null; done: boolean } {
  if (!focusId) return { selectedId: null, done: true };
  if (skills.some(skill => skill.id === focusId)) return { selectedId: focusId, done: true };
  return { selectedId: null, done: state !== "loading" };
}
