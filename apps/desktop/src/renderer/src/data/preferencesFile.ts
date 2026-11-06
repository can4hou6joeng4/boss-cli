import { LEGACY_UI_STORAGE_PREFIX, UI_STORAGE_PREFIX } from "./uiStorage";
import type { ThemePreference } from "./themePreference";

/**
 * 界面偏好导出文件的解析与校验。
 *
 * 导出文件只包含本应用允许迁移的界面偏好；导入时逐键校验，
 * 任一已知键非法就整体拒绝，避免只恢复半份偏好却不提示。
 * 改名前的 `boss-cli.ui` 作用域已随 rc.14 发布过，导入时继续接受并按旧前缀读取。
 */
export type Density = "compact" | "comfortable";
export type Motion = "reduced" | "full";

export const PREFERENCE_FONT_SIZES = [12, 13, 14, 15, 16] as const;
export const PREFERENCE_FILE_MAX_BYTES = 64 * 1024;

const PREFERENCE_FILE_VERSION = 1;
const PREFERENCE_FILE_SCOPE = "boss-harness.ui";
const LEGACY_PREFERENCE_FILE_SCOPE = "boss-cli.ui";

export interface PreferencesFileValues {
  fontSize?: number;
  density?: Density;
  motion?: Motion;
  approvalSound?: boolean;
  theme?: ThemePreference;
}

export type PreferencesFileResult =
  | { ok: true; values: PreferencesFileValues; fields: number }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function knownKey(name: string): string {
  return `${UI_STORAGE_PREFIX}${name}`;
}

/** 解析导出的 JSON 文本；只读取白名单键，未知键忽略。 */
export function parsePreferencesFile(text: string): PreferencesFileResult {
  if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "文件为空" };
  if (text.length > PREFERENCE_FILE_MAX_BYTES) return { ok: false, reason: "文件超过 64 KiB" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "不是有效的 JSON 文件" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "文件结构无效" };
  if (parsed.version !== PREFERENCE_FILE_VERSION) return { ok: false, reason: "不支持的版本，请使用当前版本导出的文件" };
  if (parsed.scope !== PREFERENCE_FILE_SCOPE && parsed.scope !== LEGACY_PREFERENCE_FILE_SCOPE) {
    return { ok: false, reason: "不是本应用的界面偏好文件" };
  }
  if (!isRecord(parsed.preferences)) return { ok: false, reason: "缺少界面偏好内容" };

  const preferences = parsed.preferences;
  const prefix = parsed.scope === LEGACY_PREFERENCE_FILE_SCOPE ? LEGACY_UI_STORAGE_PREFIX : UI_STORAGE_PREFIX;
  const readKey = (name: string): string => `${prefix}${name}`;
  const values: PreferencesFileValues = {};
  let fields = 0;

  const fontSizeRaw = preferences[readKey("fontSize")];
  if (fontSizeRaw !== undefined) {
    const size = typeof fontSizeRaw === "string" ? Number(fontSizeRaw) : Number.NaN;
    if (!PREFERENCE_FONT_SIZES.some((candidate) => candidate === size)) return { ok: false, reason: "字体大小无效" };
    values.fontSize = size;
    fields += 1;
  }

  const densityRaw = preferences[readKey("density")];
  if (densityRaw !== undefined) {
    if (densityRaw !== "compact" && densityRaw !== "comfortable") return { ok: false, reason: "会话密度无效" };
    values.density = densityRaw;
    fields += 1;
  }

  const motionRaw = preferences[readKey("motion")];
  if (motionRaw !== undefined) {
    if (motionRaw !== "reduced" && motionRaw !== "full") return { ok: false, reason: "动态效果设置无效" };
    values.motion = motionRaw;
    fields += 1;
  }

  const approvalSoundRaw = preferences[readKey("approvalSound")];
  if (approvalSoundRaw !== undefined) {
    if (approvalSoundRaw !== "true" && approvalSoundRaw !== "false") return { ok: false, reason: "审批提示音设置无效" };
    values.approvalSound = approvalSoundRaw === "true";
    fields += 1;
  }

  const themeRaw = preferences[readKey("theme")];
  if (themeRaw !== undefined) {
    if (themeRaw !== "system" && themeRaw !== "light" && themeRaw !== "dark") return { ok: false, reason: "主题设置无效" };
    values.theme = themeRaw;
    fields += 1;
  }

  if (fields === 0) return { ok: false, reason: "文件不包含可导入的界面偏好" };
  return { ok: true, values, fields };
}

/** 生成导出文件内容；主题与界面设置一起备份，旧版读取方会忽略不认识的键。 */
export function buildPreferencesFile(preferences: { fontSize: number; density: Density; motion: Motion; approvalSound: boolean }, theme: ThemePreference): string {
  const exported: Record<string, string> = {
    [knownKey("fontSize")]: String(preferences.fontSize),
    [knownKey("density")]: preferences.density,
    [knownKey("motion")]: preferences.motion,
    [knownKey("approvalSound")]: String(preferences.approvalSound),
    [knownKey("theme")]: theme,
  };
  // 工作区别名与项目名可能包含隐私文本，即使同处界面前缀也不能导出；这里只允许白名单键。
  return JSON.stringify({ version: PREFERENCE_FILE_VERSION, scope: PREFERENCE_FILE_SCOPE, preferences: exported }, null, 2);
}
