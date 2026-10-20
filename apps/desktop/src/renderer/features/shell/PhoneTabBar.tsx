import * as Dropdown from '../../components/radix/dropdown-menu';
import { WorkspaceRole } from '@calaba/protocol';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { Ellipsis, GripVertical, Pin } from 'lucide-react';
import { memo, useCallback, useMemo, type ReactNode } from 'react';
import { BoardsActiveIcon, BoardsIdleIcon, CalendarActiveIcon, CalendarIdleIcon, CanvasActiveIcon, CanvasIdleIcon, DiskActiveIcon, DiskIdleIcon, PersonalActiveIcon, PersonalIdleIcon, TeamActiveIcon, TeamIdleIcon, WikiActiveIcon, WikiIdleIcon } from '../../assets/nav/icons';
import { CountBadge, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { PHONE_TABS, PINNED_COUNT, barTabs, moveTab, togglePin, type PhoneTab } from '../../lib/phoneNav';
import { UNREAD_DOT, dmBadge, type Badge } from '../../lib/sections';
import { openTab } from '../../services/phoneNav';
import { unreadCount, useBoards } from '../../stores/boards';
import { HOME, isDm } from '../../stores/dms';
import { usePrefs } from '../../stores/prefs';
import { showsUnread, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { ProfileTabIcon } from './PhoneProfile';

/**
 * The phone's bottom tab bar (ADR-0073 §1, ADR-0095 + addendum 2026-10-14): four pinned tabs and
 * «Ещё», five equal cells. «Ещё» opens a centred card (a Radix Dropdown: lib/phoneMenus.ts does the
 * card look) with every section the account may open, a 52 px row each: icon · name · unread · pin ·
 * drag handle. A tap on a row opens the section; the pin only pins/unpins (disabled with a hint when
 * four are pinned) and never reorders; the order of the rows (long-press the handle, drag) is the
 * left-to-right order of the pinned tabs. When the open section is not pinned, the fifth cell shows
 * its icon and name exactly like a tab; a tap reopens the card.
 *
 * Re-renders (CLAUDE.md): the bar subscribes to primitives (guest flag, can-open-full), the pinned
 * list and the order; buttons are memo; badges are leaves with id-free primitive selectors that
 * short-circuit to 0 for tabs they do not show; the card is mounted only while open (Radix portal),
 * its rows get primitives only.
 */

/** The name of a tab, as the bar and the card show it. */
export function tabLabel(tab: PhoneTab): string {
  switch (tab) {
    case 'chats':
      return t('mobile.tabChats');
    case 'dms':
      return t('mobile.tabDms');
    case 'boards':
      return t('shell.modeBoards');
    case 'calendar':
      return t('cal.open');
    case 'disk':
      return t('mobile.tabDisk');
    case 'wiki':
      return t('mobile.tabWiki');
    case 'canvas':
      return t('canvas.section');
    case 'profile':
      return t('mobile.profile');
  }
}

/** The tab's icon: the owner's drawings (filled when open), «Профиль» my avatar. `cls` sizes the drawings. */
const TabIcon = memo(function TabIcon({ tab, active, cls }: { tab: PhoneTab; active: boolean; cls: string }): ReactNode {
  switch (tab) {
    case 'chats':
      return active ? <TeamActiveIcon className={cls} /> : <TeamIdleIcon className={cls} />;
    case 'dms':
      return active ? <PersonalActiveIcon className={cls} /> : <PersonalIdleIcon className={cls} />;
    case 'boards':
      return active ? <BoardsActiveIcon className={cls} /> : <BoardsIdleIcon className={cls} />;
    case 'calendar':
      return active ? <CalendarActiveIcon className={cls} /> : <CalendarIdleIcon className={cls} />;
    case 'disk':
      return active ? <DiskActiveIcon className={cls} /> : <DiskIdleIcon className={cls} />;
    case 'wiki':
      return active ? <WikiActiveIcon className={cls} /> : <WikiIdleIcon className={cls} />;
    case 'canvas':
      return active ? <CanvasActiveIcon className={cls} /> : <CanvasIdleIcon className={cls} />;
    case 'profile':
      return <ProfileTabIcon active={active} />;
  }
});

const ICON = 'size-7';

export function TabBar({ tab }: { tab: PhoneTab }): ReactNode {
  const guest = useSession((s) => !!s.me?.user?.isGuest);
  // Calendar, boards and the disk belong to a workspace the account is a full member of (a guest has rooms only).
  const full = useWorkspaces((s) => s.order.some((id) => s.byId[id] && s.byId[id].role !== WorkspaceRole.GUEST));
  const pinned = usePrefs((s) => s.phonePinnedTabs);
  const order = usePrefs((s) => s.phoneTabOrder);
  const available = useMemo(
    () =>
      PHONE_TABS.filter((x) => {
        if (x === 'dms') return !guest;
        if (x === 'boards' || x === 'calendar' || x === 'disk' || x === 'wiki' || x === 'canvas') return full && !guest;
        return true;
      }),
    [guest, full],
  );
  const { bar, more } = useMemo(() => barTabs(pinned, available, order), [pinned, available, order]);
  const hidden = useMemo(() => available.filter((x) => !bar.includes(x)), [available, bar]);
  const inBar = bar.includes(tab);
  return (
    <nav
      aria-label={t('mobile.tabs')}
      data-testid="phone-tabbar"
      className="mat-toolbar flex shrink-0 border-t border-line pb-[var(--safe-bottom,0px)] [.kb-open_&]:hidden"
    >
      {bar.map((x) => (
        <TabButton key={x} tab={x} active={x === tab} />
      ))}
      {more || !inBar ? <MoreButton tab={tab} inBar={inBar} hidden={hidden} available={available} bar={bar} /> : null}
    </nav>
  );
}

const BUTTON = 'relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-micro font-medium';

const TabButton = memo(function TabButton({ tab, active }: { tab: PhoneTab; active: boolean }): ReactNode {
  return (
    <button
      type="button"
      onClick={() => {
        if (!active) haptics.tap();
        openTab(tab);
      }}
      aria-current={active ? 'page' : undefined}
      data-testid={`phone-tab-${tab}`}
      className={cx(BUTTON, active ? 'text-fg' : 'text-muted')}
    >
      <span className="relative flex">
        <TabIcon tab={tab} active={active} cls={ICON} />
        <BadgeOf tabs={[tab]} />
      </span>
      <span className="max-w-full truncate px-1">{tabLabel(tab)}</span>
    </button>
  );
});

/** «Ещё» (`⋯`), or — when the open section is not pinned — that section, drawn like any other tab. */
const MoreButton = memo(function MoreButton({ tab, inBar, hidden, available, bar }: { tab: PhoneTab; inBar: boolean; hidden: readonly PhoneTab[]; available: readonly PhoneTab[]; bar: readonly PhoneTab[] }): ReactNode {
  const others = useMemo(() => (inBar ? hidden : hidden.filter((x) => x !== tab)), [inBar, hidden, tab]);
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          aria-current={inBar ? undefined : 'page'}
          aria-label={inBar ? t('mobile.more') : `${tabLabel(tab)}, ${t('mobile.more')}`}
          data-testid="phone-tab-more"
          className={cx(BUTTON, inBar ? 'text-muted' : 'text-fg')}
          onClick={() => haptics.tap()}
        >
          <span className="relative flex">
            {inBar ? (
              <span className={cx(ICON, 'flex items-center justify-center')}>
                <Ellipsis className="size-6" strokeWidth={1.75} aria-hidden />
              </span>
            ) : (
              <TabIcon tab={tab} active cls={ICON} />
            )}
            <BadgeOf tabs={others} />
          </span>
          <span className="max-w-full truncate px-1">{inBar ? t('mobile.more') : tabLabel(tab)}</span>
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          data-testid="phone-more-card"
          className="mat-popover anim-in z-[var(--z-popover)] w-72 rounded-[var(--radius-card)] p-1 text-fg"
          sideOffset={8}
          collisionPadding={16}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <MoreList available={available} bar={bar} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
});

/** The card's rows in the user's order; a drop on another row moves the dragged one there (pins untouched). */
function MoreList({ available, bar }: { available: readonly PhoneTab[]; bar: readonly PhoneTab[] }): ReactNode {
  const order = usePrefs((s) => s.phoneTabOrder);
  const rows = useMemo(() => order.filter((x) => available.includes(x)), [order, available]);
  const full = bar.length >= PINNED_COUNT;
  // Mouse: a small move starts a drag; touch: press and hold 300 ms (as the other lists), a swipe before that scrolls.
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 4 } }), useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }));
  const onEnd = useCallback((e: DragEndEvent): void => {
    const from = e.active.id as PhoneTab;
    const to = e.over?.id as PhoneTab | undefined;
    if (!to || from === to) return;
    usePrefs.getState().setPrefs({ phoneTabOrder: moveTab(usePrefs.getState().phoneTabOrder, from, to) });
    haptics.select();
  }, []);
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
      {rows.map((x) => (
        <MoreRow key={x} tab={x} pinned={bar.includes(x)} pinDisabled={full && !bar.includes(x)} bar={bar} />
      ))}
      {full ? (
        <p data-testid="more-pin-hint" className="px-3 pb-1.5 pt-1 text-micro text-muted">
          {t('mobile.pinFull')}
        </p>
      ) : null}
    </DndContext>
  );
}

