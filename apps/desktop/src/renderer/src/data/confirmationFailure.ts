import { harnessErrorText } from "./harnessBridge";

/**
 * 主操作回执未知、随后重新核对也失败时的说明。
 *
 * 这类场景此前只报主操作的原因，核对失败被静默吞掉；用户会以为界面正在核对，
 * 实际停在过期状态。两条原因都要给出，并明确不会自动重试。
 */
export function unconfirmedFailure(label: string, primary: unknown, verification: unknown, next: string): string {
  return `${label}尚未确认：${harnessErrorText(primary)}；重新核对也失败（${harnessErrorText(verification)}）。${next}`;
}
