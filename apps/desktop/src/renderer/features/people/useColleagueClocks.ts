import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { fmt, useTimeFormat } from '../../lib/format';
import { formatUtcZone, formatWorkRange, localTimeZone, timeZoneLabel, utcOffsetMinutes } from '../../lib/timezone';
import { ensureBusy, hoursSignature, parseHoursSignature } from '../../services/freebusy';
import { entryKey, useFreeBusy } from '../../stores/freebusy';
import { useWorkspaces } from '../../stores/workspaces';
import { useNow } from '../shell/voiceFormat';

const NONE: readonly string[] = [];
/** At most this many people are asked for their working hours at once (free/busy, 20 per request). */
const MAX_ASKED = 60;

/** Loads the zone and working hours (free/busy answers carry them) of people for the next 24 h. */
export function askHours(workspaceId: string, userIds: readonly string[]): void {
  const from = Date.now();
  ensureBusy(workspaceId, userIds, from, from + 86_400_000);
}

/**
 * Picker notes «14:32 · UTC+5 · 10–19» (docs/09 #85): the local time, zone and working hours of the
 * people whose offset differs from mine — what a meeting's participants picker shows next to a
 * name. Nothing is read, loaded or ticking while `active` is false (the picker is closed); open,
 * the clock moves once a minute on the shared ticker, which sleeps in a hidden window. Hours
 * arrive from the one free/busy request and fill in when it answers.
 */
export function useColleagueClocks(workspaceId: string, userIds: readonly string[], active: boolean): Readonly<Record<string, string>> {
  const now = useNow(active ? 60_000 : 0);
  useTimeFormat();
  const zones = useWorkspaces(useShallow((s) => (active ? userIds.map((id) => s.users[id]?.timezone ?? '') : NONE)));
  const mine = localTimeZone();
  const at = new Date(now);
  const differing = active ? userIds.filter((_, i) => timeZoneLabel(zones[i] ?? '', mine, at) !== null).slice(0, MAX_ASKED) : NONE;
  const key = differing.join(',');
  useEffect(() => {
    if (key) askHours(workspaceId, key.split(','));
  }, [workspaceId, key]);
  const hours = useFreeBusy(useShallow((s) => (active ? differing.map((id) => hoursSignature(s.entries[entryKey(workspaceId, id)])) : NONE)));
  const out: Record<string, string> = {};
  differing.forEach((id, i) => {
    const tz = zones[userIds.indexOf(id)] ?? '';
    const off = utcOffsetMinutes(tz, at);
    if (off === null) return;
    const h = parseHoursSignature(hours[i] ?? '')?.workHours;
    const work = h && h.days.length ? ` · ${formatWorkRange(h.startMin, h.endMin)}` : '';
    out[id] = `${fmt.timeIn(at, tz)} · ${formatUtcZone(off)}${work}`;
  });
  return out;
}
