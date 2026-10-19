import React, { useState } from "react";
import { IconDiffFiles, IconUndo, IconChevronDown } from "../components/Icons";
import { Tooltip } from "../components/Tooltip";
import type { DiffFile } from "../data/mockData";

interface DiffCardProps {
  fileCount: number;
  additions: number;
  deletions: number;
  initialFiles: DiffFile[];
  extraFiles: DiffFile[];
  onReviewChanges?: () => void;
  onRevertChanges?: () => void;
}

export const DiffCard: React.FC<DiffCardProps> = ({
  fileCount,
  additions,
  deletions,
  initialFiles,
  extraFiles,
  onReviewChanges,
  onRevertChanges,
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="codex-diff-card" role="region" aria-label="文件变更统计卡片">
      {/* 头部行：左侧上下两行（标题 + 副标题统计），右侧撤销与查看变更按钮垂直居中 */}
      <div className="codex-diff-card__header">
        <div className="codex-diff-card__header-left">
          <div className="codex-diff-card__title-row">
            <IconDiffFiles size={16} style={{ color: "var(--color-text-secondary)" }} />
            <span className="codex-diff-card__title">
              已编辑 {fileCount} 个文件
            </span>
          </div>
          <div className="codex-diff-card__stats-row">
            <span className="codex-diff-stat--add">+{additions}</span>
            <span className="codex-diff-stat--del">−{deletions}</span>
          </div>
        </div>

        <div className="codex-diff-card__header-right">
          <Tooltip content="撤销本次更改">
            <button
              type="button"
              className="codex-diff-card__btn"
              onClick={onRevertChanges}
            >
              <IconUndo size={12} />
              <span>撤销</span>
            </button>
          </Tooltip>

          <Tooltip content="查看代码统一差异">
            <button
              type="button"
              className="codex-diff-card__btn"
              onClick={onReviewChanges}
            >
              <span>查看变更</span>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* 文件行列表 */}
      <div className="codex-diff-card__file-list">
        {initialFiles.map((file, idx) => (
          <div key={`init-${idx}`} className="codex-diff-card__file-row">
            <span className="codex-diff-card__file-name">{file.name}</span>
            <div className="codex-diff-card__file-stats">
              <span className="codex-diff-stat--add">+{file.additions}</span>
              <span className="codex-diff-stat--del">−{file.deletions}</span>
            </div>
          </div>
        ))}

        {expanded &&
          extraFiles.map((file, idx) => (
            <div key={`extra-${idx}`} className="codex-diff-card__file-row">
              <span className="codex-diff-card__file-name">{file.name}</span>
              <div className="codex-diff-card__file-stats">
                <span className="codex-diff-stat--add">+{file.additions}</span>
                <span className="codex-diff-stat--del">−{file.deletions}</span>
              </div>
            </div>
          ))}
      </div>

      {/* 尾行：再显示 5 个文件 */}
      <div className="codex-diff-card__footer">
        <button
          type="button"
          className="codex-diff-card__more-btn"
          onClick={() => setExpanded(!expanded)}
        >
          <span>
            {expanded
              ? "收起文件列表"
              : `再显示 ${extraFiles.length} 个文件`}
          </span>
          <IconChevronDown
            size={12}
            style={{
              transform: expanded ? "rotate(180deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          />
        </button>
      </div>
    </div>
  );
};
