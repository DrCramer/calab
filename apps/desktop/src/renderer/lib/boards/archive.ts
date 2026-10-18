import { create } from '@bufbuild/protobuf';
import { TaskField, TaskFilterSchema, TaskOp, type TaskFilter } from '@calaba/protocol';

/** «Поиск в архиве»: the server's TEXT condition (title, description, key); blank = none. */
export function archiveFilter(query: string): TaskFilter | undefined {
  const q = query.trim();
  if (!q) return undefined;
  return create(TaskFilterSchema, { conditions: [{ field: TaskField.TEXT, op: TaskOp.CONTAINS, values: [q] }] });
}
