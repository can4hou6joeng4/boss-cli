import { kernelSearchText, kernelSearchTextWithMap, searchText, searchTextWithMap, type MappedSearchText } from "./searchText";

export interface TextRange { start: number; end: number }

/** 在已归一化的文本中查找命中区间，并把偏移量还原到原文。 */
function scanRanges(mapped: MappedSearchText, needle: string, limit: number): TextRange[] {
  const { normalized, starts, ends } = mapped;
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

/**
 * 在文本中查找所有命中区间，返回原文偏移量（不重叠，按出现顺序）。
 * 与 messageSearch 共用同一套整串 NFKC + 不区分大小写归一化，`limit` 限制单段文本的区间数。
 */
export function findTextRanges(text: string, query: string, limit = 200): TextRange[] {
  const needle = searchText(query).trim();
  if (!needle || limit <= 0) return [];
  return scanRanges(searchTextWithMap(text), needle, limit);
}

/** 标注内核搜索命中：内核使用逐码点 NFKC + casefold，与小写归一化在 `ß`/`ss` 等处不同。 */
export function findKernelTextRanges(text: string, query: string, limit = 200): TextRange[] {
  const needle = kernelSearchText(query.trim());
  if (!needle || limit <= 0) return [];
  return scanRanges(kernelSearchTextWithMap(text), needle, limit);
}

export interface TextSegment { text: string; match: boolean }

function splitByRanges(text: string, ranges: TextRange[]): TextSegment[] {
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

/**
 * 把文本拆成命中 / 未命中片段，供搜索结果标注关键词。
 * 复用 `findTextRanges` 的归一化与区间计算，未命中时返回整段原文。
 */
export function splitHighlight(text: string, query: string, limit = 50): TextSegment[] {
  return splitByRanges(text, findTextRanges(text, query, limit));
}

/** 标注内核命中片段：与 `findKernelTextRanges` 共用内核的 casefold 归一化。 */
export function splitKernelHighlight(text: string, query: string, limit = 50): TextSegment[] {
  return splitByRanges(text, findKernelTextRanges(text, query, limit));
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
