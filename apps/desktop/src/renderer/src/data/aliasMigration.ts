import type { SessionItem } from "./mockData";

/**
 * 旧版本「更改显示名称」只写入本机偏好，内核标题保持创建时的值；现在的重命名
 * 写入内核并在成功后清除本机别名。启动后把仍然存在的遗留别名迁移到内核，
 * 避免侧栏、搜索与导出长期显示不同名称。
 */
export interface AliasMigration {
  session: SessionItem;
  /** 去除首尾空白后的显示名称；与重命名对话框的提交规则一致。 */
  name: string;
}

export interface AliasMigrationPlan {
  /** 需要写入内核的别名，按会话列表顺序排列。 */
  rename: AliasMigration[];
  /** 与内核标题一致或没有有效名称，只需删除本机别名，不发起写入。 */
  drop: string[];
}

/** 内核 `thread/name/set` 的字符上限；超出时保持本机别名，不发起必然失败的写入。 */
export const MAX_ALIAS_LENGTH = 500;
/** 单次启动最多迁移的数量；剩余别名留给下次启动，避免被异常偏好拖住。 */
export const MAX_ALIAS_MIGRATIONS = 50;

/**
 * 只计划当前会话列表中存在的会话：已删除会话的别名不迁移，避免把旧名称写回。
 * 空白、无效或与内核标题一致的别名直接删除，不需要任何 RPC。
 */
export function planAliasMigrations(
  aliases: Record<string, string>,
  sessions: readonly SessionItem[],
): AliasMigrationPlan {
  const plan: AliasMigrationPlan = { rename: [], drop: [] };
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    if (!Object.prototype.hasOwnProperty.call(aliases, session.id)) continue;
    const alias: unknown = aliases[session.id];
    if (typeof alias !== "string") { plan.drop.push(session.id); continue; }
    const name = alias.trim();
    const title = typeof session.title === "string" ? session.title.trim() : "";
    if (!name || name === title) { plan.drop.push(session.id); continue; }
    if (Array.from(name).length > MAX_ALIAS_LENGTH || plan.rename.length >= MAX_ALIAS_MIGRATIONS) continue;
    plan.rename.push({ session, name });
  }
  return plan;
}
