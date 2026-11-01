// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LabelsOverflow, type LabelItem } from './LabelsOverflow';

vi.mock('../../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));

// Mocked layout: a pill is 6 px per letter + 22, the group probe 40, the tail 28, the row is `rowWidth`.
let rowWidth = 300;
const observers: Array<() => void> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    private readonly seen = new Set<Element>();
    constructor(private readonly cb: (entries: Array<{ target: Element }>) => void) {
      observers.push(() => this.cb([...this.seen].map((target) => ({ target }))));
    }
    observe(el: Element): void {
      this.seen.add(el);
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    let width = 0;
    if (el.getAttribute('role') === 'group') width = rowWidth;
    else if (el.dataset['loPill'] !== undefined) width = el.textContent.length * 6 + 22;
    else if (el.dataset['loProbe'] !== undefined) width = 40;
    else if (el.dataset['loTail'] !== undefined) width = 28;
    return { width, height: 20, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20, toJSON: () => ({}) } satisfies Partial<DOMRect>;
  };
});

let root: Root;
let host: HTMLElement;

const names = ['Bug', 'Design', 'Feature', 'Backend', 'Docs', 'Mobile', 'Urgent'];
const labels = (n: number): LabelItem[] => names.slice(0, n).map((name, i) => ({ id: `l${i}`, name, color: 0xff0000 + i }));
const show = (items: LabelItem[], extra: Record<string, unknown> = {}): void => {
  act(() => {
    root.render(createElement(LabelsOverflow, { labels: items, ...extra }));
  });
};
const shown = (): string[] => [...host.querySelectorAll('[data-lo-pill]:not([inert])')].map((e) => e.textContent);
const group = (): HTMLElement | null => host.querySelector('[data-testid="labels-more"]');

beforeEach(() => {
  rowWidth = 300;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

describe('LabelsOverflow', () => {
  it('shows every label and no group when they fit', () => {
    show(labels(3)); // 40 + 52 + 58 + gaps = 158 < 300
    expect(shown()).toEqual(['Bug', 'Design', 'Feature']);
    expect(group()).toBeNull();
  });

  it('fits two rows before collapsing', () => {
    show(labels(5)); // 40 52 58 58 46: row 1 = 40+52+58+58 + 3 gaps = 220 (+46 no), row 2 = 46
    expect(shown()).toHaveLength(5);
    expect(group()).toBeNull();
  });

  it('collapses the rest into «+N» with the group reserved, and never needs a third row', () => {
    rowWidth = 130; // 40+52 = 96 | 58+58 = 120 ... the group (40) needs room on row 2
    show(labels(7));
    const visible = shown();
    expect(visible.length).toBeLessThan(7);
    expect(group()?.getAttribute('aria-label')).toContain(String(7 - visible.length));
    expect(group()?.textContent).toBe(`+${7 - visible.length}`);
    // Rows by the same flow as the browser: all visible pills + the group fit in two rows.
    const w = [...visible.map((s) => s.length * 6 + 22), 40];
    let row = 1;
    let used = 0;
    for (const x of w) {
      if (used === 0) used = x;
      else if (used + 4 + x <= rowWidth) used += 4 + x;
      else {
        row++;
        used = x;
      }
    }
    expect(row).toBeLessThanOrEqual(2);
  });

  it('keeps the hidden pills out of the tab order and the accessibility tree', () => {
    rowWidth = 130;
    show(labels(7));
    const off = [...host.querySelectorAll('[data-lo-pill][inert]')];
    expect(off.length).toBe(7 - shown().length);
    expect(off.every((e) => e.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('recomputes when the width changes', () => {
    rowWidth = 130;
    show(labels(7));
    const narrow = shown().length;
    rowWidth = 600;
    act(() => observers.forEach((cb) => cb()));
    expect(shown().length).toBe(7);
    expect(group()).toBeNull();
    rowWidth = 130;
    act(() => observers.forEach((cb) => cb()));
    expect(shown().length).toBe(narrow);
  });

  it('recomputes when the labels change', () => {
    rowWidth = 130;
    show(labels(7));
    show(labels(2));
    expect(shown()).toEqual(['Bug', 'Design']);
    expect(group()).toBeNull();
  });

  it('opens the hidden labels on click, closes with Escape, and the click does not reach the parent', () => {
    rowWidth = 130;
    const parent = vi.fn();
    document.body.addEventListener('click', parent);
    show(labels(7));
    const hiddenCount = 7 - shown().length;
    act(() => group()?.click());
    const list = document.querySelector('[data-testid="labels-more-list"]');
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll('[data-testid="label-pill"]')).toHaveLength(hiddenCount);
    expect(group()?.getAttribute('aria-expanded')).toBe('true');
    expect(parent).not.toHaveBeenCalled();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-testid="labels-more-list"]')).toBeNull();
  });

  it('reserves the trailing control in the fit', () => {
    rowWidth = 130;
    show(labels(3), { trailing: createElement('button', null, '+') });
    // 40 + 52 + gap = 96 | 58 + tail 28 + gap = 90: fits in two rows.
    expect(shown()).toHaveLength(3);
    rowWidth = 80;
    act(() => observers.forEach((cb) => cb()));
    expect(shown().length).toBeLessThan(3);
  });
});
