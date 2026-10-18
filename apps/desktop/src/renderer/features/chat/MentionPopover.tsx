import { RoomType, type Role, type Room, type WorkspaceRole } from '@calaba/protocol';
import { AtSign, EyeOff } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { SPECIAL, type MentionCandidate } from '../../lib/mentions';
import { mentionableOnBoard, pickerAccess } from '../../lib/boards/access';
import { mayEditTask } from '../boards/model';
import { taskPermsOf } from '../../stores/boards';
import { myUserId } from '../../stores/session';
import { can, roomPerms } from '../../lib/permissions';
import { customLook, rolesOfMember } from '../../lib/roles';
import { useBoards } from '../../stores/boards';
import { isGuest, useWorkspaces } from '../../stores/workspaces';
import { BotBadge, RoleMark, roleTextClass, roleTextStyle } from '../people/MemberBits';

export type MentionOption = { kind: 'member'; c: MentionCandidate; guest: boolean; outsider?: 'card' | 'locked' | undefined; role?: WorkspaceRole | undefined; custom?: Role | undefined } | { kind: 'special'; v: (typeof SPECIAL)[number] };

export const optionKey = (o: MentionOption): string => (o.kind === 'member' ? o.c.id : o.v);

export interface Mentionables {
  /** Members who can see the room, except me (popover candidates). */
  candidates: MentionCandidate[];
  guests: Set<string>;
  /**
   * Task rooms: members who do not see the board. 'card' = the mention opens this card to them (the
   * author may edit the task); 'locked' = the author cannot edit it, so cannot call them (ADR-0076 §4–5).
   */
  outsiders: Map<string, 'card' | 'locked'>;
  /** Workspace role per candidate (name colour + RoleMark, docs/09 #26). */
  roles: Map<string, { role: WorkspaceRole; custom: Role | undefined }>;
  /** Every member of the workspace with the name shown in the field (typed-name conversion). */
  all: Array<{ id: string; name: string }>;
}

/** Members of the workspace for the composer: names are nickname-aware (like memberName()). */
export function useMentionables(workspaceId: string, room: Room, me: string): Mentionables {
  // Members and roles, not the whole entry: that one changes on every voice state.
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const wsRoles = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  // A task's comment room is hidden and its access derives from the board (ADR-0042): the
  // board object (stable between edits) decides, not the room's own overrides.
  const isTask = room.type === RoomType.TASK;
  const board = useBoards((s) => (isTask ? s.boards[s.tasks[s.roomTask[room.id] ?? '']?.boardId ?? ''] : undefined));
  // May the author edit the task (= open its card to the mentioned, ADR-0076 §4–5): one boolean.
  const canEdit = useBoards((s) => {
    const task = isTask ? s.tasks[s.roomTask[room.id] ?? ''] : undefined;
    return task ? mayEditTask(task, taskPermsOf(s, task, myUserId()), myUserId()) : false;
  });
  return useMemo(() => {
    const out: Mentionables = { candidates: [], guests: new Set(), outsiders: new Map(), roles: new Map(), all: [] };
    for (const m of Object.values(members ?? {})) {
      const u = m.user;
      if (!u) continue;
      const name = m.nickname || u.displayName;
      out.all.push({ id: u.id, name });
      const roles = wsRoles ? rolesOfMember(wsRoles, m) : [];
      if (u.id === me) continue;
      const sees = isTask ? mentionableOnBoard(board, wsRoles ?? [], m) : can(roomPerms(roles, u.id, room), 'VIEW_ROOM');
      if (!sees) {
        // A task comment may call a workspace member without board access: the card opens to them
        // (ADR-0076 §5). Guests and bots without access are not offered.
        if (!isTask || isGuest(m) || pickerAccess(board, wsRoles ?? [], m) !== 'card') continue;
        out.outsiders.set(u.id, canEdit ? 'card' : 'locked');
      }
      if (isGuest(m)) out.guests.add(u.id);
      out.roles.set(u.id, { role: m.role, custom: customLook(roles) });
      out.candidates.push({ id: u.id, name, alt: m.nickname && m.nickname !== u.displayName ? [u.displayName] : [], ...(u.username ? { nick: u.username } : {}) });
    }
    return out;
  }, [members, wsRoles, me, room, isTask, board, canEdit]);
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
              aria-disabled={o.kind === 'member' && o.outsider === 'locked' ? true : undefined}
              ref={active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(o);
              }}
              onMouseMove={() => (active ? undefined : onHover(i))}
              className={cx(
                'flex h-9 cursor-default items-center gap-2.5 rounded-[5px] px-2 text-body',
                active ? 'bg-accent-strong text-accent-fg' : 'text-fg',
                o.kind === 'member' && o.outsider === 'locked' && 'opacity-60',
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
                    <span
                      className={cx('ml-auto flex min-w-0 max-w-[58%] shrink items-center gap-1 text-micro', active ? 'text-accent-fg' : 'text-muted')}
                      title={t(o.outsider === 'card' ? 'chat.mentionOutsiderHint' : 'chat.mentionOutsiderLocked')}
                    >
                      <EyeOff className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">{t(o.outsider === 'card' ? 'chat.mentionOutsider' : 'chat.mentionOutsiderLocked')}</span>
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
