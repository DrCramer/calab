import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { TaskPriority, TaskSchema, type Task } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { EMPTY_MY_FILTER, matchMine, migrateMyFilter, myFilterCount, sortMine } from './myTasks';

const task = (id: string, p: { c?: number; u?: number; priority?: TaskPriority; dueOn?: string; boardId?: string } = {}): Task => {
  const { c = 0, u = 0, ...rest } = p;
  const init: MessageInitShape<typeof TaskSchema> = { id, boardId: 'b1', createdAt: timestampFromMs(c), updatedAt: timestampFromMs(u), ...rest };
  return create(TaskSchema, init);
};
const ids = (l: Task[]): string[] => l.map((x) => x.id);

describe('sortMine', () => {
  const list = [
    task('a', { c: 1, u: 30, priority: TaskPriority.LOW, dueOn: '2026-10-20' }),
    task('b', { c: 3, u: 10, priority: TaskPriority.URGENT }),
    task('c', { c: 2, u: 20, priority: TaskPriority.URGENT, dueOn: '2026-10-10' }),
  ];
  it('created: newest first', () => expect(ids(sortMine(list, 'created'))).toEqual(['b', 'c', 'a']));
  it('updated: latest edit first', () => expect(ids(sortMine(list, 'updated'))).toEqual(['a', 'c', 'b']));
  it('due: soonest first, undated last', () => expect(ids(sortMine(list, 'due'))).toEqual(['c', 'a', 'b']));
  it('priority: urgent first, ties newest first', () => expect(ids(sortMine(list, 'priority'))).toEqual(['b', 'c', 'a']));
  it('does not mutate the input', () => {
    const before = ids(list);
    sortMine(list, 'created');
    expect(ids(list)).toEqual(before);
  });
});

describe('matchMine', () => {
  const today = '2026-10-15';
  it('passes everything by default', () => expect(matchMine(task('a'), EMPTY_MY_FILTER, today, false)).toBe(true));
  it('priority and board', () => {
    const f = { ...EMPTY_MY_FILTER, priorities: [TaskPriority.HIGH], boards: ['b1'] };
    expect(matchMine(task('a', { priority: TaskPriority.HIGH }), f, today, false)).toBe(true);
    expect(matchMine(task('a', { priority: TaskPriority.LOW }), f, today, false)).toBe(false);
    expect(matchMine(task('a', { priority: TaskPriority.HIGH, boardId: 'b2' }), f, today, false)).toBe(false);
  });
  it('overdue ignores done tasks, dated needs a date', () => {
    const late = task('a', { dueOn: '2026-10-01' });
    expect(matchMine(late, { ...EMPTY_MY_FILTER, due: 'overdue' }, today, false)).toBe(true);
    expect(matchMine(late, { ...EMPTY_MY_FILTER, due: 'overdue' }, today, true)).toBe(false);
    expect(matchMine(task('a', { dueOn: '2026-11-01' }), { ...EMPTY_MY_FILTER, due: 'overdue' }, today, false)).toBe(false);
    expect(matchMine(task('a'), { ...EMPTY_MY_FILTER, due: 'dated' }, today, false)).toBe(false);
  });
});

describe('filter storage', () => {
  it('counts conditions, not values', () => expect(myFilterCount({ priorities: [1, 2], due: 'overdue', boards: [] })).toBe(2));
  it('sanitises garbage', () => expect(migrateMyFilter({ priorities: ['x', 2], due: 'nope', boards: 5 })).toEqual({ priorities: [2], due: 'any', boards: [] }));
});
