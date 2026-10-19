// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installPopoverScroll } from './popoverScroll';

/** Which events reach a document listener (where react-remove-scroll's lock sits). */
function setup(html: string): { seen: string[]; fire: (sel: string, type: 'wheel' | 'touchmove') => void; done: () => void } {
  document.body.innerHTML = html;
  const uninstall = installPopoverScroll(document);
  const seen: string[] = [];
  const onDoc = (e: Event): void => {
    seen.push(`${e.type}:${(e.target as Element).id}`);
  };
  document.addEventListener('wheel', onDoc);
  document.addEventListener('touchmove', onDoc);
  return {
    seen,
    fire: (sel, type) => document.querySelector(sel)?.dispatchEvent(new Event(type, { bubbles: true })),
    done: () => {
      uninstall();
      document.removeEventListener('wheel', onDoc);
      document.removeEventListener('touchmove', onDoc);
    },
  };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = '';
});

describe('installPopoverScroll', () => {
  it('wheel inside a dialog or a popover never reaches the scroll lock; outside it does', () => {
    const s = setup('<div id="app"></div><div role="dialog"><div id="row">x</div></div><div data-radix-popper-content-wrapper><div id="item">y</div></div>');
    cleanup = s.done;
    s.fire('#row', 'wheel');
    s.fire('#item', 'wheel');
    s.fire('#app', 'wheel');
    expect(s.seen).toEqual(['wheel:app']);
  });

  it('touch inside a dialog stays with the lock (phones), popovers are still exempt', () => {
    const s = setup('<div role="dialog"><div id="row">x</div></div><div data-scroll-shard><div id="item">y</div></div>');
    cleanup = s.done;
    s.fire('#row', 'touchmove');
    s.fire('#item', 'touchmove');
    expect(s.seen).toEqual(['touchmove:row']);
  });
});
