import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { CalendarPlus, CalendarSearch, Check, ChevronDown, ChevronLeft, ChevronRight, Users, Video } from 'lucide-react';
import { useCallback, useEffect, type ReactNode } from 'react';
import { Bar } from '../../components/Bar';
import { Button, IconButton, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { mayCreateTempRooms } from '../../lib/permissions';
import { addDays, dayStart, formatLongDay, formatWeekTitle } from '../../lib/calendar/time';
import { loadCalDav } from '../../services/freebusy';
import { useFreeBusy } from '../../stores/freebusy';
import { myUserId } from '../../stores/session';
import { useUi, type CalView } from '../../stores/ui';
import { rolesOf, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem } from '../shell/menu';
import { defaultDraft, newEvent, startFind } from './actions';
import { PeopleBar } from './PeopleBar';

/*
 * The desktop header of the calendar (ADR-0038 §7; the week — bug board #6, Yandex Calendar), one
 * for the day and the week view: ‹ › (a day / a week), the title, «Сегодня» (when today is not
 * shown), «Подобрать время», «День / Неделя», «Звонок» and «+ Встреча». The phone keeps its own
 * compact day header (DayView.tsx) and never shows the week.
 */

export function CalendarHeader({
  workspaceId,
  day,
  days,
  today,
  creatable,
  view,
}: {
  workspaceId: string;
  /** The view's day (the week view: the anchor inside the week). */
  day: string;
  /** The days shown: one, or the week's seven. */
  days: readonly string[];
  today: string;
  creatable: boolean;
  view: CalView;
}): ReactNode {
  const open = useUi((s) => s.openCalendarDay);
  const week = view === 'week';
  const step = week ? 7 : 1;
  const showsToday = days.includes(today);
  return (
    <Bar className="@container gap-1 pl-3 pr-2">
      <IconButton label={week ? t('cal.prevWeek') : t('cal.prevDay')} shortcut="←" onClick={() => open(addDays(day, -step))} data-testid="cal-prev">
        <ChevronLeft className="size-[18px]" />
      </IconButton>
      <IconButton label={week ? t('cal.nextWeek') : t('cal.nextDay')} shortcut="→" onClick={() => open(addDays(day, step))} data-testid="cal-next">
        <ChevronRight className="size-[18px]" />
      </IconButton>
      <h1 className="ml-1 min-w-0 flex-1 truncate text-list font-semibold first-letter:uppercase" aria-live="polite" data-testid="cal-title">
        {week ? formatWeekTitle(days) : formatLongDay(dayStart(day))}
      </h1>
      {!showsToday ? (
        <Tip label={t('cal.today')} shortcut="T">
          <Button variant="secondary" size="sm" onClick={() => open(today)} data-testid="cal-today">
            {t('cal.today')}
          </Button>
        </Tip>
      ) : null}
      {creatable ? (
        <Tip label={t('fb.find')}>
          <Button variant="secondary" size="sm" onClick={() => startFind(workspaceId)} aria-label={t('fb.find')} data-testid="day-find">
            <CalendarSearch className="size-3.5" aria-hidden />
            {/* A narrow pane (960 px window, the week's buttons): the icon keeps the title room. */}
            <span className="hidden @[620px]:inline">{t('fb.find')}</span>
          </Button>
        </Tip>
      ) : null}
      <ViewSwitch view={view} />
      <CallButton workspaceId={workspaceId} />
      {creatable ? (
        <Tip label={t('cal.newEventLong')} shortcut="N">
          <Button size="sm" onClick={() => newEvent(workspaceId, defaultDraft(day === today || !showsToday ? day : today))} data-testid="day-new-event">
            {t('cal.newEvent')}
          </Button>
        </Tip>
      ) : null}
    </Bar>
  );
}

/** «День / Неделя ▾» (Yandex Calendar): the view, kept on this device. */
function ViewSwitch({ view }: { view: CalView }): ReactNode {
  const setView = useUi((s) => s.setCalView);
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <Button variant="secondary" size="sm" aria-label={t('cal.viewPick', { view: view === 'week' ? t('cal.viewWeek') : t('cal.viewDay') })} className="data-[state=open]:bg-active" data-testid="cal-view">
          {view === 'week' ? t('cal.viewWeek') : t('cal.viewDay')}
          <ChevronDown className="size-3.5 text-muted" aria-hidden />
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'min-w-40')} sideOffset={4} align="end" collisionPadding={16}>
          <Dropdown.RadioGroup value={view} onValueChange={(v) => setView(v === 'week' ? 'week' : 'day')}>
            {(['day', 'week'] as const).map((v) => (
              <Dropdown.RadioItem key={v} value={v} className={menuItem} data-testid={`cal-view-${v}`}>
                <span className="grid w-4 place-items-center">
                  <Dropdown.ItemIndicator>
                    <Check className="size-4" aria-hidden />
                  </Dropdown.ItemIndicator>
                </span>
                <span className="flex-1">{v === 'week' ? t('cal.viewWeek') : t('cal.viewDay')}</span>
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/**
 * «Звонок»: a call right now — the calendar has no instant-meeting flow of its own, so it is the
 * temporary room dialog (ADR-0044: a voice room with a link for colleagues and guests, optionally
 * with a calendar meeting). Only with CREATE_TEMP_ROOMS.
 */
function CallButton({ workspaceId }: { workspaceId: string }): ReactNode {
  const me = myUserId();
  const allowed = useWorkspaces((st) => mayCreateTempRooms(rolesOf(st.byId[workspaceId], me)));
  if (!allowed) return null;
  return (
    <Tip label={t('cal.callHint')}>
      <Button variant="secondary" size="sm" onClick={() => useUi.getState().openDialog({ kind: 'temp-room-create', workspaceId })} data-testid="cal-call">
        <Video className="size-3.5" aria-hidden />
        {t('cal.call')}
      </Button>
    </Tip>
  );
}

/** «Люди» over the grid (desktop): the chips of the filter; the CalDAV hint at the right end. */
export function FilterRow({ workspaceId, people }: { workspaceId: string; people: readonly string[] }): ReactNode {
  const dispatch = useFreeBusy((s) => s.dispatchPeople);
  const onAdd = useCallback((ids: readonly string[]) => dispatch({ type: 'add', workspaceId, ids }), [dispatch, workspaceId]);
  const onRemove = useCallback((id: string) => dispatch({ type: 'remove', workspaceId, id }), [dispatch, workspaceId]);
  const onClear = useCallback(() => dispatch({ type: 'clear', workspaceId }), [dispatch, workspaceId]);
  return (
    <div className="@container flex h-10 shrink-0 items-center gap-2 border-b border-line pl-3 pr-2" data-testid="day-filter">
      <Users className="size-4 shrink-0 text-muted" aria-hidden />
      <PeopleBar workspaceId={workspaceId} people={people} onAdd={onAdd} onRemove={onRemove} onClear={onClear} testId="people-filter" />
      <ConnectControl />
    </div>
  );
}

/**
 * The right end of the filter (owner, 30.09; docs/09 #140): without my CalDAV calendar — the
 * orange «Подключить свой календарь» (Settings → Calendar); nothing when connected (the «Только
 * мои» switch is gone, 02.10) or until the account is known (asked once, here).
 */
export function ConnectControl(): ReactNode {
  const caldav = useFreeBusy((s) => (s.caldav === undefined ? 'unknown' : s.caldav ? 'yes' : 'no'));
  useEffect(() => {
    if (caldav === 'unknown') void loadCalDav();
  }, [caldav]);
  if (caldav !== 'no') return null;
  return (
    <Button
      variant="attention"
      size="sm"
      title={t('fb.connectHint')}
      aria-label={t('fb.connect')}
      onClick={() => useUi.getState().openDialog({ kind: 'settings', tab: 'calendar' })}
      data-testid="connect-calendar"
    >
      <CalendarPlus className="size-3.5" aria-hidden />
      {/* A narrow row (960 px window, chips selected): the short label keeps the chips room. */}
      <span className="@[720px]:hidden">{t('fb.connectShort')}</span>
      <span className="hidden @[720px]:inline">{t('fb.connect')}</span>
    </Button>
  );
}
