import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { CalendarEventCommentSchema, type CalendarEventComment } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { EMPTY_THREAD } from '../../stores/eventComments';
import { withComment, withPage, withoutComment } from './comments';

const c = (id: string, body = id, editedMs?: number): CalendarEventComment =>
  create(CalendarEventCommentSchema, { id, eventId: 'e1', authorId: 'u1', body, ...(editedMs ? { editedAt: timestampFromMs(editedMs) } : {}) });

/** A meeting's comment thread (ADR-0104): pages, upserts and removals keep the id (= time) order. */
describe('meeting comment thread', () => {
  it('the first page, then an older one, merge in id order; hasMore follows the older page', () => {
    const first = withPage(EMPTY_THREAD, [c('03'), c('04')], true);
    expect([first.ids, first.loaded, first.hasMore]).toEqual([['03', '04'], true, true]);
    const older = withPage(first, [c('01'), c('02')], false);
    expect([older.ids, older.hasMore]).toEqual([['01', '02', '03', '04'], false]);
  });

  it('an added comment lands in order once; a stale copy never replaces an edit', () => {
    let th = withPage(EMPTY_THREAD, [c('01'), c('03')], false);
    th = withComment(th, c('02'));
    th = withComment(th, c('02'));
    expect(th.ids).toEqual(['01', '02', '03']);
    th = withComment(th, c('02', 'правка', 2000));
    expect(withComment(th, c('02', 'старое')).byId['02']?.body).toBe('правка');
    expect(withComment(th, c('02', 'новее', 3000)).byId['02']?.body).toBe('новее');
  });

  it('a removed comment leaves the thread; an unknown id changes nothing', () => {
    const th = withPage(EMPTY_THREAD, [c('01'), c('02')], false);
    expect(withoutComment(th, '01').ids).toEqual(['02']);
    expect(withoutComment(th, 'xx')).toBe(th);
  });
});
