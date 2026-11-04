import { UI_STORAGE_PREFIX } from "./uiStorage";

const SOUND_KEY = `${UI_STORAGE_PREFIX}approvalSound`;
/** 连续审批时至少间隔这么久再响，避免多声叠加。 */
export const APPROVAL_SOUND_MIN_GAP_MS = 1500;

let lastPlayedAt = 0;
let audio: AudioContext | null = null;

/** 提示音偏好：只有明确写入 "true" 才开启；存储不可用或读取失败按关闭处理。 */
export function approvalSoundEnabled(read: () => string | null = () => localStorage.getItem(SOUND_KEY)): boolean {
  try {
    return read() === "true";
  } catch {
    return false;
  }
}

/** 是否该播放提示音：偏好已开启、时间可读，且与上次播放满足最小间隔。 */
export function approvalSoundDue(enabled: boolean, now: number, lastPlayed: number, gap = APPROVAL_SOUND_MIN_GAP_MS): boolean {
  if (!enabled || !Number.isFinite(now)) return false;
  if (!Number.isFinite(lastPlayed) || lastPlayed <= 0) return true;
  return now - lastPlayed >= gap;
}

function audioContext(): AudioContext | null {
  if (audio) return audio;
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return null;
  audio = new window.AudioContext();
  return audio;
}

/** 在用户手势中提前创建并恢复音频上下文，降低后续提示被自动播放策略挂起的概率。 */
export function primeApprovalChime(): void {
  try {
    const context = audioContext();
    if (context?.state === "suspended") void context.resume().catch(() => {});
  } catch {
    // 音频不可用只是少一种提醒方式，不影响通知与审批流程。
  }
}

/** 播放两声短提示音；不支持 Web Audio、自动播放受限或设备不可用时静默跳过。 */
export function playApprovalChime(now = Date.now()): boolean {
  if (!approvalSoundDue(true, now, lastPlayedAt)) return false;
  lastPlayedAt = now;
  try {
    const context = audioContext();
    if (!context) return false;
    if (context.state === "suspended") void context.resume().catch(() => {});
    const start = context.currentTime;
    for (const [index, frequency] of [880, 1318.51].entries()) {
      const at = start + index * 0.13;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.06, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.13);
    }
    return true;
  } catch {
    return false;
  }
}
