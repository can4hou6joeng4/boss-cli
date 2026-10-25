import { useEffect, useRef, useState } from "react";
import type { ToolResultReadResponse, ToolResultReference } from "@boss-cli/protocol";
import { readToolResultChunk } from "../data/toolResultReads";

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
  const requestId = useRef(0);
  useEffect(() => () => { requestId.current += 1; }, []);

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
      if (id === requestId.current) setError(problem instanceof Error ? problem.message.slice(0, 500) : "读取失败，请重试");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  const end = chunk ? chunk.offset + Array.from(chunk.text).length : 0;
  return <details className="tool-source-output tool-result-segments">
    <summary>查看完整结构化结果（分段）</summary>
    <p>共 {reference.characterLength.toLocaleString()} 字符，按需读取。每次最多显示 16,384 字符。</p>
    <div className="tool-result-controls">
      <button type="button" disabled={loading} onClick={() => void read(0, undefined, 0)}>读取第一段</button>
      <button type="button" disabled={loading || !chunk || position === 0} onClick={() => void read(position - 1, cursors[position - 1])}>上一段</button>
      <button type="button" disabled={loading || !chunk?.nextCursor} onClick={() => chunk?.nextCursor && void read(position + 1, chunk.nextCursor, end)}>下一段</button>
    </div>
    <div role="status">{loading ? "正在读取…" : chunk ? `字符 ${chunk.offset + 1}–${end} / ${reference.characterLength}${chunk.nextCursor ? "" : " · 已到末尾"}` : "点击读取第一段查看内容"}</div>
    {error && <p role="alert">{error}</p>}
    {chunk && <pre>{chunk.text}</pre>}
  </details>;
}
