import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface VirtualWindowInput {
  count: number;
  scrollTop: number;
  viewportHeight: number;
  heights: ReadonlyArray<number>;
  defaultHeight: number;
  overscan: number;
  gap: number;
}

export interface VirtualWindowResult {
  startIndex: number;
  endIndex: number;
  topSpacer: number;
  bottomSpacer: number;
  totalHeight: number;
  offsets: number[];
}

/**
 * Computes the visible slice and top/bottom spacer heights for a variable-height
 * list with uniform vertical flex gap.
 */
export function computeVirtualWindow({
  count,
  scrollTop,
  viewportHeight,
  heights,
  defaultHeight,
  overscan,
  gap,
}: VirtualWindowInput): VirtualWindowResult {
  if (count <= 0) {
    return { startIndex: 0, endIndex: 0, topSpacer: 0, bottomSpacer: 0, totalHeight: 0, offsets: [] };
  }

  const offsets = new Array<number>(count);
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    offsets[i] = cursor;
    const h = heights[i] > 0 ? heights[i] : defaultHeight;
    cursor += h + (i < count - 1 ? gap : 0);
  }
  const totalHeight = cursor;

  const viewTop = Math.max(0, scrollTop);
  const viewBottom = viewTop + Math.max(viewportHeight, defaultHeight);

  // Binary search first item whose bottom edge > viewTop
  let lo = 0;
  let hi = count - 1;
  let firstVisible = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const itemH = heights[mid] > 0 ? heights[mid] : defaultHeight;
    if (offsets[mid] + itemH >= viewTop) {
      firstVisible = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  // Binary search last item whose top edge <= viewBottom
  lo = firstVisible;
  hi = count - 1;
  let lastVisible = firstVisible;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= viewBottom) {
      lastVisible = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(count, lastVisible + 1 + overscan);

  const topSpacer = startIndex > 0 ? offsets[startIndex] : 0;
  let bottomSpacer = 0;
  if (endIndex < count) {
    const lastRendered = endIndex - 1;
    const lastH = heights[lastRendered] > 0 ? heights[lastRendered] : defaultHeight;
    const renderedBottom = offsets[lastRendered] + lastH + gap;
    bottomSpacer = Math.max(0, totalHeight - renderedBottom);
  }

  return { startIndex, endIndex, topSpacer, bottomSpacer, totalHeight, offsets };
}

export interface UseSidebarVirtualWindowOptions {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  itemKeys: ReadonlyArray<string>;
  enabled: boolean;
  defaultHeight?: number;
  gap?: number;
  overscan?: number;
}

/**
 * Lightweight ResizeObserver-measured virtual window for large source sidebars (>40 cards).
 */
export function useSidebarVirtualWindow({
  scrollRef,
  itemKeys,
  enabled,
  defaultHeight = 230,
  gap = 10,
  overscan = 8,
}: UseSidebarVirtualWindowOptions) {
  const heightCacheRef = useRef<Map<string, number>>(new Map());
  const observersRef = useRef<Map<string, ResizeObserver>>(new Map());
  const [measureVersion, setMeasureVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);

  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;

    let rafId = 0;
    const syncViewport = () => {
      setViewportHeight((prev) => (el.clientHeight > 0 && prev !== el.clientHeight ? el.clientHeight : prev));
    };
    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        setScrollTop(el.scrollTop);
      });
    };

    syncViewport();
    setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });

    let containerObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      containerObserver = new ResizeObserver(() => syncViewport());
      containerObserver.observe(el);
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      el.removeEventListener("scroll", onScroll);
      containerObserver?.disconnect();
    };
  }, [enabled, scrollRef]);

  useEffect(() => {
    return () => {
      for (const observer of observersRef.current.values()) {
        observer.disconnect();
      }
      observersRef.current.clear();
    };
  }, []);

  const measureItem = useCallback((key: string, el: HTMLElement | null) => {
    const prevObserver = observersRef.current.get(key);
    if (prevObserver) {
      prevObserver.disconnect();
      observersRef.current.delete(key);
    }
    if (!el || typeof ResizeObserver === "undefined") return;

    const recordHeight = (nextHeight: number) => {
      const rounded = Math.round(nextHeight);
      if (rounded <= 0) return;
      const existing = heightCacheRef.current.get(key);
      if (existing === undefined || Math.abs(existing - rounded) >= 2) {
        heightCacheRef.current.set(key, rounded);
        setMeasureVersion((v) => v + 1);
      }
    };

    recordHeight(el.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        recordHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    observersRef.current.set(key, observer);
  }, []);

  const heights = useMemo(() => {
    void measureVersion;
    return itemKeys.map((k) => heightCacheRef.current.get(k) ?? defaultHeight);
  }, [itemKeys, defaultHeight, measureVersion]);

  const windowResult = useMemo(() => {
    if (!enabled) {
      return {
        startIndex: 0,
        endIndex: itemKeys.length,
        topSpacer: 0,
        bottomSpacer: 0,
        totalHeight: 0,
        offsets: [] as number[],
      };
    }
    return computeVirtualWindow({
      count: itemKeys.length,
      scrollTop,
      viewportHeight,
      heights,
      defaultHeight,
      overscan,
      gap,
    });
  }, [enabled, itemKeys.length, scrollTop, viewportHeight, heights, defaultHeight, overscan, gap]);

  const scrollToIndex = useCallback(
    (index: number) => {
      if (!enabled || index < 0 || index >= itemKeys.length) return;
      const container = scrollRef.current;
      if (!container) return;
      const offset = windowResult.offsets[index] ?? index * (defaultHeight + gap);
      const itemH = heights[index] ?? defaultHeight;
      const currentTop = container.scrollTop;
      const currentBottom = currentTop + (container.clientHeight || viewportHeight);
      if (offset >= currentTop && offset + itemH <= currentBottom) return;
      const targetTop = Math.max(0, offset - Math.round((container.clientHeight || viewportHeight) * 0.25));
      container.scrollTo({ top: targetTop, behavior: "smooth" });
      setScrollTop(targetTop);
    },
    [enabled, itemKeys.length, scrollRef, windowResult.offsets, defaultHeight, gap, heights, viewportHeight],
  );

  return {
    startIndex: windowResult.startIndex,
    endIndex: windowResult.endIndex,
    topSpacer: windowResult.topSpacer,
    bottomSpacer: windowResult.bottomSpacer,
    measureItem,
    scrollToIndex,
  };
}
