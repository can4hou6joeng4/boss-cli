/**
 * 关于页的环境信息与诊断文本。
 *
 * 所有字段都可能来自尚未连接的内核、浏览器预览或旧构建；缺失、空白或
 * 非字符串的值统一显示为「未知」，不把空值渲染成看似有效的版本号。
 */
export interface AboutEnvironment {
  appVersion?: string | null;
  protocolVersion?: string | null;
  electron?: string | null;
  chrome?: string | null;
  node?: string | null;
  platform?: string | null;
  kernelConnected: boolean;
}

export interface AboutField {
  label: string;
  value: string;
}

export const ABOUT_UNKNOWN = "未知";

/** 把版本或平台值规范为可展示文本；空白与非字符串回退为「未知」。 */
export function aboutValue(value: string | null | undefined): string {
  if (typeof value !== "string") return ABOUT_UNKNOWN;
  const trimmed = value.trim();
  return trimmed || ABOUT_UNKNOWN;
}

/** 平台显示名：把 Node / Electron 的平台标识换成用户能读的名称。 */
export function aboutPlatformLabel(platform: string | null | undefined): string {
  const value = aboutValue(platform);
  if (value === "darwin") return "macOS";
  if (value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  return value;
}

/** 关于页展示的条目；顺序固定，便于用户和探针核对。 */
export function aboutFields(environment: AboutEnvironment): AboutField[] {
  return [
    { label: "应用版本", value: aboutValue(environment.appVersion) },
    { label: "协议版本", value: aboutValue(environment.protocolVersion) },
    { label: "Electron", value: aboutValue(environment.electron) },
    { label: "Chromium", value: aboutValue(environment.chrome) },
    { label: "Node", value: aboutValue(environment.node) },
    { label: "平台", value: aboutPlatformLabel(environment.platform) },
    { label: "内核", value: environment.kernelConnected ? "已连接" : "未连接" },
  ];
}

/**
 * 复制用的诊断文本：只包含版本、平台与连接状态。
 * 不包含路径、凭据、会话内容或任何本机状态目录。
 */
export function aboutDiagnostics(environment: AboutEnvironment): string {
  return ["BOSS Harness 诊断信息", ...aboutFields(environment).map(field => `${field.label}：${field.value}`)].join("\n");
}
