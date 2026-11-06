import { useEffect, useRef, useState } from "react";
import type { ToolResultReadResponse, ToolResultReference } from "@boss-harness/protocol";
import { MAX_WHOLE_RESULT_CHARS, readToolResultChunk, readWholeToolResult } from "../data/toolResultReads";
import { useClipboardCopy } from "../data/clipboardCopy";
import { harnessErrorText } from "../data/harnessBridge";

export function ToolResultDetails({ output, resultRef }: { output?: string; resultRef?: ToolResultReference }) {
  if (resultRef) return <ChunkedResult key={`${resultRef.threadId}:${resultRef.itemId}:${resultRef.sha256}`} reference={resultRef} />;
  return output ? <details className="tool-source-output"><summary>查看结构化结果</summary><pre>{output}</pre></details> : null;
}

function ChunkedResult({ reference }: { reference: ToolResultReference }) {
  const [chunk, setChunk] = useState<ToolResultReadResponse | null>(null);
  const [position, setPosition] = useState(0);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copying, setCopying] = useState(false);
  const [copyProgress, setCopyProgress] = useState<{ loaded: number; total: number } | null>(null);
  const clipboard = useClipboardCopy();
  const requestId = useRef(0);
  const copyRequestId = useRef(0);
  useEffect(() => () => { requestId.current += 1; copyRequestId.current += 1; }, []);

  async function read(index: number, cursor: string | undefined, expectedOffset?: number) {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const next = await readToolResultChunk(reference, cursor);
      if (id !== requestId.current) return;
      if (expectedOffset !== undefined && next.offset !== expectedOffset) throw new Error("结果分段顺序已变化，请重新读取第一段");
      setChunk(next);
      setPosition(index);
      setCursors(previous => [...previous.slice(0, index), cursor]);
    } catch (problem) {
      if (id === requestId.current) setError(harnessErrorText(problem));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  const end = chunk ? chunk.offset + Array.from(chunk.text).length : 0;
  const copyKey = `${reference.threadId}:${reference.itemId}:${reference.sha256}:whole`;
  const copyFeedback = clipboard.feedback?.key === copyKey ? clipboard.feedback : null;
  const validLength = Number.isSafeInteger(reference.characterLength) && reference.characterLength >= 1;
  const copyTooLarge = !validLength || reference.characterLength > MAX_WHOLE_RESULT_CHARS;
  const copyTitle = !validLength
    ? "结果引用无效，无法整体复制"
    : copyTooLarge
      ? `结果共 ${reference.characterLength.toLocaleString()} 字符，超过整体复制上限 ${MAX_WHOLE_RESULT_CHARS.toLocaleString()} 字符`
      : "读取并复制完整结构化结果";

  async function copyWhole() {
    const id = ++copyRequestId.current;
    setCopying(true);
    setCopyProgress({ loaded: 0, total: reference.characterLength });
    setError("");
    try {
      const text = await readWholeToolResult(reference, {
        onProgress: (loaded, total) => {
          if (id === copyRequestId.current) setCopyProgress({ loaded, total });
        },
      });
      if (id !== copyRequestId.current) return;
      await clipboard.copy(text, copyKey);
    } catch (problem) {
      if (id === copyRequestId.current) setError(harnessErrorText(problem));
    } finally {
      if (id === copyRequestId.current) {
        setCopying(false);
        setCopyProgress(null);
      }
    }
  }

  return <details className="tool-source-output tool-result-segments">
    <summary>查看完整结构化结果（分段）</summary>
    <p>共 {reference.characterLength.toLocaleString()} 字符，按需读取。每次最多显示 16,384 字符。</p>
    <div className="tool-result-controls">
      <button type="button" disabled={loading || copying} onClick={() => void read(0, undefined, 0)}>读取第一段</button>
      <button type="button" disabled={loading || copying || !chunk || position === 0} onClick={() => void read(position - 1, cursors[position - 1])}>上一段</button>
      <button type="button" disabled={loading || copying || !chunk?.nextCursor} onClick={() => chunk?.nextCursor && void read(position + 1, chunk.nextCursor, end)}>下一段</button>
      <button type="button" disabled={loading || copying || copyTooLarge} title={copyTitle} onClick={() => void copyWhole()}>{copying ? "正在读取…" : "复制完整结果"}</button>
    </div>
    <div role="status">{loading ? "正在读取…" : chunk ? `字符 ${chunk.offset + 1}–${end} / ${reference.characterLength}${chunk.nextCursor ? "" : " · 已到末尾"}` : "点击读取第一段查看内容"}</div>
    {copying && copyProgress && <div role="status">正在读取 {copyProgress.loaded.toLocaleString()} / {copyProgress.total.toLocaleString()} 字符…</div>}
    {copyFeedback && <div role="status" style={{ fontSize: 11, color: copyFeedback.ok ? "var(--accent-green)" : "var(--text-muted)" }}>{copyFeedback.ok ? `已复制 ${reference.characterLength.toLocaleString()} 字符` : `复制失败：${copyFeedback.reason}`}</div>}
    {copyTooLarge && <p className="tool-result-note">{validLength ? `结果超过整体复制上限（${MAX_WHOLE_RESULT_CHARS.toLocaleString()} 字符），请分段查看。` : "结果引用无效，请分段查看。"}</p>}
    {error && <p role="alert">{error}</p>}
    {chunk && <pre>{chunk.text}</pre>}
  </details>;
}
