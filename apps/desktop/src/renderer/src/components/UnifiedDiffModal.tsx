import { useState } from "react";
import { ModalSurface } from "./ModalSurface";
import { IconDiffFiles, IconCopy, IconCheck } from "./Icons";
import type { MessageItem } from "../data/mockData";
const PREVIEW_LINES: Record<string, { before: string[]; after: string[] }> = {
  "profiles/大模型算法专家_JD.md": { before: ["# 大模型算法专家", "熟悉大模型训练与部署", "根据履历评估匹配程度"], after: ["# 大模型算法专家", "必备：有可核实的训练或推理优化经历", "加分：参与开源模型或相关研究", "每项判断附上履历来源与待确认问题"] },
  "prompts/候选人初筛匹配门禁.ts": { before: ["return rankCandidates(candidates);"], after: ["const facts = collectVerifiedExperience(candidates);", "return compareWithRequirements(facts, jobRequirements);"] },
  "templates/个性化打招呼邀约话术.txt": { before: ["你好，想与你沟通我们的岗位。"], after: ["你好，关注到你在相关项目中的经历。", "我们正在寻找有此类实践的同事，方便进一步交流吗？", "发送前请核实经历与岗位事实。"] },
  "configs/招聘策略_精准对齐.json": { before: ["{", "  \"reviewBeforeSend\": false", "}"], after: ["{", "  \"reviewBeforeSend\": true,", "  \"includeEvidence\": true", "}"] },
};
export function UnifiedDiffModal({ isOpen, onClose, onRevertChanges, messages, preview }: { isOpen: boolean; onClose: () => void; onRevertChanges?: () => void; messages: MessageItem[]; preview: boolean }) {
  const [selected, setSelected] = useState(0), [mode, setMode] = useState<"unified" | "split">("unified"), [copied, setCopied] = useState(false);
  if (!isOpen) return null;
  const summary = [...messages].reverse().find(message => message.diffSummary)?.diffSummary;
  const files = [...(summary?.initialFiles ?? []), ...(summary?.extraFiles ?? [])], file = files[selected] ?? files[0];
  const content = preview && file ? PREVIEW_LINES[file.name] : undefined;
  return <ModalSurface title={preview ? "变更审阅 · 示例" : "变更审阅"} onClose={onClose} className="diff-review-dialog">
    <div className="diff-review-toolbar"><div className="segmented-control"><button className={mode === "unified" ? "selected" : ""} onClick={() => setMode("unified")}>统一差异</button><button className={mode === "split" ? "selected" : ""} onClick={() => setMode("split")}>并排对比</button></div><span className="diff-added">+{summary?.additions ?? 0}</span><span className="diff-deleted">−{summary?.deletions ?? 0}</span><button className="titlebar-btn" disabled={!file} aria-label="复制文件路径" onClick={() => { if (file) void navigator.clipboard?.writeText(file.name).then(() => setCopied(true)); }}>{copied ? <IconCheck size={15} /> : <IconCopy size={15} />}</button></div>
    <div className="diff-review-layout"><div className="diff-file-list">{files.map((item, index) => <button className={file?.name === item.name ? "selected" : ""} key={item.name} onClick={() => { setSelected(index); setCopied(false); }}><IconDiffFiles size={15} /><span>{item.name}</span><small className="diff-added">+{item.additions}</small><small className="diff-deleted">−{item.deletions}</small></button>)}</div>
      <div className="diff-review-content">{file && <div className="diff-file-heading">{file.name}</div>}{content ? <><p className="diff-preview-note">招聘内容预览片段 · 未写入文件</p><div className={`diff-code ${mode}`}>{mode === "split" ? <>{[content.before, content.after].map((lines, index) => <div key={index}><header>{index ? "变更后" : "变更前"}</header>{lines.map((line, n) => <div className={index ? "diff-line-added" : "diff-line-deleted"} key={n}><span>{n + 1}</span><code>{line}</code></div>)}</div>)}</> : <div><header>@@ 招聘内容预览 @@</header>{[...content.before.map(text => ({ text, add: false })), ...content.after.map(text => ({ text, add: true }))].map((line, index) => <div className={line.add ? "diff-line-added" : "diff-line-deleted"} key={index}><span>{line.add ? "+" : "−"}</span><code>{line.text}</code></div>)}</div>}</div></> : <div className="diff-unavailable"><IconDiffFiles size={28} /><p>{file ? "当前内核尚未提供逐行差异。" : "当前聊天没有文件变更。"}</p></div>}</div></div>
    <div className="diff-review-footer"><span>{preview ? "所有内容均为招聘任务示例" : "以本地内核返回的变更为准"}</span><div>{preview && file && onRevertChanges && <button className="secondary-button" onClick={onRevertChanges}>重置示例变更</button>}<button className="solid-button" onClick={onClose}>完成审阅</button></div></div>
  </ModalSurface>;
}
