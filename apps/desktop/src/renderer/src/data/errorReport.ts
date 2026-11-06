/**
 * 渲染异常的文本化。
 *
 * 错误边界捕获的抛出值不一定是 `Error`：可能是字符串、普通对象甚至
 * `undefined`。这里只做纯字符串处理，把任意值收敛成有上限的可读摘要与
 * 可复制详情，避免异常对象本身把界面或剪贴板撑坏。
 */

/** 单行摘要上限；异常消息可能是整段 JSON 或很长路径，界面只显示开头。 */
export const MAX_ERROR_MESSAGE_LENGTH = 300;
/** 详情（堆栈 / 序列化值）上限；足够定位问题，又不会把剪贴板写成几 MB。 */
export const MAX_ERROR_DETAIL_LENGTH = 4_000;

export interface ErrorReport {
  /** 单行摘要，已折叠空白并按 {@link MAX_ERROR_MESSAGE_LENGTH} 截断。 */
  message: string;
  /** 堆栈或原始文本；没有更多信息或与摘要相同时为 `undefined`。 */
  detail?: string;
}

/** 按字符数截断并追加省略号；上限本身非法时只返回省略号。 */
export function truncateErrorText(text: string, limit: number): string {
  if (limit <= 0) return "…";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/** 把连续空白折叠成单个空格，摘要始终单行显示。 */
export function collapseErrorWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 只去掉首尾空白行，保留每行开头的缩进。
 *
 * React 的 `componentStack` 以换行加缩进开头，直接 `trim()` 会把第一行的
 * 缩进吃掉，让组件栈看起来错位。
 */
export function trimErrorBlankLines(text: string): string {
  const lines = text.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  while (start < end && !(lines[start] ?? "").trim()) start += 1;
  while (end > start && !(lines[end - 1] ?? "").trim()) end -= 1;
  return lines.slice(start, end).join("\n");
}

interface ErrorLikeParts {
  name: string;
  message: string;
  stack: string;
}

/**
 * 识别 `Error` 或结构相近的对象（跨 realm 时 `instanceof` 可能失效）。
 * 只接受 `message` 为字符串的对象，其余交回通用序列化。
 */
function errorLikeParts(value: unknown): ErrorLikeParts | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { name?: unknown; message?: unknown; stack?: unknown };
  if (typeof record.message !== "string") return null;
  return {
    name: typeof record.name === "string" && record.name ? record.name : "Error",
    message: record.message,
    stack: typeof record.stack === "string" ? record.stack : "",
  };
}

/** 把非 Error 抛出值转成文本；对象优先 JSON，失败退回默认描述。 */
function plainThrownText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      if (typeof json === "string") return json;
    } catch {
      // 循环引用、BigInt 等无法序列化，退回默认描述。
    }
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "无法描述的异常值";
    }
  }
  try {
    return String(value);
  } catch {
    return "无法描述的异常值";
  }
}

/**
 * 把任意抛出值转成可读摘要与详情。
 *
 * - `Error` 或形似对象：摘要取 message（为空时取 name），详情取 stack。
 * - 字符串：折叠空白后作为摘要；原文与摘要不同时放进详情。
 * - 其他值：JSON 序列化或 `String()`，失败时给出固定文案。
 */
export function describeThrown(value: unknown): ErrorReport {
  const parts = errorLikeParts(value);
  if (parts) {
    const collapsed = collapseErrorWhitespace(parts.message || parts.name) || "未知错误";
    const message = truncateErrorText(collapsed, MAX_ERROR_MESSAGE_LENGTH);
    const stack = trimErrorBlankLines(parts.stack);
    let detail: string | undefined;
    // 堆栈第一行通常已包含完整消息；没有堆栈而摘要被截断时，详情补上原文。
    if (stack) detail = truncateErrorText(stack, MAX_ERROR_DETAIL_LENGTH);
    else if (collapsed.length > MAX_ERROR_MESSAGE_LENGTH) detail = truncateErrorText(collapsed, MAX_ERROR_DETAIL_LENGTH);
    return { message, detail };
  }
  const text = plainThrownText(value);
  const collapsed = collapseErrorWhitespace(text);
  if (!collapsed) return { message: "未知错误" };
  const message = truncateErrorText(collapsed, MAX_ERROR_MESSAGE_LENGTH);
  // 原文有换行或摘要被截断时保留详情，复制后仍能看到完整文本。
  const needsDetail = text !== collapsed || collapsed.length > MAX_ERROR_MESSAGE_LENGTH;
  return {
    message,
    detail: needsDetail ? truncateErrorText(text, MAX_ERROR_DETAIL_LENGTH) : undefined,
  };
}

export interface ErrorDetailContext {
  /** 出错区域，例如「应用根节点」「会话区」。 */
  scope: string;
  /** 出错时间，ISO 字符串；由调用方在捕获时生成。 */
  occurredAt: string;
  /** React 提供的组件树位置（`componentStack`）。 */
  componentStack?: string;
}

/** 界面上的单行摘要，带上出错区域。 */
export function errorSummary(report: ErrorReport, scope: string): string {
  const label = collapseErrorWhitespace(scope);
  return label ? `${label}渲染失败：${report.message}` : report.message;
}

/** 生成可复制的错误详情；组件栈同样受详情长度上限约束。 */
export function errorDetailText(report: ErrorReport, context: ErrorDetailContext): string {
  const lines = [
    `区域：${collapseErrorWhitespace(context.scope) || "未知区域"}`,
    `时间：${context.occurredAt}`,
    `摘要：${report.message}`,
  ];
  const detail = report.detail ? trimErrorBlankLines(report.detail) : "";
  if (detail) lines.push("", "堆栈：", detail);
  const componentStack = context.componentStack ? trimErrorBlankLines(context.componentStack) : "";
  if (componentStack) {
    lines.push("", "组件栈：", truncateErrorText(componentStack, MAX_ERROR_DETAIL_LENGTH));
  }
  return lines.join("\n");
}
