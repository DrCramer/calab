import { RoomType, type RoomInvite } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2Off, Pencil } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, IconButton, Row, Select, Spinner, Tip, Toggle } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { fmt } from '../../lib/format';
import { api } from '../../lib/api/endpoints';
import { roomInviteUrl } from '../../services/links';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { roomLinkError } from './roomLink';
import { linkDraftOf, linkEditInit, maxUsesOptions, type LinkDraft } from './linkEdit';
import { LinkApprovalRow, LinkApprovalSelect, LinkApprovalTag, RoomApprovalCard, linkApprovalInit, type LinkApproval } from '../guests/ApprovalSettings';

const EXPIRY: Array<{ s: number; key: MessageKey }> = [
  { s: 3600, key: 'people.link.hour' },
  { s: 86400, key: 'people.link.day' },
  { s: 7 * 86400, key: 'people.link.week' },
  { s: 0, key: 'people.link.never' },
];
export const MAX_USES = [0, 1, 5, 10, 25, 50, 100];

/** Always https (docs/09 #53); '' only without a known server (nothing to copy then). */
export const linkOf = (i: Pick<RoomInvite, 'code'>): string => roomInviteUrl(useSession.getState().serverUrl, i.code) ?? '';

async function copy(i: RoomInvite, created = false): Promise<void> {
  try {
    const link = linkOf(i);
    if (!link) throw new Error('no server URL for the room link');
    await navigator.clipboard.writeText(link);
    toast.success(created ? `${t('people.link.created')} · ${t('people.link.copied').toLowerCase()}` : t('people.link.copied'));
  } catch {
    if (created) toast.success(t('people.link.created'));
  }
}

function expiryText(i: RoomInvite): string {
  return i.expiresAt ? t('people.link.until', { date: fmt.dateTime(timestampDate(i.expiresAt), 'short') }) : t('people.link.forever');
}

