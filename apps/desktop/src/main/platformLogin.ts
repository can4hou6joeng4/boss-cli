import { randomUUID } from "node:crypto";
import { BrowserWindow, WebContentsView, session, type Session } from "electron";
import type { PlatformLoginStatus, PlatformLoginContext } from "@boss-cli/protocol";
import { isLoginVerificationUrl, isOfficialLoginUrl, loginCaptureReadiness, loginViewBounds } from "./security";

type Attempt = PlatformLoginStatus & { id?: string };
type Request = <T>(method: string, params?: unknown) => Promise<T>;

/** The official page never receives a preload, Node, IPC or the app session. */
export class PlatformLogin {
  private view: WebContentsView | null = null;
  private browserSession: Session | null = null;
  private parent: BrowserWindow | null = null;
  private attempt = "";
  private generation = 0;
  private captureTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private detachParent: (() => void) | undefined;
  private status: PlatformLoginStatus = { state: "idle", summary: "尚未开始扫码登录" };

  constructor(private request: Request, private publish: (status: PlatformLoginStatus) => void) {}

  read(): PlatformLoginStatus {
    const contents = this.view?.webContents;
    const available = Boolean(contents && !contents.isDestroyed());
    return { ...this.status, browser: { available, loading: available && contents!.isLoading(),
      canGoBack: available && contents!.canGoBack(), canGoForward: available && contents!.canGoForward() } };
  }

  private update(status: PlatformLoginStatus): void {
    this.status = { ...this.status, state: status.state, summary: status.summary, code: status.code,
      phase: status.phase ?? this.status.phase, identity: status.identity ?? this.status.identity };
    this.publish(this.read());
  }

  async open(parent: BrowserWindow, threadId: string): Promise<PlatformLoginStatus> {
    if (["opening", "waiting", "saving"].includes(this.status.state)) {
      if (this.parent !== parent || this.status.threadId !== threadId) throw new Error("another thread owns this login");
      return this.read();
    }
    this.closeBrowser();
    this.parent = parent;
    this.status = { state: "idle", summary: "", threadId, browserId: randomUUID() };
    const hide = (): void => { if (this.view) this.view.setVisible(false); };
    const cancel = (): void => { this.cancel(); };
    parent.on("resize", hide);
    parent.on("hide", hide);
    parent.once("closed", cancel);
    parent.webContents.on("did-start-loading", hide);
    parent.webContents.on("render-process-gone", cancel);
    this.detachParent = () => {
      if (!parent.isDestroyed()) { parent.removeListener("resize", hide); parent.removeListener("hide", hide); parent.removeListener("closed", cancel); }
      if (!parent.webContents.isDestroyed()) { parent.webContents.removeListener("did-start-loading", hide); parent.webContents.removeListener("render-process-gone", cancel); }
    };
    this.attempt = "";
    const generation = ++this.generation;
    this.update({ state: "opening", phase: "scan", identity: "unknown", summary: "正在准备官方页面，请稍候…" });
    try {
      const attempt = await this.request<Attempt>("platform/login/start");
      if (generation !== this.generation) {
        if (attempt.id) void this.request("platform/login/cancel", { id: attempt.id }).catch(() => {});
        return this.read();
      }
      if (attempt.state !== "waiting" || !attempt.id) { this.update(attempt); this.closeBrowser(); return this.read(); }
      this.attempt = attempt.id;
      this.update(attempt);
      this.createBrowser(parent, generation);
    } catch {
      if (generation === this.generation) {
        if (this.attempt) void this.request("platform/login/cancel", { id: this.attempt }).catch(() => {});
        this.update({ state: "failed", code: "LOGIN_OPEN_FAILED", summary: "无法打开官方页面，请确认本机连接后重试" });
        this.closeBrowser();
      }
    }
    return this.read();
  }

