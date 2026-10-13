import { Hash, Lock, Timer, Volume2 } from 'lucide-react';
import { memo, type CSSProperties, type ReactNode } from 'react';
import { t } from '../i18n';
import { thumbnailPath } from '../lib/api/endpoints';
import { roomGlyph, roomIconFile, roomIsPrivate, type RoomIconInfo } from '../lib/roomIcon';
import { useRooms } from '../stores/rooms';
import { MediaImg } from './MediaImg';
import { cx } from './ui';

const GLYPH = { text: Hash, voice: Volume2, temp: Timer } as const;

/**
 * Sizes (ADR-0092 §3):
 * - 16 / 20 — a bare glyph in a list row, ⌘K, search, the desktop header (`text-faint`); a picture
 *   is a circle of that size.
 * - 32 / 44 — a disc (the phone header / the phone room list) on the fill colour; a picture fills it.
 */
export type RoomIconSize = 16 | 20 | 32 | 44;

/** The private lock badge in the corner, sized to the icon (the presence dot of an avatar). */
const BADGE: Record<RoomIconSize, { box: string; lock: string }> = {
  16: { box: 'size-2.5', lock: 'size-1.5' },
  20: { box: 'size-3', lock: 'size-2' },
  32: { box: 'size-[14px] border-2', lock: 'size-2' },
  44: { box: 'size-[18px] border-2', lock: 'size-2.5' },
};

/**
 * The room's picture or the glyph of its type (`#`, speaker, timer) — one component everywhere a
 * room is shown (ADR-0092 §3). Reads the room by id with primitive selectors (a row re-renders only
 * when its own picture / type / privacy changes); `room` describes a room missing from the store.
 *
 * - `live` — people are in the voice: the green tone (a green ring around a picture).
 * - A private room: a small lock badge in the corner; on a bare text glyph (16/20 without a picture)
 *   the lock replaces the `#` instead (the desktop room list, owner 07.10).
 * - `ring` — the surface colour the badge's cutout ring takes (default: the sidebar).
 */
export const RoomIcon = memo(function RoomIcon({
  roomId,
  room,
  size,
  live = false,
  ring,
  className,
}: {
  roomId: string;
  room?: RoomIconInfo | undefined;
  size: RoomIconSize;
  live?: boolean;
  ring?: string;
  className?: string;
}): ReactNode {
  const iconFileId = useRooms((s) => roomIconFile(s, roomId, room));
  const glyph = useRooms((s) => roomGlyph(s, roomId, room));
  const isPrivate = useRooms((s) => roomIsPrivate(s, roomId, room));
  const disc = size >= 32;
  const px = size;
  const lockInstead = !disc && !iconFileId && isPrivate && glyph === 'text';
  const Icon = lockInstead ? Lock : GLYPH[glyph];
  const badge = isPrivate && !lockInstead;
  const glyphPx = size === 44 ? 22 : size === 32 ? 18 : size;
  return (
    <span
      className={cx('relative inline-grid shrink-0 place-items-center', className)}
      style={{ width: px, height: px }}
      data-room-icon={iconFileId ? 'picture' : glyph}
      {...(lockInstead ? { role: 'img', 'aria-label': t('room.private') } : { 'aria-hidden': badge ? undefined : true })}
    >
      {iconFileId ? (
        <MediaImg
          path={thumbnailPath(iconFileId)}
          alt=""
          draggable={false}
          className={cx('size-full rounded-full bg-[var(--color-fill)] object-cover', live && 'outline outline-2 outline-offset-1 outline-[var(--color-ok)]')}
        />
      ) : disc ? (
        <span
          className={cx(
            'grid size-full place-items-center rounded-full',
            live ? 'bg-[color-mix(in_srgb,var(--color-ok)_18%,transparent)] text-ok' : 'bg-[var(--color-fill)] text-muted',
          )}
        >
          <Icon style={{ width: glyphPx, height: glyphPx }} strokeWidth={size === 32 ? 1.75 : 2} aria-hidden />
        </span>
      ) : (
        <Icon className={live ? 'text-ok' : 'text-faint'} style={{ width: glyphPx, height: glyphPx }} strokeWidth={1.75} aria-hidden />
      )}
      {badge ? (
        <span
          role="img"
          aria-label={t('room.private')}
          className={cx(
            'absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full bg-[var(--color-fill-hover)]',
            BADGE[size].box,
            disc && 'border-[var(--badge-ring)]',
          )}
          style={disc ? ({ '--badge-ring': ring ?? 'var(--color-sidebar,var(--color-bg))' } as CSSProperties) : undefined}
        >
          <Lock className={cx('text-fg', BADGE[size].lock)} aria-hidden />
        </span>
      ) : null}
    </span>
  );
});
