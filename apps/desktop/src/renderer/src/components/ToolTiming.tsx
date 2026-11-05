import { useEffect, useState } from "react";
import type { MessageItem } from "../data/mockData";
import { toolTimingLabel } from "../data/toolTiming";

/** 工具卡摘要行的耗时；运行中每秒刷新，完成后定格为内核测量的耗时。 */
export function ToolTiming({ toolUse }: { toolUse: NonNullable<MessageItem["toolUse"]> }) {
  const running = toolUse.endedAt === undefined && toolUse.durationMs === undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    // 依赖项只取实际计时起点：其它增量事件不重建定时器。
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, toolUse.startedAt, toolUse.waitingSince]);
  const text = toolTimingLabel(toolUse, now);
  return text ? <span className="tool-timing">{text}</span> : null;
}
