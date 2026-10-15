// @vitest-environment jsdom
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { BoardSchema, BoardStatusSchema, BoardStatusType, TaskField, TaskOp, TaskPriority, TaskSchema, type Board, type Task } from '@calaba/protocol';
import { describe, expect, it, vi } from 'vitest';

// The list's own grouping (ListView's listItems) is used as is; its imports reach the platform layer.
vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() }, isWeb: true }));

import { EMPTY_DATA, setBoardTasks, type BoardsData } from '../../lib/boards/reducers';
import { EMPTY_FILTER, type MatchCtx } from '../../lib/boards/filter';
import { DEFAULT_PREFS, type BoardPrefs } from '../../stores/boardsUi';
import { boardOrder, escStep, keepOrder, positionOf, stepTask } from './taskOrder';

const task = (id: string, statusId: string, position: number, p: MessageInitShape<typeof TaskSchema> = {}): Task =>
  create(TaskSchema, { id, boardId: 'b1', workspaceId: 'w1', statusId, position, number: position, key: `CAL-${id}`, title: id, ...p });

const board: Board = create(BoardSchema, {
  id: 'b1',
  workspaceId: 'w1',
  statuses: [
    create(BoardStatusSchema, { id: 'todo', name: 'To Do', position: 1, type: BoardStatusType.UNSTARTED }),
    create(BoardStatusSchema, { id: 'doing', name: 'Doing', position: 2, type: BoardStatusType.STARTED }),
    create(BoardStatusSchema, { id: 'done', name: 'Done', position: 3, type: BoardStatusType.COMPLETED }),
  ],
});

function data(): BoardsData {
  const tasks = [
    task('a', 'todo', 1, { priority: TaskPriority.LOW }),
    task('b', 'todo', 2, { priority: TaskPriority.URGENT, dueOn: '2026-10-20' }),
    task('c', 'doing', 1, { priority: TaskPriority.HIGH, startOn: '2026-10-10', dueOn: '2026-10-12' }),
    task('d', 'done', 1, { priority: TaskPriority.URGENT }),
  ];
  return { ...EMPTY_DATA, boards: { b1: board }, ...setBoardTasks(EMPTY_DATA, 'b1', tasks) };
}

const ctx: MatchCtx = { me: 'u1', statuses: { todo: { type: BoardStatusType.UNSTARTED }, doing: { type: BoardStatusType.STARTED }, done: { type: BoardStatusType.COMPLETED } }, today: '2026-10-14' };
const prefs = (p: Partial<BoardPrefs> = {}): BoardPrefs => ({ ...DEFAULT_PREFS, ...p });

describe('task order of the board view (full-screen task ↑/↓)', () => {
  it('kanban: column by column, hidden and completed columns left out', () => {
    expect(boardOrder(data(), board, prefs(), 'kanban', ctx, 'w1')).toEqual(['a', 'b', 'c']);
    expect(boardOrder(data(), board, prefs({ completion: 'all' }), 'kanban', ctx, 'w1')).toEqual(['a', 'b', 'c', 'd']);
    expect(boardOrder(data(), board, prefs({ hidden: ['todo'] }), 'kanban', ctx, 'w1')).toEqual(['c']);
  });

  it('list: the grouping and the sort the list renders with', () => {
    expect(boardOrder(data(), board, prefs({ kind: 'list' }), 'list', ctx, 'w1')).toEqual(['a', 'b', 'c']);
    expect(boardOrder(data(), board, prefs({ kind: 'list', groupBy: 'priority' }), 'list', ctx, 'w1')).toEqual(['b', 'c', 'a']);
    expect(boardOrder(data(), board, prefs({ kind: 'list', groupBy: 'none', sort: 'due' }), 'list', ctx, 'w1')).toEqual(['c', 'b', 'a']);
  });

  it('list: the filter applies', () => {
    const filter = { ...EMPTY_FILTER, conds: [{ field: TaskField.PRIORITY, op: TaskOp.IS, values: ['urgent'] }] };
    expect(boardOrder(data(), board, prefs({ kind: 'list', filter, completion: 'all' }), 'list', ctx, 'w1')).toEqual(['b', 'd']);
    expect(boardOrder(data(), board, prefs({ filter }), 'kanban', ctx, 'w1')).toEqual(['b']);
  });

  it('timeline: dated rows by start, then the undated', () => {
    expect(boardOrder(data(), board, prefs({ kind: 'timeline' }), 'timeline', ctx, 'w1')).toEqual(['c', 'b', 'a']);
  });

  it('steps, position and the ends', () => {
    const order = ['a', 'b', 'c'];
    expect(positionOf(order, 'b')).toEqual({ n: 2, total: 3 });
    expect(positionOf(order, 'x')).toBeNull();
    expect(stepTask(order, 'b', 1)).toBe('c');
    expect(stepTask(order, 'b', -1)).toBe('a');
    expect(stepTask(order, 'a', -1)).toBeNull();
    expect(stepTask(order, 'c', 1)).toBeNull();
    expect(stepTask(order, 'x', 1)).toBeNull();
  });

  it('keeps the walked list when the fresh one lost the open task', () => {
    // «Непрочитанное»: the opened task leaves the list.
    expect(keepOrder(['a', 'b', 'c'], ['a', 'c'], 'b')).toEqual(['a', 'b', 'c']);
    // A fresh list with the task wins.
    expect(keepOrder(['a', 'b'], ['b', 'a'], 'b')).toEqual(['b', 'a']);
    // Neither has it (a deep link to a filtered task): the fresh one.
    expect(keepOrder(['a'], ['c'], 'x')).toEqual(['c']);
  });
});

describe('Esc in boards mode', () => {
  const base = { inField: false, layer: false, taskOpen: false, fieldInTask: false, selected: false, focused: false };
  it('a menu or dialog keeps it; a field of the task blurs first, then the task closes', () => {
    expect(escStep({ ...base, layer: true, taskOpen: true })).toBe('none');
    expect(escStep({ ...base, inField: true, taskOpen: true, fieldInTask: true })).toBe('blur');
    expect(escStep({ ...base, taskOpen: true })).toBe('closeTask');
    expect(escStep({ ...base, inField: true })).toBe('none');
  });
  it('without a task: selection, then focus, then the mode', () => {
    expect(escStep({ ...base, selected: true, focused: true })).toBe('clearSelection');
    expect(escStep({ ...base, focused: true })).toBe('unfocus');
    expect(escStep(base)).toBe('leave');
  });
});
