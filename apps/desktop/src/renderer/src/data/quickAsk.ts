import type { ModelDescriptor } from "@boss-harness/protocol";

interface RouteFields {
  provider?: string;
  model?: string;
}

export interface QuickAskRoute {
  provider: string;
  model: string;
}

export type QuickAskResolution = { ok: true; route: QuickAskRoute } | { ok: false; reason: string };

/**
 * 解析快速提问要使用的线路：当前会话 → 进程默认线路 → 目录里同一 provider 的条目。
 * 解析不出精确 provider/model 时明确失败，不用显示值或占位线路冒充可用配置。
 */
export function resolveQuickAskRoute(session: RouteFields | null | undefined,
  defaultModel: QuickAskRoute | null | undefined, models: ModelDescriptor[] | undefined): QuickAskResolution {
  const provider = session?.provider ?? defaultModel?.provider;
  const model = session?.model
    ?? (provider !== undefined && provider === defaultModel?.provider ? defaultModel?.model : undefined)
    ?? models?.find(candidate => candidate.provider === provider)?.id;
  if (!provider || !model) {
    return { ok: false, reason: "没有可用的模型线路，无法提问。请先在设置中配置模型。" };
  }
  if (provider.toLowerCase() === "none") {
    return { ok: false, reason: "当前模型线路为 none（未配置模型），无法提问。" };
  }
  return { ok: true, route: { provider, model } };
}
