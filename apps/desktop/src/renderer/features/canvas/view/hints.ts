/**
 * The toolbar's hint cards: one small scene per tool, drawn by the canvas's own renderer (so it matches the board
 * in both themes and needs no image files). Pure data, no React.
 */
import { inkFromStroke } from '../../../lib/canvas/ink';
import { buildTemplate, type TemplateText } from '../../../lib/canvas/templates';
import type { ObjectInit } from '../../../lib/canvas/types';

export const HINT_IDS = ['select', 'sticky', 'text', 'shape', 'connector', 'frame', 'pen', 'comment', 'sticker', 'templates', 'vote', 'timer'] as const;
export type HintId = (typeof HINT_IDS)[number];

export type HintArtKey = 'idea' | 'task' | 'note' | 'title' | 'body' | 'start' | 'finish' | 'comment' | 'frame';
export type HintText = (key: HintArtKey) => string;

type Item = { id: string; init: ObjectInit };

const sticky = (id: string, x: number, y: number, color: string, text: string, w = 160): Item => ({
  id, init: { kind: 'sticky', x, y, w, h: w, color, text },
});

/** A stroke through the points `f(t)`, t in [0, 1] (`n` samples), as the pen would store it. */
function stroke(id: string, f: (t: number) => [number, number], n: number, color: string, width: number, marker = false): Item {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) pts.push(...f(i / n));
  const ink = inkFromStroke(pts, 0.5) ?? { x: 0, y: 0, w: 1, h: 1, points: [0, 0, 0, 0] };
  return { id, init: { kind: 'ink', ...ink, stroke: color, strokeWidth: width, ...(marker ? { marker: true } : {}) } };
}

/** The objects of a tool's scene, world units. `tpl` translates the template's own keys (the templates card). */
export function hintScene(id: HintId, tr: HintText, tpl: TemplateText): Item[] {
  switch (id) {
    case 'select':
      return [
        sticky('a', 0, 0, 'yellow', tr('idea')),
        sticky('b', 200, 40, 'sky', tr('task')),
        // The selection frame the live view draws as an overlay, here as an outline.
        { id: 'f', init: { kind: 'shape', shape: 'rect', x: -10, y: -10, w: 180, h: 180, fill: 'none', stroke: 'blue', strokeWidth: 3 } },
      ];
    case 'sticky':
      return [sticky('a', 0, 0, 'yellow', tr('idea')), sticky('b', 190, 0, 'pink', tr('task')), sticky('c', 380, 0, 'sky', tr('note'))];
    case 'text':
      return [
        { id: 'a', init: { kind: 'text', x: 0, y: 0, w: 420, size: 44, text: tr('title') } },
        { id: 'b', init: { kind: 'text', x: 0, y: 70, w: 420, size: 22, color: 'gray', text: tr('body') } },
      ];
    case 'shape':
      return [
        { id: 'a', init: { kind: 'shape', shape: 'rounded', x: 0, y: 20, w: 150, h: 100, fill: 'soft:blue', stroke: 'blue' } },
        { id: 'b', init: { kind: 'shape', shape: 'ellipse', x: 180, y: 10, w: 120, h: 120, fill: 'soft:green', stroke: 'green' } },
        { id: 'c', init: { kind: 'shape', shape: 'diamond', x: 330, y: 10, w: 130, h: 120, fill: 'soft:orange', stroke: 'orange' } },
      ];
    case 'connector':
      return [
        { id: 'a', init: { kind: 'shape', shape: 'rounded', x: 0, y: 0, w: 150, h: 80, fill: 'soft:green', stroke: 'green', text: tr('start') } },
        { id: 'b', init: { kind: 'shape', shape: 'rounded', x: 320, y: 90, w: 150, h: 80, fill: 'soft:blue', stroke: 'blue', text: tr('finish') } },
        { id: 'w', init: { kind: 'connector', from: { id: 'a', side: 'right' }, to: { id: 'b', side: 'left' }, route: 'curve', arrow: 'end', stroke: 'stroke', strokeWidth: 3 } },
      ];
    case 'frame':
      // A titled board holding a row of notes (what the owner's Miro example looked like).
      return [
        { id: 'f', init: { kind: 'frame', x: 0, y: 0, w: 470, h: 170, fill: 'blue', title: tr('frame') } },
        sticky('a', 20, 20, 'yellow', tr('idea'), 130),
        sticky('b', 170, 20, 'pink', tr('task'), 130),
        sticky('c', 320, 20, 'mint', tr('note'), 130),
      ];
    case 'pen':
      return [
        // A word underlined with the marker, a loop around it with the pen, a wave below.
        stroke('m', (t) => [10 + 170 * t, 66 + 3 * Math.sin(t * 3)], 12, 'yellow', 22, true),
        { id: 't', init: { kind: 'text', x: 14, y: 20, w: 200, size: 40, text: tr('idea') } },
        stroke('o', (t) => [100 + 125 * Math.cos(-2.6 + t * 6.6), 48 + 62 * Math.sin(-2.6 + t * 6.6)], 48, 'blue', 4),
        stroke('w', (t) => [-10 + 420 * t, 150 + 14 * Math.sin(t * Math.PI * 5)], 60, 'red', 5),
      ];
    case 'comment':
      return [
        sticky('a', 0, 20, 'yellow', tr('idea')),
        { id: 'b', init: { kind: 'shape', shape: 'bubble', x: 190, y: 0, w: 250, h: 110, fill: 'white', stroke: 'gray', text: tr('comment') } },
      ];
    case 'sticker':
      return [{ id: 'a', init: { kind: 'text', x: 0, y: 0, w: 400, size: 72, text: '👍 🎉 ❤️ 🚀' } }];
    case 'templates': {
      let n = 0;
      return buildTemplate('kanban', { x: 0, y: 0 }, tpl, () => `k${n++}`);
    }
    case 'vote':
      return [
        sticky('a', 0, 0, 'yellow', tr('idea')),
        sticky('b', 190, 0, 'sky', tr('task')),
        { id: 'v1', init: { kind: 'shape', shape: 'ellipse', x: 120, y: -16, w: 52, h: 52, fill: 'blue', stroke: 'blue', text: '3' } },
        { id: 'v2', init: { kind: 'shape', shape: 'ellipse', x: 310, y: -16, w: 52, h: 52, fill: 'blue', stroke: 'blue', text: '1' } },
      ];
    case 'timer':
      return [
        { id: 'a', init: { kind: 'shape', shape: 'rounded', x: 0, y: 0, w: 300, h: 120, fill: 'soft:blue', stroke: 'none', strokeWidth: 0, fontPx: 64, text: '05:00' } },
      ];
  }
}
