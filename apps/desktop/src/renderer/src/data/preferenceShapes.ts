import type { ProjectFolder } from "./mockData";

/**
 * 本地界面偏好的形状校验。
 *
 * `localStorage` 可能被手改、旧版本写入或中断写入留下错误类型；这里只保留可安全渲染的部分，
 * 其余回退默认值，避免 `includes` / `new Set` / `filter` 在渲染时抛出并白屏。
 */

/** 字符串集合：丢弃非字符串、空串与重复项。 */
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

/** 字符串映射（别名、线程分组）：丢弃非字符串值；数组与原始值视为空。 */
export function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** 本地分组：只保留 id 与名称有效的对象并按 id 去重；会话由内核列表与线程分组映射产生。 */
export function projectFolders(value: unknown): ProjectFolder[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const folder = item as { id?: unknown; name?: unknown };
    if (typeof folder.id !== "string" || !folder.id.trim() || typeof folder.name !== "string" || !folder.name.trim()) return [];
    if (seen.has(folder.id)) return [];
    seen.add(folder.id);
    return [{ id: folder.id, name: folder.name, sessions: [] }];
  });
}

/** 布尔映射（折叠状态）：丢弃非布尔值；null、数组与原始值视为空。 */
export function booleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
}

/** 布尔偏好：只有真正的布尔值生效，其余使用默认值。 */
export function booleanPreference(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