/** Toggles the pin of `tab` on top of the bar as shown (so a guest's topped-up bar counts). The order is not touched. */
function pin(tab: PhoneTab, bar: readonly PhoneTab[]): void {
  const { pinned, full } = togglePin(bar, tab);
  if (full) return;
  usePrefs.getState().setPrefs({ phonePinnedTabs: pinned });
  haptics.select();
}

/** A row of the «Ещё» card: the section (tap = open), its pin (a separate 44 px button, the card stays open) and the drag handle. */
const MoreRow = memo(function MoreRow({ tab, pinned, pinDisabled, bar }: { tab: PhoneTab; pinned: boolean; pinDisabled: boolean; bar: readonly PhoneTab[] }): ReactNode {
  const active = useUi((s) => s.phone.tab === tab);
  const label = tabLabel(tab);
  const { setNodeRef: setDragRef, setActivatorNodeRef, listeners, transform, isDragging } = useDraggable({ id: tab });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: tab });
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef],
  );
  return (
    <div
      ref={setRef}
      className={cx('relative flex h-[52px] items-center', isDragging && 'z-10 rounded-[var(--radius-control)] bg-hover shadow-md', isOver && !isDragging && 'bg-hover/60')}
      style={transform ? { transform: `translate3d(0, ${Math.round(transform.y)}px, 0)` } : undefined}
      role="none"
      data-testid={`more-wrap-${tab}`}
    >
      <Dropdown.Item
        className="flex h-[52px] min-w-0 flex-1 cursor-default items-center gap-3 rounded-[var(--radius-control)] pl-2.5 pr-1 text-list outline-none data-[highlighted]:bg-hover"
        onSelect={() => {
          if (!active) haptics.tap();
          openTab(tab);
        }}
        aria-current={active ? 'page' : undefined}
        data-testid={`more-row-${tab}`}
      >
        <span className="flex size-7 shrink-0 items-center justify-center"><TabIcon tab={tab} active={active} cls="size-6" /></span>
        <span className={cx('min-w-0 flex-1 truncate', active && 'font-semibold')}>{label}</span>
        <BadgeOf tabs={[tab]} inline />
      </Dropdown.Item>
      {/* A menuitemcheckbox, not a bare button: a menu may hold menu items only (axe aria-required-children); onSelect keeps the card open. */}
      <Dropdown.CheckboxItem
        checked={pinned}
        disabled={pinDisabled}
        aria-label={pinned ? t('mobile.unpin', { name: label }) : t('mobile.pin', { name: label })}
        data-testid={`more-pin-${tab}`}
        onSelect={(e) => {
          e.preventDefault();
          pin(tab, bar);
        }}
        className={cx('grid size-11 shrink-0 cursor-default place-items-center rounded-full outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40', pinned ? 'text-fg' : 'text-muted')}
      >
        <Pin className={cx('size-5', pinned && 'fill-current')} strokeWidth={1.75} aria-hidden />
      </Dropdown.CheckboxItem>
      {/* The handle is the only draggable part (touch: 300 ms hold); not a menu item, hidden from the a11y tree. */}
      <span
        ref={setActivatorNodeRef}
        {...listeners}
        aria-hidden
        title={t('mobile.reorder', { name: label })}
        data-testid={`more-drag-${tab}`}
        className="grid size-11 shrink-0 touch-none place-items-center text-muted"
      >
        <GripVertical className="size-5" strokeWidth={1.75} aria-hidden />
      </span>
    </div>
  );
});

