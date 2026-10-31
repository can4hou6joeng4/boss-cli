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

// Shape check only; the kernel canonicalizes case and aliases such as "codex".
const PROVIDER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RENDERER_METHODS = new Set([
  "thread/start", "thread/list", "thread/read", "thread/resume", "thread/fork",
  "thread/leaf/read", "thread/leaf/set", "thread/branches/list", "thread/branchSummary/read", "thread/usage/read",
  "thread/archive", "thread/unarchive", "thread/name/set", "thread/model/set", "thread/reasoning/read", "thread/reasoning/set", "thread/turns/list", "thread/items/list", "thread/item/result/read", "thread/item/content/read",
  "turn/start", "turn/interrupt", "turn/steer", "turn/read", "turn/continuation/read", "turn/continue", "task/read", "queue/list", "queue/add", "queue/remove",
  "event/list", "model/list", "config/read", "skills/list", "tool/list", "attachment/add", "attachment/read",
  "context/read", "context/compact/plan", "context/compact/start", "context/compact/abort", "context/compact/read", "context/compact", "context/edit/read", "context/edit", "approval/list", "approval/respond",
  "connection/read", "connection/check",
  "runtime/resources/read",
]);
const THREAD_METHODS = new Set([
  "thread/read", "thread/resume", "thread/fork", "thread/leaf/read", "thread/leaf/set", "thread/branches/list",
  "thread/branchSummary/read", "thread/usage/read", "thread/archive", "thread/unarchive", "thread/name/set", "thread/model/set",
  "thread/reasoning/read", "thread/reasoning/set", "thread/turns/list", "thread/items/list", "thread/item/result/read", "thread/item/content/read", "turn/start", "turn/interrupt", "turn/steer", "turn/read", "turn/continuation/read", "turn/continue",
  "task/read", "queue/list", "queue/add", "queue/remove", "context/read", "context/compact/plan", "context/compact/start", "context/compact", "context/edit/read", "context/edit",
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
  if (payload.method === "turn/continuation/read" || payload.method === "turn/continue") {
    const allowed = payload.method === "turn/continue"
      ? new Set(["threadId", "sourceTurnId", "continuationId"])
      : new Set(["threadId", "sourceTurnId"]);
    if (!params || Object.keys(params).some(key => !allowed.has(key)) ||
      typeof params.threadId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(params.threadId) ||
      typeof params.sourceTurnId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(params.sourceTurnId) ||
      (payload.method === "turn/continue" &&
        (typeof params.continuationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(params.continuationId)))) {
      throw new Error("invalid turn continuation request");
    }
    return { method: payload.method, params };
  }
  if (payload.method === "thread/leaf/read" || payload.method === "thread/leaf/set" || payload.method === "thread/branches/list") {
    const allowed = payload.method === "thread/leaf/read" ? new Set(["threadId"])
      : payload.method === "thread/leaf/set" ? new Set(["threadId", "turnId", "summarize"])
        : new Set(["threadId", "cursor", "limit"]);
    if (!params || Object.keys(params).some(key => !allowed.has(key)) ||
      typeof params.threadId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(params.threadId) ||
      (payload.method === "thread/leaf/set" && (!("turnId" in params) ||
        (params.turnId !== null && (typeof params.turnId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(params.turnId))) ||
        (params.summarize !== undefined && typeof params.summarize !== "boolean"))) ||
      (payload.method === "thread/branches/list" && (
        (params.cursor !== undefined && params.cursor !== null && (typeof params.cursor !== "string" || !params.cursor || params.cursor.length > 2048)) ||
        (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 200))))) {
      throw new Error("invalid session branch request");
    }
    return { method: payload.method, params };
  }
  if (payload.method === "thread/branchSummary/read") {
    if (!params || Object.keys(params).some(key => key !== "threadId" && key !== "entryId") ||
      typeof params.threadId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(params.threadId) ||
      typeof params.entryId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(params.entryId)) {
      throw new Error("invalid branch summary read");
    }
    return { method: payload.method, params };
  }
  if (payload.method === "thread/usage/read") {
    const allowed = new Set(["threadId", "view", "cursor", "limit"]);
    if (!params || Object.keys(params).some(key => !allowed.has(key)) ||
      typeof params.threadId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(params.threadId) ||
      (params.view !== undefined && params.view !== "log" && params.view !== "branch") ||
      (params.cursor !== undefined && (typeof params.cursor !== "string" || !params.cursor.startsWith("p1_") || params.cursor.length > 4096)) ||
      (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 200))) {
      throw new Error("invalid thread usage read");
    }
    return { method: payload.method, params };
  }
  if ((payload.method === "thread/read" || payload.method === "thread/resume" || payload.method === "thread/turns/list" ||
    payload.method === "thread/items/list") && params?.view !== undefined && params.view !== "log" && params.view !== "branch") {
    throw new Error("invalid thread view");
  }
  if (payload.method === "task/read") {
    const allowed = new Set(["threadId", "kind", "id"]);
    if (!params || Object.keys(params).some(key => !allowed.has(key)) ||
      typeof params.threadId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(params.threadId) ||
      (params.kind !== "turn" && params.kind !== "queue" && params.kind !== "compaction") ||
      typeof params.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(params.id)) {
      throw new Error("invalid task read");
    }
    return { method: payload.method, params };
  }
  if (payload.method === "runtime/resources/read" && params && Reflect.ownKeys(params).length > 0) {
    throw new Error("runtime resource read does not accept params");
  }
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
  if (payload.method === "turn/start" && params && "autoCompaction" in params) {
    const policy = params.autoCompaction;
    const allowed = new Set(["enabled", "triggerPercent", "keepRecentTokens"]);
    if (!record(policy) ||
      (Object.getPrototypeOf(policy) !== Object.prototype && Object.getPrototypeOf(policy) !== null) ||
      Reflect.ownKeys(policy).some(key => typeof key !== "string" || !allowed.has(key)) ||
      ("enabled" in policy && typeof policy.enabled !== "boolean") ||
      ("triggerPercent" in policy && (typeof policy.triggerPercent !== "number" ||
        !Number.isSafeInteger(policy.triggerPercent) || policy.triggerPercent < 1 || policy.triggerPercent > 100)) ||
      ("keepRecentTokens" in policy && (typeof policy.keepRecentTokens !== "number" ||
        !Number.isSafeInteger(policy.keepRecentTokens) || policy.keepRecentTokens < 1 || policy.keepRecentTokens > 1_000_000))) {
      throw new Error("invalid auto compaction policy");
    }
  }
  if (payload.method === "thread/start" && params?.title !== undefined &&
    (typeof params.title !== "string" || params.title.length > 500)) throw new Error("invalid thread title");
  if (payload.method === "thread/start" && params?.provider !== undefined &&
    (typeof params.provider !== "string" || !PROVIDER_PATTERN.test(params.provider))) {
    throw new Error("invalid thread provider");
  }
  if (payload.method === "thread/model/set" && (!params ||
    Object.keys(params).some(key => !["threadId", "provider", "model"].includes(key)) ||
    typeof params.provider !== "string" || !PROVIDER_PATTERN.test(params.provider) ||
    typeof params.model !== "string" || !/^[^\s]{1,200}$/.test(params.model))) {
    throw new Error("invalid thread model selection");
  }
  if (payload.method === "approval/respond" && (typeof params?.approvalId !== "string" || !params.approvalId ||
    typeof params.approved !== "boolean")) throw new Error("invalid approval decision");
  if (payload.method === "approval/list" && params && (
    Object.keys(params).some(key => key !== "threadId" && key !== "limit") ||
    (params.threadId !== undefined && (typeof params.threadId !== "string" || !params.threadId || params.threadId.length > 64)) ||
    (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 200))
  )) throw new Error("invalid approval list request");
  if (payload.method === "context/compact/read" || payload.method === "context/compact/abort") {
    if (typeof params?.jobId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(params.jobId)) {
      throw new Error("invalid compaction jobId");
    }
  }
  if (payload.method === "context/edit/read" || payload.method === "context/edit") {
    const allowed = payload.method === "context/edit/read"
      ? new Set(["threadId", "itemId"])
      : new Set(["threadId", "itemId", "sourceDigest", "replacementText"]);
    if (!params || Object.keys(params).some(key => !allowed.has(key)) ||
      typeof params.itemId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(params.itemId) ||
      (payload.method === "context/edit" &&
        (typeof params.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(params.sourceDigest) ||
          (params.replacementText !== null && (typeof params.replacementText !== "string" ||
            params.replacementText.length < 1 || params.replacementText.length > 32_000 ||
            Buffer.byteLength(params.replacementText, "utf8") > 128 * 1024))))) {
      throw new Error("invalid context edit request");
    }
  }
  if (payload.method === "context/compact/plan" || payload.method === "context/compact/start") {
    if ((params?.throughTurnId !== undefined && (typeof params.throughTurnId !== "string" || !params.throughTurnId.trim())) ||
      (params?.keepRecentTokens !== undefined && (typeof params.keepRecentTokens !== "number" ||
        !Number.isSafeInteger(params.keepRecentTokens) || params.keepRecentTokens < 1 || params.keepRecentTokens > 1_000_000)) ||
      (params?.throughTurnId !== undefined && params?.keepRecentTokens !== undefined) ||
      (params?.sourceDigest !== undefined && (typeof params.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(params.sourceDigest)))) {
      throw new Error("invalid compaction plan");
    }
  }
  if (payload.method === "thread/item/result/read") {
    const allowed = new Set(["threadId", "itemId", "sha256", "cursor", "limit"]);
    if (!params || Object.keys(params).some(key => !allowed.has(key)) ||
      ![params.threadId, params.itemId].every(value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value)) ||
      typeof params.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(params.sha256) ||
      (params.cursor !== undefined && (typeof params.cursor !== "string" || !params.cursor.startsWith("tr1_") || params.cursor.length > 2048)) ||
      (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 32768))) {
      throw new Error("invalid tool result read");
    }
    return { method: payload.method, params };
  }
  if (payload.method === "thread/item/content/read") {
    const allowed = new Set(["threadId", "itemId", "part", "sha256", "cursor", "limit", "snapshotId"]);
    if (!params || Object.keys(params).some(key => !allowed.has(key)) ||
      ![params.threadId, params.itemId].every(value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value)) ||
      (params.part !== "text" && params.part !== "thinking") ||
      typeof params.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(params.sha256) ||
      (params.cursor !== undefined && (typeof params.cursor !== "string" || !params.cursor.startsWith("ic1_") || params.cursor.length > 2048)) ||
      (params.snapshotId !== undefined && (typeof params.snapshotId !== "string" || !/^[a-f0-9]{32}$/.test(params.snapshotId))) ||
      (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 32768))) {
      throw new Error("invalid item content read");
    }
    return { method: payload.method, params };
  }
  for (const key of ["limit", "offset"]) {
    const value = params?.[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000)) {
      throw new Error(`invalid ${key}`);
    }
  }
  return { method: payload.method, params };
}
