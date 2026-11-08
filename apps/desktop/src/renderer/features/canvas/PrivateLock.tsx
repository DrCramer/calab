import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { ancestorsOf } from '../../lib/canvas/tree';
import { useCanvas } from '../../stores/canvas';

/**
 * The lock of a tree / search / phone row, as on a private board's row (BoardsList): «Только
 * выбранные» (restricted) on the item itself, or fainter below a restricted folder. Its own
 * subscription (a primitive), so the row does not re-render for it.
 */
export function PrivateLock({ id }: { id: string }): ReactNode {
  const kind = useCanvas((s) => {
    if (s.items[id]?.restricted) return 'own';
    return ancestorsOf(s.items, id).some((a) => !!s.items[a]?.restricted) ? 'inherited' : null;
  });
  if (!kind) return null;
  return (
    <Lock
      className={cx('size-3.5 shrink-0 text-faint', kind === 'inherited' && 'opacity-50')}
      aria-label={t(kind === 'own' ? 'canvas.private' : 'canvas.privateParent')}
      data-testid="canvas-private"
      data-kind={kind}
    />
  );
}
