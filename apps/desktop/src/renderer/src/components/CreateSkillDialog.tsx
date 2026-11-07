import { useState } from "react";
import type { SkillDescriptor } from "@boss-harness/protocol";
import { createSkill, harnessErrorText } from "../data/harnessBridge";
import { skillDialogCloseIntent } from "../data/skillEditorClose";
import { ModalSurface } from "./ModalSurface";
import "../styles/skill-editor.css";

interface Props {
  /** 当前生效的技能目录；旧内核不返回时按首选目录预览。 */
  root: string | null;
  onClose: () => void;
  onCreated: (skill: SkillDescriptor) => void;
}

const LIMIT_BYTES = 64 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 生成的 SKILL.md 正文：保留最小 frontmatter，正文原样放在分隔线之后。 */
function buildContent(id: string, name: string, description: string, body: string): string {
  const clean = (value: string) => value.trim().replace(/\s+/g, " ");
  const lines = ["---", `name: ${clean(name) || id}`];
  const summary = clean(description);
  lines.push(`description: ${summary}`, "---", "", body.trim());
  return lines.join("\n");
}

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * 新建技能：只写当前生效的技能目录，不会覆盖同名技能。
 * 表单只负责拼出 SKILL.md，id 与大小限制仍由内核复核。
 */
export function CreateSkillDialog(props: Props) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const content = buildContent(id.trim(), name, description, body);
  const bytes = byteLength(content);
  const idValid = ID_PATTERN.test(id.trim());
  const bodyValid = body.trim().length > 0;
  const overLimit = bytes > LIMIT_BYTES;
  const canSave = idValid && bodyValid && !overLimit && !saving;
  const dirty = id.trim() !== "" || name.trim() !== "" || description.trim() !== "" || body.trim() !== "";
  const root = props.root ?? ".boss-harness/skills";

  // 关闭、Esc、遮罩与右上角按钮共用同一入口：创建中不关闭，已填写内容先提示一次。
  const requestClose = () => {
    const intent = skillDialogCloseIntent(saving, dirty, confirmClose);
    if (intent === "ignore") return;
    if (intent === "confirm") { setConfirmClose(true); return; }
    setConfirmClose(false);
    props.onClose();
  };

  const submit = async () => {
    if (!canSave) return;
    setSaving(true); setError(""); setConfirmClose(false);
    try {
      const result = await createSkill(id.trim(), content);
      const skill = result?.skill;
      if (!skill || typeof skill.id !== "string" || typeof skill.name !== "string" || typeof skill.bytes !== "number") {
        setError("内核返回的新建结果无法识别；请刷新技能目录确认是否已创建。");
        return;
      }
      props.onCreated(skill);
    } catch (cause) {
      setError(`创建技能失败：${harnessErrorText(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  return <ModalSurface title="新建工作区技能" onClose={requestClose} closeDisabled={saving} className="compact-dialog">
    <div className="dialog-form skill-editor-form">
      <p className="dialog-note">只会新建，不会覆盖已有技能。创建后仍需在输入区选择，才会作为上下文注入。</p>
      <p className="skill-editor-path">写入：<code>{root}/{id.trim() || "<id>"}/SKILL.md</code></p>
      <label>技能 id
        <input value={id} onChange={event => setId(event.target.value)} placeholder="例如 candidate-screen" spellCheck={false} autoComplete="off" />
      </label>
      <p className="skill-editor-hint">{id && !idValid ? "id 只能包含小写字母、数字、下划线与连字符，且不超过 64 字符。" : "小写字母、数字、下划线与连字符；创建后目录名即为此 id。"}</p>
      <label>名称（可选）
        <input value={name} onChange={event => setName(event.target.value)} placeholder="默认与 id 相同" />
      </label>
      <label>描述（可选）
        <input value={description} onChange={event => setDescription(event.target.value)} placeholder="一句话说明适用场景" />
      </label>
      <label>技能正文
        <textarea value={body} onChange={event => setBody(event.target.value)} placeholder="说明这个技能在什么情况下使用、需要遵循哪些步骤。" spellCheck={false} />
      </label>
      <p className={"skill-editor-count" + (overLimit ? " is-over" : "")}>{bytes.toLocaleString("zh-CN")} / {LIMIT_BYTES.toLocaleString("zh-CN")} 字节{overLimit ? "，已超过上限" : ""}</p>
      {confirmClose && dirty && <p className="skill-editor-warning" role="alert">有未保存的修改；再次关闭将丢弃。</p>}
      {error && <p className="skill-editor-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" onClick={requestClose} disabled={saving}>取消</button>
        <button type="button" className="solid-button" onClick={() => { void submit(); }} disabled={!canSave}>{saving ? "正在创建…" : "创建技能"}</button>
      </div>
    </div>
  </ModalSurface>;
}
