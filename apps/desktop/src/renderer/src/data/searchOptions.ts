import type { ThreadSearchMatch } from "@boss-harness/protocol";
import type { SessionItem } from "./mockData";
import type { SessionRow } from "./sessionRows";

/** 搜索弹窗的键盘 / 点击顺序：消息命中在前，会话标题结果在后。 */
export type SearchOption =
  | { kind: "message"; key: string; hit: ThreadSearchMatch; session: SessionItem }
  | { kind: "session"; key: string; row: SessionRow };

export function buildSearchOptions(
  rows: SessionRow[],
  hits: ThreadSearchMatch[],
  sessions: Map<string, SessionItem>,
): SearchOption[] {
  const options: SearchOption[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const session = sessions.get(hit.threadId);
    if (!session) continue;
    const key = `message:${hit.threadId}:${hit.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ kind: "message", key, hit, session });
  }
  for (const row of rows) {
    const key = `session:${row.session.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ kind: "session", key, row });
  }
  return options;
}
