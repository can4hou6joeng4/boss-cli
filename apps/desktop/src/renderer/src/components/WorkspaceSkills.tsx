import { useEffect, useRef, useState } from "react";
import type { SkillDescriptor, SkillProblem, SkillReadResponse } from "@boss-harness/protocol";
import { harnessErrorText, readSkill, type SkillCatalogState } from "../data/harnessBridge";
import { CreateSkillDialog } from "./CreateSkillDialog";
import { DeleteSkillDialog } from "./DeleteSkillDialog";
import { EditSkillDialog } from "./EditSkillDialog";
import { IconChevronRight, IconClose, IconSearch, IconSparkles } from "./Icons";
import { filterSkillProblems, filterSkills } from "../data/skillFilter";
import { resolveSkillFocus } from "../data/skillFocus";

export interface WorkspaceSkillsProps {
  skills: SkillDescriptor[];
  state: SkillCatalogState;
  error?: string;
  /** 内核声明 skillsRead 时才请求正文；否则只展示目录里的名称与描述。 */
  readable: boolean;
  /** 当前生效的技能目录；旧内核不返回时为 null。 */
  root: string | null;
  /** 内核声明 skillsCreate 时才显示新建入口。 */
  creatable: boolean;
  /** 内核声明 skillsWrite 时才显示编辑入口。 */
  writable: boolean;
  /** 内核声明 skillsDelete 时才显示删除入口。 */
  deletable: boolean;
  /** 目录里无法安全读取的 SKILL.md；旧内核不返回时为空。 */
  problems: SkillProblem[];
  /** 把技能预选进新会话草稿；不会自动发送。 */
  onUseSkill: (skillId: string) => void;
  preview: boolean;
  onRefresh: () => void;
  /** 从对话里的回合技能标签跳转进来时，目录就绪后选中该技能。 */
  focusSkillId?: string | null;
  /** 聚焦已完成或确认无法完成；上层据此清除一次性跳转意图。 */
  onFocusSkill?: () => void;
}

const byteText = (value: number) => `${value.toLocaleString("zh-CN")} 字节`;

/**
 * 「技能与工具」页的工作区技能列表、正文与新建入口。正文来自 SKILL.md，
 * 选择后才作为上下文注入；这里不提供编辑或执行入口。
 */
