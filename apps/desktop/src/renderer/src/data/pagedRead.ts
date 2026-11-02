/**
 * 渲染层逐页读取的公共部分：只负责拼接条目与校验分页游标。
 *
 * 调用方负责校验每一页的业务形状（归属、视图、条目结构）。这里保证异常游标不会让界面
 * 重复渲染同一页，也不会把「翻不到下一页」误当成「还有更多」。
 */
export interface PagedItems<T> {
  items: T[];
  /** 达到页数上限时内核仍有后续页。 */
  truncated: boolean;
}

const MAX_CURSOR_LENGTH = 2048;

export async function readPagedItems<T>(
  label: string,
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>,
  maxPages: number,
): Promise<PagedItems<T>> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < maxPages; pages += 1) {
    const page = await fetchPage(cursor);
    const next: string | null = page.nextCursor;
    if (next !== null && (typeof next !== "string" || !next || next.length > MAX_CURSOR_LENGTH)) {
      throw new Error(`${label}分页游标无效`);
    }
    if (next !== null && next === cursor) throw new Error(`${label}分页未前进`);
    items.push(...page.items);
    if (next === null) return { items, truncated: false };
    cursor = next;
  }
  return { items, truncated: true };
}
