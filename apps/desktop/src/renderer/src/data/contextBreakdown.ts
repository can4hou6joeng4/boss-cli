/**
 * 把 `context/read.breakdown` 拆成可展示的构成项。
 *
 * 应用历史用量校准后，内核只上报「历史用量基线 + 新增消息」：基线来自 provider
 * 实际上报的输入 token，已包含系统提示、工具定义与历史消息，不能再拆分；此时
 * 若按未校准的分段展示，会把系统提示误报为 0。字段缺失、类型非法、负数或总和
 * 为 0 时返回 null，由调用方按旧内核处理，不展示部分数据。
 */
export interface ContextBreakdownPart {
  key: string;
  label: string;
  tokens: number;
}

export interface ContextBreakdown {
  calibrated: boolean;
  parts: ContextBreakdownPart[];
  total: number;
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function contextBreakdown(value: unknown): ContextBreakdown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const messages = count(fields.messages);
  const baseline = count(fields.usageBaseline);
  let parts: ContextBreakdownPart[];
  if (baseline !== undefined) {
    if (messages === undefined) return null;
    parts = [
      { key: "usageBaseline", label: "历史用量基线", tokens: baseline },
      { key: "messages", label: "新增消息", tokens: messages },
    ];
  } else {
    const system = count(fields.system), tools = count(fields.tools), options = count(fields.options);
    if (system === undefined || messages === undefined || tools === undefined || options === undefined) return null;
    parts = [
      { key: "system", label: "系统提示", tokens: system },
      { key: "messages", label: "消息历史", tokens: messages },
      { key: "tools", label: "工具定义", tokens: tools },
      { key: "options", label: "选项", tokens: options },
    ];
  }
  const total = parts.reduce((sum, part) => sum + part.tokens, 0);
  return total > 0 ? { calibrated: baseline !== undefined, parts, total } : null;
}
