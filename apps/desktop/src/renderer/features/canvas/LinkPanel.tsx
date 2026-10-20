import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { CanvasLink } from '@calaba/protocol';
import { Copy, Lock } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Input, Select, Spinner, Switch } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { canvasApi } from '../../services/canvas';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';

export const LINK_EXPIRY_DAYS = [0, 1, 7, 30] as const;
type Expiry = (typeof LINK_EXPIRY_DAYS)[number];

/** The canvas's public address `/c/{code}` on the server's origin (the answer's `url` when known). */
const publicUrl = (code: string): string => new URL(`/c/${code}`, useSession.getState().serverUrl || window.location.origin).toString();

/** The days left of a live link, rounded to one of the choices (the select shows the current term). */
function expiryOf(link: CanvasLink | undefined): Expiry {
  if (!link?.expiresAt) return 0;
  const days = (timestampDate(link.expiresAt).getTime() - Date.now()) / 86_400_000;
  return days > 7 ? 30 : days > 1 ? 7 : 1;
}

/**
 * «Ссылка» of a canvas's «Доступ» (ADR-0115 wave 5): «Доступ по ссылке» — anyone with it sees the canvas without
 * signing in, never edits it and never sees who is on it; the address with «Скопировать», the term (never, 1, 7, 30
 * days; changing it keeps the code), the views. A private canvas (restricted, or below a restricted folder) cannot
 * have one: the switch is off and says why. The dialog is the owner's or CANVAS_MANAGE's (the server checks).
 */
export function LinkPanel({ itemId, restricted }: { itemId: string; restricted: boolean }): ReactNode {
  const [link, setLink] = useState<CanvasLink | undefined>(undefined);
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [expiry, setExpiry] = useState<Expiry>(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    canvasApi.link(itemId).then(
      (r) => {
        if (!live) return;
        setLink(r.link);
        setUrl(r.url);
        setExpiry(expiryOf(r.link));
        setLoaded(true);
      },
      (e: unknown) => {
        if (!live) return;
        setLoaded(true);
        toast.fail(e, t('canvasShare.err.link'));
      },
    );
    return () => {
      live = false;
    };
  }, [itemId]);

  const on = !!link;
  const address = url || (link ? publicUrl(link.code) : '');
  const apply = (next: { on: boolean; days: Expiry }): void => {
    setBusy(true);
    const err = (e: unknown): void => {
      toast.fail(e, t('canvasShare.err.link'));
      setBusy(false);
    };
    if (next.on) {
      canvasApi.createLink(itemId, next.days).then((r) => {
        setLink(r.link);
        setUrl(r.url);
        setBusy(false);
      }, err);
    } else {
      canvasApi.deleteLink(itemId).then(() => {
        setLink(undefined);
        setUrl('');
        setBusy(false);
      }, err);
    }
  };

  if (!loaded) {
    return (
      <div className="grid h-40 place-items-center" data-testid="canvas-link-loading">
        <Spinner />
      </div>
    );
  }
  if (restricted && !on) {
    return (
      <div className="flex flex-col gap-4" data-testid="canvas-link">
        <Switch checked={false} onChange={() => undefined} label={t('canvasShare.link.on')} hint={t('canvasShare.link.hint')} disabled />
        <p className="flex items-start gap-2 text-caption text-muted" data-testid="canvas-link-private">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('canvasShare.link.private')}
        </p>
      </div>
    );
  }
  const until = link?.expiresAt ? timestampDate(link.expiresAt) : null;
  return (
    <div className="flex flex-col gap-4" data-testid="canvas-link">
      <Switch checked={on} onChange={(v) => apply({ on: v, days: expiry })} label={t('canvasShare.link.on')} hint={t('canvasShare.link.hint')} disabled={busy} />
      {link ? (
        <>
          <div className="flex items-center gap-2">
            <Input readOnly value={address} aria-label={t('disk.link.address')} className="min-w-0 flex-1 text-ellipsis font-mono text-caption" onFocus={(e) => e.currentTarget.select()} data-testid="canvas-link-url" />
            <Button
              variant="secondary"
              className="shrink-0"
              disabled={!address}
              onClick={() =>
                void navigator.clipboard.writeText(address).then(
                  () => toast.success(t('disk.link.copied')),
                  (e: unknown) => toast.fail(e),
                )
              }
              data-testid="canvas-link-copy"
            >
              <Copy className="size-3.5" aria-hidden />
              {t('disk.link.copyShort')}
            </Button>
          </div>
          <p className="text-caption text-muted" data-testid="canvas-link-meta">
            {until ? t('disk.link.until', { date: fmt.stamp(until) }) : t('disk.link.forever')}
            {' · '}
            {t('canvasShare.link.views', { n: Number(link.views) })}
          </p>
        </>
      ) : null}
      <label className="flex items-center justify-between gap-4 text-body">
        <span>{t('disk.link.expiry')}</span>
        <span className="w-40">
          <Select
            value={String(expiry)}
            disabled={busy}
            onChange={(e) => {
              const days = Number(e.target.value) as Expiry;
              setExpiry(days);
              if (on) apply({ on: true, days }); // the live link keeps its code
            }}
            data-testid="canvas-link-expiry"
          >
            {LINK_EXPIRY_DAYS.map((d) => (
              <option key={d} value={d}>
                {d === 0 ? t('disk.link.never') : t('disk.link.days', { n: d })}
              </option>
            ))}
          </Select>
        </span>
      </label>
    </div>
  );
}
