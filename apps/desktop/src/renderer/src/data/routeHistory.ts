/**
 * 会话历史导航的路由栈维护。
 *
 * 历史栈里记录的是「工作区页面 + 会话 id」。会话被删除后，栈里仍可能残留指向它的路由：
 * 后退/前进落到这些路由时，界面无法打开对应会话。这里只做纯计算，打开视图与提示由调用方负责。
 */

export interface HistoryRouteLike {
  page: string;
  sessionId?: string;
}

export interface SessionHistoryPrune<Route extends HistoryRouteLike> {
  routes: Route[];
  /** 修剪后光标应指向的下标；始终落在有效范围内。 */
  cursor: number;
}

/**
 * 从历史栈移除指定会话的路由。
 *
 * 返回 null 表示栈里没有该会话，调用方无需更新。光标按「原位置或其后最近一条」调整：
 * 光标落在被移除条目上时，修剪后同一下标即原位置之后的第一条；没有后续条目时停在末尾。
 */
export function dropSessionHistory<Route extends HistoryRouteLike>(
  routes: readonly Route[], cursor: number, sessionId: string,
): SessionHistoryPrune<Route> | null {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= routes.length) return null;
  const matches = (route: HistoryRouteLike | undefined): boolean =>
    route !== undefined && route.sessionId === sessionId;
  if (!routes.some(matches)) return null;
  // 只计算光标之前被移除的条目：原光标位置的元素被移除时，同一下标自然指向它后面的第一条。
  const removedBefore = routes.slice(0, cursor).filter(matches).length;
  const remaining = routes.filter(route => !matches(route));
  // 初始的首页路由不带 sessionId，不会被移除，所以修剪后至少剩一条。
  return { routes: remaining, cursor: Math.max(0, Math.min(cursor - removedBefore, remaining.length - 1)) };
}

/**
 * 从光标出发按方向找到最近一条可达路由的下标；全部不可达或方向越界时返回 -1。
 * 用于「后退/前进」跳过已删除会话留下的失效路由，避免把用户带到一个打不开的页面。
 */
export function nextReachableIndex<Route>(
  routes: readonly Route[], cursor: number, delta: number, reachable: (route: Route) => boolean,
): number {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= routes.length
      || !Number.isSafeInteger(delta) || delta === 0) return -1;
  for (let index = cursor + delta; index >= 0 && index < routes.length; index += delta) {
    const route = routes[index];
    if (route !== undefined && reachable(route)) return index;
  }
  return -1;
}
