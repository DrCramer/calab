import { describe, expect, it } from 'vitest';
import { HINT_IDS, hintScene } from './hints';

const tr = (key: string) => key;
const tpl = (key: string) => key;

describe('hintScene', () => {
  it.each(HINT_IDS)('the %s card is a non-empty scene with unique object ids', (id) => {
    const items = hintScene(id, tr, tpl);
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('the pen card draws a stroke, not a shape', () => {
    expect(hintScene('pen', tr, tpl).some((i) => i.init.kind === 'ink')).toBe(true);
  });
});
