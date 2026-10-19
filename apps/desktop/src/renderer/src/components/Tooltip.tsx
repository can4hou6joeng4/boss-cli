import React, { useState, useRef, useEffect } from "react";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  position = "top",
  delay = 400,
}) => {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const showTooltip = () => {
    timerRef.current = setTimeout(() => {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        let x = rect.left + rect.width / 2;
        let y = rect.top;

        if (position === "top") {
          y = rect.top - 8;
        } else if (position === "bottom") {
          y = rect.bottom + 8;
        } else if (position === "left") {
          x = rect.left - 8;
          y = rect.top + rect.height / 2;
        } else if (position === "right") {
          x = rect.right + 8;
          y = rect.top + rect.height / 2;
        }

        setCoords({ x, y });
        setVisible(true);
      }
    }, delay);
  };

  const hideTooltip = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div
      ref={triggerRef}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      {children}
      {visible && (
        <div
          className="codex-tooltip"
          style={{
            left: `${coords.x}px`,
            top: `${coords.y}px`,
            transform:
              position === "top"
                ? "translate(-50%, -100%)"
                : position === "bottom"
                ? "translate(-50%, 0)"
                : position === "left"
                ? "translate(-100%, -50%)"
                : "translate(0, -50%)",
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
};
