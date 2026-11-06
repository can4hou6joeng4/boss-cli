/**
 * 运行状态面板的分区标识与 WAI-ARIA Tabs 导航。
 * 标签与内容区共用同一组 id 构造函数，避免 aria-controls 与实际节点漂移。
 */
export const COCKPIT_TAB_KEYS = ["overview", "turns", "approvals", "catalog"] as const;

export type CockpitTab = typeof COCKPIT_TAB_KEYS[number];

export function cockpitTabId(tab: CockpitTab): string {
  return `cockpit-tab-${tab}`;
}

export function cockpitTabPanelId(tab: CockpitTab): string {
  return `cockpit-panel-${tab}`;
}

/**
 * 水平 tablist 的键盘导航：← / → 循环移动，Home / End 跳到首末。
 * 返回目标索引；其他按键、越界索引或非整数返回 null，交回浏览器默认行为。
 */
export function cockpitTabIndexForKey(index: number, length: number, key: string): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= length) return null;
  if (key === "ArrowRight") return (index + 1) % length;
  if (key === "ArrowLeft") return (index - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}
