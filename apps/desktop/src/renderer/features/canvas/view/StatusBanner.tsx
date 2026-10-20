import { Eye, Loader2, UserRound, WifiOff, X } from 'lucide-react';
import { memo, useSyncExternalStore, type ReactNode } from 'react';
import { Button, IconButton, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import type { CanvasSync, CanvasSyncStatus } from '../../../lib/canvasSync';
import type { CanvasEngine } from '../engine';
import { PANEL } from './chrome';
import { useAfter, useEngineValue } from './hooks';
import { TimerChip } from './Timer';
import type { TimerStore } from './timerStore';
import { VoteChip } from './Vote';

const noopSubscribe = (): (() => void) => () => undefined;

export function useSyncStatus(sync: CanvasSync | null): CanvasSyncStatus {
  return useSyncExternalStore(sync ? (cb) => sync.subscribe(cb) : noopSubscribe, () => (sync ? sync.getStatus() : 'connecting'));
}

/** «Вы следите за X · ✕»: its own leaf, so a follow starting or ending re-renders just this. */
const FollowChip = memo(function FollowChip({ engine }: { engine: CanvasEngine }): ReactNode {
  useLocale();
  const key = useEngineValue(engine, (s) => s.followKey);
  const name = useEngineValue(engine, (s) => s.followName);
  if (key === null) return null;
  return (
    <div role="status" className={cx(PANEL, 'flex items-center gap-2 rounded-full py-1 pl-3 pr-1 text-control text-fg')} data-testid="canvas-following">
      <UserRound className="size-4 text-muted" aria-hidden />
      <span>{t('canvasBoard.follow.banner', { name: name || '?' })}</span>
      <IconButton label={t('canvasBoard.follow.stop')} size="sm" tip={false} onMouseDown={(e) => e.preventDefault()} onClick={() => engine.follow(null)} data-testid="canvas-following-stop">
        <X className="size-4" strokeWidth={1.75} aria-hidden />
      </IconButton>
    </div>
  );
});

/**
 * Connection and mode notices, top center: «Подключение…», «Переподключение…» (a loader spins only while
 * it shows), «Только просмотр» (no CANVAS_WRITE) and the newer-schema notice. Primitives only.
 */
export const StatusBanner = memo(function StatusBanner({
  engine, sync, timer, canWrite, gone, onRetry, phone = false,
}: {
  engine: CanvasEngine;
  sync: CanvasSync;
  timer: TimerStore;
  canWrite: boolean;
  gone: boolean;
  onRetry: () => void;
  /** The phone viewer: view only is the rule there (its own note says so), no «Только просмотр» chip. */
  phone?: boolean;
}): ReactNode {
  useLocale();
  const status = useSyncStatus(sync);
  const engineReadOnly = useEngineValue(engine, (s) => s.readOnly);
  // «Подключение» is the normal first second: shown only if it takes a while.
  const connecting = useAfter(status === 'connecting', 600);
  const offline = status === 'offline';

  if (gone) {
    return (
      <div role="alert" data-testid="canvas-gone" className="absolute inset-0 z-20 grid place-items-center bg-main/80 text-body text-muted">
        <div className={cx(PANEL, 'flex flex-col items-center gap-2 px-4 py-3')}>
          <span>{t('canvasBoard.status.gone')}</span>
          <Button variant="secondary" size="sm" onClick={onRetry} data-testid="canvas-retry">
            {t('canvasBoard.status.retry')}
          </Button>
        </div>
      </div>
    );
  }
  const chip = 'flex items-center gap-2 rounded-full px-3 py-1.5 text-control text-fg';
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 flex-col items-center gap-1.5" data-testid="canvas-status">
      <TimerChip store={timer} engine={engine} />
      {offline || connecting ? (
        <div role="status" className={cx(PANEL, chip)} data-testid={offline ? 'canvas-offline' : 'canvas-connecting'}>
          {offline ? <WifiOff className="size-4 text-muted" aria-hidden /> : <Loader2 className="size-4 animate-spin text-muted" aria-hidden />}
          <span>{offline ? t('canvasBoard.status.offline') : t('canvasBoard.status.connecting')}</span>
          {offline && !phone ? <span className="text-muted">{t('canvasBoard.status.offlineHint')}</span> : null}
        </div>
      ) : null}
      {phone ? null : !canWrite ? (
        <div role="status" className={cx(PANEL, chip)} title={t('canvasBoard.status.viewOnlyHint')} data-testid="canvas-view-only">
          <Eye className="size-4 text-muted" aria-hidden />
          <span>{t('canvasBoard.status.viewOnly')}</span>
        </div>
      ) : engineReadOnly ? (
        <div role="status" className={cx(PANEL, chip)} data-testid="canvas-newer-schema">
          <Eye className="size-4 text-muted" aria-hidden />
          <span>{t('canvasBoard.status.newerSchema')}</span>
        </div>
      ) : null}
      <FollowChip engine={engine} />
      <VoteChip engine={engine} />
    </div>
  );
});
