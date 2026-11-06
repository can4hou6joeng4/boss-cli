import type { MessageItem } from "./mockData";

/**
 * 资料库的纯函数数据层。
 *
 * 汇总两类真实存在的会话数据：文件变更摘要（`diffSummary`）与工具调用来源
 * （`toolUse.source`）。前者目前只有示例数据会构造，后者由内核为每次工具
 * 调用生成；两类都按稳定规则去重、排序，供页面直接渲染。
 */

/** 资料库中的文件条目：同一路径在会话中多次出现时合并为一条。 */
export interface LibraryFile {
  /** 完整路径；同时作为去重键。 */
  path: string;
  /** 文件名部分。 */
  name: string;
  /** 所在目录；没有目录时为空字符串。 */
  directory: string;
  /** 扩展名标签；没有可识别扩展名时为 `FILE`。 */
  kind: string;
  /** 首次出现该文件的消息与回合 id，用于回到来源。 */
  messageId: string;
  turnId?: string;
  /** 会话中累计的新增 / 删除行数与出现次数。 */
  additions: number;
  deletions: number;
  occurrences: number;
}

/** 资料库中的来源条目：每次工具调用一条，按 ref 去重。 */
export interface LibrarySource {
  /** 内核生成的来源编号，例如 `tool:<threadId>:<entryId>`。 */
  ref: string;
  tool: string;
  /** 查询开始时间；内核原样返回，可能为空字符串或不可解析。 */
  queriedAt: string;
  /** 产生该来源的消息与回合 id。 */
  messageId: string;
  turnId?: string;
}

/** 把完整路径拆成目录与文件名；同时兼容 `/` 与 `\` 分隔。 */
export function splitLibraryPath(path: string): { directory: string; name: string } {
  const trimmed = typeof path === "string" ? path.trim() : "";
  if (!trimmed) return { directory: "", name: "" };
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return { directory: "", name: trimmed };
  return { directory: trimmed.slice(0, index), name: trimmed.slice(index + 1) };
}

/**
 * 从文件名推断扩展名标签。
 *
 * 点开头且没有第二个点的文件（如 `.gitignore`）、点结尾、非字母数字扩展名
 * 都视为没有扩展名；只保留前 8 个字符以内的扩展名，避免把整段文本当成标签。
 */
export function libraryFileKind(name: string): string {
  const value = typeof name === "string" ? name.trim() : "";
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return "FILE";
  const extension = value.slice(dot + 1);
  if (!/^[A-Za-z0-9]{1,8}$/.test(extension)) return "FILE";
  return extension.toUpperCase();
}

/** 统计字段兜底：非数字、负数或非有限值按 0 处理，避免脏数据把累计值变成 NaN。 */
function finiteCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * 收集会话中的文件变更；同一路径只保留一条，累加行数与出现次数，
 * 来源消息与回合保留首次出现的位置。结果按路径字典序稳定排序。
 */
export function collectLibraryFiles(messages: MessageItem[]): LibraryFile[] {
  const byPath = new Map<string, LibraryFile>();
  for (const message of messages) {
    const summary = message.diffSummary;
    if (!summary) continue;
    for (const file of [...summary.initialFiles, ...summary.extraFiles]) {
      const path = typeof file.name === "string" ? file.name.trim() : "";
      if (!path) continue;
      const existing = byPath.get(path);
      if (existing) {
        existing.additions += finiteCount(file.additions);
        existing.deletions += finiteCount(file.deletions);
        existing.occurrences += 1;
        continue;
      }
      const { directory, name } = splitLibraryPath(path);
      byPath.set(path, {
        path,
        name,
        directory,
        kind: libraryFileKind(name),
        messageId: message.id,
        turnId: message.turnId,
        additions: finiteCount(file.additions),
        deletions: finiteCount(file.deletions),
        occurrences: 1,
      });
    }
  }
  return [...byPath.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/**
 * 收集工具调用来源；同一 ref 只保留首次出现。
 * 查询时间可解析时按时间倒序（最新在前），否则按 ref 字典序兜底，保证顺序稳定。
 */
export function collectLibrarySources(messages: MessageItem[]): LibrarySource[] {
  const byRef = new Map<string, LibrarySource>();
  for (const message of messages) {
    const source = message.toolUse?.source;
    if (!source) continue;
    const ref = typeof source.ref === "string" ? source.ref.trim() : "";
    if (!ref || byRef.has(ref)) continue;
    const tool = typeof source.tool === "string" && source.tool.trim() ? source.tool.trim() : "未知工具";
    byRef.set(ref, {
      ref,
      tool,
      queriedAt: typeof source.queriedAt === "string" ? source.queriedAt : "",
      messageId: message.id,
      turnId: message.turnId,
    });
  }
  return [...byRef.values()].sort((left, right) => {
    const leftTime = Date.parse(left.queriedAt);
    const rightTime = Date.parse(right.queriedAt);
    const leftValid = Number.isFinite(leftTime);
    const rightValid = Number.isFinite(rightTime);
    if (leftValid && rightValid && leftTime !== rightTime) return rightTime - leftTime;
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
    return left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0;
  });
}

/** 筛选查询归一化：全角转半角、大小写不敏感，并去掉首尾空白。 */
function normalizeQuery(value: string): string {
  return (typeof value === "string" ? value : "").normalize("NFKC").toLowerCase().trim();
}

/** 按完整路径筛选文件；空查询返回原列表。 */
export function filterLibraryFiles(files: LibraryFile[], query: string): LibraryFile[] {
  const needle = normalizeQuery(query);
  if (!needle) return files;
  return files.filter(file => normalizeQuery(file.path).includes(needle));
}

/** 按来源编号或工具名筛选来源；空查询返回原列表。 */
export function filterLibrarySources(sources: LibrarySource[], query: string): LibrarySource[] {
  const needle = normalizeQuery(query);
  if (!needle) return sources;
  return sources.filter(source => normalizeQuery(`${source.ref} ${source.tool}`).includes(needle));
}

/**
 * 把来源查询时间格式化为本地 `YYYY-MM-DD HH:mm`；空值或不可解析时原样显示，
 * 不把未知时间伪装成有效时间。
 */
export function formatSourceQueriedAt(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "查询时间未知";
  const time = Date.parse(trimmed);
  if (!Number.isFinite(time)) return trimmed;
  const date = new Date(time);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 截短内部消息 / 回合 id 供界面显示；空值返回空字符串。 */
export function shortLibraryId(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  return trimmed.length > 12 ? `${trimmed.slice(0, 8)}…` : trimmed;
}
