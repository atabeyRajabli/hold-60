// Where the coach bubble goes: next to its target, never on top of anything in `avoid` (the chart legend).
// Pure geometry (rects are {left, top, right, bottom, width}), so it is unit-tested in Node.

const hits = (a, b, m = 6) => a.left < b.right + m && a.right > b.left - m && a.top < b.bottom + m && a.bottom > b.top - m;

/**
 * @param {{target: object, size: {w: number, h: number}, viewport: {w: number, h: number}, avoid?: object[], floor?: number, pad?: number, gap?: number}} o
 * @returns {{top: number, left: number, side: 'below'|'above'|'none'}} `none` = no good spot beside the target, so the
 *   bubble sits clear of the avoided rects and its arrow is hidden.
 */
export function placeCoachBox({ target, size, viewport, avoid = [], floor = 0, pad = 12, gap = 10 }) {
  const { w, h } = size;
  const left = Math.min(viewport.w - w - pad, Math.max(pad, target.left + target.width / 2 - w / 2));
  const box = (top, side) => ({ top, left, side, rect: { left, top, right: left + w, bottom: top + h } });
  const clear = (c) => !avoid.some((a) => hits(c.rect, a));

  const belowTop = Math.max(target.bottom + gap, floor);
  const aboveTop = target.top - h - gap;
  const fitsBelow = target.bottom + h + 14 < viewport.h;
  const fitsAbove = aboveTop >= pad;
  // the original rule: below when it fits, otherwise above (clamped to the top edge)
  const first = fitsBelow ? box(belowTop, 'below') : box(Math.max(pad, aboveTop), 'above');
  const order = [first];
  if (fitsBelow && fitsAbove) order.push(box(aboveTop, 'above'));
  if (!fitsBelow) order.push(box(belowTop, 'below'));
  for (const c of order) if (clear(c) && c.rect.bottom <= viewport.h - pad) return { top: c.top, left: c.left, side: c.side };

  // no clear side: tuck under the avoided rects, or above them, with the arrow hidden
  if (avoid.length) {
    const under = box(Math.max(...avoid.map((a) => a.bottom)) + gap, 'none');
    if (under.rect.bottom <= viewport.h - pad) return { top: under.top, left: under.left, side: 'none' };
    const over = box(Math.min(...avoid.map((a) => a.top)) - h - gap, 'none');
    if (over.top >= pad) return { top: over.top, left: over.left, side: 'none' };
  }
  return { top: first.top, left: first.left, side: first.side };
}
