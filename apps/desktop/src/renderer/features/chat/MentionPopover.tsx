import { RoomType, type Role, type Room, type WorkspaceRole } from '@calaba/protocol';
import { AtSign, EyeOff } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { SPECIAL, type MentionCandidate } from '../../lib/mentions';
import { mentionableOnBoard, pickerAccess } from '../../lib/boards/access';
import { cachedMentionAccess, loadMentionAccess, type MentionAccess } from '../../lib/boards/mentionAccess';
import { can, roomPerms } from '../../lib/permissions';
import { customLook, rolesOfMember } from '../../lib/roles';
import { useBoards } from '../../stores/boards';
import { isGuest, useWorkspaces } from '../../stores/workspaces';
import { BotBadge, RoleMark, roleTextClass, roleTextStyle } from '../people/MemberBits';

export type MentionOption = { kind: 'member'; c: MentionCandidate; guest: boolean; outsider?: 'card' | undefined; role?: WorkspaceRole | undefined; custom?: Role | undefined } | { kind: 'special'; v: (typeof SPECIAL)[number] };

export const optionKey = (o: MentionOption): string => (o.kind === 'member' ? o.c.id : o.v);

export interface Mentionables {
  /** Members who can see the room, except me (popover candidates). */
  candidates: MentionCandidate[];
  guests: Set<string>;
  /**
   * Task rooms: members who do not see the board; the mention opens this card to them. Any
   * commenter may call them, editing rights do not matter (ADR-0076 §5).
   */
  outsiders: Map<string, 'card'>;
  /** Workspace role per candidate (name colour + RoleMark, docs/09 #26). */
  roles: Map<string, { role: WorkspaceRole; custom: Role | undefined }>;
  /** Every member of the workspace with the name shown in the field (typed-name conversion). */
  all: Array<{ id: string; name: string }>;
}

/** Members of the workspace for the composer: names are nickname-aware (like memberName()). */
export function useMentionables(workspaceId: string, room: Room, me: string, active = false): Mentionables {
  // Members and roles, not the whole entry: that one changes on every voice state.
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const wsRoles = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  // A task's comment room is hidden and its access derives from the board (ADR-0042): the
  // board object (stable between edits) decides, not the room's own overrides.
  const isTask = room.type === RoomType.TASK;
  const board = useBoards((s) => (isTask ? s.boards[s.tasks[s.roomTask[room.id] ?? '']?.boardId ?? ''] : undefined));
  // A commenter without MANAGE_BOARD never receives the board's overrides, so the server tells who
  // sees the board (ADR-0076 §5): asked once per open popover (cached), the local guess meanwhile.
  const taskId = useBoards((s) => (isTask ? (s.roomTask[room.id] ?? '') : ''));
  const [fetched, setFetched] = useState<{ taskId: string; v: MentionAccess } | null>(null);
  useEffect(() => {
    if (!active || !taskId) return;
    if (cachedMentionAccess(taskId)) return;
    let live = true;
    const ids = Object.values(members ?? {}).flatMap((m) => (m.user && m.user.id !== me ? [m.user.id] : []));
    void loadMentionAccess(taskId, ids).then((v) => {
      if (live && v) setFetched({ taskId, v });
    });
    return () => {
      live = false;
    };
  }, [active, taskId, members, me]);
  const acc = (fetched && fetched.taskId === taskId ? fetched.v : undefined) ?? (active && taskId ? cachedMentionAccess(taskId) : undefined);
  return useMemo(() => {
    const out: Mentionables = { candidates: [], guests: new Set(), outsiders: new Map(), roles: new Map(), all: [] };
    for (const m of Object.values(members ?? {})) {
      const u = m.user;
      if (!u) continue;
      const name = m.nickname || u.displayName;
      out.all.push({ id: u.id, name });
      const roles = wsRoles ? rolesOfMember(wsRoles, m) : [];
      if (u.id === me) continue;
      // The server's answer wins for the members it was asked about (guests keep the local rule).
      const known = isTask && acc && acc.asked.has(u.id) && !isGuest(m);
      if (known && !acc.see.has(u.id) && !acc.card.has(u.id)) continue;
      const sees = known ? acc.see.has(u.id) : isTask ? mentionableOnBoard(board, wsRoles ?? [], m) : can(roomPerms(roles, u.id, room), 'VIEW_ROOM');
      if (!sees) {
        // A task comment may call a workspace member without board access: the card opens to them
        // (ADR-0076 §5). Guests and bots without access are not offered.
        if (!isTask || isGuest(m) || (!known && pickerAccess(board, wsRoles ?? [], m) !== 'card')) continue;
        out.outsiders.set(u.id, 'card');
      }
      if (isGuest(m)) out.guests.add(u.id);
      out.roles.set(u.id, { role: m.role, custom: customLook(roles) });
      out.candidates.push({ id: u.id, name, alt: m.nickname && m.nickname !== u.displayName ? [u.displayName] : [], ...(u.username ? { nick: u.username } : {}) });
    }
    return out;
  }, [members, wsRoles, me, room, isTask, board, acc]);
}

