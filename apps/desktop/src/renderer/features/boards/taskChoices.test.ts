import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { TaskSchema, type Task } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { taskChoices } from './taskChoices';

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
