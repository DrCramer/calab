import { describe, expect, it } from 'vitest';
import { blockBox } from './gridParts';

describe('blockBox (day / week block placement)', () => {
  it('the day view: equal side-by-side columns', () => {
    expect(blockBox(600, 60, 1, 2)).toMatchObject({ left: 'calc(50% + 2px)', width: 'calc(50% - 4px)', top: 481, height: 46 });
  });

  it('the week view: never narrower than minPx, a cluster cascades across the column', () => {
    const b = blockBox(600, 60, 1, 2, 64);
    expect(b.width).toBe('calc(max(50%, 64px) - 4px)');
    expect(b.left).toBe('calc(min(50%, (100% - max(50%, 64px)) * 1) + 2px)');
    // the first block of a cluster stays at the left edge
    expect(blockBox(600, 60, 0, 3, 64).left).toBe('calc(min(0%, (100% - max(33.333333333333336%, 64px)) * 0) + 2px)');
  });

  it('a lone block in the week view takes the whole column', () => {
    expect(blockBox(600, 60, 0, 1, 64)).toMatchObject({ left: 'calc(0% + 2px)', width: 'calc(100% - 4px)' });
  });
});