/** One line about a link: expiry · uses · what guests may do. */
export function linkSummary(i: RoomInvite, voice: boolean): string {
  const rights = [
    voice && i.allowSpeak ? t('people.link.speak') : '',
    i.allowMessages ? t('people.link.messages') : '',
    i.allowFiles ? t('people.link.files') : '',
    voice && i.allowStream ? t('people.link.stream') : '',
  ]
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  return [
    expiryText(i),
    i.maxUses ? t('people.link.uses', { uses: i.uses, max: i.maxUses }) : t('people.link.usesUnlimited', { uses: i.uses }),
    i.membersOnly ? t('people.link.membersShort') : i.allowGuests ? '' : t('people.link.guestsOff'),
    rights.join(', '),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Room settings → «Ссылка для гостей» (docs/09 #35, ADR-0016): create a link (expiry, max
 * uses, guest rights), copy it, edit it (ADR-0107), revoke, list active ones. `guests`:
 * INVITE_GUESTS (ADR-0043, server-checked); without it (INVITE_MEMBERS, or the creator of a
 * temporary room, ADR-0044) only members-only links are made and listed. The room's own approval
 * switch also needs MANAGE_ROOM (`manage`).
 */
export function RoomLinkTab({ roomId, manage, guests: guestLinks = true }: { roomId: string; manage: boolean; guests?: boolean }): ReactNode {
  const voice = useRooms((s) => s.byId[roomId]?.type === RoomType.VOICE);
  const qc = useQueryClient();
  const key = ['roomInvites', roomId];
  const q = useQuery({ queryKey: key, queryFn: () => api.roomInvites.list(roomId) });
  const [expires, setExpires] = useState(7 * 86400);
  const [maxUses, setMaxUses] = useState(0);
  const [guests, setGuests] = useState(true);
  const [speak, setSpeak] = useState(true);
  const [messages, setMessages] = useState(true);
  const [files, setFiles] = useState(false);
  const [stream, setStream] = useState(false);
  const [approval, setApproval] = useState<LinkApproval>('inherit');

  const create = useMutation({
    mutationFn: () =>
      api.roomInvites.create(roomId, {
        expiresInSeconds: expires,
        maxUses,
        allowSpeak: voice && speak,
        allowMessages: messages,
        allowFiles: files,
        allowStream: voice && stream,
        ...(guestLinks ? { allowGuests: guests, ...linkApprovalInit(approval) } : { membersOnly: true }),
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: key });
      if (r.invite) void copy(r.invite, true);
    },
    onError: (e) => toast.error(roomLinkError(e)),
  });
  const [editing, setEditing] = useState<string | null>(null);

  const invites = q.data?.invites ?? [];
  return (
    <>
      {manage && guestLinks ? <RoomApprovalCard roomId={roomId} /> : null}
      <Card title={t('people.link.new')} footer={guestLinks ? t('people.link.newHint') : t('people.link.newMembersHint')}>
        <Row label={t('people.link.expiry')}>
          <Select aria-label={t('people.link.expiry')} className="w-60" value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
            {EXPIRY.map((x) => (
              <option key={x.s} value={x.s}>
                {t(x.key)}
              </option>
            ))}
          </Select>
        </Row>
        <Row label={t('people.link.maxUses')}>
          <Select aria-label={t('people.link.maxUses')} className="w-60" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            {MAX_USES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t('people.link.unlimited') : n}
              </option>
            ))}
          </Select>
        </Row>
        {guestLinks ? (
          <>
            <Row label={t('people.link.allowGuests')} hint={t('people.link.allowGuestsHint')}>
              <Toggle label={t('people.link.allowGuests')} checked={guests} onChange={setGuests} />
            </Row>
            <LinkApprovalRow roomId={roomId} value={approval} onChange={setApproval} />
          </>
        ) : null}
      </Card>
      <Card title={guestLinks ? t('people.link.rights') : t('people.link.rightsMembers')}>
        {voice ? (
          <Row label={t('people.link.speak')}>
            <Toggle label={t('people.link.speak')} checked={speak} onChange={setSpeak} />
          </Row>
        ) : null}
        <Row label={t('people.link.messages')}>
          <Toggle label={t('people.link.messages')} checked={messages} onChange={setMessages} />
        </Row>
        <Row label={t('people.link.files')}>
          <Toggle label={t('people.link.files')} checked={files} onChange={setFiles} />
        </Row>
        {voice ? (
          <Row label={t('people.link.stream')}>
            <Toggle label={t('people.link.stream')} checked={stream} onChange={setStream} />
          </Row>
        ) : null}
      </Card>
      <div className="-mt-3 flex justify-end">
        <Button busy={create.isPending} onClick={() => create.mutate()}>
          {t('people.link.create')}
        </Button>
      </div>
      <Card title={t('people.link.active')}>
        {q.isLoading ? (
          <div className="grid min-h-10 place-items-center">
            <Spinner className="size-4" />
          </div>
        ) : invites.length === 0 ? (
          <p className="flex min-h-10 items-center px-3 text-body text-muted">{t('people.link.none')}</p>
        ) : (
          invites.map((i) => (
            <LinkRow
              key={i.id}
              roomId={roomId}
              invite={i}
              voice={voice}
              approval={guestLinks && !i.membersOnly}
              editing={editing === i.id}
              onEdit={setEditing}
            />
          ))
        )}
      </Card>
    </>
  );
}

/**
 * One active link: address, summary, its approval (guest links), edit · copy · revoke. «Изменить»
 * opens the row's editor below it (one at a time): a new expiry from now, the use limit, the
 * rights — PATCH of what changed (ADR-0107; members_only / guests never change, a new link
 * instead).
 */
