import { useLayoutEffect, useRef, useState } from "react";
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
 * the pill. Positions are measured within the pill, so scrolling or route
 * changes never move it: it slides only when `active` changes or the options
 * resize (a language switch changes label widths).
 */
export function usePill<T extends HTMLElement>(active: unknown) {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<PillBox | null>(null);

  useLayoutEffect(() => {
    const pill = ref.current;
    if (!pill) return;
    const measure = () => {
      const on = pill.querySelector<HTMLElement>("[data-pill-active='true']");
      setBox(on ? { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pill);
    for (const child of pill.children) observer.observe(child);
    return () => observer.disconnect();
  }, [active]);

  return { ref, box };
}

/** The highlight behind the selected option. It mounts in place (a new
 * element doesn't transition), then slides. No slide under prefers-reduced-motion.
 * `rounded` is separate because cn() doesn't merge Tailwind classes. */
export function PillIndicator({
  box,
  className,
  rounded = "rounded-full",
}: {
  box: PillBox | null;
  className: string;
  rounded?: string;
}) {
  if (!box) return null;
  return (
    <span
      aria-hidden="true"
      style={{ width: box.w, height: box.h, transform: `translate(${box.x}px, ${box.y}px)` }}
      className={cn(
        "pointer-events-none absolute left-0 top-0",
        rounded,
        "transition-[transform,width,height] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        className,
      )}
    />
  );
}
