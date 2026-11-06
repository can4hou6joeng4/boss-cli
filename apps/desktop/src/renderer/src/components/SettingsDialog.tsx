import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PROTOCOL_VERSION, type AutoCompactionSource } from "@boss-harness/protocol";
import appIcon from "../../../../resources/icon.png";
import {
  IconCheck,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconHelp,
  IconMonitor,
  IconMoon,
  IconNotification,
  IconSettings,
  IconSun,
  IconTerminal,
} from "./Icons";
import { UI_STORAGE_PREFIX } from "../data/uiStorage";
import { primeApprovalChime } from "../data/approvalChime";
import { readNotificationTestResult } from "../data/notificationTest";
import { aboutDiagnostics, aboutFields } from "../data/aboutInfo";
import { useClipboardCopy } from "../data/clipboardCopy";
import { compactionDraft, compactionFields, compactionSourceLabel, type CompactionSettingDraft } from "../data/compactionSettings";
import type { ThemePreference } from "../data/themePreference";
import { harnessErrorText, readConfig, setAutoCompactionSettings } from "../data/harnessBridge";
import "../styles/settings.css";
import { ConnectionSettings } from "./ConnectionSettings";

export interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  theme: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
  onOpenShortcuts: () => void;
  harnessUp: boolean;
  /** 内核声明 autoCompactionConfig 后，才允许在设置页保存默认策略。 */
  autoCompactionConfig?: boolean;
  initialSection?: SettingsSection;
  onLogin?: () => void;
}

export type SettingsSection = "general" | "appearance" | "context" | "notifications" | "connections" | "data" | "keyboard" | "about";
type Density = "compact" | "comfortable";
type Motion = "reduced" | "full";

interface UIPreferences {
  fontSize: number;
  density: Density;
  motion: Motion;
  approvalSound: boolean;
}

const STORAGE_PREFIX = UI_STORAGE_PREFIX;
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

function ContextIcon(): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 5.5h13M2.5 9h13M2.5 12.5h13" />
      <circle cx="6.5" cy="5.5" r="1.6" fill="var(--bg-window)" />
      <circle cx="11.5" cy="9" r="1.6" fill="var(--bg-window)" />
      <circle cx="7.5" cy="12.5" r="1.6" fill="var(--bg-window)" />
    </svg>
  );
}

