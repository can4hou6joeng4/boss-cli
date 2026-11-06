/**
 * 主题偏好的解析与合成。
 *
 * 存储值有三态：`system` 跟随系统外观，`light` / `dark` 为固定外观。
 * 旧版本只写入过 `light` / `dark`，这些值继续按固定外观生效；缺失、
 * 空白、大小写不一致以外的非法值一律回退为跟随系统。
 */
export type ThemePreference = "system" | "light" | "dark";

/** 解析本地存储值；任何无法识别的值都回退为跟随系统。 */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  if (typeof raw !== "string") return "system";
  const value = raw.trim().toLowerCase();
  return value === "light" || value === "dark" ? value : "system";
}

/** 把偏好与当前系统外观合成为实际是否使用深色。 */
export function resolveDarkTheme(preference: ThemePreference, systemPrefersDark: boolean): boolean {
  if (preference === "dark") return true;
  if (preference === "light") return false;
  return systemPrefersDark;
}

/** 写回存储的规范值；只有三态之一，避免把旧值或脏值原样保留。 */
export function serializeThemePreference(preference: ThemePreference): ThemePreference {
  return preference === "light" || preference === "dark" ? preference : "system";
}
