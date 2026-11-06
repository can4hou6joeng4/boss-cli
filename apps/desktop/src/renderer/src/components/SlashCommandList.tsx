import React, { useEffect, useLayoutEffect, useRef } from "react";
import {
  IconSearch,
  IconSparkles,
  IconFolder,
  IconUser,
  IconChat,
  IconPanel,
  IconDiffFiles,
  IconTerminal,
} from "./Icons";

export interface SlashCommandItem {
  id: string;
  command: string;
  label: string;
  description: string;
  iconType: "tools" | "status" | "stats" | "search" | "recommend" | "jobs" | "candidates" | "chat" | "plan";
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "cmd-tools",
    command: "/tools",
    label: "查看上游能力目录",
    description: "列出上游 boss-agent-cli 当前提供的全部能力（只读，不改变工具权限）",
    iconType: "tools",
  },
  {
    id: "cmd-status",
    command: "/status",
    label: "检查本地登录与连接状态",
    description: "读取本地登录态与健康检查（只读；不会进行在线验证）",
    iconType: "status",
  },
  {
    id: "cmd-stats",
    command: "/stats",
    label: "读取本地招聘漏斗与看板",
    description: "读取本地投递转化漏斗与沟通数据看板（只读，不刷新平台数据）",
    iconType: "stats",
  },
  {
    id: "cmd-search",
    command: "/search ",
    label: "检索在招职位",
    description: "按关键词检索职位（只读）",
    iconType: "search",
  },
  {
    id: "cmd-recommend",
    command: "/recommend",
    label: "读取个性化职位推荐",
    description: "读取基于简历的推荐职位列表（只读）",
    iconType: "recommend",
  },
  {
    id: "cmd-jobs",
    command: "/jobs",
    label: "查看已发布职位列表",
    description: "招聘者模式：查看已发布的职位列表（只读）",
    iconType: "jobs",
  },
  {
    id: "cmd-candidates",
    command: "/candidates ",
    label: "搜索匹配候选人",
    description: "招聘者模式：按关键词搜索候选人（只读）",
    iconType: "candidates",
  },
  {
    id: "cmd-chat",
    command: "/chat",
    label: "查看沟通消息列表",
    description: "招聘者模式：查看候选人沟通列表与未读数（只读）",
    iconType: "chat",
  },
  {
    id: "cmd-plan",
    command: "/plan ",
    label: "制定招聘任务规划",
    description: "拆解任务执行路线与分阶段执行计划",
    iconType: "plan",
  },
];

/** 输入被外部替换（建议词、编辑消息、恢复队列消息）后，已请求打开的菜单不能继续覆盖新文本。 */
export function slashMenuVisible(requested: boolean, text: string): boolean {
  return requested && /^\/[^\s]*$/.test(text);
}

/** 菜单渲染与 Composer 键盘选取共用同一过滤结果，避免两处规则漂移。 */
export function filterSlashCommands(search: string): SlashCommandItem[] {
  const query = (search.startsWith("/") ? search.slice(1) : search).toLowerCase();
  return SLASH_COMMANDS.filter(item =>
    item.command.toLowerCase().includes(query)
    || item.label.toLowerCase().includes(query)
    || item.description.toLowerCase().includes(query));
}

function renderSlashIcon(type: SlashCommandItem["iconType"]) {
  switch (type) {
    case "tools":
      return <IconTerminal size={14} />;
    case "status":
    case "recommend":
      return <IconSparkles size={14} />;
    case "stats":
      return <IconDiffFiles size={14} />;
    case "search":
      return <IconSearch size={14} />;
    case "jobs":
      return <IconFolder size={14} />;
    case "candidates":
      return <IconUser size={14} />;
    case "chat":
      return <IconChat size={14} />;
    case "plan":
      return <IconPanel size={14} />;
  }
}

interface SlashCommandListProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (item: SlashCommandItem) => void;
  search?: string;
  selectedIndex?: number;
}

export const SlashCommandList: React.FC<SlashCommandListProps> = ({
  isOpen,
  onClose,
  onSelect,
  search = "",
  selectedIndex = 0,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isOpen, onClose]);

  // 列表高度小于全部命令；方向键移动选中项时把它滚入视口，否则高亮会停在不可见区域。
  useLayoutEffect(() => {
    if (!isOpen) return;
    containerRef.current?.querySelector<HTMLElement>(".popup-command-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [isOpen, search, selectedIndex]);

  if (!isOpen) return null;

  const filtered = filterSlashCommands(search);

  return (
    <div ref={containerRef} className="popup-command-menu">
      <div className="popup-command-header">
        <span>快捷指令 · 按 Enter 选取</span>
      </div>

      <div className="popup-command-list">
        {filtered.length === 0 ? (
          <div className="popup-command-empty">未找到匹配的命令</div>
        ) : (
          filtered.map((item, idx) => {
            const isSelected = idx === Math.min(selectedIndex, filtered.length - 1);
            return (
              <div
                key={item.id}
                className={`popup-command-item ${isSelected ? "selected" : ""}`}
                onClick={() => onSelect(item)}
              >
                <div className="popup-command-left">
                  <span className="popup-command-icon">{renderSlashIcon(item.iconType)}</span>
                  <div>
                    <div className="popup-command-title">
                      <span className="popup-command-name">{item.command.trim()}</span>
                      <span className="popup-command-label">{item.label}</span>
                    </div>
                    <div className="popup-command-desc">{item.description}</div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
