// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, BarContext } from '../ui';
import * as Dropdown from './dropdown-menu';
import * as Popover from './popover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

const BAR_H = 'h-(--control-h-bar)';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(content: (inner: ReactNode) => ReactNode): void {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      createElement(
        BarContext.Provider,
        { value: true },
        createElement(Button, { id: 'in-bar' }, 'x'),
        content(createElement(Button, { id: 'in-menu' }, 'y')),
      ),
    );
  });
}

describe('BarContext does not leak into portalled surfaces', () => {
  it('a Button in a dropdown opened from a bar keeps its normal size', () => {
    mount((inner) =>
      createElement(
        Dropdown.Root,
        { open: true },
        createElement(Dropdown.Trigger, null, 'open'),
        createElement(Dropdown.Portal, null, createElement(Dropdown.Content, null, inner)),
      ),
    );
    expect(document.querySelector('#in-bar')?.className).toContain(BAR_H);
    expect(document.querySelector('#in-menu')?.className).not.toContain(BAR_H);
  });

  it('same for a popover', () => {
    mount((inner) =>
      createElement(
        Popover.Root,
        { open: true },
        createElement(Popover.Trigger, null, 'open'),
        createElement(Popover.Portal, null, createElement(Popover.Content, null, inner)),
      ),
    );
    expect(document.querySelector('#in-menu')?.className).not.toContain(BAR_H);
  });
});
