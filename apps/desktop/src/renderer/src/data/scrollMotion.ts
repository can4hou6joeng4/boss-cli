/**
 * 聊天区滚动的动效解析。
 *
 * CSS 的 `scroll-behavior` 会被显式 `behavior: "smooth"` 覆盖，因此 JavaScript 发起的
 * 滚动必须自己遵守「减少动态效果」：应用内设置与系统 `prefers-reduced-motion` 任一
 * 开启时使用即时滚动，避免设置说明与实际行为不一致。
 */
export type ScrollBehavior = "auto" | "smooth";

export function resolveScrollBehavior(appMotion: string | undefined | null, systemPrefersReduced: boolean): ScrollBehavior {
  return appMotion === "reduced" || systemPrefersReduced ? "auto" : "smooth";
}

/** 读取当前文档上的应用设置与系统偏好；环境缺失时退回平滑滚动。 */
export function currentScrollBehavior(): ScrollBehavior {
  let appMotion: string | undefined;
  let systemPrefersReduced = false;
  try { appMotion = document.documentElement.dataset.motion; } catch { /* 文档不可用时按未设置处理。 */ }
  try { systemPrefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true; } catch { /* 系统偏好不可用时按未开启处理。 */ }
  return resolveScrollBehavior(appMotion, systemPrefersReduced);
}
