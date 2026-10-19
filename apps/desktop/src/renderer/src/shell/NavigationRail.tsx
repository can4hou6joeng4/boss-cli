import type { FC } from "react";
import { IconHome, IconHistory, IconFolder, IconMore, IconBranch, IconSparkles, IconChat } from "../components/Icons";

export type WorkspacePage = "home" | "recents" | "library" | "skills";
interface Props {
  page: WorkspacePage;
  onNavigate: (page: WorkspacePage) => void;
  onOpenSettings: () => void;
  onOpenCockpit: () => void;
  onOpenSideChat: () => void;
}
export const NavigationRail: FC<Props> = ({ page, onNavigate, onOpenSettings, onOpenCockpit, onOpenSideChat }) => (
  <nav className="navigation-rail" aria-label="快捷导航">
    <div className="rail-items">
      <button className={`rail-button ${page === "home" ? "selected" : ""}`} onClick={() => onNavigate("home")} aria-label="主页" title="主页"><IconHome size={20} /></button>
      <button className="rail-button" onClick={onOpenSideChat} aria-label="快速提问" title="快速提问 · ⌘;"><IconChat size={20} /></button>
      <button className={`rail-button ${page === "recents" ? "selected" : ""}`} onClick={() => onNavigate("recents")} aria-label="最近会话" title="最近会话"><IconHistory size={20} /></button>
      <button className={`rail-button ${page === "library" ? "selected" : ""}`} onClick={() => onNavigate("library")} aria-label="资料库" title="资料库"><IconFolder size={20} /></button>
      <button className="rail-button" onClick={onOpenSettings} aria-label="更多与设置" title="更多与设置"><IconMore size={20} /></button>
      <div className="rail-divider" />
      <button className="rail-button" onClick={onOpenCockpit} aria-label="招聘驾驶舱" title="招聘驾驶舱 · ⌘⇧K"><IconBranch size={20} /></button>
      <button className={`rail-button ${page === "skills" ? "selected" : ""}`} onClick={() => onNavigate("skills")} aria-label="技能与工具" title="技能与工具"><IconSparkles size={20} /></button>
    </div>
    <button className="rail-avatar" onClick={onOpenSettings} aria-label="工作区设置" title="本地工作区 · 设置">BO</button>
  </nav>
);