  private createBrowser(parent: BrowserWindow, generation: number): void {
    const isolated = session.fromPartition(`boss-platform-login:${randomUUID()}`);
    this.browserSession = isolated;
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on("will-download", event => event.preventDefault());
    const view = new WebContentsView({ webPreferences: {
      session: isolated, contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webviewTag: false, devTools: false, webSecurity: true,
      allowRunningInsecureContent: false, safeDialogs: true, navigateOnDragDrop: false,
    } });
    this.view = view;
    view.setVisible(false);
    parent.contentView.addChildView(view);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event, url) => { if (!isOfficialLoginUrl(url)) event.preventDefault(); });
    view.webContents.on("will-frame-navigate", event => {
      if (event.isMainFrame && !isOfficialLoginUrl(event.url)) event.preventDefault();
    });
    view.webContents.on("will-redirect", (event, url, _inPlace, mainFrame) => {
      if (mainFrame && !isOfficialLoginUrl(url)) event.preventDefault();
    });
    view.webContents.on("will-attach-webview", event => event.preventDefault());
    view.webContents.on("will-prevent-unload", event => event.preventDefault());
    view.webContents.on("did-navigate", () => this.scheduleCapture(generation));
    view.webContents.on("did-navigate-in-page", (_event, _url, mainFrame) => { if (mainFrame) this.scheduleCapture(generation); });
    view.webContents.on("did-finish-load", () => this.scheduleCapture(generation));
    const navigationChanged = (): void => { if (generation === this.generation) this.publish(this.read()); };
    view.webContents.on("did-start-loading", navigationChanged);
    view.webContents.on("did-stop-loading", navigationChanged);
    view.webContents.on("did-navigate", navigationChanged);
    view.webContents.on("did-navigate-in-page", navigationChanged);
    view.webContents.on("did-fail-load", (_event, errorCode, _description, _url, mainFrame) => {
      if (mainFrame && errorCode !== -3 && generation === this.generation && this.status.state === "waiting") {
        this.update({ state: "failed", code: "LOGIN_PAGE_UNAVAILABLE", summary: "官方登录页未能加载，请检查网络后重新打开" });
        this.closeBrowser();
      }
    });
    isolated.cookies.on("changed", (_event, cookie, _cause, removed) => {
      if (!removed && ["wt2", "__zp_stoken__"].includes(cookie.name)) this.scheduleCapture(generation);
    });
    this.publish(this.read());
    void view.webContents.loadURL("https://www.zhipin.com/web/user/").catch(() => { /* did-fail-load supplies a fixed message. */ });
    this.deadlineTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.cancel();
      this.update({ state: "failed", code: "LOGIN_TIMEOUT", summary: "等待已超过五分钟。请重新打开官方页面，选择已有身份并完成页面提示" });
    }, 5 * 60_000);
  }

  /** Only the owning window and the current browser generation may place/control the view. */
  control(parent: BrowserWindow, action: "layout" | "back" | "forward" | "reload" | "cancel", context: PlatformLoginContext): PlatformLoginStatus {
    if (parent !== this.parent || context.threadId !== this.status.threadId || context.browserId !== this.status.browserId) return this.read();
    if (action === "cancel") return this.cancel();
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return this.read();
    if (action === "layout") {
      const bounds = loginViewBounds(context.bounds, parent.getContentBounds());
      if (!context.visible || !bounds || parent.isDestroyed() || !parent.isVisible()) { view.setVisible(false); return this.read(); }
      view.setBounds(bounds);
      // Give the official page a desktop viewport, fitted within the native pane.
      // Browser zoom alone leaves the site's narrow-window form without a QR switch.
      const pageWidth = Math.max(1040, bounds.width);
      const scale = bounds.width / pageWidth;
      view.webContents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: { width: 0, height: 0 },
        viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0,
        viewSize: { width: pageWidth, height: Math.round(bounds.height / scale) }, scale });
      view.setVisible(true);
    } else if (this.status.state === "waiting") {
      if (action === "back" && view.webContents.canGoBack()) view.webContents.goBack();
      if (action === "forward" && view.webContents.canGoForward()) view.webContents.goForward();
      if (action === "reload") view.webContents.reload();
    }
    return this.read();
  }

  private scheduleCapture(generation: number): void {
    if (generation !== this.generation || this.status.state !== "waiting" || this.captureTimer) return;
    this.captureTimer = setTimeout(() => { this.captureTimer = undefined; void this.capture(generation); }, 1500);
  }

  private async capture(generation: number): Promise<void> {
    const view = this.view, isolated = this.browserSession;
    if (generation !== this.generation || this.status.state !== "waiting" || !view || view.webContents.isDestroyed() || !isolated) return;
    const url = view.webContents.getURL();
    if (!isOfficialLoginUrl(url)) return;
    if (isLoginVerificationUrl(url)) {
      this.update({ state: "waiting", phase: "confirm", summary: "官方页面需要安全验证，应用已暂停连接。请在浏览器的官方页面完成验证后继续" });
      return;
    }
    try {
      const values = await isolated.cookies.get({ url });
      if (generation !== this.generation || this.status.state !== "waiting") return;
      if (view.webContents.isDestroyed()) return;
      if (view.webContents.getURL() !== url) { this.scheduleCapture(generation); return; }
      const cookies: Record<string, string> = Object.create(null);
      for (const cookie of values) {
        const domain = cookie.domain?.replace(/^\./, "").toLowerCase();
        if (domain !== "zhipin.com" && domain !== "www.zhipin.com") continue;
        if (cookies[cookie.name] !== undefined && cookies[cookie.name] !== cookie.value) throw new Error("conflicting cookies");
        cookies[cookie.name] = cookie.value;
      }
      // QR confirmation can set wt2 before navigation and token generation
      // finish. Both job-seeker and recruiter accounts can connect; the page
      // identity is a hint, never proof of access to recruiter tools.
      const readiness = loginCaptureReadiness(view.webContents.getURL(), cookies);
      if (!readiness.ready) {
        if (readiness.summary !== this.status.summary || readiness.identity !== this.status.identity) {
          this.update({ state: "waiting", summary: readiness.summary, phase: readiness.phase, identity: readiness.identity });
        }
        return;
      }
      this.update({ state: "saving", summary: readiness.summary, phase: readiness.phase, identity: readiness.identity });
      const result = await this.request<Attempt>("platform/login/complete", {
        id: this.attempt, cookies, userAgent: view.webContents.getUserAgent(),
      });
      if (generation !== this.generation) return;
      this.update(result);
      this.poll(generation);
    } catch {
      if (generation === this.generation) {
        this.update({ state: "failed", code: "LOGIN_SAVE_FAILED", summary: "未能完成登录保存，请检查本机连接后重新打开官方页面" });
        void this.request("platform/login/cancel", { id: this.attempt }).catch(() => {});
        this.closeBrowser();
      }
    }
  }

  private poll(generation: number): void {
    if (generation !== this.generation) return;
    if (this.status.state !== "saving") {
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      this.closeBrowser();
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.request<Attempt>("platform/login/read").then(result => {
        if (generation !== this.generation) return;
        if (result.id !== this.attempt) throw new Error("login attempt changed");
        this.update(result); this.poll(generation);
      }).catch(() => {
        if (generation === this.generation) {
          this.cancel();
          this.update({ state: "failed", code: "LOGIN_CONNECTION_LOST", summary: "登录连接中断，保存结果未知，请检查本机登录态" });
        }
      });
    }, 500);
  }

  cancel(): PlatformLoginStatus {
    const wasSaving = this.status.state === "saving";
    const active = ["opening", "waiting", "saving"].includes(this.status.state);
    ++this.generation;
    if (this.attempt && this.status.state !== "succeeded") void this.request("platform/login/cancel", { id: this.attempt }).catch(() => {});
    if (active) this.update({ state: "cancelled", summary: wasSaving ? "保存已停止，登录态可能已更新，请手动检查" : "已取消扫码登录" });
    this.closeBrowser();
    return this.read();
  }

  private closeBrowser(): void {
    for (const timer of [this.captureTimer, this.pollTimer, this.deadlineTimer]) if (timer) clearTimeout(timer);
    this.captureTimer = this.pollTimer = this.deadlineTimer = undefined;
    const parent = this.parent, view = this.view, isolated = this.browserSession;
    this.detachParent?.(); this.detachParent = undefined;
    this.parent = null; this.view = null; this.browserSession = null;
    if (parent && !parent.isDestroyed() && view) parent.contentView.removeChildView(view);
    if (view && !view.webContents.isDestroyed()) { view.webContents.stop(); view.webContents.close({ waitForBeforeUnload: false }); }
    if (isolated) {
      isolated.cookies.removeAllListeners("changed");
      void Promise.allSettled([isolated.clearStorageData(), isolated.closeAllConnections()]);
    }
    this.publish(this.read());
  }
}
