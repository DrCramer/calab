/**
 * The text field of a canvas comment (ADR-0115 wave 4) with the project's @ autocomplete (MentionPopover):
 * the field shows `@Имя`, the wire text holds `@<user_id>` (lib/mentions). Only members the server says see
 * the canvas are offered (GET …/comments/mention-access, cached a minute); nobody is offered until it answers.
 * Enter sends, Shift+Enter breaks the line, Esc cancels.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, cx } from '../../../../components/ui';
import { t } from '../../../../i18n';
import { mentionCount } from '../../../../lib/canvas/comments';
import { applyMention, exactNames, filterCandidates, fromWire, mentionQuery, toWire, type MentionCandidate } from '../../../../lib/mentions';
import { canvasMentionAccess, cachedCanvasMentionAccess, COMMENT_MAX, COMMENT_MENTIONS_MAX } from '../../../../services/canvasComments';
import { myUserId } from '../../../../stores/session';
import { isGuest, memberName, useWorkspaces } from '../../../../stores/workspaces';
import { MentionPopover, type MentionOption } from '../../../chat/MentionPopover';

export interface CommentInputProps {
  canvasId: string;
  workspaceId: string;
  /** The wire text to edit (an edit); empty for a new comment. */
  initial?: string;
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  /** Resolves true when written: the field clears. */
  onSubmit: (wire: string) => Promise<boolean>;
  onCancel?: () => void;
}

export function CommentInput({ canvasId, workspaceId, initial = '', placeholder, submitLabel, autoFocus = false, onSubmit, onCancel }: CommentInputProps): ReactNode {
  const start = useMemo(() => fromWire(initial, (id) => memberName(workspaceId, id)), [initial, workspaceId]);
  const [text, setText] = useState(start.text);
  const [caret, setCaret] = useState(start.text.length);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  // The @ just completed (or closed with Esc): its list stays closed while the caret is still after it.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [see, setSee] = useState<ReadonlySet<string> | undefined>(() => cachedCanvasMentionAccess(canvasId));
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(start.mentions);
  const field = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const users = useWorkspaces((s) => s.users);
  const me = myUserId();

  // Who may be called: asked when the field is used, not for every comment on screen.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!asked || see) return undefined;
    let live = true;
    const ids = Object.values(members ?? {}).flatMap((m) => (m.user && m.user.id !== me && !users[m.user.id]?.isBot ? [m.user.id] : []));
    void canvasMentionAccess(canvasId, ids).then((v) => {
      if (live && v) setSee(v);
    });
    return () => {
      live = false;
    };
  }, [asked, see, canvasId, members, users, me]);

  const { candidates, all, guests } = useMemo(() => {
    const out = { candidates: [] as MentionCandidate[], all: [] as Array<{ id: string; name: string }>, guests: new Set<string>() };
    for (const m of Object.values(members ?? {})) {
      const u = m.user;
      if (!u) continue;
      const name = m.nickname || u.displayName;
      out.all.push({ id: u.id, name });
      if (u.id === me || !see?.has(u.id)) continue;
      if (isGuest(m)) out.guests.add(u.id);
      out.candidates.push({ id: u.id, name, alt: m.nickname && m.nickname !== u.displayName ? [u.displayName] : [], ...(u.username ? { nick: u.username } : {}) });
    }
    return out;
  }, [members, see, me]);

  const query = mentionQuery(text, caret);
  const options: MentionOption[] = query && query.start !== dismissed ? filterCandidates(query.query, candidates).map((c) => ({ kind: 'member', c, guest: guests.has(c.id) })) : [];
  const popover = options.length > 0;

  const wire = (): string => {
    const known = exactNames(all);
    for (const [name, id] of picked) known.set(name, id);
    return toWire(text.trim(), known);
  };
  const tooLong = text.length > COMMENT_MAX;

  const pick = (o: MentionOption): void => {
    if (o.kind !== 'member' || !query) return;
    setPicked((m) => new Map(m).set(o.c.name, o.c.id));
    setDismissed(query.start);
    const next = applyMention(text, query.start, caret, o.c.name);
    setText(next.text);
    setCaret(next.caret);
    setSel(0);
    requestAnimationFrame(() => field.current?.setSelectionRange(next.caret, next.caret));
  };

  const submit = async (): Promise<void> => {
    const w = wire();
    if (!w || busy || tooLong) return;
    if (mentionCount(w) > COMMENT_MENTIONS_MAX) return;
    setBusy(true);
    const ok = await onSubmit(w);
    setBusy(false);
    if (ok) {
      setText('');
      setCaret(0);
      setDismissed(null);
      setPicked(new Map());
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (popover) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const o = options[Math.min(sel, options.length - 1)];
        if (o) pick(o);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (popover && query) setDismissed(query.start);
      else onCancel?.();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const tooMany = text.includes('@') && mentionCount(wire()) > COMMENT_MENTIONS_MAX;
  return (
    <div className="relative flex flex-col gap-1.5" data-testid="canvas-comment-input">
      {popover ? <MentionPopover id={listId} options={options} sel={Math.min(sel, options.length - 1)} onPick={pick} onHover={setSel} /> : null}
      <textarea
        ref={field}
        rows={2}
        value={text}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-controls={popover ? listId : undefined}
        aria-expanded={popover}
        aria-autocomplete="list"
        onFocus={() => setAsked(true)}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setSel(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        className={cx(
          'max-h-40 min-h-[52px] w-full resize-none rounded-[var(--radius-control)] border border-line bg-main px-2.5 py-1.5 text-body text-fg outline-none placeholder:text-muted focus:border-accent',
          (tooLong || tooMany) && 'border-danger focus:border-danger',
        )}
      />
      <div className="flex items-center justify-end gap-1.5">
        {tooLong ? <span className="mr-auto text-caption text-danger">{t('canvasComments.tooLong', { n: COMMENT_MAX })}</span> : null}
        {!tooLong && tooMany ? <span className="mr-auto text-caption text-danger">{t('canvasComments.tooManyMentions', { n: COMMENT_MENTIONS_MAX })}</span> : null}
        {onCancel ? (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        ) : null}
        <Button size="sm" busy={busy} disabled={!text.trim() || tooLong || tooMany} onClick={() => void submit()} data-testid="canvas-comment-send">
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
