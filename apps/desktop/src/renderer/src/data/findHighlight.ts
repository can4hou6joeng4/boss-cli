export interface TextRange { start: number; end: number }

const LOCALE = "zh-CN";
const normalizeChar = (char: string) => char.normalize("NFKC").toLocaleLowerCase(LOCALE);

/** 归一化整段文本，并记录每个归一化字符对应的原文 UTF-16 区间；DOM Range 的偏移量以 UTF-16 为单位。 */
function normalizeWithMap(text: string): { normalized: string; starts: number[]; ends: number[] } {
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const value = normalizeChar(char);
    for (let index = 0; index < value.length; index += 1) {
      normalized += value[index];
      starts.push(offset);
      ends.push(offset + char.length);
    }
    offset += char.length;
  }
  return { normalized, starts, ends };
}

/**
 * 在文本中查找所有命中区间，返回原文偏移量（不重叠，按出现顺序）。
 * 与 messageSearch 使用相同的 NFKC + 不区分大小写归一化，`limit` 限制单段文本的区间数。
 */
export function findTextRanges(text: string, query: string, limit = 200): TextRange[] {
  const needle = Array.from(query.trim()).map(normalizeChar).join("");
  if (!needle || limit <= 0) return [];
  const { normalized, starts, ends } = normalizeWithMap(text);
  const ranges: TextRange[] = [];
  let from = 0;
  while (ranges.length < limit) {
    const index = normalized.indexOf(needle, from);
    if (index < 0) break;
    const start = starts[index];
    const end = ends[index + needle.length - 1];
    if (start === undefined || end === undefined) break;
    ranges.push({ start, end });
    from = index + needle.length;
  }
  return ranges;
}

export interface TextSegment { text: string; match: boolean }

/**
 * 把文本拆成命中 / 未命中片段，供搜索结果标注关键词。
 * 复用 `findTextRanges` 的归一化与区间计算，未命中时返回整段原文。
 */
export function splitHighlight(text: string, query: string, limit = 50): TextSegment[] {
  const ranges = findTextRanges(text, query, limit);
  if (!ranges.length) return text ? [{ text, match: false }] : [];
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start < cursor) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

/** 收集元素内的文本节点并映射到原文偏移量，供 CSS Custom Highlight 使用。 */
export function collectTextRanges(root: Node, query: string, limit = 200): Range[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const parts: string[] = [];
  const ownerNode: number[] = [];
  const ownerOffset: number[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data) continue;
    const index = nodes.length;
    nodes.push(text);
    parts.push(text.data);
    for (let offset = 0; offset < text.data.length; offset += 1) {
      ownerNode.push(index);
      ownerOffset.push(offset);
    }
  }
  if (!nodes.length) return [];
  const combined = parts.join("");
  const result: Range[] = [];
  for (const { start, end } of findTextRanges(combined, query, limit)) {
    const startNode = nodes[ownerNode[start] ?? -1];
    const startOffset = ownerOffset[start];
    if (!startNode || startOffset === undefined) continue;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    if (end < combined.length) {
      const endNode = nodes[ownerNode[end] ?? -1];
      const endOffset = ownerOffset[end];
      if (!endNode || endOffset === undefined) continue;
      range.setEnd(endNode, endOffset);
    } else {
      const last = nodes[nodes.length - 1];
      if (!last) continue;
      range.setEnd(last, last.data.length);
    }
    result.push(range);
  }
  return result;
}
