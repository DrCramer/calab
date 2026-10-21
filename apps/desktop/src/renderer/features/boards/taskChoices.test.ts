import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { TaskSchema, type Task } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { linkChoices, taskChoices } from './taskChoices';

const t = (id: string, number: number, p: MessageInitShape<typeof TaskSchema> = {}): Task => create(TaskSchema, { id, number, boardId: 'b1', key: `DOC-${number}`, title: id, ...p });

describe('taskChoices', () => {
  it('is empty while the tasks are not loaded', () => {
    expect(taskChoices(null, 'b1', 'x')).toEqual([]);
    expect(taskChoices({}, 'b1', 'x')).toEqual([]);
  });
  it('keeps live tasks of the board except the task itself, newest first', () => {
    const tasks = { a: t('a', 1), b: t('b', 2), c: t('c', 3), d: t('d', 4, { boardId: 'b2' }) };
    expect(taskChoices(tasks, 'b1', 'b').map((c) => c.id)).toEqual(['c', 'a']);
    expect(taskChoices(tasks, 'b1', 'b')[0]).toMatchObject({ label: 'DOC-3 c', search: ['DOC-3', 'c'] });
  });
});

describe('linkChoices (CBF-47)', () => {
  const names: Record<string, string> = { b1: 'DOC', b2: 'INV' };
  const name = (id: string): string => names[id] ?? '';
  it('puts the search hits of every board first, then the board, without repeats', () => {
    const tasks = { a: t('a', 1), b: t('b', 2), x: t('x', 7, { boardId: 'b2', key: 'INV-7' }), y: t('y', 8, { boardId: 'b2', key: 'INV-8', archivedAt: { seconds: 1n } }), z: t('z', 9) };
    const c = linkChoices(tasks, 'b1', 'b', ['x', 'a', 'b', 'y', 'gone'], name);
    expect(c.map((x) => x.id)).toEqual(['x', 'a', 'z']);
    expect(c[0]).toMatchObject({ label: 'INV-7 x', search: ['INV-7', 'x'], caption: 'INV' });
    expect(c[1]).toMatchObject({ caption: 'DOC' });
  });
  it('is the board alone without a search, and empty while the tasks are not loaded', () => {
    expect(linkChoices({ a: t('a', 1), d: t('d', 4, { boardId: 'b2' }) }, 'b1', 'x', [], name).map((x) => x.id)).toEqual(['a']);
    expect(linkChoices(null, 'b1', 'x', ['a'], name)).toEqual([]);
  });
});
