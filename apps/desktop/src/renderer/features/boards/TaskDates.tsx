import { timestampMs } from '@bufbuild/protobuf/wkt';
import { memo, type ReactNode } from 'react';
import { Tip } from '../../components/ui';
import { taskDatesFull, taskDatesLine } from '../../lib/boards/taskDates';
import { useBoards } from '../../stores/boards';

/**
 * «Создано 13 окт., 10:54 · обновлено вчера в 13:40» under the task's title (#90): small grey text,
 * the full dates on hover. A leaf with two primitive selectors (created / updated, ms): a title or
 * status edit that does not move «updated» renders nothing here. The relative day («вчера») is
 * computed on render, no timer — it refreshes with the next update of the task.
 */
export const TaskDates = memo(function TaskDates({ id }: { id: string }): ReactNode {
  const created = useBoards((s) => {
    const c = s.tasks[id]?.createdAt;
    return c ? timestampMs(c) : 0;
  });
  const updated = useBoards((s) => {
    const u = s.tasks[id]?.updatedAt;
    return u ? timestampMs(u) : 0;
  });
  if (!created) return null;
  return (
    <Tip
      side="bottom"
      label={
        <span className="flex flex-col">
          {taskDatesFull(created, updated).map((l) => (
            <span key={l}>{l}</span>
          ))}
        </span>
      }
    >
      <p className="-mt-3 w-fit max-w-full truncate text-caption text-muted" data-testid="task-dates">
        {taskDatesLine(created, updated)}
      </p>
    </Tip>
  );
});
