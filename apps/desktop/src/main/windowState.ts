import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { BrowserWindow, Rectangle } from "electron";

/** 与主窗口的最小尺寸一致；恢复时低于它的值视为不可信，回退到默认窗口。 */
export const MIN_WINDOW_WIDTH = 240;
export const MIN_WINDOW_HEIGHT = 160;
const DEFAULT_WINDOW_WIDTH = 1440;
const DEFAULT_WINDOW_HEIGHT = 900;
const MAX_WINDOW_SIZE = 16_384;
/** 窗口至少要有这么多像素落在某块显示器的工作区里，标题栏才抓得到。 */
const MIN_VISIBLE_WIDTH = 80;
const MIN_VISIBLE_HEIGHT = 40;

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface WindowRestore {
  /** 没有 x/y 时交给系统决定位置（居中）；宽高始终给出。 */
  bounds: { x?: number; y?: number; width: number; height: number };
  maximized: boolean;
}

/** 解析持久化状态；任何字段缺失或越界都整体视为无效，而不是猜一个值。 */
export function parseWindowState(text: string): WindowState | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  const { x, y, width, height } = state;
  if (![x, y, width, height].every(item => typeof item === "number" && Number.isSafeInteger(item))) return null;
  if ((width as number) < MIN_WINDOW_WIDTH || (height as number) < MIN_WINDOW_HEIGHT ||
      (width as number) > MAX_WINDOW_SIZE || (height as number) > MAX_WINDOW_SIZE) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number, maximized: state.maximized === true };
}

/** 两个矩形的重叠尺寸；不相交时得到负数，交给调用方与阈值比较。 */
function overlap(a: Rectangle, b: Rectangle): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

function overlapArea(a: Rectangle, b: Rectangle): number {
  const value = overlap(a, b);
  return value.width > 0 && value.height > 0 ? value.width * value.height : 0;
}

/**
 * 校验并收敛保存的窗口状态：位置必须仍落在当前显示器上，尺寸不能超过所在工作区，
 * 否则窗口可能在启动后完全不可见。无法安全恢复时回到默认尺寸并交给系统居中。
 */
export function restoreWindowState(state: WindowState | null, workAreas: Rectangle[]): WindowRestore {
  const largest = workAreas.reduce<Rectangle | null>((best, area) =>
    !best || area.width * area.height > best.width * best.height ? area : best, null);
  const fallback: WindowRestore = {
    bounds: {
      width: Math.min(DEFAULT_WINDOW_WIDTH, largest ? Math.max(MIN_WINDOW_WIDTH, largest.width) : DEFAULT_WINDOW_WIDTH),
      height: Math.min(DEFAULT_WINDOW_HEIGHT, largest ? Math.max(MIN_WINDOW_HEIGHT, largest.height) : DEFAULT_WINDOW_HEIGHT),
    },
    maximized: false,
  };
  if (!state || workAreas.length === 0) return fallback;
  const saved: Rectangle = state;
  const visible = workAreas.some(area => {
    const value = overlap(saved, area);
    return value.width >= MIN_VISIBLE_WIDTH && value.height >= MIN_VISIBLE_HEIGHT;
  });
  if (!visible) return fallback;
  // 收敛到重叠最多的那块工作区：显示器变小或分辨率变化后，窗口仍然完整可见。
  const target = workAreas.reduce((best, area) => overlapArea(saved, area) > overlapArea(saved, best) ? area : best);
  const width = Math.min(state.width, target.width);
  const height = Math.min(state.height, target.height);
  return {
    bounds: {
      x: Math.min(Math.max(state.x, target.x), target.x + target.width - width),
      y: Math.min(Math.max(state.y, target.y), target.y + target.height - height),
      width,
      height,
    },
    maximized: state.maximized,
  };
}

export function readWindowState(path: string): WindowState | null {
  try { return parseWindowState(readFileSync(path, "utf8")); } catch { return null; }
}

/** 先写临时文件再改名，避免退出时留下半截 JSON；状态只是便利信息，写入失败不影响运行。 */
export function writeWindowState(path: string, state: WindowState): void {
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch { /* 磁盘只读或目录缺失时保留本次会话，不打断退出。 */ }
}

/** 移动、缩放后防抖保存，关闭前再保存一次；最大化时保存的是还原后的位置。 */
export function trackWindowState(window: BrowserWindow, path: string): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = (): void => {
    try {
      if (window.isDestroyed()) return;
      writeWindowState(path, { ...window.getNormalBounds(), maximized: window.isMaximized() });
    } catch { /* 窗口正在销毁时读取边界可能失败，忽略即可。 */ }
  };
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; save(); }, 500);
  };
  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("close", () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; save(); });
}
