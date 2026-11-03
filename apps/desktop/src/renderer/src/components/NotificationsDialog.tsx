import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingApproval } from "@boss-harness/protocol";
import { ModalSurface } from "./ModalSurface";
import { IconNotification, IconCheck, IconClock } from "./Icons";
import { approvalRemainingText } from "../data/pendingApprovals";
import { harnessErrorText, listPendingApprovals } from "../data/harnessBridge";
import { sessionRows } from "../data/sessionRows";
import type { ProjectFolder, SessionItem } from "../data/mockData";

type PendingState =
  | { status: "loading" }
  | { status: "ready"; approvals: PendingApproval[]; now: number }
  | { status: "error"; message: string };

export function NotificationsDialog({ folders, preview = false, onSelect, onLoaded, onClose }: {
  folders: ProjectFolder[];
  /** 示例模式不连接内核，不发起审批读取。 */
  preview?: boolean;
  onSelect: (session: SessionItem) => void;
  /** 成功读取后回报数量，供侧栏徽标同步；失败不调用。 */
  onLoaded?: (count: number) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<PendingState>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const loaded = useRef(onLoaded); loaded.current = onLoaded;

  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    setState({ status: "loading" });
    void listPendingApprovals(100).then(
      approvals => { if (cancelled) return; setState({ status: "ready", approvals, now: Date.now() }); loaded.current?.(approvals.length); },
      cause => { if (!cancelled) setState({ status: "error", message: harnessErrorText(cause) }); },
    );
    return () => { cancelled = true; };
  }, [reload, preview]);

  const retry = useCallback(() => setReload(previous => previous + 1), []);
  const sessions = state.status === "ready"
    ? new Map(sessionRows(folders, "", { includeArchived: true }).map(row => [row.session.id, row.session]))
    : new Map<string, SessionItem>();

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
      {!preview && state.status === "ready" && state.approvals.length > 0 && <>
        <div className="notification-toolbar">
          <span>{state.approvals.length} 项等待你确认</span>
          <button className="secondary-button" onClick={retry}>刷新</button>
        </div>
        <ul className="notification-list">
          {state.approvals.map(approval => {
            const session = sessions.get(approval.threadId);
            const label = session?.title ?? `会话 ${approval.threadId.slice(0, 8)}`;
            return <li key={approval.approvalId}>
              <button className="notification-row" disabled={!session} title={session ? `打开「${label}」` : "该会话不在当前列表中"} onClick={() => { if (!session) return; onSelect(session); onClose(); }}>
                <span className="notification-row-heading"><strong>{approval.toolName}</strong><span className="notification-remaining"><IconClock size={12} />{approvalRemainingText(approval.deadline, state.now)}</span></span>
                <span className="notification-row-thread">{label}{session?.archived === true ? " · 已归档" : ""}</span>
                {approval.summary && <span className="notification-row-summary">{approval.summary}</span>}
              </button>
            </li>;
          })}
        </ul>
      </>}
    </ModalSurface>
  );
}
