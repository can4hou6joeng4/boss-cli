/** 桌面界面偏好的本地存储命名空间。改名前的 `boss-cli.ui.*` 只做一次性补齐，不删除旧键。 */
export const UI_STORAGE_PREFIX = "boss-harness.ui.";
const LEGACY_UI_STORAGE_PREFIX = "boss-cli.ui.";

/** 把旧命名空间里尚不存在于新命名空间的键复制过来；本地存储不可用时由各调用方自行回退。 */
export function migrateLegacyUiStorage(): void {
  try {
    const legacyKeys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_UI_STORAGE_PREFIX)) legacyKeys.push(key);
    }
    for (const key of legacyKeys) {
      const next = UI_STORAGE_PREFIX + key.slice(LEGACY_UI_STORAGE_PREFIX.length);
      // 新键已存在说明新版写过偏好；旧值只用于补齐，不能反过来覆盖。
      if (localStorage.getItem(next) !== null) continue;
      const value = localStorage.getItem(key);
      if (value !== null) localStorage.setItem(next, value);
    }
  } catch {
    // 隐私模式或存储被禁用：界面按默认值运行，迁移留到下次可写入时再试。
  }
}
