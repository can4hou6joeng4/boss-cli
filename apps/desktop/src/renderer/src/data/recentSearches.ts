import { UI_STORAGE_PREFIX } from "./uiStorage";

/** 最近搜索的本地存储键；只在渲染层使用，不参与协议。 */
export const RECENT_SEARCH_KEY = UI_STORAGE_PREFIX + "recentSearches";
/** 记入历史与展示的最少字符数，与弹窗触发消息搜索的阈值一致。 */
export const RECENT_SEARCH_MIN_LENGTH = 2;
export const RECENT_SEARCH_LIMIT = 5;
const RECENT_SEARCH_MAX_LENGTH = 200;

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("zh-CN");

/** 去空白、限长、去重并截断；保留用户输入的原始大小写与全角写法。 */
function sanitize(values: unknown[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const query = value.trim();
    if (query.length < RECENT_SEARCH_MIN_LENGTH || query.length > RECENT_SEARCH_MAX_LENGTH) continue;
    const key = normalize(query);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(query);
    if (result.length >= limit) break;
  }
  return result;
}

/** 解析存储里的数组；损坏或非数组一律回退为空，避免旧数据阻塞搜索。 */
export function parseRecentSearches(raw: string | null, limit = RECENT_SEARCH_LIMIT): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? sanitize(parsed, limit) : [];
}

/** 把新查询放到最前；空查询不改变现有历史。 */
export function mergeRecentSearch(list: string[], query: string, limit = RECENT_SEARCH_LIMIT): string[] {
  if (!query.trim()) return sanitize(list, limit);
  return sanitize([query, ...list], limit);
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(RECENT_SEARCH_KEY);
  } catch {
    // 隐私模式或存储被禁用：搜索照常可用，只是不保留历史。
    return null;
  }
}

export function readRecentSearches(): string[] {
  return parseRecentSearches(readRaw());
}

export function rememberRecentSearch(query: string): string[] {
  const next = mergeRecentSearch(readRecentSearches(), query);
  try {
    localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(next));
  } catch {
    // 写入失败只影响下次会话，当前弹窗仍显示刚记下的条目。
  }
  return next;
}

export function clearRecentSearches(): void {
  try {
    localStorage.removeItem(RECENT_SEARCH_KEY);
  } catch {
    // 存储不可用时没有需要清理的数据。
  }
}