// ---------------------------------------------------------------- badges

/**
 * The unread of the given tabs as one primitive (lib/sections.ts Badge): > 0 the summed count, -1 a
 * dot, 0 nothing. «Команда»: mentions across the workspaces' rooms (a dot for plain unread);
 * «Личные»: every DM message; «Доски»: unread tasks of the open workspace (the one the old switch
 * showed). Each selector returns 0 for a tab not asked for, so a badge re-renders only for its own data.
 */
function useBadge(tabs: readonly PhoneTab[]): Badge {
  const wantChats = tabs.includes('chats');
  const wantDms = tabs.includes('dms');
  const wantBoards = tabs.includes('boards');
  const chats = useRooms((s) => {
    if (!wantChats) return 0;
    let n = 0;
    let unread = false;
    for (const id in s.mentions) {
      const r = s.byId[id];
      if (r && !isDm(r) && r.workspaceId !== '') n += s.mentions[id] ?? 0;
    }
    if (n === 0) unread = Object.values(s.byId).some((r) => r.workspaceId !== '' && !isDm(r) && showsUnread(r.id, s));
    return n > 0 ? n : unread ? UNREAD_DOT : 0;
  });
  const dms = useRooms((s) => (wantDms ? dmBadge(s) : 0));
  const open = useUi((s) => (s.activeWorkspaceId === HOME ? null : s.activeWorkspaceId));
  const first = useWorkspaces((s) => s.order[0] ?? null);
  const wsId = open ?? first;
  const boards = useBoards((s) => (wantBoards && wsId ? unreadCount(s, wsId) : 0));
  const count = Math.max(chats, 0) + dms + boards;
  return count > 0 ? count : chats === UNREAD_DOT ? UNREAD_DOT : 0;
}

