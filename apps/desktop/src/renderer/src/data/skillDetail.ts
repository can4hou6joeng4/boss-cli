import type { SkillDescriptor, SkillReadResponse } from "@boss-harness/protocol";

/**
 * 详情区只展示与当前选中技能同属一个条目的正文快照。
 *
 * 点击另一个技能后，`selectedId` 先变化，清空旧正文的 effect 要到下一次提交才执行。
 * 若直接读取 `detail`，这一帧会把上一个技能的名称、字节数与正文挂在新技能的 id 与摘要下，
 * 「编辑技能…」也会打开旧快照。按 id 归属过滤后，不匹配的快照一律按“尚未读取”处理，
 * 由目录元数据兜底，等新正文读取完成再替换。
 */
export function visibleSkillDetail(
  selected: SkillDescriptor | null,
  detail: SkillReadResponse | null,
): SkillReadResponse | null {
  return selected && detail && detail.id === selected.id ? detail : null;
}
