import { timestampMs } from '@bufbuild/protobuf/wkt';
import { Copy, Timer } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Field, Input, Modal, Segmented, Switch, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { fmt } from '../../lib/format';
import { mayInviteGuests } from '../../lib/permissions';
import {
  LIFETIME_PRESETS,
  MAX_LIFETIME_MS,
  expiresMs,
  extendTo,
  fromLocalInput,
  presetTtl,
  toLocalInput,
  validEnd,
  type LifetimePreset,
} from '../../lib/tempRooms';
import { voice } from '../../services/voice';
import { extendTempRoom, rememberTempLink } from '../../services/tempRooms';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useMemberRoles } from '../../stores/workspaces';
import { PeopleBar } from '../calendar/PeopleBar';
import { useOwnerSeesPrivate } from '../people/PrivateAccess';

/**
 * «Временная комната» (ADR-0044 §UI, docs/08 «Колонка комнат»): name (Enter creates), lifetime
 * presets or «до даты», visibility «Все участники / Только выбранные» with the people, «Пускать
 * гостей по ссылке» (with INVITE_GUESTS; otherwise the link is members-only and a hint says so),
 * «Добавить встречу в календарь». POST …/rooms/temp; then the same dialog shows the link —
 * «Скопировать», «Войти» (voice at once) and «Готово». Errors (limit, rights) are inline.
 */

const PRESET_LABEL: Record<LifetimePreset, MessageKey> = {
  '1h': 'temp.preset.1h',
  '3h': 'temp.preset.3h',
  eod: 'temp.preset.eod',
  '1d': 'temp.preset.1d',
  '3d': 'temp.preset.3d',
  '7d': 'temp.preset.7d',
  date: 'temp.preset.date',
};

const MAX_MEMBERS = 50;

type Visibility = 'all' | 'selected';

interface Created {
  roomId: string;
  name: string;
  url: string;
  expires: number;
}

