import { Eye, Loader2, WifiOff } from 'lucide-react';
import { memo, useSyncExternalStore, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import type { CanvasSync, CanvasSyncStatus } from '../../../lib/canvasSync';
import type { CanvasEngine } from '../engine';
import { PANEL } from './chrome';
import { useAfter, useEngineValue } from './hooks';

const noopSubscribe = (): (() => void) => () => undefined;

export function useSyncStatus(sync: CanvasSync | null): CanvasSyncStatus {
  return useSyncExternalStore(sync ? (cb) => sync.subscribe(cb) : noopSubscribe, () => (sync ? sync.getStatus() : 'connecting'));
}

/**
 * Connection and mode notices, top center: «Подключение…», «Переподключение…» (a loader spins only while
 * it shows), «Только просмотр» (no CANVAS_WRITE) and the newer-schema notice. Primitives only.
 */
export const StatusBanner = memo(function StatusBanner({
  engine, sync, canWrite, gone,
}: {
  engine: CanvasEngine;
  sync: CanvasSync;
  canWrite: boolean;
  gone: boolean;
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
        <span className={cx(PANEL, 'px-4 py-3')}>{t('canvasBoard.status.gone')}</span>
      </div>
    );
  }
  const chip = 'flex items-center gap-2 rounded-full px-3 py-1.5 text-control text-fg';
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 flex-col items-center gap-1.5" data-testid="canvas-status">
      {offline || connecting ? (
        <div role="status" className={cx(PANEL, chip)} data-testid={offline ? 'canvas-offline' : 'canvas-connecting'}>
          {offline ? <WifiOff className="size-4 text-muted" aria-hidden /> : <Loader2 className="size-4 animate-spin text-muted" aria-hidden />}
          <span>{offline ? t('canvasBoard.status.offline') : t('canvasBoard.status.connecting')}</span>
          {offline ? <span className="text-muted">{t('canvasBoard.status.offlineHint')}</span> : null}
        </div>
      ) : null}
      {!canWrite ? (
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
    </div>
  );
});
