import { create } from '@bufbuild/protobuf';
import { SearchResponseSchema, SearchType } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { summaryRows } from './summary';

const msg = (id: string) => ({ snippet: `m ${id}`, ref: { case: 'message' as const, value: { messageId: id, roomId: 'r' } } });
const task = (id: string, keyMatch = false) => ({ title: id, ref: { case: 'task' as const, value: { taskId: id, boardId: 'b', key: id, keyMatch } } });

describe('⌘K summary rows', () => {
  it('≤ 4 hits per section in display order, «Все: N» after each, empty sections left out', () => {
    const r = create(SearchResponseSchema, {
      sections: [
        { type: SearchType.MESSAGES, items: ['1', '2', '3', '4', '5'].map(msg), totalEstimate: 37 },
        { type: SearchType.TASK_COMMENTS },
        { type: SearchType.TASKS, items: [task('t1')], totalEstimate: 1 },
        { type: SearchType.FILES },
      ],
    });
    const { byKey, rows } = summaryRows(r);
    expect(byKey).toEqual([]);
    expect(rows.map((x) => (x.kind === 'hit' ? `${x.section}:${x.id}` : `${x.kind}:${x.section}`))).toEqual([
      'messages:h-message:1',
      'messages:h-message:2',
      'messages:h-message:3',
      'messages:h-message:4',
      'more:messages',
      'tasks:h-t:t1',
      'more:tasks',
    ]);
    expect(rows[4]).toMatchObject({ kind: 'more', total: 37 });
  });

  it('a timed-out section is one quiet row; others are unaffected', () => {
    const r = create(SearchResponseSchema, {
      sections: [
        { type: SearchType.MESSAGES, timedOut: true },
        { type: SearchType.EVENTS, items: [{ title: 'Созвон', ref: { case: 'event', value: { eventId: 'e1' } } }], totalEstimate: 1 },
      ],
    });
    expect(summaryRows(r).rows.map((x) => x.kind)).toEqual(['timeout', 'hit', 'more']);
  });

  it('a task found by its key goes first, out of its section', () => {
    const r = create(SearchResponseSchema, {
      sections: [
        { type: SearchType.MESSAGES, items: [msg('1')], totalEstimate: 1 },
        { type: SearchType.TASKS, items: [task('FNG-12', true), task('FNG-120')], totalEstimate: 2 },
      ],
    });
    const { byKey, rows } = summaryRows(r);
    expect(byKey).toMatchObject([{ kind: 'hit', byKey: true, section: 'tasks', id: 'k-t:FNG-12' }]);
    expect(rows.filter((x) => x.kind === 'hit').map((x) => x.id)).toEqual(['h-message:1', 'h-t:FNG-120']);
  });

  it('wiki pages and Disk items are sections of their own (the server sends them in its order)', () => {
    const r = create(SearchResponseSchema, {
      sections: [
        { type: SearchType.FILES, items: [{ title: 'a.pdf', ref: { case: 'file', value: { fileId: 'f1', messageId: 'm1' } } }], totalEstimate: 1 },
        { type: SearchType.WIKI, items: [{ title: 'Онбординг', ref: { case: 'wiki', value: { pageId: 'p1' } } }], totalEstimate: 1 },
        { type: SearchType.DISK, items: [{ title: 'План.xlsx', ref: { case: 'disk', value: { itemId: 'd1' } } }], totalEstimate: 3 },
      ],
    });
    expect(summaryRows(r).rows.map((x) => x.id)).toEqual(['h-w:p1', 'a-wiki', 'h-f:f1:m1', 'a-files', 'h-d:d1', 'a-disk']);
  });

  it('canvases are a section after the wiki (a folder hit too)', () => {
    const r = create(SearchResponseSchema, {
      sections: [
        { type: SearchType.CANVAS, items: [{ title: 'Roadmap', ref: { case: 'canvas', value: { itemId: 'c1' } } }, { title: 'Планы', ref: { case: 'canvas', value: { itemId: 'c2', folder: true } } }], totalEstimate: 7 },
        { type: SearchType.WIKI, items: [{ title: 'Онбординг', ref: { case: 'wiki', value: { pageId: 'p1' } } }], totalEstimate: 1 },
      ],
    });
    const { rows } = summaryRows(r);
    expect(rows.map((x) => x.id)).toEqual(['h-w:p1', 'a-wiki', 'h-v:c1', 'h-v:c2', 'a-canvas']);
    expect(rows.at(-1)).toMatchObject({ kind: 'more', section: 'canvas', total: 7 });
  });

  it('the section of a lone key match keeps no «Все» row of its own', () => {
    const r = create(SearchResponseSchema, { sections: [{ type: SearchType.TASKS, items: [task('FNG-12', true)], totalEstimate: 1 }] });
    expect(summaryRows(r)).toMatchObject({ byKey: [{ id: 'k-t:FNG-12' }], rows: [] });
  });
});
