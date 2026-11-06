import type { SessionItem } from "./mockData";

/**
 * 会话内异步操作的归属判定。
 *
 * 选中会话后发起的读取可能比列表刷新更晚返回：改名、归档与切换线路都会触发 refresh
 * 并替换当前会话对象。异步回调只有仍指向同一对象时才能写回，否则会用旧快照覆盖新值。
 */

/** resume 快照的元数据写回目标；选中时的对象已被列表刷新替换时返回 null。 */
export function resumedSession(current: SessionItem | null, selected: SessionItem): SessionItem | null {
  return current === selected ? selected : null;
}

export interface ContinuationIdentity {
  threadId: string;
  sourceTurnId: string;
}

/** 提示是否属于本次续接请求；期间切换会话后，新会话的提示不得被清理。 */
export function matchesContinuation<T extends ContinuationIdentity>(current: T | null | undefined, check: ContinuationIdentity): current is T {
  return Boolean(current && current.threadId === check.threadId && current.sourceTurnId === check.sourceTurnId);
}
