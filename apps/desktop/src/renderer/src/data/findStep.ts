/**
 * 聊天内查找的跳转游标。
 *
 * 跳转按「处」而不是按「条消息」：一条回复里的思考块、多个工具块与最终答复都可能命中
 * 同一个词，只按消息跳转会漏掉本条内的其余命中，用户没有路径逐处核对上下文。
 *
 * 每个匹配消息至少算一处：命中出现在界面没有渲染出的文本里，或超出高亮区间上限时，
 * DOM 里可能找不到可高亮的区间；退化成消息级定位即可，不能让这条消息变得不可达。
 */

export interface FindCursor {
  /** 匹配消息在 `findMatches` 中的下标。 */
  message: number;
  /** 该消息内的第几处命中，从 0 开始。 */
  offset: number;
}

const EMPTY: FindCursor = { message: 0, offset: 0 };

const whole = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

/** 每条匹配消息的可跳转位点数，至少 1。 */
export function findSteps(counts: readonly number[]): number[] {
  return counts.map(count => Math.max(1, whole(count)));
}

/** 全部匹配消息的位点总数；没有匹配时为 0。 */
export function findStepTotal(counts: readonly number[]): number {
  return findSteps(counts).reduce((sum, steps) => sum + steps, 0);
}

/** 把游标收敛到合法位置：消息下标与消息内位点都夹进范围，非法数值按 0 处理。 */
export function clampFindCursor(cursor: FindCursor, counts: readonly number[]): FindCursor {
  if (!counts.length) return EMPTY;
  const steps = findSteps(counts);
  const message = Math.min(whole(cursor.message), steps.length - 1);
  const offset = Math.min(whole(cursor.offset), (steps[message] ?? 1) - 1);
  return { message, offset };
}

/**
 * 前后移动一个位点。消息内还有命中就先走完，跨消息时直接进入相邻的匹配消息；
 * 到达两端后回到另一端，与按消息跳转时的循环行为一致。
 */
export function stepFindCursor(cursor: FindCursor, counts: readonly number[], delta: 1 | -1): FindCursor {
  if (!counts.length) return EMPTY;
  const steps = findSteps(counts);
  const current = clampFindCursor(cursor, counts);
  const next = current.offset + delta;
  if (next >= 0 && next < (steps[current.message] ?? 1)) return { message: current.message, offset: next };
  const length = steps.length;
  const message = (current.message + delta + length * length) % length;
  return { message, offset: delta > 0 ? 0 : (steps[message] ?? 1) - 1 };
}

/** 游标在全部位点中的全局序号，从 0 开始；用于状态行的「第 N / M 处命中」。 */
export function findCursorPosition(cursor: FindCursor, counts: readonly number[]): number {
  if (!counts.length) return 0;
  const steps = findSteps(counts);
  const safe = clampFindCursor(cursor, counts);
  let position = 0;
  for (let index = 0; index < safe.message; index += 1) position += steps[index] ?? 1;
  return position + safe.offset;
}
