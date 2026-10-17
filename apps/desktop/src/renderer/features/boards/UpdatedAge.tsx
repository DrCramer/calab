import { timestampMs } from '@bufbuild/protobuf/wkt';
import { memo, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { ageOf, isStale } from '../../lib/boards/age';
import { fmt } from '../../lib/format';
import { useBoards } from '../../stores/boards';

/**
 * The list row's «updated» cell: the short age of the task's last activity («2 ч», «5 дн»), muted;
 * quiet for 14+ days — the warning tone. A leaf with a primitive selector (the timestamp): a title
 * edit elsewhere in the row does not touch it. The age is computed on render, with no timer — it
 * refreshes whenever the row re-renders (a task update, scrolling it back into view).
 */
export const UpdatedAge = memo(function UpdatedAge({ id, slot }: { id: string; slot: string }): ReactNode {
  const at = useBoards((s) => {
    const u = s.tasks[id]?.updatedAt;
    return u ? timestampMs(u) : 0;
  });
  const now = Date.now();
  const age = ageOf(at, now);
  if (!age) return <span className={slot} />;
  return (
    <span className={slot}>
      <Tip label={t('boards.tip.updated', { when: fmt.dateTime(new Date(at), 'short') })}>
        <span className={cx('tabular-nums', isStale(at, now) ? 'text-[var(--color-warn-text)]' : 'text-faint')} data-testid="row-updated" data-stale={isStale(at, now) || undefined}>
          {t(age.key, { n: age.n })}
        </span>
      </Tip>
    </span>
  );
});
