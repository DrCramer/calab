import { timestampMs } from '@bufbuild/protobuf/wkt';
import type { Room } from '@calaba/protocol';

/**
 * Temporary rooms (ADR-0044): lifetime presets of the create dialog, the remaining-time text of the
 * room row / island, the «Продлить» targets. Pure (the clock is a parameter), unit-tested.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Server bounds of `ttl_seconds` (CreateTempRoomRequest) and of an extension (≤ 30 days from now; the server's TEMP_ROOM_MAX_TTL_DAYS default, CBF-38). */
export const MIN_TTL_S = 15 * 60;
export const MAX_TTL_S = 30 * 24 * 60 * 60;
export const MAX_LIFETIME_MS = MAX_TTL_S * 1000;

/** Under this the row and the island turn to the attention colour and the island shows «⏱ 9 мин». */
export const EXPIRING_MS = 10 * MIN;

export type LifetimePreset = '1h' | '3h' | 'eod' | '1d' | '3d' | '7d' | '30d' | 'date';
export const LIFETIME_PRESETS: readonly LifetimePreset[] = ['1h', '3h', 'eod', '1d', '3d', '7d', '30d', 'date'];

const FIXED: Record<Exclude<LifetimePreset, 'eod' | 'date'>, number> = {
  '1h': HOUR,
  '3h': 3 * HOUR,
  '1d': DAY,
  '3d': 3 * DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
};

/** Local midnight after `now` (the end of today in the viewer's zone). */
export function endOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * The room's lifetime in seconds for a preset, or null when out of the server's bounds
 * (15 min … 30 days): «до конца дня» late in the evening, «до даты» in the past / too far.
 * `until` — the picked end (ms) for 'date'.
 */
export function presetTtl(preset: LifetimePreset, now: number, until?: number): number | null {
  const end = preset === 'eod' ? endOfDay(now) : preset === 'date' ? (until ?? NaN) : now + FIXED[preset];
  const s = Math.round((end - now) / 1000);
  return Number.isFinite(s) && s >= MIN_TTL_S && s <= MAX_TTL_S ? s : null;
}

/** Remaining time split for display: minutes rounded up (a live room never reads «0 м»). */
export function remainingParts(ms: number): { d: number; h: number; m: number } {
  const totalMin = Math.max(0, Math.ceil(ms / MIN));
  const d = Math.floor(totalMin / (24 * 60));
  const h = Math.floor((totalMin % (24 * 60)) / 60);
  return { d, h, m: totalMin % 60 };
}

/** Localised units: ru «1 ч 20 м», en «1h 20m». */
export interface RemainingUnits {
  d: (n: number) => string;
  h: (n: number) => string;
  m: (n: number) => string;
}

/** «2 д 3 ч», «1 ч 20 м», «1 ч», «9 м» — at most two units, the larger ones first. */
export function formatRemaining(ms: number, u: RemainingUnits): string {
  const { d, h, m } = remainingParts(ms);
  if (d > 0) return h > 0 ? `${u.d(d)} ${u.h(h)}` : u.d(d);
  if (h > 0) return m > 0 ? `${u.h(h)} ${u.m(m)}` : u.h(h);
  return u.m(Math.max(1, m));
}

export const isExpiring = (remainingMs: number): boolean => remainingMs < EXPIRING_MS;

/** A temporary room (ADR-0044: `expires_at` set). */
export const isTempRoom = (r: Pick<Room, 'expiresAt'> | undefined): boolean => !!r?.expiresAt;

/** `expires_at` in ms, 0 for a permanent room — a primitive for store selectors. */
export const expiresMs = (r: Pick<Room, 'expiresAt'> | undefined): number => (r?.expiresAt ? timestampMs(r.expiresAt) : 0);

/** The «Временные» group: soonest to close first, then by name. */
export function sortTempRooms<T extends Pick<Room, 'expiresAt' | 'name' | 'id'>>(rooms: readonly T[]): T[] {
  return [...rooms].sort((a, b) => expiresMs(a) - expiresMs(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * «Продлить» (+1 ч / +1 день): from the current end (or from now, if it has passed), never beyond
 * 30 days from now — the server's cap.
 */
export function extendTo(expires: number, addMs: number, now: number): number {
  return Math.min(Math.max(expires, now) + addMs, now + MAX_LIFETIME_MS);
}

/** «Продлить до даты»: a picked end within (now + 15 min, now + 30 days], else null. */
export function validEnd(until: number, now: number): number | null {
  return Number.isFinite(until) && until - now >= MIN_TTL_S * 1000 && until - now <= MAX_LIFETIME_MS ? until : null;
}

/** `<input type="datetime-local">` value of a moment in the local zone: «2026-01-15T14:30». */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Parses a datetime-local value (local zone); NaN when empty or invalid. */
export function fromLocalInput(v: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}
