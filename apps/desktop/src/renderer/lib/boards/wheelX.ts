/**
 * Scrollbars are never drawn (docs/08), so on a mouse without a horizontal wheel (Windows laptops)
 * a wide board has no way to reach its last column. A plain vertical wheel turn over `root` that no
 * vertically scrollable ancestor (a column's card list) can still use scrolls `root` sideways.
 * Returns the delta to add to `root.scrollLeft`, or 0 to leave the event alone.
 */
export function wheelToScrollX(e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'shiftKey' | 'ctrlKey' | 'target'>, root: HTMLElement): number {
  if (e.ctrlKey || e.shiftKey || e.deltaY === 0 || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return 0;
  if (root.scrollWidth <= root.clientWidth) return 0;
  const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * root.clientWidth : e.deltaY;
  for (let n = e.target instanceof Element ? e.target : null; n && n !== root; n = n.parentElement) {
    if (n.scrollHeight <= n.clientHeight) continue;
    const oy = getComputedStyle(n).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    if (dy < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return 0;
  }
  const max = root.scrollWidth - root.clientWidth;
  if (dy < 0 ? root.scrollLeft <= 0 : root.scrollLeft >= max - 1) return 0;
  return dy;
}
