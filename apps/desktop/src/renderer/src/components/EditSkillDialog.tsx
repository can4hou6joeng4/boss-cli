import { useState } from "react";
import type { SkillDescriptor, SkillReadResponse } from "@boss-harness/protocol";
import { harnessErrorText, writeSkill } from "../data/harnessBridge";
import { skillDialogCloseIntent } from "../data/skillEditorClose";
import { ModalSurface } from "./ModalSurface";
import "../styles/skill-editor.css";

interface Props {
  /** 读取到的技能快照；摘要用作并发校验，正文作为编辑初值。 */
  skill: SkillReadResponse;
  root: string | null;
  onClose: () => void;
  onSaved: (skill: SkillDescriptor) => void;
}

const LIMIT_BYTES = 64 * 1024;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * 编辑已有技能：保存时携带读取摘要，技能被外部修改后内核拒绝写入，
 * 不会静默覆盖别人的改动。
 */
export function EditSkillDialog(props: Props) {
  const [content, setContent] = useState(props.skill.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const bytes = byteLength(content);
  const overLimit = bytes > LIMIT_BYTES;
  const changed = content !== props.skill.content;
  const canSave = changed && content.trim().length > 0 && !overLimit && !saving;
  const root = props.root ?? ".boss-harness/skills";

  // 「取消」、Esc、遮罩与右上角按钮共用同一关闭入口：保存中不关闭，未保存时先提示一次。
  const requestClose = () => {
    const intent = skillDialogCloseIntent(saving, changed, confirmClose);
    if (intent === "ignore") return;
    if (intent === "confirm") { setConfirmClose(true); return; }
    setConfirmClose(false);
    props.onClose();
  };

  const submit = async () => {
    if (!canSave) return;
    setSaving(true); setError(""); setConfirmClose(false);
    try {
      const result = await writeSkill(props.skill.id, content, props.skill.digest);
      const skill = result?.skill;
      if (!skill || typeof skill.id !== "string" || typeof skill.name !== "string" || typeof skill.bytes !== "number") {
        setError("内核返回的修改结果无法识别；请关闭后重新读取技能确认。");
        return;
      }
      props.onSaved(skill);
    } catch (cause) {
      setError(`修改技能失败：${harnessErrorText(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  return <ModalSurface title={`编辑技能 ${props.skill.name}`} onClose={requestClose} closeDisabled={saving} className="compact-dialog">
    <div className="dialog-form skill-editor-form">
      <p className="dialog-note">保存会覆盖磁盘上的 SKILL.md。若文件在此期间被外部修改，保存会失败而不会覆盖；此时请关闭并重新读取。</p>
      <p className="skill-editor-path">写入：<code>{root}/{props.skill.id}/SKILL.md</code></p>
      <p className="skill-editor-hint">读取摘要：{props.skill.digest.slice(0, 12)}…（保存时用于确认内容未被修改）</p>
      <label>SKILL.md 正文
        <textarea value={content} onChange={event => setContent(event.target.value)} spellCheck={false} />
      </label>
      <p className={"skill-editor-count" + (overLimit ? " is-over" : "")}>{bytes.toLocaleString("zh-CN")} / {LIMIT_BYTES.toLocaleString("zh-CN")} 字节{overLimit ? "，已超过上限" : ""}</p>
      {confirmClose && changed && <p className="skill-editor-warning" role="alert">有未保存的修改；再次关闭将丢弃。</p>}
      {error && <p className="skill-editor-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" onClick={requestClose} disabled={saving}>取消</button>
        <button type="button" className="solid-button" onClick={() => { void submit(); }} disabled={!canSave}>{saving ? "正在保存…" : changed ? "保存修改" : "没有修改"}</button>
      </div>
    </div>
  </ModalSurface>;
}
