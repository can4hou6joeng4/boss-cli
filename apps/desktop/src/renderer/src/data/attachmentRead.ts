/** 附件读取：逐个文件读取文本，单个失败不拖累同批其余文件，并把原因带回界面。 */
import { safeSlice } from "@boss-harness/shared";

export interface ReadAttachment { id: string; name: string; text: string; size: number }
export interface AttachmentFailure { name: string; reason: string }

const MAX_REASON_LENGTH = 80;
const MAX_LISTED_FAILURES = 3;

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = message.trim();
  return trimmed ? safeSlice(trimmed, MAX_REASON_LENGTH) : "无法读取";
}

export async function readTextAttachments(
  files: readonly File[],
  makeId: () => string,
): Promise<{ added: ReadAttachment[]; failures: AttachmentFailure[] }> {
  const results = await Promise.all(files.map(async (file): Promise<{ added: ReadAttachment } | { failure: AttachmentFailure }> => {
    try {
      return { added: { id: makeId(), name: file.name, text: await file.text(), size: file.size } };
    } catch (error) {
      return { failure: { name: file.name, reason: failureReason(error) } };
    }
  }));
  const added: ReadAttachment[] = [];
  const failures: AttachmentFailure[] = [];
  for (const result of results) {
    if ("added" in result) added.push(result.added);
    else failures.push(result.failure);
  }
  return { added, failures };
}

/** 失败提示：列出前几个失败文件与原因，并说明同批成功项是否已添加。 */
export function attachmentFailureNotice(failures: readonly AttachmentFailure[], addedCount: number): string {
  const listed = failures.slice(0, MAX_LISTED_FAILURES).map(failure => `${failure.name}（${failure.reason}）`).join("、");
  const rest = failures.length > MAX_LISTED_FAILURES ? `等 ${failures.length} 个文件` : "";
  const kept = addedCount > 0 ? `；其余 ${addedCount} 个文件已添加` : "";
  const retry = failures.length > 1 ? "这些文件" : "该文件";
  return `未能读取 ${listed}${rest}${kept}。请重新选择${retry}。`;
}
