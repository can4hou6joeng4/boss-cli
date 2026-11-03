import React from "react";
import { useClipboardCopy } from "../data/clipboardCopy";
import { IconCopy, IconCheck, IconExternalLink } from "./Icons";

interface RichMarkdownProps {
  content: string;
}

/**
 * 与主进程 isAllowedExternalUrl 保持同一协议集合：只有这些链接交给系统打开。
 * 其余协议（javascript:、file: 等）既不导航也不交给系统，避免静默失败造成的误判。
 */
const EXTERNAL_SCHEMES = ["http:", "https:", "mailto:"];
function externalTarget(url: string): string | null {
  try {
    return EXTERNAL_SCHEMES.includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

export const RichMarkdown: React.FC<RichMarkdownProps> = ({ content }) => {
  const { feedback, copy } = useClipboardCopy();

  const handleCopyCode = (code: string, index: number) => {
    // 只有写入成功才显示「已复制」；失败时给出原因，避免用户粘贴出旧内容才发现。
    void copy(code, String(index));
  };

  // 拆分代码块与常规文本
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  const parts: { type: "code" | "text"; lang?: string; content: string }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        content: content.slice(lastIndex, match.index),
      });
    }
    parts.push({
      type: "code",
      lang: match[1] || "text",
      content: match[2] ?? "",
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({
      type: "text",
      content: content.slice(lastIndex),
    });
  }

  // 行内解析器（解析链接、引文药丸、Mention、粗体、行内代码）
  const renderInline = (text: string) => {
    // 匹配:
    // 1. [text](url) -> 链接或 Citation
    // 2. `code` -> 行内代码
    // 3. **bold** -> 粗体
    // 4. @mention -> 实体药丸
    const tokenRegex = /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|@([a-zA-Z0-9_\u4e00-\u9fa5:*]+))/g;

    const elements: React.ReactNode[] = [];
    let currentIdx = 0;
    let inlineMatch: RegExpExecArray | null;

    while ((inlineMatch = tokenRegex.exec(text)) !== null) {
      if (inlineMatch.index > currentIdx) {
        elements.push(text.slice(currentIdx, inlineMatch.index));
      }

      if (inlineMatch[1]?.startsWith("[")) {
        const linkText = inlineMatch[2] ?? "";
        const linkUrl = inlineMatch[3] ?? "";
        const target = externalTarget(linkUrl);
        const isCitation = linkText.startsWith("来源") || /^\d+$/.test(linkText) || linkText.includes("↗") || linkText.includes("GitHub");

        if (isCitation) {
          elements.push(
            <a
              key={inlineMatch.index}
              href={linkUrl}
              target="_blank"
              rel="noreferrer"
              className="chat-citation-pill"
              title={target ? `打开链接: ${target}` : `${linkUrl}（该链接协议不会打开）`}
              onClick={(e) => {
                e.preventDefault();
                if (target) window.open(target, "_blank");
              }}
            >
              <span>{linkText}</span>
              <IconExternalLink size={10} style={{ opacity: 0.7 }} />
            </a>
          );
        } else {
          elements.push(
            <a
              key={inlineMatch.index}
              href={linkUrl}
              className="chat-inline-link"
              title={target ? target : `${linkUrl}（该链接协议不会打开）`}
              onClick={(e) => {
                // 一律拦截默认导航：外部协议交给主进程，其余协议（javascript: 等）不在渲染进程里执行。
                e.preventDefault();
                if (target) window.open(target, "_blank");
              }}
            >
              {linkText}
            </a>
          );
        }
      } else if (inlineMatch[4]) {
        // 行内代码 `code`
        elements.push(
          <code key={inlineMatch.index} className="chat-inline-code">
            {inlineMatch[4]}
          </code>
        );
      } else if (inlineMatch[5]) {
        // 粗体 **bold**
        elements.push(
          <strong key={inlineMatch.index} style={{ fontWeight: 600, color: "var(--text-main)" }}>
            {inlineMatch[5]}
          </strong>
        );
      } else if (inlineMatch[6]) {
        // @Mention
        elements.push(
          <span key={inlineMatch.index} className="chat-mention-pill">
            @{inlineMatch[6]}
          </span>
        );
      }

      currentIdx = inlineMatch.index + inlineMatch[0].length;
    }

    if (currentIdx < text.length) {
      elements.push(text.slice(currentIdx));
    }

    return elements;
  };

  return (
    <div className="agent-markdown">
      {parts.map((part, pIdx) => {
        if (part.type === "code") {
          return (
            <div key={pIdx} className="code-block-wrapper">
              <div className="code-block-header">
                <span>{part.lang}</span>
                <button
                  type="button"
                  className="code-block-copy-btn"
                  title={feedback?.key === String(pIdx) && !feedback.ok ? `复制失败：${feedback.reason}` : "复制代码到剪贴板"}
                  onClick={() => handleCopyCode(part.content, pIdx)}
                >
                  {feedback?.key === String(pIdx) && feedback.ok ? (
                    <>
                      <IconCheck size={11} style={{ color: "var(--accent-green)" }} />
                      <span style={{ color: "var(--accent-green)" }}>已复制</span>
                    </>
                  ) : feedback?.key === String(pIdx) ? (
                    <>
                      <IconCopy size={11} style={{ color: "var(--text-muted)" }} />
                      <span style={{ color: "var(--text-muted)" }}>复制失败</span>
                    </>
                  ) : (
                    <>
                      <IconCopy size={11} />
                      <span>复制代码</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="code-block-pre">
                <code>{part.content.trim()}</code>
              </pre>
            </div>
          );
        }

        // 常规文本行处理
        const lines = part.content.split("\n");
        return (
          <React.Fragment key={pIdx}>
            {lines.map((line, lIdx) => {
              const trimmed = line.trim();
              if (!trimmed) return <div key={lIdx} style={{ height: 6 }} />;

              // 引用块
              if (trimmed.startsWith("> ")) {
                return (
                  <blockquote key={lIdx} className="chat-blockquote">
                    {renderInline(trimmed.slice(2))}
                  </blockquote>
                );
              }

              // 无序列表
              if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
                return (
                  <div key={lIdx} className="chat-list-item">
                    <span className="chat-list-bullet">•</span>
                    <span>{renderInline(trimmed.slice(2))}</span>
                  </div>
                );
              }

              // 有序列表
              const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
              if (orderedMatch) {
                return (
                  <div key={lIdx} className="chat-list-item">
                    <span className="chat-list-num">{orderedMatch[1]}.</span>
                    <span>{renderInline(orderedMatch[2] ?? "")}</span>
                  </div>
                );
              }

              // 标题
              const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
              if (heading) {
                const level = heading[1]!.length;
                return React.createElement(`h${level}`, { key: lIdx, className: `chat-heading chat-heading-${level}` }, renderInline(heading[2]!));
              }

              return <p key={lIdx}>{renderInline(line)}</p>;
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
};
