import { create } from '@bufbuild/protobuf';
import { TaskField, TaskOp, TaskSchema, type Task } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { archiveFilter } from '../lib/boards/archive';
import { useBoards } from './boards';
import { EMPTY_ARCHIVE, useBoardArchive } from './boardArchive';

const task = (id: string): Task => create(TaskSchema, { id, key: `OPS-${id}`, boardId: 'b1', title: id });

describe('board archive store', () => {
  beforeEach(() => useBoardArchive.setState(EMPTY_ARCHIVE));

  it('pages append in order without duplicates; a new query starts over', () => {
    const s = useBoardArchive.getState();
    s.reset('b1', '');
    expect(useBoardArchive.getState().load).toBe('loading');
    s.setPage([task('3'), task('2')], '9:2', false);
    s.setPage([task('2'), task('1')], '', true);
    const a = useBoardArchive.getState();
    expect(a.ids).toEqual(['3', '2', '1']);
    expect(a.cursor).toBe('');
    expect(a.load).toBe('ready');
    s.reset('b1', 'x');
    expect(useBoardArchive.getState().ids).toEqual([]);
  });

  it('a restored task leaves the list', () => {
    const s = useBoardArchive.getState();
    s.setPage([task('2'), task('1')], '', false);
    s.drop('2');
    expect(useBoardArchive.getState().ids).toEqual(['1']);
    expect(useBoardArchive.getState().tasks['2']).toBeUndefined();
  });

  it('never touches the boards store', () => {
    useBoardArchive.getState().setPage([task('7')], '', false);
    expect(useBoards.getState().tasks['7']).toBeUndefined();
  });

  it('an error of a next page keeps the list', () => {
    const s = useBoardArchive.getState();
    s.setPage([task('1')], 'c', false);
    s.setLoading(true);
    s.setError();
    const a = useBoardArchive.getState();
    expect(a.load).toBe('ready');
    expect(a.more).toBe(false);
    expect(a.ids).toEqual(['1']);
  });

  it('the search is a TEXT condition, blank is none', () => {
    expect(archiveFilter('  ')).toBeUndefined();
    const f = archiveFilter(' релиз ');
    expect(f?.conditions[0]).toMatchObject({ field: TaskField.TEXT, op: TaskOp.CONTAINS, values: ['релиз'] });
  });
});