export function WorkspaceSkills(props: WorkspaceSkillsProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillReadResponse | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<SkillReadResponse | null>(null);
  const [deleting, setDeleting] = useState<SkillReadResponse | null>(null);
  const [query, setQuery] = useState("");
  const filtering = query.trim().length > 0;
  const filteredSkills = filterSkills(props.skills, query);
  const filteredProblems = filterSkillProblems(props.problems, query);
  const selected = filteredSkills.find(skill => skill.id === selectedId) ?? null;
  useEffect(() => {
    // 目录刷新后选中项可能消失；正文只属于当前目录中的技能。
    if (selectedId && !props.skills.some(skill => skill.id === selectedId)) {
      setSelectedId(null); setDetail(null); setDetailError("");
    }
  }, [props.skills, selectedId]);
  const appliedFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!props.focusSkillId) { appliedFocus.current = null; return; }
    if (appliedFocus.current === props.focusSkillId) return;
    const focus = resolveSkillFocus(props.focusSkillId, props.skills, props.state);
    if (!focus.done) return;
    appliedFocus.current = props.focusSkillId;
    if (focus.selectedId) {
      setSelectedId(focus.selectedId); setReload(0); setQuery(""); setNotice("");
    } else {
      setNotice(`技能 ${props.focusSkillId} 已不在当前技能目录；可能已被删除或重命名。`);
    }
    props.onFocusSkill?.();
  }, [props.focusSkillId, props.skills, props.state, props.onFocusSkill]);
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
      <span className="workspace-skill-tools">
        {props.creatable && <button type="button" className="subtle-button" onClick={() => { setNotice(""); setCreating(true); }} disabled={props.state === "unavailable"}>新建技能…</button>}
        <button type="button" className="subtle-button" onClick={props.onRefresh} disabled={props.state === "loading" || props.state === "unavailable"}>{props.state === "loading" ? "正在读取…" : "刷新技能目录"}</button>
      </span>
    </div>
    {notice && <p className="workspace-skill-source" role="status">{notice}</p>}
    {creating && <CreateSkillDialog root={props.root} onClose={() => setCreating(false)} onCreated={skill => { setCreating(false); setNotice(`已创建技能 ${skill.id}；目录刷新后可在列表中查看。`); props.onRefresh(); }} />}
    {editing && <EditSkillDialog skill={editing} root={props.root} onClose={() => setEditing(null)} onSaved={skill => { setEditing(null); setNotice(`已保存技能 ${skill.id}；正文已刷新，下一回合生效。`); setReload(previous => previous + 1); }} />}
    {deleting && <DeleteSkillDialog skill={deleting} root={props.root} onClose={() => setDeleting(null)} onDeleted={id => { setDeleting(null); setSelectedId(null); setDetail(null); setNotice(`已删除技能 ${id}；目录刷新后将从列表移除。`); props.onRefresh(); }} />}
    {props.state === "loading" && <div className="page-tool-empty">正在读取工作区技能…</div>}
    {props.state === "error" && <div className="page-tool-empty">技能目录读取失败{props.error ? `：${props.error}` : ""}。这只表示读取没有完成，不代表工作区没有技能。</div>}
    {props.state === "unavailable" && <div className="page-tool-empty">{props.preview ? "浏览器预览未连接技能目录。启动桌面端后显示工作区技能。" : "连接本地 Harness 后可读取工作区技能。"}</div>}
    {props.state === "empty" && props.problems.length === 0 && <div className="page-tool-empty">当前工作区没有技能。可在 <code>.boss-harness/skills/&lt;id&gt;/SKILL.md</code> 添加。</div>}
    {props.root && (props.state === "ready" || props.state === "empty") && <p className="workspace-skill-source">技能目录：<code>{props.root}</code>{props.root === ".boss-cli/skills" ? "（旧目录；新建 .boss-harness/skills 后将改用新目录）" : ""}</p>}
    {(props.state === "ready" || props.state === "empty") && (props.skills.length > 0 || props.problems.length > 0) && <div className="page-search workspace-skill-search"><IconSearch size={16} /><input aria-label="筛选工作区技能" placeholder="搜索技能名称、描述或未加载原因…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" className="search-clear" aria-label="清除技能筛选" onClick={() => setQuery("")}><IconClose size={14} /></button>}</div>}
    {filtering && (props.state === "ready" || props.state === "empty") && <p className="workspace-skill-source" role="status">匹配 {filteredSkills.length} / {props.skills.length} 个可加载技能{props.problems.length > 0 ? `，${filteredProblems.length} / ${props.problems.length} 个未加载项` : ""}。</p>}
    {filteredProblems.length > 0 && (props.state === "ready" || props.state === "empty") && <div className="workspace-skill-problems" role="status">
      <strong>{filtering ? `${filteredProblems.length} 个未加载项匹配筛选` : `${props.problems.length} 个技能未能加载`}</strong>
      <ul>{filteredProblems.slice(0, 5).map(problem => <li key={problem.id}><code>{problem.id}</code>：{problem.reason}</li>)}</ul>
      {filteredProblems.length > 5 && <p>另有 {filteredProblems.length - 5} 个未列出；修复后刷新目录即可。</p>}
      <p>这些技能不会出现在列表，也不会被注入。常见原因：文件缺失、改为符号链接、超过 64 KiB 或不是 UTF-8。</p>
    </div>}
    {filtering && filteredSkills.length === 0 && (props.state === "ready" || props.state === "empty") && <div className="page-tool-empty">没有匹配的可加载技能{filteredProblems.length > 0 ? "；匹配的未加载项见上方。" : "。"}</div>}
    {filteredSkills.length > 0 && <div className="workspace-skill-layout">
      <div className="workspace-skill-list">
        {filteredSkills.map(skill => <button type="button" key={skill.id} aria-pressed={skill.id === selectedId} className={"workspace-skill-row" + (skill.id === selectedId ? " is-selected" : "")} onClick={() => { setSelectedId(skill.id); setReload(0); }}>
          <span className="skill-icon"><IconSparkles size={18} /></span>
          <span><strong>{skill.name}</strong><small>{skill.id} · {byteText(skill.bytes)}</small><p>{skill.description || "无描述"}</p></span>
          <IconChevronRight size={14} />
        </button>)}
      </div>
      <div className="workspace-skill-detail" aria-live="polite">
        {!selected && <p className="page-empty-note">选择技能可查看它会向模型注入的正文。</p>}
        {selected && !props.readable && <><strong>{selected.name}</strong><p className="workspace-skill-description">{selected.description || "无描述"}</p><p className="page-empty-note">当前内核未声明技能正文读取能力，无法在应用内查看内容；仍可在输入区选择该技能。</p></>}
        {selected && props.readable && <>
          <div className="page-section-head"><strong>{detail?.name ?? selected.name}</strong><span className="workspace-skill-tools"><button type="button" className="subtle-button" onClick={() => setReload(previous => previous + 1)} disabled={detailLoading}>{detailLoading ? "正在读取…" : "重新读取"}</button>{props.writable && detail && !detailLoading && <button type="button" className="subtle-button" onClick={() => { setNotice(""); setEditing(detail); }}>编辑技能…</button>}</span></div>
          <small className="workspace-skill-meta">{selected.id} · {byteText(detail?.bytes ?? selected.bytes)} · 摘要 {selected.digest.slice(0, 12)}…</small>
          <div className="workspace-skill-actions"><button type="button" className="solid-button" onClick={() => props.onUseSkill(selected.id)}>在新聊天中使用该技能</button><span className="workspace-skill-hint">只预选到新会话草稿，不会自动发送。</span></div>
          {detailLoading && <p className="page-empty-note">正在读取技能正文…</p>}
          {detailError && <p className="page-empty-note" role="alert">{detailError}</p>}
          {detail && <pre className="workspace-skill-content">{detail.content}</pre>}
          <p className="page-empty-note">最多 {(detail?.limitBytes ?? 64 * 1024).toLocaleString("zh-CN")} 字节；仍需在输入区选择后才会作为上下文注入，不改变工具权限。保存修改后下一回合生效。</p>
        </>}
      </div>
    </div>}
  </section>;
}