const LinkRow = memo(function LinkRow({
  roomId,
  invite: i,
  voice,
  approval,
  editing,
  onEdit,
}: {
  roomId: string;
  invite: RoomInvite;
  voice: boolean;
  approval: boolean;
  editing: boolean;
  onEdit: (id: string | null) => void;
}): ReactNode {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.roomInvites.revoke(roomId, i.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['roomInvites', roomId] }),
    onError: (e) => toast.error(roomLinkError(e)),
  });
  const link = linkOf(i);
  const summary = linkSummary(i, voice);
  return (
    <div>
      <div className="flex min-h-12 items-center gap-3 px-3 py-2">
        <div className="min-w-0 flex-1">
          <Tip label={link}>
            <code className="selectable block truncate font-mono text-caption">{link}</code>
          </Tip>
          <div className="flex min-w-0 items-center gap-1.5">
            <Tip label={summary}>
              <span className="truncate text-caption text-muted">{summary}</span>
            </Tip>
            {approval ? <LinkApprovalTag roomId={roomId} invite={i} /> : null}
          </div>
        </div>
        {approval ? <LinkApprovalSelect roomId={roomId} invite={i} /> : null}
        {/* Meeting guest links follow their meeting (ADR-0038): not edited by hand. */}
        {i.eventId ? null : (
          <IconButton label={t('people.link.editAria', { code: i.code })} active={editing} aria-expanded={editing} onClick={() => onEdit(editing ? null : i.id)}>
            <Pencil className="size-4" />
          </IconButton>
        )}
        <IconButton label={t('people.link.copyAria', { code: i.code })} onClick={() => void copy(i)}>
          <Copy className="size-4" />
        </IconButton>
        <IconButton
          label={t('people.link.revokeAria', { code: i.code })}
          danger
          onClick={() => void confirmAction(t('people.link.revoke'), t('people.link.revokeConfirm'), t('people.link.revoke')).then((ok) => ok && revoke.mutate())}
        >
          <Link2Off className="size-4" />
        </IconButton>
      </div>
      {editing ? <LinkEditor roomId={roomId} invite={i} voice={voice} onDone={() => onEdit(null)} /> : null}
    </div>
  );
});

function LinkEditor({ roomId, invite: i, voice, onDone }: { roomId: string; invite: RoomInvite; voice: boolean; onDone: () => void }): ReactNode {
  const qc = useQueryClient();
  const [d, setD] = useState<LinkDraft>(() => linkDraftOf(i));
  const set = (patch: Partial<LinkDraft>): void => setD((cur) => ({ ...cur, ...patch }));
  const init = linkEditInit(i, d, voice);
  const save = useMutation({
    mutationFn: () => api.roomInvites.update(roomId, i.id, init ?? {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['roomInvites', roomId] });
      toast.success(t('people.link.saved'));
      onDone();
    },
    onError: (e) => toast.error(roomLinkError(e)),
  });
  return (
    <div className="mx-3 mb-3 rounded-[var(--radius-card)] border border-line" data-testid="room-link-editor">
      <Row label={t('people.link.expiry')}>
        <Select
          aria-label={t('people.link.expiry')}
          className="w-60"
          value={String(d.expires)}
          onChange={(e) => set({ expires: e.target.value === 'keep' ? 'keep' : Number(e.target.value) })}
        >
          <option value="keep">{t('people.link.keep', { value: expiryText(i) })}</option>
          {EXPIRY.map((x) => (
            <option key={x.s} value={x.s}>
              {t(x.key)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('people.link.maxUses')}>
        <Select aria-label={t('people.link.maxUses')} className="w-60" value={d.maxUses} onChange={(e) => set({ maxUses: Number(e.target.value) })}>
          {maxUsesOptions(i, MAX_USES).map((n) => (
            <option key={n} value={n}>
              {n === 0 ? t('people.link.unlimited') : n}
            </option>
          ))}
        </Select>
      </Row>
      {voice ? (
        <Row label={t('people.link.speak')}>
          <Toggle label={t('people.link.speak')} checked={d.speak} onChange={(v) => set({ speak: v })} />
        </Row>
      ) : null}
      <Row label={t('people.link.messages')}>
        <Toggle label={t('people.link.messages')} checked={d.messages} onChange={(v) => set({ messages: v })} />
      </Row>
      <Row label={t('people.link.files')}>
        <Toggle label={t('people.link.files')} checked={d.files} onChange={(v) => set({ files: v })} />
      </Row>
      {voice ? (
        <Row label={t('people.link.stream')}>
          <Toggle label={t('people.link.stream')} checked={d.stream} onChange={(v) => set({ stream: v })} />
        </Row>
      ) : null}
      <div className="flex justify-end gap-2 px-3 py-2">
        <Button variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button busy={save.isPending} disabled={!init} onClick={() => save.mutate()}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
