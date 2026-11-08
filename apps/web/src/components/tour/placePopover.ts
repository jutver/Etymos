export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const MARGIN = 16;
const GAP = 14;

/**
 * Where the tour's card goes beside the spotlit box: below it if it fits,
 * else above, right, left, and failing all of those over the box's lower
 * edge. Always kept inside the viewport. No box = centred.
 */
export function placePopover(
  box: Box | null,
  pop: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const { width: w, height: h } = pop;
  const { width: vw, height: vh } = viewport;
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, vw - w - MARGIN));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(y, vh - h - MARGIN));

  if (!box) return { top: clampY((vh - h) / 2), left: clampX((vw - w) / 2) };

  const bottom = box.top + box.height;
  const right = box.left + box.width;
  const centreX = clampX(box.left + box.width / 2 - w / 2);
  const centreY = clampY(box.top + box.height / 2 - h / 2);

  if (bottom + GAP + h <= vh - MARGIN) return { top: bottom + GAP, left: centreX };
  if (box.top - GAP - h >= MARGIN) return { top: box.top - GAP - h, left: centreX };
  if (right + GAP + w <= vw - MARGIN) return { top: centreY, left: right + GAP };
  if (box.left - GAP - w >= MARGIN) return { top: centreY, left: box.left - GAP - w };
  return { top: clampY(bottom - h - MARGIN), left: centreX };
}
