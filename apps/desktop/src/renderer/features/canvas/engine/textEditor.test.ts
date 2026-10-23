// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextEditor, type EditSpec } from './textEditor';

const spec = (over: Partial<EditSpec> = {}): EditSpec => ({
  box: { x: 100, y: 50, w: 200, h: 100 }, text: 'start', size: 20, color: '#111', align: 'left', vcenter: false, autoHeight: false, fontFamily: 'sans-serif', ...over,
});

function setup(cam = { tx: 10, ty: 20, scale: 2 }) {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const state = { cam };
  const ed = new TextEditor({ host, canvas, getCamera: () => state.cam });
  return { host, canvas, ed, state };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('TextEditor', () => {
  it('opens a real textarea positioned by the camera, focused with the caret at the end', () => {
    const { ed, host } = setup();
    ed.open(spec(), vi.fn());
    const ta = host.querySelector('textarea');
    expect(ta).not.toBeNull();
    expect(ed.isOpen).toBe(true);
    expect(ta?.style.left).toBe('210px'); // 100 * 2 + 10
    expect(ta?.style.top).toBe('120px'); // 50 * 2 + 20
    // Laid out at world size, scaled by the camera (wraps like the canvas at any zoom).
    expect(ta?.style.width).toBe('200px');
    expect(ta?.style.fontSize).toBe('20px');
    expect(ta?.style.transform).toBe('scale(2)');
    expect(document.activeElement).toBe(ta);
    expect(ta?.selectionStart).toBe(5);
  });
  it('takes its accessible name from the option, read at every open', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    let name = 'Текст на холсте';
    const ed = new TextEditor({ host, canvas: document.createElement('canvas'), getCamera: () => ({ tx: 0, ty: 0, scale: 1 }), label: () => name });
    ed.open(spec(), vi.fn());
    expect(host.querySelector('textarea')?.getAttribute('aria-label')).toBe('Текст на холсте');
    ed.commit();
    name = 'Canvas text';
    ed.open(spec(), vi.fn());
    expect(host.querySelector('textarea')?.getAttribute('aria-label')).toBe('Canvas text');
  });
  it('follows the camera', () => {
    const { ed, host, state } = setup();
    ed.open(spec(), vi.fn());
    state.cam = { tx: 0, ty: 0, scale: 1 };
    ed.reposition();
    const ta = host.querySelector('textarea');
    expect(ta?.style.left).toBe('100px');
    expect(ta?.style.fontSize).toBe('20px');
  });
  it('reports the text once on commit, and whether it changed', () => {
    const { ed, host } = setup();
    const done = vi.fn();
    ed.open(spec(), done);
    const ta = host.querySelector('textarea');
    if (!ta) throw new Error('no textarea');
    ta.value = 'new text';
    ta.dispatchEvent(new Event('input'));
    ed.commit();
    ed.commit();
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith('new text', true, undefined, false);
    expect(host.querySelector('textarea')).toBeNull();
    expect(ed.isOpen).toBe(false);
  });
  it('commits unchanged text with changed = false', () => {
    const { ed } = setup();
    const done = vi.fn();
    ed.open(spec(), done);
    ed.commit();
    expect(done).toHaveBeenCalledWith('start', false, undefined, false);
  });
  it('commits on Escape, ⌘/Ctrl+Enter and blur; plain Enter inserts a newline', () => {
    for (const make of [
      (ta: HTMLTextAreaElement) => ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      (ta: HTMLTextAreaElement) => ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true })),
      (ta: HTMLTextAreaElement) => ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true })),
      (ta: HTMLTextAreaElement) => ta.dispatchEvent(new FocusEvent('blur')),
    ]) {
      const { ed, host } = setup();
      const done = vi.fn();
      ed.open(spec(), done);
      const ta = host.querySelector('textarea');
      if (!ta) throw new Error('no textarea');
      make(ta);
      expect(done).toHaveBeenCalledTimes(1);
    }
    const { ed, host } = setup();
    const done = vi.fn();
    ed.open(spec(), done);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    host.querySelector('textarea')?.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(done).not.toHaveBeenCalled();
  });
  it('does not end the edit in the middle of IME composition', () => {
    const { ed, host } = setup();
    const done = vi.fn();
    ed.open(spec(), done);
    const ta = host.querySelector('textarea');
    ta?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }));
    ta?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, isComposing: true }));
    expect(done).not.toHaveBeenCalled();
  });
  it('opening a second editor commits the first', () => {
    const { ed } = setup();
    const first = vi.fn();
    ed.open(spec({ text: 'a' }), first);
    ed.open(spec({ text: 'b' }), vi.fn());
    expect(first).toHaveBeenCalledWith('a', false, undefined, false);
  });
  it('cancel closes without reporting', () => {
    const { ed, host } = setup();
    const done = vi.fn();
    ed.open(spec(), done);
    ed.cancel();
    expect(done).not.toHaveBeenCalled();
    expect(host.querySelector('textarea')).toBeNull();
  });
  it('limits the length to 5000 characters', () => {
    const { ed, host } = setup();
    ed.open(spec(), vi.fn());
    expect(host.querySelector('textarea')?.maxLength).toBe(5000);
  });
});
