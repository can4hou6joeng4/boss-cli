import React, { useEffect, useRef } from "react";
import {
  IconUser,
  IconDiffFiles,
  IconFolder,
  IconPanel,
  IconHistory,
  IconSparkles,
} from "./Icons";

export interface MentionItem {
  id: string;
  name: string;
  label: string;
  description: string;
  category: "candidates" | "jobs" | "tools";
  iconType: "candidates" | "resume" | "jobs" | "jd" | "funnel" | "status";
}

export const RECRUITMENT_MENTIONS: MentionItem[] = [
  {
    id: "m-candidates",
    name: "候选人库",
    label: "候选人池",
    description: "当前招聘项目中已筛选、初筛通过与沟通中的牛人全集",
    category: "candidates",
    iconType: "candidates",
  },
  {
    id: "m-resume",
    name: "在线简历",
    label: "在线简历卡片",
    description: "候选人结构化技术背景、教育履历与实操项目档案",
    category: "candidates",
    iconType: "resume",
  },
  {
    id: "m-jobs",
    name: "在招职位",
    label: "已发布岗位",
    description: "当前招聘团队已上线或草稿状态的招聘职位列表",
    category: "jobs",
    iconType: "jobs",
  },
  {
    id: "m-jd",
    name: "岗位JD",
    label: "职位描述详情",
    description: "目标职位的核心职责、硬性门槛、加分技能与薪资范围",
    category: "jobs",
    iconType: "jd",
  },
  {
    id: "m-funnel",
    name: "转化漏斗",
    label: "招聘转化报表",
    description: "打招呼/投递/初筛/面试全链路转化率与留存漏斗统计",
    category: "tools",
    iconType: "funnel",
  },
  {
    id: "m-status",
    name: "平台健康度",
    label: "直聘会话凭据",
    description: "BOSS 直聘平台认证有效性、Token 时效与风控连接健康度",
    category: "tools",
    iconType: "status",
  },
];

export function filterMentions(search: string): MentionItem[] {
  const query = search.replace(/^@/, "").toLowerCase();
  return RECRUITMENT_MENTIONS.filter(item => [item.name, item.label, item.description].some(text => text.toLowerCase().includes(query)));
}

function renderMentionIcon(type: MentionItem["iconType"]) {
  switch (type) {
    case "candidates":
      return <IconUser size={14} />;
    case "resume":
      return <IconDiffFiles size={14} />;
    case "jobs":
      return <IconFolder size={14} />;
    case "jd":
      return <IconPanel size={14} />;
    case "funnel":
      return <IconHistory size={14} />;
    case "status":
      return <IconSparkles size={14} />;
  }
}

interface AtMentionListProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (item: MentionItem) => void;
  search?: string;
  selectedIndex?: number;
}

export const AtMentionList: React.FC<AtMentionListProps> = ({
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

  const filtered = filterMentions(search);

  return (
    <div ref={containerRef} className="popup-command-menu">
      <div className="popup-command-header">
        <span>提及对象 · 按 Enter 关联</span>
      </div>

      <div className="popup-command-list">
        {filtered.length === 0 ? (
          <div className="popup-command-empty">未找到匹配项</div>
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
                  <span className="popup-command-icon">{renderMentionIcon(item.iconType)}</span>
                  <div>
                    <div className="popup-command-title">
                      <span className="popup-command-name">@{item.name}</span>
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
