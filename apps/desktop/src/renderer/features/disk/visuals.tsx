import type { DiskItem, FileMeta } from '@calaba/protocol';
import { Folder, Link2, Lock, Users } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { thumbnailPath } from '../../lib/api/endpoints';
import { isFolder } from '../../lib/disk';
import { fileType, type FileFamily } from '../../lib/fileType';

/**
 * The type tint per family (CBF-22), from the theme's tokens so it reads in light and dark:
 * documents blue, tables green, slides orange, PDF red, archives grey-brown, code violet, design
 * pink, audio cyan, images teal, video yellow, plain text and unknown neutral.
 */
const TONE: Record<FileFamily, string> = {
  doc: 'var(--color-accent)',
  sheet: 'var(--color-green)',
  slides: 'var(--color-warn)',
  pdf: 'var(--color-red)',
  archive: 'color-mix(in srgb, var(--color-warn) 45%, var(--color-muted))',
  code: 'color-mix(in srgb, var(--color-accent) 55%, var(--color-red))',
  design: 'var(--color-syn-keyword)',
  audio: 'var(--color-syn-type)',
  image: 'var(--color-syn-fn)',
  video: 'var(--color-yellow)',
  text: 'var(--color-muted)',
  other: 'var(--color-muted)',
};

/**
 * The file type plate (CBF-22): a document-shaped tile with a folded corner, two text lines and a
 * band in the type's colour carrying the extension. One component in tiles, rows, the card, chat
 * link chips and search hits; plain SVG, no images. `compact` (small rows) leaves the band unlabelled.
 */
export const FileTypeIcon = memo(function FileTypeIcon({
  file,
  className,
  compact = false,
}: {
  file: Pick<FileMeta, 'mime' | 'name'> | undefined;
  className?: string;
  compact?: boolean;
}): ReactNode {
  const { family, label } = fileType(file);
  return (
    <svg viewBox="0 0 40 48" className={className} style={{ color: TONE[family] }} aria-hidden data-testid="file-type-icon" data-family={family}>
      <path
        d="M6 1.5H25L36.5 13V44a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 44V4A2.5 2.5 0 0 1 6 1.5Z"
        fill="color-mix(in srgb, currentColor 14%, transparent)"
        stroke="currentColor"
        strokeOpacity={0.75}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <path
        d="M25 1.5V10.5a2.5 2.5 0 0 0 2.5 2.5H36.5"
        fill="color-mix(in srgb, currentColor 28%, transparent)"
        stroke="currentColor"
        strokeOpacity={0.75}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <path d="M10 17.5H21M10 22H30" stroke="currentColor" strokeOpacity={0.45} strokeWidth={2} strokeLinecap="round" fill="none" />
      <rect x="3.5" y="28" width="33" height="12.5" fill="currentColor" />
      {compact || !label ? null : (
        <text x="20" y="37.2" textAnchor="middle" fontSize="9" fontWeight="700" fontFamily="system-ui, sans-serif" fill="var(--color-bg)">
          {label}
        </text>
      )}
    </svg>
  );
});

/** The glyph of a Disk item's kind (a folder, or the file type plate): search rows. */
export function DiskKindGlyph({ folder, mime, name, className }: { folder: boolean; mime: string; name: string; className: string }): ReactNode {
  if (folder) return <Folder className={className} strokeWidth={1.75} aria-hidden />;
  return <FileTypeIcon file={{ mime, name }} className={className} compact />;
}

/** Small glyphs (rows, chips) carry no label: it would be unreadable. */
const SMALL = /\bsize-(4|5|6)\b/;

/** The item's glyph: a filled accent folder, or the file type plate. */
export function ItemGlyph({ item, className }: { item: DiskItem; className: string }): ReactNode {
  if (isFolder(item)) return <Folder className={cx(className, 'fill-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] text-accent')} strokeWidth={1.5} aria-hidden />;
  return <FileTypeIcon file={item.file} className={className} compact={SMALL.test(className)} />;
}

/** A tile's picture: the image thumbnail (lazy) or the glyph on the tile's plate. */
export const ItemPicture = memo(function ItemPicture({ item }: { item: DiskItem }): ReactNode {
  const thumb = !isFolder(item) && item.file?.thumbnailUrl ? item.file.id : '';
  if (thumb) return <MediaImg path={thumbnailPath(thumb)} alt="" loading="lazy" decoding="async" draggable={false} className="block size-full object-cover" />;
  return (
    <span className="grid size-full place-items-center">
      <ItemGlyph item={item} className="size-[72px]" />
    </span>
  );
});

/** Badges of an item: restricted («Только выбранные»), shared (own overrides), a public link. */
export function ItemBadges({ item, className }: { item: DiskItem; className?: string }): ReactNode {
  if (!item.restricted && !item.shared && !item.link) return null;
  return (
    <span className={cx('flex shrink-0 items-center gap-1 text-muted', className)} data-testid="disk-badges">
      {item.restricted ? (
        <span title={t('disk.badge.restricted')} aria-label={t('disk.badge.restricted')} role="img">
          <Lock className="size-3.5" aria-hidden />
        </span>
      ) : item.shared ? (
        <span title={t('disk.badge.shared')} aria-label={t('disk.badge.shared')} role="img">
          <Users className="size-3.5" aria-hidden />
        </span>
      ) : null}
      {item.link ? (
        <span title={t('disk.badge.link')} aria-label={t('disk.badge.link')} role="img">
          <Link2 className="size-3.5" aria-hidden />
        </span>
      ) : null}
    </span>
  );
}
