import { formatUtcZone, utcOffsetMinutes } from '../timezone';
import { dayKey } from './time';

/*
 * Extra time zones of the calendar's hour axis (board #85, Me.settings.calendar_zones): the zone
 * list of the picker and the aligned hour rows of an extra column. Pure; the zone database of
 * `Intl` only (never fixed offsets), so DST and half-hour zones are right on both sides.
 */

/** At most this many extra zones (the server checks it too). */
export const MAX_EXTRA_ZONES = 2;
/** A label is at most this many characters (the server checks it too). */
export const ZONE_LABEL_MAX = 16;

export interface ExtraZone {
  zone: string;
  /** "" = the zone's city. */
  label: string;
}

const SEP_FIELD = '\u0001';
const SEP_ITEM = '\u0002';

/** The list as a primitive (a store selector returns it: no re-render while it is the same). */
export function zonesSig(zones: readonly { zone: string; label: string }[] | undefined): string {
  return (zones ?? []).map((z) => `${z.zone}${SEP_FIELD}${z.label}`).join(SEP_ITEM);
}

export function parseZonesSig(sig: string): ExtraZone[] {
  if (!sig) return [];
  return sig.split(SEP_ITEM).map((s) => {
    const [zone = '', label = ''] = s.split(SEP_FIELD);
    return { zone, label };
  });
}

/** «Asia/Kolkata» → «Kolkata», «America/Argentina/Buenos_Aires» → «Buenos Aires», «UTC» → «UTC». */
export function zoneCity(zone: string): string {
  const last = zone.split('/').pop() ?? zone;
  return last.replace(/_/g, ' ');
}

/** What the axis header shows for a zone: its label, else its city. */
export const zoneTitle = (z: ExtraZone): string => z.label.trim() || zoneCity(z.zone);

/** «UTC+5:30» of a zone at an instant; "" for an unknown zone. */
export function zoneOffsetLabel(zone: string, at: number): string {
  const off = utcOffsetMinutes(zone, new Date(at));
  return off === null ? '' : formatUtcZone(off);
}

/** «+5:30», «−4», «±0» — the compact offset of the phone's narrow column. */
export function zoneOffsetShort(zone: string, at: number): string {
  const off = utcOffsetMinutes(zone, new Date(at));
  if (off === null) return '';
  if (off === 0) return '±0';
  const abs = Math.abs(off);
  const m = abs % 60;
  return `${off > 0 ? '+' : '−'}${Math.floor(abs / 60)}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();

/** «14:30» of an instant on the wall clock of `zone`, in the UI language's hour format. */
export function zoneTime(at: number, zone: string, locale: string): string {
  const k = `${locale}${SEP_FIELD}${zone}`;
  let f = timeFormats.get(k);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: zone });
    } catch {
      return '';
    }
    timeFormats.set(k, f);
  }
  return f.format(at);
}

/** One label of an extra column: the zone's wall time at a row of the main grid. */
export interface ZoneRow {
  /** The row (hour of the main grid, 1..23). */
  hour: number;
  /** «14:30». */
  time: string;
  /**
   * The zone's `YYYY-MM-DD` where it is worth saying: the first row of a new zone date, and the
   * first row when the zone is on another date than the main grid there; else null.
   */
  newDay: string | null;
  /** The zone's date at this row against the main grid's: +1 (ahead), −1 (behind), 0 (the same). */
  shift: number;
}

/**
 * The rows of an extra column. `rows[h]` is the instant of the main grid's line h (0 = the top,
 * the main day's midnight; length 24); the labels are for lines 1..23, like the main scale.
 * `mainZone` (tests) — the main grid's zone; default the device's.
 */
export function zoneRows(rows: readonly number[], zone: string, locale: string, mainZone?: string): ZoneRow[] {
  const out: ZoneRow[] = [];
  let prev = rows[0] === undefined ? '' : dayKey(rows[0], zone);
  for (let h = 1; h < rows.length; h++) {
    const at = rows[h] ?? 0;
    const key = dayKey(at, zone);
    const changed = key !== prev;
    prev = key;
    const shift = Math.sign(key.localeCompare(dayKey(at, mainZone)));
    out.push({ hour: h, time: zoneTime(at, zone, locale), newDay: changed || (h === 1 && shift !== 0) ? key : null, shift });
  }
  return out;
}

/** The instants of the main grid's 24 hour lines of a local day (wall hours, DST-safe). */
export function hourLines(day: string): number[] {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return Array.from({ length: 24 }, (_, h) => new Date(y, m - 1, d, h).getTime());
}

/** A zone of the picker. */
export interface ZoneOption {
  id: string;
  city: string;
  /** Minutes east of UTC now. */
  offset: number;
  /** «UTC+5:30». */
  offsetLabel: string;
  /** The zone's generic name in the UI language («Индия», «Москва»), "" when the runtime has none. */
  name: string;
  /** Fields the search matches: the IANA name, the city, the localized name, the offset. */
  search: string[];
}

/** ICU still lists some zones by their old names; the picker shows the current IANA ones. */
const RENAMED: Readonly<Record<string, string>> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
};

function supportedZones(): string[] {
  try {
    const all = ((Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []).map((z) => RENAMED[z] ?? z);
    if (all.length) return all.includes('UTC') ? all : [...all, 'UTC'];
  } catch {
    // older runtime: the short list below
  }
  return ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Almaty', 'Asia/Novosibirsk', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'America/Chicago', 'America/Los_Angeles'];
}

function genericName(zone: string, locale: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** Every IANA zone of the runtime, by offset then city, with what the search matches. */
export function zoneOptions(locale: string, at: number = Date.now()): ZoneOption[] {
  const now = new Date(at);
  const out: ZoneOption[] = [];
  for (const id of supportedZones()) {
    const offset = utcOffsetMinutes(id, now);
    if (offset === null) continue;
    const city = zoneCity(id);
    const name = genericName(id, locale, now);
    const offsetLabel = formatUtcZone(offset);
    out.push({ id, city, offset, offsetLabel, name: name.startsWith('GMT') ? '' : name, search: [city, id, name, offsetLabel] });
  }
  return out.sort((a, b) => a.offset - b.offset || a.city.localeCompare(b.city));
}

/** A list with `i` moved one place up (the first stays). */
export function moveUp<T>(list: readonly T[], i: number): T[] {
  if (i <= 0 || i >= list.length) return [...list];
  const out = [...list];
  const [x] = out.splice(i, 1);
  out.splice(i - 1, 0, x as T);
  return out;
}
