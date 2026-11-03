import type { ThreadSearchMatch } from "@boss-harness/protocol";
import type { SessionRow } from "./sessionRows";

/** 搜索弹窗的键盘 / 点击顺序：消息命中在前，会话标题结果在后。 */
export type SearchOption =
  | { kind: "message"; key: string; hit: ThreadSearchMatch; row: SessionRow }
  | { kind: "session"; key: string; row: SessionRow };

/** `rowsById` 来自同一份会话行，消息命中与会话结果因此共享项目与会话信息。 */
export function buildSearchOptions(
  rows: SessionRow[],
  hits: ThreadSearchMatch[],
  rowsById: Map<string, SessionRow>,
): SearchOption[] {
  const options: SearchOption[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const row = rowsById.get(hit.threadId);
    if (!row) continue;
    const key = `message:${hit.threadId}:${hit.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ kind: "message", key, hit, row });
  }
  for (const row of rows) {
    const key = `session:${row.session.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ kind: "session", key, row });
  }
  return options;
}