const SECTIONS: Array<{ id: SettingsSection; title: string; icon: ReactNode }> = [
  { id: "general", title: "常规", icon: <IconSettings size={17} /> },
  { id: "appearance", title: "外观", icon: <IconSun size={17} /> },
  { id: "context", title: "上下文", icon: <ContextIcon /> },
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
    approvalSound: false,
  };
  try {
    const fontSize = Number(localStorage.getItem(`${STORAGE_PREFIX}fontSize`));
    return {
      fontSize: FONT_SIZES.some((size) => size === fontSize) ? fontSize : defaults.fontSize,
      density: localStorage.getItem(`${STORAGE_PREFIX}density`) === "compact" ? "compact" : "comfortable",
      motion: localStorage.getItem(`${STORAGE_PREFIX}motion`) === "reduced"
        ? "reduced"
        : localStorage.getItem(`${STORAGE_PREFIX}motion`) === "full" ? "full" : defaults.motion,
      approvalSound: localStorage.getItem(`${STORAGE_PREFIX}approvalSound`) === "true",
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
export function SettingsDialog({ isOpen, onClose, theme, onThemeChange, onOpenShortcuts, harnessUp, autoCompactionConfig = false, initialSection, onLogin }: SettingsDialogProps): JSX.Element | null {
  const [section, setSection] = useState<SettingsSection>("general");
  const [preferences, setPreferences] = useState<UIPreferences>(readPreferences);
  const [status, setStatus] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [compaction, setCompaction] = useState<CompactionSettingDraft | null>(null);
  const [compactionSource, setCompactionSource] = useState<AutoCompactionSource | undefined>();
  const [compactionBusy, setCompactionBusy] = useState(false);
  const [compactionError, setCompactionError] = useState("");
  const [compactionSaved, setCompactionSaved] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const aboutClipboard = useClipboardCopy();
  closeRef.current = onClose;

  // 关于页只展示构建与运行环境的真实值；浏览器预览或旧构建缺失时由 aboutInfo 统一显示「未知」。
  const aboutEnvironment = {
    appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null,
    protocolVersion: PROTOCOL_VERSION,
    electron: window.boss?.versions?.electron,
    chrome: window.boss?.versions?.chrome,
    node: window.boss?.versions?.node,
    platform: window.boss?.versions?.platform,
    kernelConnected: harnessUp,
  };
  const aboutRows = aboutFields(aboutEnvironment);
  const aboutCopy = aboutClipboard.feedback?.key === "about-diagnostics" ? aboutClipboard.feedback : null;

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

  // 每次进入「上下文」分区都重读内核；未保存的草稿不跨越分区保留，避免与磁盘值悄悄分叉。
  useEffect(() => {
    if (!isOpen || section !== "context" || !harnessUp) return;
    let cancelled = false;
    setCompactionBusy(true);
    setCompactionError("");
    setCompactionSaved(false);
    readConfig().then(config => {
      if (cancelled) return;
      const draft = compactionDraft(config.autoCompaction);
      if (!draft) {
        setCompaction(null);
        setCompactionError("当前内核未返回可用的自动压缩默认值。");
        return;
      }
      setCompaction(draft);
      setCompactionSource(config.autoCompactionSource);
    }).catch(cause => {
      if (cancelled) return;
      setCompaction(null);
      setCompactionError(`读取自动压缩默认值失败：${harnessErrorText(cause)}。`);
    }).finally(() => {
      if (!cancelled) setCompactionBusy(false);
    });
    return () => { cancelled = true; };
  }, [isOpen, section, harnessUp]);

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

  const sendTestNotification = async (): Promise<void> => {
    const api = window.boss;
    if (!api?.testNotification) { setStatus("当前环境未连接本机内核，无法测试系统通知。"); return; }
    if (testBusy) return;
    setTestBusy(true);
    try {
      const outcome = readNotificationTestResult(await api.testNotification());
      setStatus(outcome === "sent"
        ? "已请求系统展示测试通知，请留意桌面提醒。"
        : outcome === "unsupported"
          ? "当前系统不支持系统通知，审批与回合结束不会弹窗提醒。"
          : "已请求发送，但未能确认系统是否展示；请检查系统的通知权限。");
    } catch {
      setStatus("发送测试通知失败，请检查系统通知权限。");
    } finally {
      setTestBusy(false);
    }
  };

  const editCompaction = (patch: Partial<CompactionSettingDraft>): void => {
    setCompactionSaved(false);
    setCompaction(current => current ? { ...current, ...patch } : current);
  };

  const saveCompaction = async (): Promise<void> => {
    if (!compaction || compactionBusy) return;
    const fields = compactionFields(compaction);
    if (!fields) {
      setCompactionError("触发阈值必须是 1 到 100 的整数百分比，近期保留目标必须是 1 到 1000000 的整数 token。");
      return;
    }
    setCompactionBusy(true);
    setCompactionError("");
    setCompactionSaved(false);
    try {
      const response = await setAutoCompactionSettings(fields);
      const saved = compactionDraft(response.autoCompaction);
      if (saved) setCompaction(saved);
      setCompactionSource(response.autoCompactionSource);
      setCompactionSaved(true);
    } catch (cause) {
      // 环境变量托管、配置文件不可写或断连时保留草稿，由用户决定是否重试。
      setCompactionError(`保存失败：${harnessErrorText(cause)}。设置未确认，草稿仍保留。`);
    } finally {
      setCompactionBusy(false);
    }
  };

  const exportPreferences = (): void => {
    try {
      const exported: Record<string, string> = {
        [`${STORAGE_PREFIX}fontSize`]: String(preferences.fontSize),
        [`${STORAGE_PREFIX}density`]: preferences.density,
        [`${STORAGE_PREFIX}motion`]: preferences.motion,
        [`${STORAGE_PREFIX}approvalSound`]: String(preferences.approvalSound),
      };
      // Workspace aliases and project names can contain private text, even if
      // other components store them under the UI prefix. Export this allowlist only.
      const data = JSON.stringify({ version: 1, scope: "boss-harness.ui", preferences: exported }, null, 2);
      const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "boss-harness-ui-preferences.json";
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
  const compactionEditable = autoCompactionConfig && compactionSource !== "environment" && compactionSource !== "explicit";

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
          <div className="settings-sidebar-footer"><img className="settings-brand-mark" src={appIcon} alt="" /><span>BOSS Harness<span className="settings-sidebar-version">本机前端</span></span></div>
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
                    <button type="button" className={`settings-theme-option${theme === "system" ? " is-selected" : ""}`} aria-pressed={theme === "system"} onClick={() => onThemeChange("system")}><span className="settings-theme-preview is-system"><IconMonitor size={19} /></span><span>跟随系统</span>{theme === "system" && <IconCheck className="settings-theme-check" size={12} />}</button>
                    <button type="button" className={`settings-theme-option${theme === "light" ? " is-selected" : ""}`} aria-pressed={theme === "light"} onClick={() => onThemeChange("light")}><span className="settings-theme-preview is-light"><IconSun size={19} /></span><span>浅色</span>{theme === "light" && <IconCheck className="settings-theme-check" size={12} />}</button>
                    <button type="button" className={`settings-theme-option${theme === "dark" ? " is-selected" : ""}`} aria-pressed={theme === "dark"} onClick={() => onThemeChange("dark")}><span className="settings-theme-preview is-dark"><IconMoon size={19} /></span><span>深色</span>{theme === "dark" && <IconCheck className="settings-theme-check" size={12} />}</button>
                  </div>
                </SettingRow>
                <SettingRow title="字体大小" description="调整会话和界面的文字大小"><select className="settings-select" aria-label="字体大小" value={preferences.fontSize} onChange={(event) => updatePreference("fontSize", Number(event.target.value))}>{FONT_SIZES.map((size) => <option key={size} value={size}>{size} px{size === 13 ? "（默认）" : ""}</option>)}</select></SettingRow>
                <SettingRow title="紧凑会话" description="缩小消息与侧栏条目的间距"><Switch label="紧凑会话" checked={preferences.density === "compact"} onChange={() => updatePreference("density", preferences.density === "compact" ? "comfortable" : "compact")} /></SettingRow>
                <SettingRow title="减少动态效果" description="减少过渡动画与平滑滚动"><Switch label="减少动态效果" checked={preferences.motion === "reduced"} onChange={() => updatePreference("motion", preferences.motion === "reduced" ? "full" : "reduced")} /></SettingRow>
                <div className="settings-preview"><span className="settings-preview-label">文字预览</span><p>让每一次招聘任务，都有清晰的下一步。</p><span>基于事实、保留判断依据，在你的参与下推进。</span></div>
              </>
            )}

            {section === "context" && (
              <>
                <p className="settings-intro">设置自动压缩的内核默认值。单个回合仍可在会话上下文面板临时覆盖，发送后恢复这里的默认值。</p>
                {!harnessUp ? (
                  <div className="settings-note"><IconTerminal size={17} /><div><h3>本机内核未连接</h3><p>连接后可以读取并保存自动压缩默认策略。</p></div></div>
                ) : compactionBusy && !compaction ? (
                  <p className="settings-intro">正在读取自动压缩默认值…</p>
                ) : !compaction ? (
                  <div className="settings-note"><IconTerminal size={17} /><div><h3>无法读取自动压缩设置</h3><p>{compactionError || "当前内核未返回可用的自动压缩默认值。"}</p></div></div>
                ) : (
                  <>
                    <SettingRow title="自动压缩" description="接近上下文预算上限时自动生成摘要；关闭后只保留手动压缩">
                      {compactionEditable
                        ? <Switch label="自动压缩" checked={compaction.enabled} onChange={() => editCompaction({ enabled: !compaction.enabled })} />
                        : <span className="settings-static-value">{compaction.enabled ? "已启用" : "已关闭"}</span>}
                    </SettingRow>
                    <SettingRow title="触发阈值" description="输入预算使用达到该百分比时开始自动压缩">
                      {compactionEditable
                        ? <><input className="settings-number-input" type="number" min={1} max={100} step={1} aria-label="自动压缩触发阈值"
                          value={compaction.triggerPercent} onChange={event => editCompaction({ triggerPercent: event.target.value })} /><span className="settings-number-suffix">%</span></>
                        : <span className="settings-static-value">{compaction.triggerPercent}%</span>}
                    </SettingRow>
                    <SettingRow title="近期保留目标" description="压缩时尽量保留的近期 token 数">
                      {compactionEditable
                        ? <><input className="settings-number-input" type="number" min={1} max={1000000} step={1000} aria-label="自动压缩近期保留 token"
                          value={compaction.keepRecentTokens} onChange={event => editCompaction({ keepRecentTokens: event.target.value })} /><span className="settings-number-suffix">token</span></>
                        : <span className="settings-static-value">{compaction.keepRecentTokens} token</span>}
                    </SettingRow>
                    <SettingRow title="策略来源" description="环境变量显式设置时优先生效，界面不会覆盖它"><span className="settings-static-value">{compactionSourceLabel(compactionSource)}</span></SettingRow>
                    {compactionEditable && <div className="settings-policy-actions"><button type="button" className="settings-button" disabled={compactionBusy}
                      onClick={() => { void saveCompaction(); }}>{compactionBusy ? "保存中…" : "保存默认策略"}</button></div>}
                    {!compactionEditable && <p className="settings-policy-status">{compactionSource === "environment"
                      ? "该策略由环境变量管理；修改 BOSS_HARNESS_COMPACTION 并重启内核后才能在此编辑。"
                      : compactionSource === "explicit"
                        ? "该策略由当前内核调用方显式指定，不能写入配置文件。"
                        : "当前内核不支持在界面保存默认策略；可继续使用单回合覆盖。"}</p>}
                    {compactionError && <p className="settings-policy-status is-error" role="alert">{compactionError}</p>}
                    {compactionSaved && <p className="settings-policy-status is-saved" role="status">已保存到本机内核配置，立即生效。</p>}
                  </>
                )}
              </>
            )}

            {section === "notifications" && (
              <>
                <p className="settings-intro">管理任务结束或需要你参与时的提醒方式。</p>
                <SettingRow title="桌面通知" description="窗口不在前台时，审批请求与运行超过 20 秒的回合结束会弹出系统通知，点击回到工作台"><span className="settings-static-value">自动</span></SettingRow>
                <SettingRow title="应用图标徽标" description="待审批数量显示在应用图标上（系统支持时）"><span className="settings-static-value">自动</span></SettingRow>
                <SettingRow title="审批提示音" description="新的审批请求到达时播放两声短提示音；默认关闭"><Switch label="审批提示音" checked={preferences.approvalSound} onChange={() => { const next = !preferences.approvalSound; if (next) primeApprovalChime(); updatePreference("approvalSound", next); }} /></SettingRow>
                <SettingRow title="通知权限" description="系统通知由操作系统授权并展示，工作台不单独申请"><span className="settings-static-value">跟随系统</span></SettingRow>
                <SettingRow title="测试通知" description="发送一条测试系统通知，确认当前系统允许工作台提醒"><button type="button" className="settings-button" onClick={() => void sendTestNotification()} disabled={testBusy}>{testBusy ? "正在发送…" : "发送测试通知"}</button></SettingRow>
              </>
            )}

            {section === "connections" && (
              <ConnectionSettings harnessUp={harnessUp} onLogin={onLogin} />
            )}

            {section === "data" && (
              <>
                <p className="settings-intro">管理这台设备上保存的界面偏好。</p>
                <SettingRow title="导出界面偏好" description="将当前设备的显示偏好下载为 JSON 文件"><button type="button" className="settings-button" onClick={exportPreferences}>导出 JSON</button></SettingRow>
                <div className="settings-note"><IconFolder size={17} /><div><h3>导出范围</h3><p>仅包含 <code>boss-harness.ui.*</code> 界面偏好，不包含聊天内容、候选人资料或模型凭据。</p><p>会话与真实业务数据由 Harness 管理。</p></div></div>
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
                <div className="settings-about-brand"><img className="settings-about-logo" src={appIcon} alt="" /><h3>BOSS Harness</h3><p>面向招聘任务的 Agent Harness 工作台</p></div>
                <dl className="settings-about-fields" aria-label="运行环境">
                  {aboutRows.map((field) => (
                    <div key={field.label} className="settings-about-field">
                      <dt>{field.label}</dt>
                      <dd>{field.value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="settings-about-actions">
                  <button type="button" className="settings-button" onClick={() => { void aboutClipboard.copy(aboutDiagnostics(aboutEnvironment), "about-diagnostics"); }}>复制诊断信息</button>
                  {aboutCopy && <span className={`settings-about-copy${aboutCopy.ok ? "" : " is-error"}`} role="status">{aboutCopy.ok ? "诊断信息已复制" : `复制失败：${aboutCopy.reason ?? "剪贴板不可用"}`}</span>}
                </div>
                <p className="settings-about-description">这是 BOSS Harness 的界面实现，参考本机应用的布局与交互。它不提供 OpenAI 服务，模型与招聘能力由本项目的 Harness 接入。</p>
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
