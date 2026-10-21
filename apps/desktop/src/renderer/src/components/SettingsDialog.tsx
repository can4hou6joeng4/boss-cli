import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import appIcon from "../../../../resources/icon.png";
import {
  IconCheck,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconHelp,
  IconMoon,
  IconNotification,
  IconSettings,
  IconSun,
  IconTerminal,
} from "./Icons";
import "../styles/settings.css";
import { ConnectionSettings } from "./ConnectionSettings";

export interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
  onOpenShortcuts: () => void;
  harnessUp: boolean;
  initialSection?: SettingsSection;
  onLogin?: () => void;
}

export type SettingsSection = "general" | "appearance" | "notifications" | "connections" | "data" | "keyboard" | "about";
type Density = "compact" | "comfortable";
type Motion = "reduced" | "full";

interface UIPreferences {
  fontSize: number;
  density: Density;
  motion: Motion;
}

const STORAGE_PREFIX = "boss-cli.ui.";
const FONT_SIZES = [12, 13, 14, 15, 16] as const;
const FOCUSABLE = "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

function KeyboardIcon(): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="4" width="14.5" height="10" rx="2" />
      <path d="M4.5 7h.1M7.5 7h.1M10.5 7h.1M13.5 7h.1M4.5 10h.1M7.5 10h.1M10.5 10h3M5.5 12h7" />
    </svg>
  );
}

const SECTIONS: Array<{ id: SettingsSection; title: string; icon: ReactNode }> = [
  { id: "general", title: "常规", icon: <IconSettings size={17} /> },
  { id: "appearance", title: "外观", icon: <IconSun size={17} /> },
  { id: "notifications", title: "通知", icon: <IconNotification size={17} /> },
  { id: "connections", title: "模型与连接", icon: <IconTerminal size={17} /> },
  { id: "data", title: "数据管理", icon: <IconFolder size={17} /> },
  { id: "keyboard", title: "键盘快捷键", icon: <KeyboardIcon /> },
  { id: "about", title: "关于", icon: <IconHelp size={17} /> },
];

function readPreferences(): UIPreferences {
  const defaults: UIPreferences = {
    fontSize: 13,
    density: "comfortable",
    motion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full",
  };
  try {
    const fontSize = Number(localStorage.getItem(`${STORAGE_PREFIX}fontSize`));
    return {
      fontSize: FONT_SIZES.some((size) => size === fontSize) ? fontSize : defaults.fontSize,
      density: localStorage.getItem(`${STORAGE_PREFIX}density`) === "compact" ? "compact" : "comfortable",
      motion: localStorage.getItem(`${STORAGE_PREFIX}motion`) === "reduced"
        ? "reduced"
        : localStorage.getItem(`${STORAGE_PREFIX}motion`) === "full" ? "full" : defaults.motion,
    };
  } catch {
    return defaults;
  }
}

function applyPreferences(preferences: UIPreferences): void {
  const root = document.documentElement;
  root.dataset.density = preferences.density;
  root.dataset.motion = preferences.motion;
  root.style.setProperty("--ui-font-size", `${preferences.fontSize}px`);
}

