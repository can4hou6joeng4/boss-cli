import { useEffect, useState } from "react";
import type { SkillDescriptor, SkillReadResponse } from "@boss-harness/protocol";
import { harnessErrorText, readSkill, type SkillCatalogState } from "../data/harnessBridge";
import { IconChevronRight, IconSparkles } from "./Icons";

export interface WorkspaceSkillsProps {
  skills: SkillDescriptor[];
  state: SkillCatalogState;
  error?: string;
  /** 内核声明 skillsRead 时才请求正文；否则只展示目录里的名称与描述。 */
  readable: boolean;
  /** 当前生效的技能目录；旧内核不返回时为 null。 */
  root: string | null;
  /** 把技能预选进新会话草稿；不会自动发送。 */
  onUseSkill: (skillId: string) => void;
  preview: boolean;
  onRefresh: () => void;
}

const byteText = (value: number) => `${value.toLocaleString("zh-CN")} 字节`;

/**
 * 「技能与工具」页的工作区技能列表与只读正文。正文来自 SKILL.md，
 * 选择后才作为上下文注入；这里不提供编辑或执行入口。
 */
export function WorkspaceSkills(props: WorkspaceSkillsProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillReadResponse | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const selected = props.skills.find(skill => skill.id === selectedId) ?? null;
  useEffect(() => {
    // 目录刷新后选中项可能消失；正文只属于当前目录中的技能。
    if (selectedId && !props.skills.some(skill => skill.id === selectedId)) {
      setSelectedId(null); setDetail(null); setDetailError("");
    }
  }, [props.skills, selectedId]);
  useEffect(() => {
    setDetail(null); setDetailError("");
    if (!selectedId || !props.readable) return;
    let active = true;
    setDetailLoading(true);
    readSkill(selectedId).then(value => {
      if (!active) return;
      // 内核返回的正文是展示的唯一依据；形状不符时明确失败，不静默显示半截内容。
      if (!value || typeof value.content !== "string" || typeof value.id !== "string" || typeof value.bytes !== "number") {
        setDetailError("内核返回的技能正文无法识别。");
        return;
      }
      setDetail(value);
    }).catch(cause => { if (active) setDetailError(`读取技能正文失败：${harnessErrorText(cause)}`); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId, props.readable, reload]);
  return <section aria-labelledby="workspace-skills-heading">
    <div className="page-section-head">
      <h2 className="page-section-title" id="workspace-skills-heading">工作区技能 <span>{props.state === "ready" || props.state === "empty" ? props.skills.length : "—"}</span></h2>
      <button type="button" className="subtle-button" onClick={props.onRefresh} disabled={props.state === "loading" || props.state === "unavailable"}>{props.state === "loading" ? "正在读取…" : "刷新技能目录"}</button>
    </div>
    {props.state === "loading" && <div className="page-tool-empty">正在读取工作区技能…</div>}
    {props.state === "error" && <div className="page-tool-empty">技能目录读取失败{props.error ? `：${props.error}` : ""}。这只表示读取没有完成，不代表工作区没有技能。</div>}
    {props.state === "unavailable" && <div className="page-tool-empty">{props.preview ? "浏览器预览未连接技能目录。启动桌面端后显示工作区技能。" : "连接本地 Harness 后可读取工作区技能。"}</div>}
    {props.state === "empty" && <div className="page-tool-empty">当前工作区没有技能。可在 <code>.boss-harness/skills/&lt;id&gt;/SKILL.md</code> 添加。</div>}
    {props.root && (props.state === "ready" || props.state === "empty") && <p className="workspace-skill-source">技能目录：<code>{props.root}</code>{props.root === ".boss-cli/skills" ? "（旧目录；新建 .boss-harness/skills 后将改用新目录）" : ""}</p>}
    {props.skills.length > 0 && <div className="workspace-skill-layout">
      <div className="workspace-skill-list">
        {props.skills.map(skill => <button type="button" key={skill.id} aria-pressed={skill.id === selectedId} className={"workspace-skill-row" + (skill.id === selectedId ? " is-selected" : "")} onClick={() => { setSelectedId(skill.id); setReload(0); }}>
          <span className="skill-icon"><IconSparkles size={18} /></span>
          <span><strong>{skill.name}</strong><small>{skill.id} · {byteText(skill.bytes)}</small><p>{skill.description || "无描述"}</p></span>
          <IconChevronRight size={14} />
        </button>)}
      </div>
      <div className="workspace-skill-detail" aria-live="polite">
        {!selected && <p className="page-empty-note">选择技能可查看它会向模型注入的正文。</p>}
        {selected && !props.readable && <><strong>{selected.name}</strong><p className="workspace-skill-description">{selected.description || "无描述"}</p><p className="page-empty-note">当前内核未声明技能正文读取能力，无法在应用内查看内容；仍可在输入区选择该技能。</p></>}
        {selected && props.readable && <>
          <div className="page-section-head"><strong>{detail?.name ?? selected.name}</strong><button type="button" className="subtle-button" onClick={() => setReload(previous => previous + 1)} disabled={detailLoading}>{detailLoading ? "正在读取…" : "重新读取"}</button></div>
          <small className="workspace-skill-meta">{selected.id} · {byteText(detail?.bytes ?? selected.bytes)} · 摘要 {selected.digest.slice(0, 12)}…</small>
          <div className="workspace-skill-actions"><button type="button" className="solid-button" onClick={() => props.onUseSkill(selected.id)}>在新聊天中使用该技能</button><span className="workspace-skill-hint">只预选到新会话草稿，不会自动发送。</span></div>
          {detailLoading && <p className="page-empty-note">正在读取技能正文…</p>}
          {detailError && <p className="page-empty-note" role="alert">{detailError}</p>}
          {detail && <pre className="workspace-skill-content">{detail.content}</pre>}
          <p className="page-empty-note">正文只读，最多 {(detail?.limitBytes ?? 64 * 1024).toLocaleString("zh-CN")} 字节；仍需在输入区选择后才会作为上下文注入，不改变工具权限。</p>
        </>}
      </div>
    </div>}
  </section>;
}
