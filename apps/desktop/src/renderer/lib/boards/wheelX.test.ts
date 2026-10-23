// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { wheelToScrollX } from './wheelX';

function box(el: HTMLElement, o: Record<string, number>): void {
  for (const [k, v] of Object.entries(o)) Object.defineProperty(el, k, { value: v, configurable: true, writable: true });
}
function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(id);
  return el;
}
function setup(): { root: HTMLElement; list: HTMLElement; card: HTMLElement } {
  document.body.innerHTML = '<div id="r"><div id="l" style="overflow-y:auto"><div id="c"></div></div></div>';
  const root = byId('r');
  const list = byId('l');
  box(root, { scrollWidth: 2000, clientWidth: 800, scrollLeft: 100 });
  box(list, { scrollHeight: 900, clientHeight: 500, scrollTop: 0 });
  return { root, list, card: byId('c') };
}
const ev = (target: Element, deltaY: number, extra: Partial<WheelEvent> = {}) => ({ deltaX: 0, deltaY, deltaMode: 0, shiftKey: false, ctrlKey: false, target, ...extra });

describe('wheelToScrollX', () => {
  it('leaves the wheel to a column list that can still scroll', () => {
    const { root, card } = setup();
    expect(wheelToScrollX(ev(card, 100), root)).toBe(0);
  });
  it('scrolls sideways over the gap and past the list end', () => {
    const { root, list, card } = setup();
    expect(wheelToScrollX(ev(root, 100), root)).toBe(100);
    box(list, { scrollTop: 400 });
    expect(wheelToScrollX(ev(card, 100), root)).toBe(100);
    expect(wheelToScrollX(ev(card, -100), root)).toBe(0);
  });
  it('ignores horizontal, ctrl and shift wheels and a board that fits', () => {
    const { root } = setup();
    expect(wheelToScrollX(ev(root, 10, { deltaX: 50 }), root)).toBe(0);
    expect(wheelToScrollX(ev(root, 100, { ctrlKey: true }), root)).toBe(0);
    expect(wheelToScrollX(ev(root, 100, { shiftKey: true }), root)).toBe(0);
    box(root, { scrollWidth: 800 });
    expect(wheelToScrollX(ev(root, 100), root)).toBe(0);
  });
  it('stops at the ends', () => {
    const { root } = setup();
    box(root, { scrollLeft: 1200 });
    expect(wheelToScrollX(ev(root, 100), root)).toBe(0);
    box(root, { scrollLeft: 0 });
    expect(wheelToScrollX(ev(root, -100), root)).toBe(0);
  });
});
