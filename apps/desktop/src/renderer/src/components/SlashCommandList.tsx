import React, { useEffect, useRef } from "react";
import {
  IconSearch,
  IconSparkles,
  IconFolder,
  IconUser,
  IconChat,
  IconPanel,
  IconDiffFiles,
  IconClose,
} from "./Icons";

export interface SlashCommandItem {
  id: string;
  command: string;
  label: string;
  description: string;
  iconType: "status" | "stats" | "search" | "recommend" | "jobs" | "candidates" | "chat" | "plan" | "clear";
  autoExecute?: boolean;
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "cmd-status",
    command: "/status",
    label: "检查账号与连接健康度",
    description: "查看 BOSS 直聘登录状态、Token 时效与平台会话健康度",
    iconType: "status",
    autoExecute: true,
  },
  {
    id: "cmd-stats",
    command: "/stats",
    label: "查询招聘与转化漏斗",
    description: "查询打招呼、投递与候选池全景漏斗转化数据看板",
    iconType: "stats",
    autoExecute: true,
  },
  {
    id: "cmd-search",
    command: "/search ",
    label: "检索在招职位",
    description: "按关键词、公司或技能要求检索真实职位",
    iconType: "search",
    autoExecute: false,
  },
  {
    id: "cmd-recommend",
    command: "/recommend",
    label: "获取个性化职位推荐",
    description: "基于简历特征与偏好获取推荐职位列表",
    iconType: "recommend",
    autoExecute: true,
  },
  {
    id: "cmd-jobs",
    command: "/jobs",
    label: "查看已发布职位列表",
    description: "招聘者模式：查看当前团队已发布的招聘岗位",
    iconType: "jobs",
    autoExecute: true,
  },
  {
    id: "cmd-candidates",
    command: "/candidates ",
    label: "搜索匹配候选人",
    description: "招聘者模式：多维度筛选搜索高匹配技术牛人",
    iconType: "candidates",
    autoExecute: false,
  },
  {
    id: "cmd-chat",
    command: "/chat",
    label: "查看沟通消息列表",
    description: "招聘者模式：查看与候选人的沟通列表与未读数",
    iconType: "chat",
    autoExecute: true,
  },
  {
    id: "cmd-plan",
    command: "/plan ",
    label: "制定招聘任务规划",
    description: "以 Plan 模式拆解任务执行路线与分阶段执行计划",
    iconType: "plan",
    autoExecute: false,
  },
  {
    id: "cmd-clear",
    command: "/clear",
    label: "清空当前消息流",
    description: "重置当前窗口消息展示（不影响持久化记录）",
    iconType: "clear",
    autoExecute: true,
  },
];

function renderSlashIcon(type: SlashCommandItem["iconType"]) {
  switch (type) {
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
    case "clear":
      return <IconClose size={14} />;
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

  if (!isOpen) return null;

  const query = search.startsWith("/") ? search.slice(1).toLowerCase() : search.toLowerCase();
  const filtered = SLASH_COMMANDS.filter(
    (item) =>
      item.command.toLowerCase().includes(query) ||
      item.label.toLowerCase().includes(query) ||
      item.description.toLowerCase().includes(query)
  );

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
                {item.autoExecute && (
                  <span className="popup-command-badge">即时</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
