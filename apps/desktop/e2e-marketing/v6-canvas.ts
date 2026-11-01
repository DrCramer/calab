import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { CanvasItemKind } from '@calaba/protocol';
import * as Y from 'yjs';
import { IDS } from '../e2e-support/mock-server';
import type { MockServer } from '../e2e-support/mock-server';
import type { Copy4 } from './copy4';
import { msk } from './seed';

const U = IDS.users;
const R = IDS.rooms;

/**
 * The retro canvas of the story (landing v6): three columns of stickies (green / pink / blue), two shapes,
 * three arrows, a finished vote (totals on the stickies, the leader outlined) and a paused 04:32 timer
 * (a running one counts from the server clock, which the frozen page clock cannot follow). Returns its id.
 */
export function seedStoryCanvas(mock: MockServer, c4: Copy4, phone = false): string {
  const k = c4.canvas;
  const ws = IDS.workspaces.main;
  mock.canvas.items.clear();
  mock.canvas.perms.clear();
  const folder = mock.canvas.put({ workspaceId: ws, name: k.folder, kind: CanvasItemKind.FOLDER, ownerId: U.anna, updatedAt: timestampFromMs(msk('09:00')) });
  const colors = ['green', 'pink', 'blue'] as const;
  const item = mock.canvas.put({ workspaceId: ws, parentId: folder.id, name: k.name, ownerId: U.anna, createdAt: timestampFromMs(msk('10:30', '2026-01-14')), updatedAt: timestampFromMs(msk('13:05')), updatedBy: U.dina }, (d) => {
    const ids: string[] = [];
    k.cols.forEach((text, col) => d.create({ kind: 'text', x: col * 200, y: -56, w: 200, size: 18, text }));
    k.stickies.forEach((text, i) => {
      const col = Math.floor(i / 3);
      const row = i % 3;
      ids.push(d.create({ kind: 'sticky', x: col * 200, y: row * 190, color: colors[col] ?? 'yellow', text, fontPx: 16 }) ?? '');
    });
    const summary = phone ? null : d.create({ kind: 'shape', shape: 'rounded', x: 640, y: 30, w: 180, h: 100, fill: 'none', stroke: 'stroke', text: k.shapes[0] });
    const actions = phone ? null : d.create({ kind: 'shape', shape: 'rounded', x: 640, y: 220, w: 180, h: 100, fill: 'none', stroke: 'stroke', text: k.shapes[1] });
    const link = (from: number, to: string | null | undefined, route: 'straight' | 'elbow' | 'curve'): void => {
      if (ids[from] && to) d.create({ kind: 'connector', from: { id: ids[from] ?? '', side: 'right' }, to: { id: to, side: 'left' }, arrow: 'end', route });
    };
    link(6, summary, 'straight');
    link(7, actions, 'straight');
    link(8, actions, 'elbow');
    const votes = d.ydoc.getMap<Y.Map<number>>('votes');
    const cast = (idx: number, by: Record<string, number>): void => {
      const cell = new Y.Map<number>();
      for (const [u, n] of Object.entries(by)) cell.set(u, n);
      votes.set(ids[idx] ?? '', cell);
    };
    cast(0, { [U.anna]: 1, [U.boris]: 1, [U.vera]: 1 });
    cast(1, { [U.dina]: 1 });
    cast(3, { [U.boris]: 1, [U.grigory]: 1 });
    cast(4, { [U.anna]: 1, [U.vera]: 1, [U.dina]: 1, [U.grigory]: 1 });
    cast(6, { [U.boris]: 1, [U.anna]: 1 });
    cast(7, { [U.anna]: 1, [U.boris]: 1, [U.grigory]: 1 });
    cast(8, { [U.vera]: 1, [U.dina]: 1 });
    d.meta.set('vote', { id: 'retro-vote', by: U.anna, startedAt: msk('13:00'), votesPerPerson: 3, open: false });
    d.meta.set('timer', { state: 'paused', endsAt: 0, remainingMs: 272_000, durationMs: 300_000, by: U.anna });
  });
  return item.id;
}

/** A canvas link in the chat as a card (the retro) with the team's answer. */
export function postStoryCanvas(mock: MockServer, c4: Copy4, canvasId: string): void {
  const m = mock.injectMessage({ roomId: R.general, authorId: U.anna, content: `${c4.canvas.post} [${c4.canvas.name}](${mock.url}/canvas/${canvasId})` });
  m.createdAt = timestampFromMs(msk('12:50'));
  const r = mock.injectMessage({ roomId: R.general, authorId: U.dina, content: c4.canvas.reply });
  r.createdAt = timestampFromMs(msk('12:56'));
}
