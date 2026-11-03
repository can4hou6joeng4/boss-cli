/**
 * 回合耗时展示：只用内核返回的开始/完成时间计算，不读取本机时钟，
 * 因此运行中的回合不会因为界面刷新出现持续增长的「已用」数字。
 */
export interface TurnTimingInput {
  startedAt?: string;
  completedAt?: string;
  status?: string;
}

const parse = (value: string | undefined): number | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

/** 只有两个时间都可解析且结束不早于开始时才给出耗时。 */
export function turnDurationMs(turn: TurnTimingInput): number | null {
  const start = parse(turn.startedAt), end = parse(turn.completedAt);
  return start === null || end === null || end < start ? null : end - start;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "不足 1 秒";
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60), tail = minutes % 60;
  return tail ? `${hours} 小时 ${tail} 分` : `${hours} 小时`;
}

/** 回合标签下的耗时说明；无法计算时运行中的回合显示「进行中」，其余返回 null。 */
export function turnTimingLabel(turn: TurnTimingInput): string | null {
  const duration = turnDurationMs(turn);
  if (duration !== null) return `用时 ${formatDuration(duration)}`;
  return turn.status === "running" ? "进行中" : null;
}
