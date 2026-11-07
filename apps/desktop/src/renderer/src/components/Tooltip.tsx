import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import "../styles/tooltip.css";

type TooltipPosition = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: TooltipPosition;
  delay?: number;
}

interface Anchor { x: number; y: number }
interface Size { width: number; height: number }
type Box = { left: number; top: number } & Size;

/** 提示与触发元素、窗口边缘之间的间距。 */
const GAP = 8;

const TRANSFORMS: Record<TooltipPosition, string> = {
  top: "translate(-50%, -100%)",
  bottom: "translate(-50%, 0)",
  left: "translate(-100%, -50%)",
  right: "translate(0, -50%)",
};

/**
 * 提示相对触发元素的锚点：top / bottom 水平居中，left / right 垂直居中。
 * 具体方向由 `TRANSFORMS` 负责，这里只给出锚点坐标。
 */
export function tooltipAnchor(rect: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">,
  position: TooltipPosition): Anchor {
  switch (position) {
    case "bottom": return { x: rect.left + rect.width / 2, y: rect.bottom + GAP };
    case "left": return { x: rect.left - GAP, y: rect.top + rect.height / 2 };
    case "right": return { x: rect.right + GAP, y: rect.top + rect.height / 2 };
    default: return { x: rect.left + rect.width / 2, y: rect.top - GAP };
  }
}

/** 提示在未做视口钳制时的边界；与 `TRANSFORMS` 的平移方向保持一致。 */
export function tooltipBox(anchor: Anchor, size: Size, position: TooltipPosition): Box {
  return {
    left: position === "left" ? anchor.x - size.width
      : position === "right" ? anchor.x
      : anchor.x - size.width / 2,
    top: position === "top" ? anchor.y - size.height
      : position === "bottom" ? anchor.y
      : anchor.y - size.height / 2,
    width: size.width,
    height: size.height,
  };
}

/**
 * 提示越出视口时需要的位移；完全可见时返回 `{ x: 0, y: 0 }`。
 * 提示宽度由 CSS `max-width` 限制，因此窗口比提示窄时仍能落在安全边距内。
 */
export function tooltipShift(box: Box, viewport: Size): Anchor {
  const maxLeft = Math.max(GAP, viewport.width - GAP - box.width);
  const maxTop = Math.max(GAP, viewport.height - GAP - box.height);
  return {
    x: Math.min(Math.max(box.left, GAP), maxLeft) - box.left,
    y: Math.min(Math.max(box.top, GAP), maxTop) - box.top,
  };
}

/**
 * 轻量提示浮层：悬停或键盘聚焦触发元素时，在视口坐标系显示一行说明。
 * 提示固定在视口中，不参与触发元素所在行的 flex 布局；靠近窗口边缘时整体平移回安全区域。
 */
export const Tooltip: React.FC<TooltipProps> = ({ content, children, position = "top", delay = 400 }) => {
  const [visible, setVisible] = useState(false);
  const [anchor, setAnchor] = useState<Anchor>({ x: 0, y: 0 });
  const [shift, setShift] = useState<Anchor>({ x: 0, y: 0 });
  const timerRef = useRef<number | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const showTooltip = () => {
    if (!content) return;
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const trigger = triggerRef.current;
      if (!trigger) return;
      setShift({ x: 0, y: 0 });
      setAnchor(tooltipAnchor(trigger.getBoundingClientRect(), position));
      setVisible(true);
    }, Math.max(0, delay));
  };

  const hideTooltip = () => {
    clearTimer();
    setVisible(false);
  };

  // 提示渲染后测量实际尺寸，越出视口时整体平移回安全区域。
  useLayoutEffect(() => {
    if (!visible) return;
    const update = () => {
      const trigger = triggerRef.current, tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;
      const nextAnchor = tooltipAnchor(trigger.getBoundingClientRect(), position);
      const size = { width: tooltip.offsetWidth, height: tooltip.offsetHeight };
      const nextShift = tooltipShift(tooltipBox(nextAnchor, size, position),
        { width: window.innerWidth, height: window.innerHeight });
      setAnchor(previous => previous.x === nextAnchor.x && previous.y === nextAnchor.y ? previous : nextAnchor);
      setShift(previous => previous.x === nextShift.x && previous.y === nextShift.y ? previous : nextShift);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [visible, position]);

  // 触发元素会随滚动移动，提示固定在视口中会脱离它；滚动时直接收起。
  useEffect(() => {
    if (!visible) return;
    const hide = () => setVisible(false);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [visible]);

  useEffect(() => clearTimer, []);

  return (
    <div
      ref={triggerRef}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={event => {
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        hideTooltip();
      }}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      {children}
      {visible && (
        <div
          ref={tooltipRef}
          className="ui-tooltip"
          role="tooltip"
          style={{
            left: `${anchor.x + shift.x}px`,
            top: `${anchor.y + shift.y}px`,
            transform: TRANSFORMS[position],
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
};
