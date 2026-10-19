// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { TaskSchema, type Task } from '@calaba/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({
  platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() },
  isWeb: true,
}));

import { sortColumnIds } from './columnSort';

const task = (id: string, position: number, updated: number): Task =>
  create(TaskSchema, {
    id,
    boardId: 'b',
    statusId: 's',
    position,
    number: position,
    updatedAt: timestampFromMs(updated),
  });

const tasks = {
  a: task('a', 1, 100),
  b: task('b', 2, 300),
  c: task('c', 3, 200),
};

describe('sortColumnIds', () => {
  it('manual keeps the board order untouched', () => {
    const ids = ['c', 'a', 'b'];
    expect(sortColumnIds(ids, tasks, 'manual')).toBe(ids);
  });
  it('updated: newest first, position is not read', () => {
    expect(sortColumnIds(['a', 'b', 'c'], tasks, 'updated')).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
  it('key: by task number', () => {
    expect(sortColumnIds(['c', 'a', 'b'], tasks, 'key')).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
  it('skips unknown ids and does not mutate the input', () => {
    const ids = ['a', 'zz', 'b'];
    expect(sortColumnIds(ids, tasks, 'updated')).toEqual(['b', 'a']);
    expect(ids).toEqual(['a', 'zz', 'b']);
  });
});
