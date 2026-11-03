import { existsSync, renameSync } from "node:fs";

/**
 * 产品改名后 Electron 的 userData 目录也随之改变。首次以新名启动时接管旧目录，
 * 避免界面偏好、草稿等本地状态无故丢失；新目录已存在时保持新目录，不回填旧数据。
 * 接管失败（跨卷、权限、正被占用）时仍使用新目录，不让启动因此失败。
 */
export function adoptLegacyUserData(current: string, legacy: string): string {
  if (current === legacy || existsSync(current) || !existsSync(legacy)) return current;
  try {
    renameSync(legacy, current);
  } catch {
    // 旧目录保留在原处：用户可见的代价是一次重新设置，而不是启动失败。
  }
  return current;
}
