import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingApproval } from "@boss-harness/protocol";
import { ModalSurface } from "./ModalSurface";
import { IconNotification, IconCheck, IconClock } from "./Icons";
import { approvalRemainingText, groupPendingApprovals, nextApprovalIndex } from "../data/pendingApprovals";
import { notificationGroupLabel } from "../data/notificationLabels";
import { harnessErrorText, listPendingApprovals } from "../data/harnessBridge";
import { sessionRows } from "../data/sessionRows";
import type { ProjectFolder, SessionItem } from "../data/mockData";

type PendingState =
  | { status: "loading" }
  | { status: "ready"; approvals: PendingApproval[]; truncated: boolean; now: number }
  | { status: "error"; message: string };

export function NotificationsDialog({ folders, preview = false, refreshToken, onSelect, onOpenMessage, onLoaded, onClose }: {
  folders: ProjectFolder[];
  /** 示例模式不连接内核，不发起审批读取。 */
  preview?: boolean;
  /** 打开期间外部审批事件计数；变化时静默重读，不切换加载态。 */
  refreshToken?: number;
  onSelect: (session: SessionItem) => void;
  /** 打开会话并定位到审批项；缺省时只打开会话。 */
  onOpenMessage?: (session: SessionItem, itemId: string) => void;
  /** 成功读取后回报数量，供侧栏徽标同步；失败不调用。 */
  onLoaded?: (count: number) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<PendingState>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const loaded = useRef(onLoaded); loaded.current = onLoaded;
  const silentReload = useRef<() => void>(() => {});

  useEffect(() => {
    if (preview) return;
    let cancelled = false, inFlight = false;
    const load = (silent: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (!silent) setState({ status: "loading" });
      void listPendingApprovals(100).then(
        result => { if (cancelled) return; setState({ status: "ready", approvals: result.approvals, truncated: result.truncated, now: Date.now() }); loaded.current?.(result.approvals.length); },
        cause => {
          if (cancelled) return;
          // 后台刷新失败保留已有列表；首次读取失败才展示错误与重试。
          setState(previous => silent && previous.status === "ready" ? previous : { status: "error", message: harnessErrorText(cause) });
        },
      ).finally(() => { inFlight = false; });
    };
    silentReload.current = () => load(true);
    load(false);
    // 打开期间每 15 秒静默重读，让新审批、已处理项与到期提示保持新鲜。
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") load(true); }, 15_000);
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true; silentReload.current = () => {};
      window.clearInterval(timer); window.removeEventListener("focus", onFocus);
    };
  }, [reload, preview]);

  useEffect(() => {
    // 审批事件到达时立即静默重读；首次挂载由上面的加载负责，inFlight 会合并重复请求。
    if (preview || !refreshToken) return;
    silentReload.current();
  }, [refreshToken, preview]);

  const retry = useCallback(() => setReload(previous => previous + 1), []);
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const key = event.key;
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".notification-row:not(:disabled)")];
    if (!rows.length) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = key === "Home" ? 0 : key === "End" ? rows.length - 1 : nextApprovalIndex(current, rows.length, key === "ArrowDown" ? 1 : -1);
    const target = rows[next];
    if (!target) return;
    event.preventDefault();
    target.focus();
  };
  const rows = state.status === "ready"
    ? new Map(sessionRows(folders, "", { includeArchived: true }).map(row => [row.session.id, row]))
    : new Map<string, { session: SessionItem; project: string }>();

  return (
    <ModalSurface title="通知" onClose={onClose}>
      {preview && <div className="notification-empty"><IconNotification size={32} /><h3>示例模式</h3><p>连接本机内核后，可在这里查看跨会话待审批。</p></div>}
      {!preview && state.status === "loading" && <div className="notification-empty" role="status">
        <IconNotification size={32} /><h3>正在读取待审批操作…</h3><p>等待本机内核返回当前会话的审批队列。</p>
      </div>}
      {!preview && state.status === "error" && <div className="notification-empty" role="alert">
        <IconNotification size={32} /><h3>无法读取待审批操作</h3>
        <p>{state.message}。这不代表没有待审批，请稍后重试。</p>
        <button className="secondary-button" onClick={retry}>重试</button>
      </div>}
      {!preview && state.status === "ready" && state.approvals.length === 0 && <div className="notification-empty">
        <IconNotification size={32} /><h3>目前没有新通知</h3><p>需要你确认的操作会在聊天中显示。</p><span><IconCheck size={13} />当前工作区</span>
      </div>}
      {!preview && state.status === "ready" && state.approvals.length > 0 && <div onKeyDown={onListKeyDown}>
        <div className="notification-toolbar">
          <span title={state.truncated ? "内核还有更早的待审批未放入本次列表；处理当前项后刷新查看。" : undefined}>
            {state.approvals.length} 项等待你确认{state.truncated ? "（仍有更早项未显示）" : ""} · ↑ ↓ 选择
          </span>
          <button className="secondary-button" onClick={retry}>刷新</button>
        </div>
        <ul className="notification-list">
          {groupPendingApprovals(state.approvals).map(group => {
            const row = rows.get(group.threadId);
            const session = row?.session;
            const label = notificationGroupLabel({ threadId: group.threadId, session, project: row?.project });
            return <li key={group.threadId} className="notification-group">
              <div className="notification-group-heading">
                <span className="notification-group-thread">{label}</span>
                <span>{group.approvals.length} 项</span>
              </div>
              <ul className="notification-group-list">
                {group.approvals.map(approval => <li key={approval.approvalId}>
                  <button className="notification-row" disabled={!session} title={session ? `打开「${label}」并定位到审批卡` : "该会话不在当前列表中"} onClick={() => { if (!session) return; if (onOpenMessage) onOpenMessage(session, approval.itemId); else onSelect(session); onClose(); }}>
                    <span className="notification-row-heading"><strong>{approval.toolName}</strong><span className="notification-remaining"><IconClock size={12} />{approvalRemainingText(approval.deadline, state.now)}</span></span>
                    {approval.summary && <span className="notification-row-summary">{approval.summary}</span>}
                  </button>
                </li>)}
              </ul>
            </li>;
          })}
        </ul>
      </div>}
    </ModalSurface>
  );
}