export function TempRoomDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const roles = useMemberRoles(workspaceId, me);
  const guestsAllowed = mayInviteGuests(roles);
  // The dialog's «now» for the presets and the date field: fixed on open (no ticking form).
  const [now] = useState(() => Date.now());
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<LifetimePreset>('1h');
  const [until, setUntil] = useState(() => toLocalInput(now + 24 * 3_600_000));
  const [vis, setVis] = useState<Visibility>('all');
  const ownerSees = useOwnerSeesPrivate(workspaceId);
  const [people, setPeople] = useState<readonly string[]>([]);
  const [guests, setGuests] = useState(true);
  const [withEvent, setWithEvent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const ttl = presetTtl(preset, now, preset === 'date' ? fromLocalInput(until) : undefined);

  const addPeople = useCallback((ids: readonly string[]) => setPeople((p) => [...p, ...ids.filter((id) => !p.includes(id))]), []);
  const removePerson = useCallback((id: string) => setPeople((p) => p.filter((x) => x !== id)), []);

  const submit = async (): Promise<void> => {
    if (!name.trim() || ttl === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.rooms.createTemp(workspaceId, {
        name: name.trim(),
        ttlSeconds: ttl,
        withEvent,
        // Without INVITE_GUESTS the server refuses `guests: true` (ADR-0044 «Контракт»): members-only.
        guests: guestsAllowed && guests,
        private: vis === 'selected',
        memberIds: vis === 'selected' ? [...people] : [],
      });
      const room = r.room;
      if (!room) throw new Error('no room in the answer');
      useRooms.getState().upsert(room);
      rememberTempLink(room.id, r.inviteUrl);
      setCreated({ roomId: room.id, name: room.name, url: r.inviteUrl, expires: expiresMs(room) || Date.now() + ttl * 1000 });
    } catch (e) {
      setError(createError(e));
    } finally {
      setBusy(false);
    }
  };

  if (created) return <TempRoomResult workspaceId={workspaceId} created={created} onClose={onClose} />;

  return (
    <Modal
      open
      onClose={onClose}
      title={t('temp.title')}
      description={t('temp.description')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={!name.trim() || ttl === null} onClick={() => void submit()} data-testid="temp-create">
            {t('common.create')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        data-testid="temp-room-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t('temp.name')}>
          <Input
            autoFocus
            value={name}
            maxLength={100}
            placeholder={t('temp.namePlaceholder')}
            icon={<Timer className="size-4" />}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </Field>

        {/* Compact for the 600 px window (docs/09 #147): «Закроется …» on the label's line, the date
            field in the pills' row. */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="shrink-0 text-caption font-medium text-muted" id="temp-lifetime">
              {t('temp.lifetime')}
            </span>
            <span className={cx('min-w-0 truncate text-caption', ttl === null ? 'text-danger-text' : 'text-muted')} aria-live="polite" data-testid="temp-closes">
              {ttl === null ? t('temp.rangeInvalid') : t('temp.closesAt', { when: fmt.stamp(new Date(now + ttl * 1000), new Date(now)) })}
            </span>
          </div>
          <div role="radiogroup" aria-labelledby="temp-lifetime" className="flex flex-wrap items-center gap-1.5">
            {LIFETIME_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={preset === p}
                onClick={() => setPreset(p)}
                className={cx(
                  'h-7 whitespace-nowrap rounded-full px-3 text-control font-medium transition-colors duration-[var(--motion-fast)]',
                  preset === p ? 'bg-accent-strong text-accent-fg' : 'bg-hover text-fg hover:bg-[var(--color-fill-hover)]',
                )}
              >
                {t(PRESET_LABEL[p])}
              </button>
            ))}
            {preset === 'date' ? (
              <Input
                type="datetime-local"
                aria-label={t('temp.untilDate')}
                value={until}
                min={toLocalInput(now + 15 * 60_000)}
                max={toLocalInput(now + MAX_LIFETIME_MS)}
                onChange={(e) => setUntil(e.target.value)}
                className="w-52"
                data-testid="temp-until"
              />
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <span className="text-caption font-medium text-muted">{t('temp.visibility')}</span>
            <Segmented<Visibility>
              label={t('temp.visibility')}
              value={vis}
              onChange={setVis}
              options={[
                { value: 'all', label: t('temp.visAll') },
                { value: 'selected', label: t('temp.visSelected') },
              ]}
            />
          </div>
          <span className="text-caption text-muted">{vis === 'all' ? t('temp.visAllHint') : t(ownerSees ? 'temp.visSelectedHintOwner' : 'temp.visSelectedHint')}</span>
          {vis === 'selected' ? (
            // Up to 3 rows of 28 px chips, then the field scrolls on its own (the dialog stays put).
            <div className="-m-1 max-h-[108px] overflow-y-auto overscroll-contain p-1" data-testid="temp-people-scroll">
              <PeopleBar workspaceId={workspaceId} people={people} onAdd={addPeople} onRemove={removePerson} wrap max={MAX_MEMBERS} testId="temp-people" />
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          {guestsAllowed ? (
            <Switch checked={guests} onChange={setGuests} label={t('temp.guests')} hint={t('temp.guestsHint')} />
          ) : (
            <p className="text-caption text-muted" data-testid="temp-guests-hint">
              {t('temp.guestsNoRight')}
            </p>
          )}
          <Switch checked={withEvent} onChange={setWithEvent} label={t('temp.withEvent')} hint={t('temp.withEventHint')} />
        </div>

        {error ? (
          <p role="alert" className="text-caption text-danger-text" data-testid="temp-error">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

/** Inline text of a failed create: the limits and rights by their reason (ADR-0044 «Контракт»). */
function createError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.is('ERROR_CODE_TEMP_ROOM_LIMIT')) {
      const limit = e.extra.limit ?? (e.reason === 'PER_USER' ? 5 : 20);
      return e.reason === 'PER_USER' ? t('temp.errLimitUser', { limit }) : t('temp.errLimitWs', { limit });
    }
    if (e.status === 403 && e.is('ERROR_CODE_FORBIDDEN')) return /INVITE_GUESTS/.test(e.message) ? t('temp.errGuests') : t('temp.errForbidden');
  }
  return errorText(e);
}

/** The link right after creating: copy, join the voice at once, or done. */
function TempRoomResult({ workspaceId, created, onClose }: { workspaceId: string; created: Created; onClose: () => void }): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const copy = (): void => {
    void navigator.clipboard.writeText(created.url).then(
      () => toast.success(t('temp.copied')),
      () => toast.error(t('temp.copyFailed')),
    );
  };
  const join = (): void => {
    useUi.getState().openRoom(workspaceId, created.roomId);
    void voice.join(created.roomId, workspaceId);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('temp.createdTitle', { name: created.name })}
      description={t('temp.resultHint', { when: fmt.stamp(new Date(created.expires)) })}
      initialFocus={input}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('temp.done')}
          </Button>
          <Button onClick={join} data-testid="temp-join">
            {t('temp.join')}
          </Button>
        </>
      }
    >
      <Field label={t('temp.link')}>
        <div className="flex items-center gap-2" data-testid="temp-room-result">
          <Input ref={input} readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1" aria-label={t('temp.link')} />
          <Button variant="secondary" onClick={copy} data-testid="temp-copy">
            <Copy className="size-4" aria-hidden /> {t('temp.copy')}
          </Button>
        </div>
      </Field>
    </Modal>
  );
}

/** «Продлить › До даты…»: a date and time within 15 minutes … 7 days from now → PATCH expires_at. */
export function TempExtendDialog({ roomId, onClose }: { roomId: string; onClose: () => void }): ReactNode {
  const name = useRooms((s) => s.byId[roomId]?.name ?? '');
  const expires = useRooms((s) => {
    const at = s.byId[roomId]?.expiresAt;
    return at ? timestampMs(at) : 0;
  });
  const [now] = useState(() => Date.now());
  const initial = useMemo(() => toLocalInput(extendTo(expires || now, 24 * 3_600_000, now)), [expires, now]);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const end = validEnd(fromLocalInput(value), now);
  if (!expires) return null;
  const save = async (): Promise<void> => {
    if (end === null) return;
    setBusy(true);
    const ok = await extendTempRoom(roomId, end);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('temp.extendTitle', { name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={end === null} onClick={() => void save()}>
            {t('temp.extend')}
          </Button>
        </>
      }
    >
      <Field label={t('temp.untilDate')} error={end === null ? t('temp.rangeInvalid') : null}>
        <Input
          type="datetime-local"
          autoFocus
          value={value}
          min={toLocalInput(now + 15 * 60_000)}
          max={toLocalInput(now + MAX_LIFETIME_MS)}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
      </Field>
    </Modal>
  );
}
