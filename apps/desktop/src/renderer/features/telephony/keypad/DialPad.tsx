import { useQuery } from '@tanstack/react-query';
import { Delete, Phone, UserRoundPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { PhoneHeader } from '../../../components/PhoneHeader';
import { cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { api } from '../../../lib/api/endpoints';
import { haptics } from '../../../lib/haptics';
import { cleanPastedNumber, dialChars, dialKey, digitsOf } from '../../../lib/phoneNumber';
import { formatNumberInput, formatPhone, maskEdit } from '../../../lib/sip';
import { startCall } from '../../../services/call';
import { placePersonalCall } from '../../../services/sipOutbound';
import { useSession } from '../../../stores/session';
import { usePersonalCallOn } from '../../../stores/sipOutbound';
import { takeDialPrefill } from '../../../stores/telContacts';
import { useWorkspaces } from '../../../stores/workspaces';
import { nameOf } from '../../people/members';
import { usePlaceCalls } from '../access';
import { contactsKey, editContact } from '../contacts/data';
import { Keypad } from './Keypad';
import { suggestDial, type DialSuggestion, type ExtensionTarget } from './suggest';

/**
 * «Набор» (ADR-0137 §6 desktop — a 320 px card in the centre, typed from the keyboard, Enter
 * calls; §7 phone — the FAB's screen, the keypad at the thumb): the number (masked, a pasted
 * «Тел.: 8 (916)…» cleaned), a one-line suggestion (a colleague's internal number → the internal
 * call; a contact → its number), the keypad, the green «Позвонить» and ⌫ (held: clears). Without
 * PLACE_CALLS a note says outside numbers are not mine to call; internal numbers still work.
 * State is local: typing re-renders this card only; the keypad is memo.
 */

const SUGGEST_DEBOUNCE_MS = 250;
const CLEAR_HOLD_MS = 500;

/** The field's text: a number masked like everywhere, a tone string (* #) as typed. */
const display = (raw: string): string => (/[*#]/.test(raw) ? raw : formatNumberInput(raw));

/** Colleagues with an internal number (people, not me) as one string: a re-render only when it changes. */
function useExtensions(ws: string): ExtensionTarget[] {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const key = useWorkspaces((s) =>
    Object.values(s.byId[ws]?.members ?? {})
      .filter((m) => m.extension && m.user && m.user.id !== me && !m.user.isBot)
      .map((m) => `${m.user?.id ?? ''}\u0001${m.extension}\u0001${nameOf(m)}`)
      .join('\u0002'),
  );
  return useMemo(
    () =>
      key
        ? key.split('\u0002').map((r) => {
            const [userId = '', number = '', name = ''] = r.split('\u0001');
            return { userId, number, name };
          })
        : [],
    [key],
  );
}

/** Contacts whose number has the typed digits (a debounced search of the book). */
function useDialContacts(ws: string, key: string) {
  const want = key.length >= 3 ? key : '';
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    if (!want) return;
    const timer = window.setTimeout(() => setDebounced(want), SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [want]);
  const q = want ? debounced : '';
  return useQuery({
    queryKey: [...contactsKey(ws), 'dial', q],
    queryFn: ({ signal }) => api.sip.contacts(ws, { q }, signal),
    enabled: !!q,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    select: (d) => d.contacts,
  }).data;
}

export function DialPad({ ws, phone }: { ws: string; phone: boolean }): ReactNode {
  useLocale();
  const [raw, setRaw] = useState(() => dialChars(takeDialPrefill()));
  const field = useRef<HTMLInputElement | null>(null);
  const place = usePlaceCalls(ws);
  const inCall = usePersonalCallOn();
  const exts = useExtensions(ws);
  const key = dialKey(raw);
  const contacts = useDialContacts(ws, /[*#]/.test(raw) ? '' : key);
  const suggestion = useMemo(() => suggestDial(raw, exts, key.length >= 3 ? (contacts ?? []) : []), [raw, exts, contacts, key.length]);
  const digits = digitsOf(raw).length;
  const external = place && digits >= 3 && !/[*#]/.test(raw);
  const canCall = !inCall && (suggestion?.kind === 'ext' || external);

  const call = useCallback((): void => {
    if (!canCall) return;
    if (suggestion?.kind === 'ext') {
      haptics.impact();
      void startCall(suggestion.userId);
      return;
    }
    const known = suggestion?.kind === 'contact' && suggestion.exact ? { contactId: suggestion.contactId, name: suggestion.name || suggestion.company } : {};
    void placePersonalCall({ workspaceId: ws, number: raw, ...known }).then((ok) => {
      if (ok) setRaw('');
    });
  }, [canCall, suggestion, ws, raw]);

  const onKey = useCallback((k: string) => setRaw((r) => (r.length >= 20 ? r : r + k)), []);
  const onPlus = useCallback(() => setRaw((r) => (r === '' || r === '0' ? '+' : r)), []);
  const back = (): void => setRaw((r) => r.slice(0, -1));
  const onPaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    e.preventDefault();
    const n = cleanPastedNumber(e.clipboardData.getData('text'));
    if (n) setRaw(n);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      call();
    }
  };
  const shown = display(raw);
  // 32 px, shrinking down to 24 for long numbers: never wraps (ADR-0137 §7).
  const big = phone ? (shown.length > 16 ? 'text-[24px]!' : shown.length > 13 ? 'text-[28px]!' : 'text-[32px]!') : 'text-[26px]!';

  const body = (
    <div className={cx('flex flex-col items-center', phone ? 'min-h-0 flex-1 justify-end px-4 pb-[calc(var(--safe-bottom,0px)+20px)]' : 'gap-0')} data-testid="tel-dial">
      <div className={cx('flex w-full flex-col items-center', phone ? 'mb-[clamp(12px,3dvh,32px)]' : 'mb-4')}>
        <input
          ref={field}
          type="tel"
          inputMode={phone ? 'none' : 'tel'}
          autoComplete="off"
          // Desktop: typed from the keyboard at once; phone: focus only by a tap (the system keyboard stays down: inputmode none).
          autoFocus={!phone}
          value={shown}
          onChange={(e) => {
            const next = e.target.value;
            setRaw(/[*#]/.test(next) || /[*#]/.test(raw) ? dialChars(next) : dialChars(maskEdit(shown, next)));
          }}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          placeholder={phone ? '' : t('telc.dial.placeholder')}
          aria-label={t('telc.dial.number')}
          className={cx('selectable h-11 w-full min-w-0 truncate bg-transparent text-center font-normal tabular-nums text-fg caret-[var(--color-accent)] outline-none placeholder:text-faint', big)}
          data-testid="tel-dial-field"
        />
        <SuggestionLine suggestion={suggestion} raw={raw} place={place} digits={digits} onPick={(n) => setRaw(dialChars(n))} onCall={call} />
      </div>
      <Keypad size={phone ? 'phone' : 'desktop'} onKey={onKey} onPlus={onPlus} testId="tel-keypad" />
      <div className={cx('grid w-full grid-cols-3 items-center justify-items-center', phone ? 'mt-[clamp(12px,2.6dvh,24px)] max-w-[300px]' : 'mt-4 max-w-[232px]')}>
        <span aria-hidden />
        <button
          type="button"
          onClick={call}
          disabled={!canCall}
          aria-label={suggestion?.kind === 'ext' ? t('telc.dial.callExt', { name: suggestion.name }) : t('tel.call')}
          className={cx('grid place-items-center rounded-full bg-ok-fill text-white transition-[filter,opacity] duration-[var(--motion-fast)] hover:brightness-110 active:brightness-90 disabled:opacity-40', phone ? 'size-[72px]' : 'size-14')}
          data-testid="tel-dial-call"
        >
          <Phone className={phone ? 'size-8' : 'size-6'} fill="currentColor" strokeWidth={1.5} aria-hidden />
        </button>
        {raw ? <BackKey phone={phone} onBack={back} onClear={() => setRaw('')} /> : <span aria-hidden />}
      </div>
    </div>
  );
  if (phone) {
    return (
      <section className="mat-content flex min-h-0 flex-1 flex-col" data-testid="tel-dial-screen">
        <PhoneHeader title={t('telc.dial')} />
        {body}
      </section>
    );
  }
  return (
    <section className="flex min-w-0 flex-1 flex-col items-center overflow-y-auto px-4 py-10" aria-label={t('telc.dial')} data-testid="tel-dial-page">
      <div className="my-auto w-[320px] max-w-full rounded-[var(--radius-panel)] bg-[var(--color-card)] px-6 pb-6 pt-5 shadow-[var(--shadow-card)]">{body}</div>
    </section>
  );
}

/** One line under the number that never changes the layout: the suggestion, «Добавить в контакты», or why not. */
function SuggestionLine({
  suggestion,
  raw,
  place,
  digits,
  onPick,
  onCall,
}: {
  suggestion: DialSuggestion | null;
  raw: string;
  place: boolean;
  digits: number;
  onPick: (n: string) => void;
  onCall: () => void;
}): ReactNode {
  const line = 'flex h-10 max-w-full items-center justify-center gap-1.5 rounded-full px-3 text-body';
  if (suggestion?.kind === 'ext') {
    return (
      <button type="button" className={cx(line, 'text-accent-text hover:bg-hover')} onClick={onCall} data-testid="tel-dial-suggestion">
        <span className="min-w-0 truncate font-medium">{suggestion.name}</span>
        <span className="shrink-0 tabular-nums text-muted">· {t('tel.ext', { n: suggestion.number })}</span>
      </button>
    );
  }
  if (suggestion?.kind === 'contact') {
    const title = suggestion.name || suggestion.company;
    return (
      <button
        type="button"
        className={cx(line, 'text-accent-text hover:bg-hover')}
        onClick={() => onPick(formatPhone(suggestion.number))}
        title={t('telc.dial.useContact', { name: title, number: formatPhone(suggestion.number) })}
        data-testid="tel-dial-suggestion"
      >
        <span className="min-w-0 truncate font-medium">{title}</span>
        {suggestion.name && suggestion.company ? <span className="min-w-0 shrink truncate text-muted">· {suggestion.company}</span> : null}
        {suggestion.exact ? null : <span className="shrink-0 tabular-nums text-muted">· {formatPhone(suggestion.number)}</span>}
      </button>
    );
  }
  if (!place && digits >= 3) {
    return (
      <p className={cx(line, 'text-caption text-muted')} data-testid="tel-dial-suggestion">
        {t('telc.dial.onlyInternal')}
      </p>
    );
  }
  // Without PLACE_CALLS (ADR-0137 §6): why outside numbers do not dial, in the same line (no jump).
  if (!place) {
    return (
      <p className="flex h-10 max-w-[300px] items-center justify-center text-center text-caption leading-4 text-muted" data-testid="tel-dial-no-place">
        {t('telc.dial.noPlace')}
      </p>
    );
  }
  if (digits >= 7 && !/[*#]/.test(raw)) {
    return (
      <button type="button" className={cx(line, 'text-accent-text hover:bg-hover')} onClick={() => editContact('', { number: display(raw) })} data-testid="tel-dial-add">
        <UserRoundPlus className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{t('telc.addContact')}</span>
      </button>
    );
  }
  return <div className="h-10" aria-hidden />;
}

/** ⌫: one character; held — the whole number. */
function BackKey({ phone, onBack, onClear }: { phone: boolean; onBack: () => void; onClear: () => void }): ReactNode {
  const hold = useRef<{ timer: number; fired: boolean } | null>(null);
  const cancel = (): void => {
    if (hold.current) window.clearTimeout(hold.current.timer);
  };
  return (
    <button
      type="button"
      aria-label={t('telc.dial.backspace')}
      className={cx('grid place-items-center rounded-full text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg [-webkit-touch-callout:none]', phone ? 'size-[72px]' : 'size-14')}
      onPointerDown={() => {
        cancel();
        const h = { fired: false, timer: 0 };
        h.timer = window.setTimeout(() => {
          h.fired = true;
          haptics.impact();
          onClear();
        }, CLEAR_HOLD_MS);
        hold.current = h;
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (hold.current?.fired) {
          hold.current = null;
          return;
        }
        hold.current = null;
        haptics.tap();
        onBack();
      }}
      data-testid="tel-dial-back"
    >
      <Delete className={phone ? 'size-7' : 'size-6'} strokeWidth={1.75} aria-hidden />
    </button>
  );
}
