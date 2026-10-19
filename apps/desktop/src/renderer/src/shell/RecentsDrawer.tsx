import React from "react";
import { IconChevronRight } from "../components/Icons";

export interface RecentThreadItem {
  id: string;
  title: string;
  time: string;
  active?: boolean;
}

interface RecentsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectThread: (id: string, title: string) => void;
}

const RECENT_GROUPS: Array<{ groupName: string; items: RecentThreadItem[] }> = [
  {
    groupName: "今天",
    items: [
      { id: "rt-1", title: "那么是否完成了IPA包重新整理", time: "11:42", active: true },
      { id: "rt-2", title: "Sonar 弱网重试逻辑审查", time: "10:15" },
    ],
  },
  {
    groupName: "昨天",
    items: [
      { id: "rt-3", title: "修复锁屏控制通知缺失", time: "昨天 18:30" },
      { id: "rt-4", title: "更新 SPM 构建产物配置", time: "昨天 14:02" },
    ],
  },
  {
    groupName: "过去 7 天",
    items: [
      { id: "rt-5", title: "初始化 iOS 客户端音频工程", time: "10月11日" },
      { id: "rt-6", title: "设计 CircularBuffer 架构方案", time: "10月09日" },
    ],
  },
];

export const RecentsDrawer: React.FC<RecentsDrawerProps> = ({
  isOpen,
  onClose,
  onSelectThread,
}) => {
  if (!isOpen) return null;

  return (
    <div className="codex-recents-drawer">
      <div className="codex-recents-drawer__header">
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            type="button"
            className="codex-titlebar__btn"
            onClick={onClose}
            aria-label="返回项目列表"
          >
            <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} />
          </button>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>最近会话</span>
        </div>
      </div>

      <div className="codex-recents-drawer__list">
        {RECENT_GROUPS.map((group) => (
          <div key={group.groupName} className="codex-recents-group">
            <div className="codex-sidebar__section-title">{group.groupName}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`codex-sidebar__project-row ${item.active ? "codex-sidebar__project-row--active" : ""}`}
                onClick={() => onSelectThread(item.id, item.title)}
              >
                <span className="codex-sidebar__project-name">{item.title}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
