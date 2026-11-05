const LOCALE = "zh-CN";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 会话内查找与命中高亮共用的归一化：整串 NFKC + 不区分大小写。
 * 整串处理才能保留上下文相关的大小写规则（如希腊词尾 sigma）。
 */
export const searchText = (value: string) => value.normalize("NFKC").toLocaleLowerCase(LOCALE);

export interface MappedSearchText {
  normalized: string;
  /** 每个归一化码元对应的原文起始偏移（UTF-16）。 */
  starts: number[];
  /** 每个归一化码元对应的原文结束偏移（UTF-16），覆盖生成它的整个字素簇。 */
  ends: number[];
}

/**
 * 归一化整段文本，并记录每个归一化码元对应的原文 UTF-16 区间。
 * NFKC 按字素簇进行，组合字符不会与基字符分离；小写仍取整串结果以保留上下文规则，
 * 再按码点的小写长度把结果映射回 NFKC 区间（词尾 sigma 等只改字形、不改长度）。
 */
export function searchTextWithMap(text: string): MappedSearchText {
  let nfkc = "";
  const nfkcStarts: number[] = [];
  const nfkcEnds: number[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const value = segment.normalize("NFKC");
    for (let offset = 0; offset < value.length; offset += 1) {
      nfkc += value[offset];
      nfkcStarts.push(index);
      nfkcEnds.push(index + segment.length);
    }
  }
  const normalized = nfkc.toLocaleLowerCase(LOCALE);
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < nfkc.length;) {
    const codePoint = nfkc.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const start = nfkcStarts[index];
    const end = nfkcEnds[index + char.length - 1];
    if (start === undefined || end === undefined) break;
    for (let offset = 0; offset < char.toLocaleLowerCase(LOCALE).length; offset += 1) {
      starts.push(start);
      ends.push(end);
    }
    index += char.length;
  }
  // 长度不一致只可能来自区域设置特有的上下文转换；补齐或截断，保证映射与归一化文本等长。
  while (starts.length < normalized.length) {
    starts.push(starts[starts.length - 1] ?? 0);
    ends.push(ends[ends.length - 1] ?? text.length);
  }
  starts.length = normalized.length;
  ends.length = normalized.length;
  return { normalized, starts, ends };
}
