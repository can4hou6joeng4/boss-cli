import { useState } from "react";
import type { SkillReadResponse } from "@boss-harness/protocol";
import { deleteSkill, harnessErrorText } from "../data/harnessBridge";
import { ModalSurface } from "./ModalSurface";
import "../styles/skill-editor.css";

interface Props {
  /** 读取到的技能快照；摘要用于确认磁盘内容未被修改。 */
  skill: SkillReadResponse;
  root: string | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
}

/**
 * 删除技能：需要二次确认，且只删除仅包含 SKILL.md 的目录。
 * 目录里还有脚本或素材时内核会拒绝，避免连带删除用户文件。
 */
export function DeleteSkillDialog(props: Props) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const root = props.root ?? ".boss-harness/skills";

  const submit = async () => {
    if (deleting) return;
    setDeleting(true); setError("");
    try {
      const result = await deleteSkill(props.skill.id, props.skill.digest);
      if (result?.id !== props.skill.id) {
        setError("内核返回的删除结果与当前技能不匹配；请关闭后刷新目录确认。");
        return;
      }
      props.onDeleted(props.skill.id);
    } catch (cause) {
      setError(`删除技能失败：${harnessErrorText(cause)}`);
    } finally {
      setDeleting(false);
    }
  };

  return <ModalSurface title={`删除技能 ${props.skill.name}`} onClose={props.onClose} className="compact-dialog">
    <div className="dialog-form">
      <p className="dialog-note">删除后不可恢复。只会删除仅包含一个 <code>SKILL.md</code> 的技能目录；目录里还有脚本、素材或其他文件时会拒绝删除。</p>
      <p className="skill-editor-path">删除：<code>{root}/{props.skill.id}/SKILL.md</code></p>
      <p className="skill-editor-hint">读取摘要：{props.skill.digest.slice(0, 12)}…（若文件已被外部修改，删除会失败）</p>
      {error && <p className="skill-editor-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" onClick={props.onClose} disabled={deleting}>取消</button>
        <button type="button" className="solid-button danger-button" onClick={() => { void submit(); }} disabled={deleting}>{deleting ? "正在删除…" : "删除技能"}</button>
      </div>
    </div>
  </ModalSurface>;
}