/**
 * Mention autocomplete above the composer field (Discord-like). Focus stays in the field:
 * ↑/↓, Enter/Tab and Esc are handled by the composer; the mouse picks without blurring it.
 */
export function MentionPopover({
  id,
  options,
  sel,
  onPick,
  onHover,
}: {
  id: string;
  options: MentionOption[];
  sel: number;
  onPick: (o: MentionOption) => void;
  onHover: (i: number) => void;
}): ReactNode {
  const users = useWorkspaces((s) => s.users);
  return (
    // A name list needs no full composer width: ≤ 420 px, anchored to the field's left edge.
    <div className="mat-popover dense anim-in absolute bottom-full left-0 z-[var(--z-popover)] mb-2 w-full max-w-[420px] overflow-hidden rounded-[var(--radius-card)]">
      <div className="px-3 pb-1 pt-2 text-micro font-semibold text-muted" aria-hidden>
        {t('chat.mentionList')}
      </div>
      <ul id={id} role="listbox" aria-label={t('chat.mentionList')} className="max-h-[min(320px,40vh)] overflow-y-auto p-1 pt-0">
        {options.map((o, i) => {
          const active = i === sel;
          const key = optionKey(o);
          return (
            <li
              key={key}
              id={`${id}-${key}`}
              role="option"
              aria-selected={active}
              ref={active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(o);
              }}
              onMouseMove={() => (active ? undefined : onHover(i))}
              className={cx(
                'flex h-9 cursor-default items-center gap-2.5 rounded-[5px] px-2 text-body',
                active ? 'bg-accent-strong text-accent-fg' : 'text-fg',
              )}
            >
              {o.kind === 'member' ? (
                <>
                  <Avatar userId={o.c.id} name={o.c.name} fileId={users[o.c.id]?.avatarFileId || undefined} size={24} />
                  <span
                    className={cx('min-w-0 truncate font-medium', roleTextClass(o.role, active ? 'inherit' : 'role', o.custom))}
                    style={roleTextStyle(o.role, active ? 'inherit' : 'role', o.custom)}
                    title={o.c.name}
                  >
                    {o.c.name}
                  </span>
                  <RoleMark role={o.role} custom={o.custom} tone={active ? 'inherit' : 'role'} />
                  {users[o.c.id]?.isBot ? <BotBadge tone={active ? 'inherit' : 'neutral'} /> : null}
                  {o.c.alt[0] ? <span className={cx('min-w-0 truncate', active ? 'text-accent-fg' : 'text-muted')}>{o.c.alt[0]}</span> : null}
                  {/* The nickname (ADR-0077): found by it, the name is what gets inserted. */}
                  {o.c.nick ? <span className={cx('min-w-0 truncate', active ? 'text-accent-fg' : 'text-muted')}>@{o.c.nick}</span> : null}
                  {o.outsider ? (
                    <span className={cx('ml-auto flex min-w-0 max-w-[58%] shrink items-center gap-1 text-micro', active ? 'text-accent-fg' : 'text-muted')}>
                      <EyeOff className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">{t('chat.mentionOutsider')}</span>
                    </span>
                  ) : o.guest ? (
                    <span className={cx('ml-auto shrink-0 text-micro', active ? 'text-accent-fg' : 'text-muted')}>{t('chat.mentionGuest')}</span>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-hover">
                    <AtSign className="size-3.5" aria-hidden />
                  </span>
                  <span className="shrink-0 font-medium">@{o.v}</span>
                  <span className={cx('min-w-0 truncate', active ? 'text-accent-fg' : 'text-muted')}>
                    {t(o.v === 'everyone' ? 'chat.mentionEveryone' : 'chat.mentionHere')}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
