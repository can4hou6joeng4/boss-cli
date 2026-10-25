import { ClientMethods, type ToolResultReadResponse, type ToolResultReference } from "@boss-cli/protocol";

type Requester = <T>(method: string, params: unknown) => Promise<T>;
const CHUNK_LIMIT = 16384;

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
