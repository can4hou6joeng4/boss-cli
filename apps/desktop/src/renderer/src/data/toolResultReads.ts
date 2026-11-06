import { ClientMethods, type ToolResultReadResponse, type ToolResultReference } from "@boss-harness/protocol";

export type Requester = <T>(method: string, params: unknown) => Promise<T>;
const CHUNK_LIMIT = 16384;
/** 整体复制的字符上限；超过时不发起任何读取，避免长时间 RPC 与大段剪贴板内容。 */
export const MAX_WHOLE_RESULT_CHARS = 1_000_000;
/** 整体读取时允许的最小分段（内核按 16,384 字符返回，这里留出容错并防止异常内核用超小分段拖住请求）。 */
const MIN_WHOLE_CHUNK_CHARS = 1024;

/** One explicit read; never follows a cursor or invokes a recruitment tool. */
export async function readToolResultChunk(
  ref: ToolResultReference,
  cursor?: string,
  requester: Requester = (method, params) => window.boss.request(method, params),
): Promise<ToolResultReadResponse> {
  const response = await requester<ToolResultReadResponse>(ClientMethods.threadItemResultRead, {
    threadId: ref.threadId, itemId: ref.itemId, sha256: ref.sha256, cursor, limit: CHUNK_LIMIT,
  });
  const actual = response?.resultRef;
  if (!actual || (["threadId", "itemId", "encoding", "sha256", "byteLength", "characterLength"] as const)
    .some(key => actual[key] !== ref[key])) throw new Error("结果版本已变化，请重新打开聊天后查看");
  if (typeof response.text !== "string" || !Number.isSafeInteger(response.offset) || response.offset < 0 ||
    !Number.isSafeInteger(ref.characterLength) || ref.characterLength < 1 ||
    !Number.isSafeInteger(ref.byteLength) || ref.byteLength < ref.characterLength ||
    (cursor === undefined ? response.offset !== 0 : response.offset === 0)) throw new Error("结果分段无效");
  const length = Array.from(response.text).length;
  const end = response.offset + length;
  if (length < 1 || length > CHUNK_LIMIT || end > ref.characterLength ||
    (response.nextCursor === null ? end !== ref.characterLength :
      typeof response.nextCursor !== "string" || !response.nextCursor.startsWith("tr1_") ||
      response.nextCursor.length > 2048 || response.nextCursor === cursor || end >= ref.characterLength)) {
    throw new Error("结果分段不完整，请重试");
  }
  return response;
}

export interface WholeResultReadOptions {
  requester?: Requester;
  /** 整体复制上限，默认 {@link MAX_WHOLE_RESULT_CHARS}；用于测试或更保守的调用方。 */
  maxChars?: number;
  /** 每读完一段回调一次；`loaded` 为已读取的 Unicode 码点数，`total` 为引用声明的总码点数。 */
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * 按游标连续读取并拼接完整工具结果，供「复制完整结果」使用。
 * 每段都经 {@link readToolResultChunk} 校验引用、偏移与游标；任一段失败、偏移不连续、
 * 分段数量异常或总长度与 `resultRef.characterLength` 不符时整体失败，不返回部分文本。
 * 超过上限时在发起请求前拒绝，因此不会产生任何 RPC。
 */
export async function readWholeToolResult(
  ref: ToolResultReference,
  options: WholeResultReadOptions = {},
): Promise<string> {
  const { requester, maxChars = MAX_WHOLE_RESULT_CHARS, onProgress } = options;
  if (!Number.isSafeInteger(ref.characterLength) || ref.characterLength < 1) throw new Error("结果引用无效");
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("整体复制上限无效");
  if (ref.characterLength > maxChars) {
    throw new Error(`结果共 ${ref.characterLength} 字符，超过整体复制上限 ${maxChars} 字符`);
  }
  const chunkBudget = Math.ceil(ref.characterLength / MIN_WHOLE_CHUNK_CHARS) + 8;
  const parts: string[] = [];
  let offset = 0;
  let cursor: string | undefined;
  while (offset < ref.characterLength) {
    const chunk = await readToolResultChunk(ref, cursor, requester);
    if (chunk.offset !== offset) throw new Error("结果分段偏移不连续，请分段查看");
    const length = Array.from(chunk.text).length;
    parts.push(chunk.text);
    offset += length;
    if (parts.length > chunkBudget) throw new Error("结果分段数量异常，请分段查看");
    if (offset > ref.characterLength) throw new Error("结果分段超出引用长度，请分段查看");
    onProgress?.(offset, ref.characterLength);
    if (offset < ref.characterLength) {
      if (!chunk.nextCursor) throw new Error("结果分段提前结束，请分段查看");
      cursor = chunk.nextCursor;
    }
  }
  return parts.join("");
}