/** A tab's badge: a count on the icon corner (or inline in a card row), or a dot. A leaf with its own subscription. */
function BadgeOf({ tabs, inline = false, plate = false }: { tabs: readonly PhoneTab[]; inline?: boolean; plate?: boolean }): ReactNode {
  const b = useBadge(tabs);
  if (b === 0) return null;
  const count = Math.max(b, 0);
  const only = tabs.length === 1 ? tabs[0] : undefined;
  const label =
    count === 0
      ? t('ws.unread')
      : only === 'chats'
        ? plural('shell.unreadMentions', count)
        : only === 'dms'
          ? t('dm.homeUnread', { n: count })
          : only === 'boards'
            ? plural('boards.unreadCount', count)
            : `${t('ws.unread')}: ${count}`;
  if (inline) {
    return count > 0 ? (
      <CountBadge count={count} phone role="img" aria-label={label} />
    ) : (
      <span role="img" aria-label={label} className="size-2.5 shrink-0 rounded-full bg-fg" />
    );
  }
  return count > 0 ? (
    <CountBadge count={count} phone ring="var(--color-toolbar,var(--color-bg))" role="img" aria-label={label} className={plate ? 'absolute -top-2 right-0' : 'absolute -top-2 left-full -ml-2.5'} />
  ) : (
    <span role="img" aria-label={label} className="absolute -right-1 -top-0.5 size-2.5 rounded-full border-2 border-[var(--color-toolbar,var(--color-bg))] bg-fg" />
  );
}