function SettingRow({ title, description, children, className = "" }: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={`settings-row ${className}`}>
      <div className="settings-row-copy">
        <div className="settings-row-title">{title}</div>
        {description && <p className="settings-row-description">{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }): JSX.Element {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="settings-switch" onClick={onChange} />;
}

/** Keep mounted with isOpen=false so saved interface preferences apply at startup. */
export function SettingsDialog({ isOpen, onClose, isDark, onToggleTheme, onOpenShortcuts, harnessUp, initialSection, onLogin }: SettingsDialogProps): JSX.Element | null {
  const [section, setSection] = useState<SettingsSection>("general");
  const [preferences, setPreferences] = useState<UIPreferences>(readPreferences);
  const [status, setStatus] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (isOpen && initialSection) { setSection(initialSection); setStatus(""); }
  }, [isOpen, initialSection]);

  useEffect(() => {
    applyPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key?.startsWith(STORAGE_PREFIX)) setPreferences(readPreferences());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    const backdrop = backdropRef.current;
    if (!dialog || !backdrop) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const siblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({ element, wasInert: element.inert }));
    siblings.forEach(({ element }) => { element.inert = true; });
    document.body.style.overflow = "hidden";

    const focusables = (): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => element.getClientRects().length > 0 && !element.closest("[inert]"));
    const focusFirst = (): void => {
      (dialog.querySelector<HTMLElement>(`[data-settings-section='${initialSection ?? section}']`) ?? dialog.querySelector<HTMLElement>("[aria-current='page']") ?? focusables()[0] ?? dialog).focus({ preventScroll: true });
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      // Stop the app's global Shift+Tab mode shortcut while navigating this dialog.
      event.stopImmediatePropagation();
      const elements = focusables();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    const handleFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusFirst();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocus);
    focusFirst();
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocus);
      siblings.forEach(({ element, wasInert }) => { element.inert = wasInert; });
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    // A link inside a page can replace that page and remove the focused element.
    if (isOpen && dialog && !dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>("[aria-current='page']")?.focus({ preventScroll: true });
    }
  }, [isOpen, section]);

  const updatePreference = <K extends keyof UIPreferences>(key: K, value: UIPreferences[K]): void => {
    setPreferences((previous) => ({ ...previous, [key]: value }));
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${key}`, String(value));
      setStatus("界面偏好已保存");
    } catch {
      setStatus("已应用到当前窗口，但此环境无法保存偏好。");
    }
  };

  const exportPreferences = (): void => {
    try {
      const exported: Record<string, string> = {
        [`${STORAGE_PREFIX}fontSize`]: String(preferences.fontSize),
        [`${STORAGE_PREFIX}density`]: preferences.density,
        [`${STORAGE_PREFIX}motion`]: preferences.motion,
      };
      // Workspace aliases and project names can contain private text, even if
      // other components store them under the UI prefix. Export this allowlist only.
      const data = JSON.stringify({ version: 1, scope: "boss-cli.ui", preferences: exported }, null, 2);
      const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "boss-cli-ui-preferences.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("已生成界面偏好导出文件");
    } catch {
      setStatus("无法导出界面偏好，请确认当前环境允许本地文件下载。");
    }
  };

  const openShortcuts = (): void => {
    onClose();
    onOpenShortcuts();
  };

  if (!isOpen) return null;
  const currentSection = SECTIONS.find((item) => item.id === section)!;

  return createPortal(
    <div className="settings-backdrop" ref={backdropRef} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="settings-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <aside className="settings-sidebar">
          <div className="settings-sidebar-heading">设置</div>
          <nav className="settings-navigation" aria-label="设置分类">
            {SECTIONS.map((item) => (
              <button key={item.id} data-settings-section={item.id} type="button" className={`settings-navigation-item${section === item.id ? " is-active" : ""}`} aria-current={section === item.id ? "page" : undefined} onClick={() => { setSection(item.id); setStatus(""); }}>
                <span aria-hidden="true">{item.icon}</span>
                <span>{item.title}</span>
              </button>
            ))}
          </nav>
          <div className="settings-sidebar-footer"><img className="settings-brand-mark" src={appIcon} alt="" /><span>BOSS-CLI<span className="settings-sidebar-version">本机前端</span></span></div>
        </aside>

        <section className="settings-main">
          <header className="settings-header"><h2 id={titleId}>{currentSection.title}</h2></header>
          <button type="button" className="settings-close" aria-label="关闭设置" onClick={onClose}><IconClose size={17} /></button>
          <div className="settings-content" key={section}>
            {section === "general" && (
              <>
                <SettingRow title="语言" description="菜单和界面使用的语言"><span className="settings-static-value">简体中文</span></SettingRow>
                <SettingRow title="启动页面" description="打开工作台时显示的页面"><span className="settings-static-value">新聊天</span></SettingRow>
                <SettingRow title="界面偏好" description="外观、字体和显示密度保存在当前设备"><button type="button" className="settings-text-button" onClick={() => setSection("appearance")}>调整外观<IconChevronRight size={13} /></button></SettingRow>
                <SettingRow title="键盘快捷键" description="查看工作区与输入操作"><button type="button" className="settings-button" onClick={openShortcuts}>查看快捷键</button></SettingRow>
              </>
            )}

            {section === "appearance" && (
              <>
                <SettingRow title="主题" description="选择工作台的显示外观" className="settings-row-theme">
                  <div className="settings-theme-picker" role="group" aria-label="主题">
                    <button type="button" className={`settings-theme-option${!isDark ? " is-selected" : ""}`} aria-pressed={!isDark} onClick={() => { if (isDark) onToggleTheme(); }}><span className="settings-theme-preview is-light"><IconSun size={19} /></span><span>浅色</span>{!isDark && <IconCheck className="settings-theme-check" size={12} />}</button>
                    <button type="button" className={`settings-theme-option${isDark ? " is-selected" : ""}`} aria-pressed={isDark} onClick={() => { if (!isDark) onToggleTheme(); }}><span className="settings-theme-preview is-dark"><IconMoon size={19} /></span><span>深色</span>{isDark && <IconCheck className="settings-theme-check" size={12} />}</button>
                  </div>
                </SettingRow>
                <SettingRow title="字体大小" description="调整会话和界面的文字大小"><select className="settings-select" aria-label="字体大小" value={preferences.fontSize} onChange={(event) => updatePreference("fontSize", Number(event.target.value))}>{FONT_SIZES.map((size) => <option key={size} value={size}>{size} px{size === 13 ? "（默认）" : ""}</option>)}</select></SettingRow>
                <SettingRow title="紧凑会话" description="缩小消息与侧栏条目的间距"><Switch label="紧凑会话" checked={preferences.density === "compact"} onChange={() => updatePreference("density", preferences.density === "compact" ? "comfortable" : "compact")} /></SettingRow>
                <SettingRow title="减少动态效果" description="减少过渡动画与平滑滚动"><Switch label="减少动态效果" checked={preferences.motion === "reduced"} onChange={() => updatePreference("motion", preferences.motion === "reduced" ? "full" : "reduced")} /></SettingRow>
                <div className="settings-preview"><span className="settings-preview-label">文字预览</span><p>让每一次招聘任务，都有清晰的下一步。</p><span>基于事实、保留判断依据，在你的参与下推进。</span></div>
              </>
            )}

            {section === "notifications" && (
              <>
                <p className="settings-intro">管理任务结束或需要你参与时的提醒方式。</p>
                <SettingRow title="桌面通知" description="系统通知尚未接入当前工作台"><span className="settings-badge">不可用</span></SettingRow>
                <SettingRow title="提示音" description="声音提醒尚未接入当前工作台"><span className="settings-badge">不可用</span></SettingRow>
                <SettingRow title="通知权限" description="当前界面尚未申请系统通知权限"><span className="settings-static-value">未连接</span></SettingRow>
              </>
            )}

            {section === "connections" && (
              <ConnectionSettings harnessUp={harnessUp} onLogin={onLogin} />
            )}

            {section === "data" && (
              <>
                <p className="settings-intro">管理这台设备上保存的界面偏好。</p>
                <SettingRow title="导出界面偏好" description="将当前设备的显示偏好下载为 JSON 文件"><button type="button" className="settings-button" onClick={exportPreferences}>导出 JSON</button></SettingRow>
                <div className="settings-note"><IconFolder size={17} /><div><h3>导出范围</h3><p>仅包含 <code>boss-cli.ui.*</code> 界面偏好，不包含聊天内容、候选人资料或模型凭据。</p><p>会话与真实业务数据由 Harness 管理。</p></div></div>
              </>
            )}

            {section === "keyboard" && (
              <>
                <p className="settings-intro">使用键盘在工作区中更快地移动。</p>
                {[{ title: "新聊天", keys: ["⌘", "N"] }, { title: "切换侧栏", keys: ["⌘", "B"] }, { title: "发送消息", keys: ["Enter"] }, { title: "输入框换行", keys: ["Shift", "Enter"] }, { title: "关闭对话框", keys: ["Esc"] }].map((shortcut) => <SettingRow key={shortcut.title} title={shortcut.title}><span className="settings-shortcut">{shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}</span></SettingRow>)}
                <div className="settings-keyboard-footer"><button type="button" className="settings-button" onClick={openShortcuts}>查看全部快捷键<IconChevronRight size={13} /></button></div>
              </>
            )}

            {section === "about" && (
              <>
                <div className="settings-about-brand"><img className="settings-about-logo" src={appIcon} alt="" /><h3>BOSS-CLI</h3><p>面向招聘任务的 Agent Harness 工作台</p></div>
                <SettingRow title="应用界面"><span className="settings-static-value">BOSS-CLI 前端</span></SettingRow>
                <SettingRow title="界面参考"><span className="settings-static-value">ChatGPT.app<br /><span className="settings-secondary-value">26.1013.40934 (20770)</span></span></SettingRow>
                <p className="settings-about-description">这是 BOSS-CLI 的界面实现，参考本机应用的布局与交互。它不提供 OpenAI 服务，模型与招聘能力由本项目的 Harness 接入。</p>
              </>
            )}
          </div>
          <footer className="settings-footer"><span role="status" aria-live="polite">{status || "界面偏好仅保存在当前设备"}</span></footer>
        </section>
      </div>
    </div>,
    document.body,
  );
}
