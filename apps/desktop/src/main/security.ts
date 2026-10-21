import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlatformLoginContext } from "@boss-cli/protocol";

/** A native child view must stay inside the renderer's measured content slot. */
export function loginViewBounds(value: unknown, content: { width: number; height: number }): PlatformLoginContext["bounds"] | null {
  if (!value || typeof value !== "object") return null;
  const bounds = value as Record<string, unknown>;
  if (!["x", "y", "width", "height"].every(key => typeof bounds[key] === "number" && Number.isFinite(bounds[key]))) return null;
  const { x, y, width, height } = bounds as { x: number; y: number; width: number; height: number };
  if (x < 0 || y < 48 || width < 100 || height < 80 || x + width > content.width + 1 || y + height > content.height + 1) return null;
  return { x: Math.ceil(x), y: Math.ceil(y), width: Math.floor(width), height: Math.floor(height) };
}

export function validateLoginContext(value: unknown): PlatformLoginContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("login context is required");
  const context = value as Record<string, unknown>;
  if (typeof context.threadId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(context.threadId)) throw new Error("invalid login thread");
  if (context.browserId !== undefined && (typeof context.browserId !== "string" || context.browserId.length > 100)) throw new Error("invalid login browser");
  if (context.visible !== undefined && typeof context.visible !== "boolean") throw new Error("invalid login visibility");
  return { threadId: context.threadId, browserId: context.browserId as string | undefined,
    visible: context.visible as boolean | undefined, bounds: context.bounds as PlatformLoginContext["bounds"] };
}

/** Both navigation and IPC use this exact entry-point policy. */
export function isTrustedRendererUrl(url: string, entryFile: string, devUrl?: string): boolean {
  try {
    const actual = new URL(url);
    if (devUrl) {
      const expected = new URL(devUrl);
      return (actual.protocol === "http:" || actual.protocol === "https:") &&
        actual.origin === expected.origin && actual.pathname === expected.pathname;
    }
    return actual.protocol === "file:" && fileURLToPath(actual) === resolve(entryFile);
  } catch { return false; }
}

export function isAllowedExternalUrl(url: string): boolean {
  try { return ["https:", "http:", "mailto:"].includes(new URL(url).protocol); }
  catch { return false; }
}

/** Official login navigation stays in an isolated, unprivileged browser view. */
export function isOfficialLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password &&
      (!parsed.port || parsed.port === "443") &&
      (parsed.hostname === "zhipin.com" || parsed.hostname.endsWith(".zhipin.com"));
  } catch { return false; }
}

export function isLoginVerificationUrl(url: string): boolean {
  try { return /(?:security-check|captcha|\/verify(?:\/|$))/i.test(new URL(url).pathname); }
  catch { return true; }
}

/** QR confirmation and a complete account session are separate observations. */
export function loginCaptureReadiness(url: string, cookies: Record<string, string>): {
  ready: boolean; summary: string; phase: "scan" | "confirm" | "credentials" | "verify";
  identity?: "jobSeeker" | "recruiter" | "unknown";
} {
  if (!isOfficialLoginUrl(url) || isLoginVerificationUrl(url)) {
    return { ready: false, phase: "confirm", summary: "请在浏览器的官方页面完成登录或安全验证，应用会等待你完成" };
  }
  if (!cookies.wt2) return { ready: false, phase: "scan", summary: "请在官方页面选择已有账号身份，切换 APP 扫码登录，再用 BOSS 直聘 App 扫码" };
  const page = new URL(url);
  const identity = /^\/web\/geek\//.test(page.pathname) ? "jobSeeker"
    : /^\/web\/(?:boss|chat)\//.test(page.pathname) ? "recruiter" : "unknown";
  if (page.hostname !== "www.zhipin.com" || !(page.pathname === "/" || /^\/web\/(?:geek|boss|chat)\//.test(page.pathname))) {
    return { ready: false, phase: "confirm", identity, summary: "扫码已确认，正在等待官方页面完成跳转；如需选择身份，请选择你已有的身份" };
  }
  if (!cookies.__zp_stoken__) {
    return { ready: false, phase: "credentials", identity, summary: "已检测到账号登录，认证信息还未就绪。请保持浏览器的官方页面打开，并完成页面中的剩余提示" };
  }
  return { ready: true, phase: "verify", identity, summary: "正在验证账号并保存连接，请稍候；此过程不会发送消息或修改职位" };
}

const RENDERER_METHODS = new Set([
  "thread/start", "thread/list", "thread/read", "thread/resume", "thread/fork",
  "thread/archive", "thread/unarchive", "thread/name/set", "thread/turns/list", "thread/items/list",
  "turn/start", "turn/interrupt", "turn/steer", "turn/read", "queue/list", "queue/add", "queue/remove",
  "event/list", "model/list", "config/read", "skills/list", "tool/list", "attachment/add", "attachment/read",
  "context/read", "context/compact", "approval/respond",
  "connection/read", "connection/check",
]);
const THREAD_METHODS = new Set([
  "thread/read", "thread/resume", "thread/fork", "thread/archive", "thread/unarchive", "thread/name/set",
  "thread/turns/list", "thread/items/list", "turn/start", "turn/interrupt", "turn/steer", "turn/read",
  "queue/list", "queue/add", "queue/remove", "context/read", "context/compact",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateHarnessRequest(payload: unknown): { method: string; params?: Record<string, unknown> } {
  if (!record(payload) || typeof payload.method !== "string" || !RENDERER_METHODS.has(payload.method)) {
    throw new Error("harness method is not exposed to the renderer");
  }
  if (payload.params !== undefined && !record(payload.params)) throw new Error("harness params must be an object");
  const params = payload.params as Record<string, unknown> | undefined;
  if (payload.method === "connection/check" && (typeof params?.target !== "string" || !["local", "model", "platform"].includes(params.target))) {
    throw new Error("invalid connection target");
  }
  if (payload.method === "thread/start" && params?.toolPolicy !== undefined && (typeof params.toolPolicy !== "string" || !["readOnly", "approval"].includes(params.toolPolicy))) {
    throw new Error("invalid tool policy");
  }
  if (Buffer.byteLength(JSON.stringify(params ?? {})) > 1024 * 1024) throw new Error("harness request exceeds byte limit");
  if (THREAD_METHODS.has(payload.method) && (typeof params?.threadId !== "string" || !params.threadId || params.threadId.length > 200)) {
    throw new Error("threadId is required");
  }
  if (payload.method === "turn/start" && (typeof params?.input !== "string" || !params.input.trim())) {
    throw new Error("turn input is required");
  }
  if (payload.method === "thread/start" && params?.title !== undefined &&
    (typeof params.title !== "string" || params.title.length > 500)) throw new Error("invalid thread title");
  if (payload.method === "approval/respond" && (typeof params?.approvalId !== "string" || !params.approvalId ||
    typeof params.approved !== "boolean")) throw new Error("invalid approval decision");
  for (const key of ["limit", "offset"]) {
    const value = params?.[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000)) {
      throw new Error(`invalid ${key}`);
    }
  }
  return { method: payload.method, params };
}
