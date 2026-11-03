import { useEffect, useState } from "react";
import type { WorkspaceInstructionsState, WorkspaceInstructionsText } from "@boss-harness/protocol";
import { harnessErrorText, readWorkspaceInstructions } from "../data/harnessBridge";
import { WorkspaceInstructionsEditor } from "./WorkspaceInstructionsEditor";

export interface WorkspaceInstructionsSectionProps {
  /** 内核声明 workspaceInstructionsEdit 时才提供状态与编辑入口。 */
  editable: boolean;
  connected: boolean;
  preview: boolean;
}

const STATUS_TEXT: Record<WorkspaceInstructionsState["status"], string> = {
  loaded: "已加载",
  empty: "文件为空，未注入",
  too_large: "超过上限，已忽略",
  unreadable: "无法读取（需普通 UTF-8 文件且不是符号链接），已忽略",
};
const number = (value: number) => value.toLocaleString("zh-CN");

/**
 * 「技能与工具」页的工作区常驻说明：没有活动会话也能查看状态并编辑，
 * 复用上下文面板的编辑器；写入规则仍由内核裁定。
 */
export function WorkspaceInstructionsSection(props: WorkspaceInstructionsSectionProps) {
  const [info, setInfo] = useState<WorkspaceInstructionsText | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setInfo(null); setError("");
    if (!props.editable || !props.connected) return;
    let active = true;
    setReading(true);
    readWorkspaceInstructions().then(value => {
      if (!active) return;
      if (!value || typeof value.path !== "string" || typeof value.status !== "string" || typeof value.limitBytes !== "number") {
        setError("内核返回的工作区说明状态无法识别。");
        return;
      }
      setInfo(value);
    }).catch(cause => { if (active) setError(`读取工作区说明失败：${harnessErrorText(cause)}`); })
      .finally(() => { if (active) setReading(false); });
    return () => { active = false; };
  }, [props.editable, props.connected, reload]);
  return <section aria-labelledby="workspace-instructions-heading">
    <div className="page-section-head">
      <h2 className="page-section-title" id="workspace-instructions-heading">工作区常驻说明</h2>
      {props.editable && !editing && <button type="button" className="subtle-button" onClick={() => setEditing(true)} disabled={!props.connected || reading}>{info ? "编辑工作区说明…" : "添加工作区说明…"}</button>}
    </div>
    {!props.editable && <div className="page-tool-empty">{props.preview ? "浏览器预览未连接工作区说明。启动桌面端后可查看或保存。" : "当前内核未声明工作区说明读取能力。"}</div>}
    {props.editable && !props.connected && <div className="page-tool-empty">连接本地 Harness 后可查看或保存工作区说明。</div>}
    {props.editable && props.connected && reading && !info && <div className="page-tool-empty">正在读取工作区说明…</div>}
    {props.editable && error && <p className="page-tool-empty" role="alert">{error}</p>}
    {info && <p className="workspace-instructions-status">生效文件：<code>{info.path}</code> · {STATUS_TEXT[info.status]}{info.bytes === null ? "" : `（${number(info.bytes)} 字节，上限 ${number(info.limitBytes)}）`}</p>}
    {props.editable && <WorkspaceInstructionsEditor open={editing} connected={props.connected} onClose={() => setEditing(false)} onSaved={() => setReload(previous => previous + 1)} />}
    <p className="page-empty-note">内容作为每回合的上下文注入，最多 8 KiB；不改变工具权限、审批要求或只读限制，保存后下一回合生效。</p>
  </section>;
}
