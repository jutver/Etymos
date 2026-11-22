import { useCallback, useLayoutEffect, useState } from "react";
import { cn } from "@etymos/shared";

interface PillBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Tracks where the selected option of a pill toggle (or a vertical list, like
 * the sidebar nav) sits inside it.
 * Put `ref` on the pill (which needs `relative`), mark the selected button
 * with `data-pill-active`, and render <PillIndicator {...pill} /> first inside
 * the pill. A callback ref tracks conditionally mounted containers (e.g.
 * FormatToolbar once `hasOriginal` becomes true) so they measure immediately.
 * Positions are measured within the pill, so scrolling or route changes never
 * move it: it slides only when `active` changes or the options resize (a
 * language switch changes label widths).
 */
export function usePill<T extends HTMLElement>(active: unknown) {
  const [pill, setPill] = useState<T | null>(null);
  const [box, setBox] = useState<PillBox | null>(null);

  const ref = useCallback((el: T | null) => {
    setPill(el);
    if (!el) setBox(null);
  }, []);

  useLayoutEffect(() => {
    if (!pill) return;
    const measure = () => {
      const on = pill.querySelector<HTMLElement>("[data-pill-active='true']");
      const next: PillBox | null =
        on && (on.offsetWidth > 0 || on.offsetHeight > 0)
          ? { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight }
          : null;
      setBox((prev) => {
        if (prev === next) return prev;
        if (prev && next && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h) {
          return prev;
        }
        return next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pill);
    for (const child of pill.children) {
      if (!child.hasAttribute("data-pill-indicator")) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [pill, active]);

  return { ref, box };
}

/** The highlight behind the selected option. It mounts in place (a new
 * element doesn't transition), then slides. No slide under prefers-reduced-motion.
 * `rounded` is separate because cn() doesn't merge Tailwind classes. */
export function PillIndicator({
  box,
  className,
  rounded = "rounded-full",
  children,
}: {
  box: PillBox | null;
  className?: string;
  rounded?: string;
  children?: React.ReactNode;
}) {
  if (!box) return null;
  return (
    <span
      aria-hidden="true"
      data-pill-indicator=""
      style={{ width: box.w, height: box.h, transform: `translate(${box.x}px, ${box.y}px)` }}
      className={cn(
        "pointer-events-none absolute left-0 top-0",
        rounded,
        "transition-[transform,width,height] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        className,
      )}
    >
      {children}
    </span>
  );
}
