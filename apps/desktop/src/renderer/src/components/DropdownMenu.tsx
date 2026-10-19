import React, { useRef, useEffect } from "react";

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  divider?: boolean;
  shortcut?: string;
  onClick?: () => void;
}

interface DropdownMenuProps {
  isOpen: boolean;
  onClose: () => void;
  items: MenuItem[];
  anchorRef: React.RefObject<HTMLElement>;
  align?: "left" | "right";
  width?: number;
}

export const DropdownMenu: React.FC<DropdownMenuProps> = ({
  isOpen,
  onClose,
  items,
  anchorRef,
  align = "left",
  width,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, anchorRef]);

  if (!isOpen || !anchorRef.current) return null;

  const rect = anchorRef.current.getBoundingClientRect();
  const top = rect.bottom + 4; // 贴在触发元素下方 4px
  const style: React.CSSProperties = {
    top: `${top}px`,
    minWidth: width ? `${width}px` : "var(--app-menu-min-width)",
  };

  if (align === "left") {
    style.left = `${rect.left}px`;
  } else {
    style.right = `${window.innerWidth - rect.right}px`;
  }

  return (
    <div ref={menuRef} className="codex-menu" style={style}>
      {items.map((item, index) => {
        if (item.divider) {
          return <div key={`div-${index}`} className="codex-menu__divider" />;
        }
        return (
          <div
            key={item.id}
            className={`codex-menu__item ${item.active ? "codex-menu__item--active" : ""}`}
            onClick={() => {
              if (item.disabled) return;
              item.onClick?.();
              onClose();
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {item.icon}
              <span>{item.label}</span>
            </div>
            {item.shortcut && (
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>
                {item.shortcut}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};
