import type { CSSProperties, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { preload } from 'react-dom';
import { LOCALE_INFO, type Locale } from '@/i18n/locales';
import { SCREENS, focusOf, isWindow, type ScreenName } from '@/lib/screens';
import { stickerSrc } from '@/lib/stickers';
import type { SceneName } from '@/i18n/home';

export { DrawnLink } from './drawn-link';

// The landing's design system (docs/plans/landing-v6.md §6): one Button, one SectionHeading, one Card / Tile,
// one Shot, one Badge, one Sticker. Tokens and the matching classes live in app/globals.css.

/**
 * Russian and English typography for copy we render: a dash never starts a line, «≈ 7 %» never breaks
 * inside, a one-letter preposition stays with its word (ru). Applied to headings, leads and tile texts.
 */
export const nb = (text: string): string =>
  text
    .replace(/ ([—–]) /g, '\u00a0$1 ')
    .replace(/(\d) %/g, '$1\u00a0%')
    .replace(/≈ /g, '≈\u00a0')
    .replace(/(?<=^|[\s(«])([вкосуиаВКОСУИА]) /g, '$1\u00a0');

/** A heading with `accent` (a part of it) set in the italic accent colour; nb() typography on both parts. */
export function accented(title: string, accent?: string): ReactNode {
  const at = accent ? title.indexOf(accent) : -1;
  if (!accent || at < 0) return nb(title);
  return (
    <>
      {nb(title.slice(0, at))}
      <span className="accent">{nb(accent)}</span>
      {nb(title.slice(at + accent.length))}
    </>
  );
}

/** The same helper under the name used in reviews. */
export const nbsp = nb;

export const cx = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(' ');

/** 1360 px content column; side fields 20 / 32 / 40 px. */
export function Container({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return <div className={cx('wrap', className)}>{children}</div>;
}

/** A page section: the same vertical rhythm everywhere (96 / 64 px), `quiet` for the pauses (128). */
export function Section({
  id,
  labelledBy,
  quiet,
  children,
  className,
  bare,
}: {
  id?: string | undefined;
  labelledBy: string;
  quiet?: boolean | undefined;
  children: ReactNode;
  className?: string | undefined;
  /** No container: the section lays out its own full-bleed content. */
  bare?: boolean | undefined;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cx('section', quiet && 'section-quiet', className)}>
      {bare ? children : <Container>{children}</Container>}
    </section>
  );
}

/** H2 + lead (max 760), an optional sticker on the right (180 / 90 px). No eyebrow (owner, 24.10). */
export function SectionHeading({
  id,
  title,
  accent,
  lead,
  sticker,
  center,
  as: Tag = 'h2',
}: {
  id: string;
  title: string;
  /** A part of the title in the italic accent (see accented()). */
  accent?: string | undefined;
  lead?: ReactNode | undefined;
  sticker?: string | undefined;
  center?: boolean | undefined;
  as?: 'h1' | 'h2' | undefined;
}) {
  return (
    <div className={cx('heading', center && 'heading-center')}>
      <div className="heading-copy">
        <Tag id={id} className={Tag === 'h1' ? 'h1 heading-h1' : 'h2'}>
          {accented(title, accent)}
        </Tag>
        {lead && <p className="lead">{typeof lead === 'string' ? nb(lead) : lead}</p>}
      </div>
      {sticker && <Sticker name={sticker} size={180} className="heading-sticker" />}
    </div>
  );
}

type ButtonProps = {
  href: string;
  children: ReactNode;
  /** kinetic: the arrow → label → arrow pill of the finale (the only one with a moving arrow). */
  variant?: 'primary' | 'secondary' | 'kinetic' | undefined;
  size?: 'lg' | 'md' | 'sm' | undefined;
  className?: string | undefined;
  external?: boolean | undefined;
  label?: string | undefined;
};

/** Pill button: 48 / 44 / 36 px; primary is the blue action, secondary is white. */
export function Button({ href, children, variant = 'primary', size = 'lg', className, external, label }: ButtonProps) {
  const ext = external ? { target: '_blank', rel: 'noopener' } : {};
  if (variant === 'kinetic') {
    return (
      <a href={href} className={cx('btn-kinetic', className)} aria-label={label} {...ext}>
        <span className="btn-kinetic-arrow" aria-hidden="true">→</span>
        <span className="btn-kinetic-label">{children}</span>
        <span className="btn-kinetic-arrow btn-kinetic-arrow-end" aria-hidden="true">→</span>
      </a>
    );
  }
  return (
    <a href={href} className={cx('btn', `btn-${variant}`, `btn-${size}`, className)} aria-label={label} {...ext}>
      {children}
    </a>
  );
}

/** r20, #111, no border. */
export function Card({ children, className, as: Tag = 'div', id }: { children: ReactNode; className?: string | undefined; as?: 'div' | 'li' | 'article'; id?: string | undefined }) {
  return (
    <Tag id={id} className={cx('card', className)}>
      {children}
    </Tag>
  );
}

/** Plan / «Скоро» / «Приложение для компьютера». */
/** One-line facts as centred cards with a large gradient-stroked icon (telephony, «Под вашим контролем»). `id` names the gradient. */
export function FactCards({ id, items, className }: { id: string; items: ReadonlyArray<{ icon: LucideIcon; text: string }>; className?: string | undefined }) {
  const gradient = `fact-gradient-${id}`;
  return (
    <>
      {/* The stroke gradient in the 24-unit icon space, so straight segments (zero-height boxes) get it too. */}
      <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradient} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#8fe3ff" />
            <stop offset="1" stopColor="#5865ff" />
          </linearGradient>
        </defs>
      </svg>
      <ul className={cx('fact-cards', className)}>
        {items.map(({ icon: Icon, text }) => (
          <li key={text} className="fact-card">
            <span className="fact-icon" aria-hidden="true">
              <Icon size={44} strokeWidth={1.6} color={`url(#${gradient})`} />
            </span>
            <span>{nb(text)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Badge({ children, tone = 'outline', className }: { children: ReactNode; tone?: 'solid' | 'outline'; className?: string | undefined }) {
  return <span className={cx('badge', `badge-${tone}`, className)}>{children}</span>;
}

/** A decorative sticker: empty alt, lazy, never in the way of the pointer. */
export function Sticker({ name, size = 120, className, eager }: { name: string; size?: 180 | 120 | 90; className?: string | undefined; eager?: boolean | undefined }) {
  return (
    <img
      className={cx('sticker', `sticker-${size}`, className)}
      src={stickerSrc(name)}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      {...(eager ? {} : { loading: 'lazy' as const })}
    />
  );
}

/**
 * A screenshot of the app (dark theme, the UI and the team in the page's language, `public/screens/<lang>/<name>`):
 * a r12 frame with a hairline, always in the crop's own proportion — no `object-fit`, nothing is cut or letterboxed.
 * Files: `<name>.webp` 1x, `<name>@2x.webp`, `<name>-720.webp` for phones; a scene with a `focus` crop serves
 * `<name>-focus(.webp|@2x.webp)` below 640 px through `<picture>`.
 * width/height are CSS px: no layout shift.
 */
export function Shot({
  scene,
  locale,
  alt,
  sizes,
  priority,
  eager,
  phone,
  className,
}: {
  scene: SceneName | ScreenName;
  locale: Locale;
  alt: string;
  sizes: string;
  /** The LCP image: preloaded with its srcset and high fetch priority. */
  priority?: boolean | undefined;
  /** Near the top of the page: eager (a lazy image there stays empty during a fast scroll). */
  eager?: boolean | undefined;
  /** A phone capture in a device edge. */
  phone?: boolean | undefined;
  className?: string | undefined;
}) {
  const { width, height } = SCREENS[scene];
  const base = `/screens/${LOCALE_INFO[locale].lang}/${scene}`;
  const focus = focusOf(scene);
  const srcSet = `${width > 720 ? `${base}-720.webp 720w, ` : ''}${base}.webp ${width}w, ${base}@2x.webp ${width * 2}w`;
  const focusSrcSet = focus && `${base}-focus.webp ${focus.width}w, ${base}-focus@2x.webp ${focus.width * 2}w`;
  if (priority) {
    // One preload per <picture> source, each limited to its media: a phone fetches only the focus crop it shows.
    preload(`${base}.webp`, { as: 'image', imageSrcSet: srcSet, imageSizes: sizes, fetchPriority: 'high', ...(focus ? { media: '(min-width: 640px)' } : {}) });
    if (focusSrcSet) preload(`${base}-focus.webp`, { as: 'image', imageSrcSet: focusSrcSet, imageSizes: 'calc(100vw - 40px)', fetchPriority: 'high', media: '(max-width: 639px)' });
  }
  const style = { '--ar': `${width} / ${height}`, ...(focus ? { '--ar-sm': `${focus.width} / ${focus.height}` } : {}) } as CSSProperties;
  return (
    <div className={cx('shot', phone && 'shot-phone', isWindow(scene) && 'shot-window', focus && 'shot-has-focus', className)} style={style}>
      <picture>
        {focus && (
          <source
            media="(max-width: 639px)"
            srcSet={focusSrcSet || undefined}
            sizes="calc(100vw - 40px)"
            width={focus.width}
            height={focus.height}
          />
        )}
        <img
          src={`${base}.webp`}
          srcSet={srcSet}
          sizes={sizes}
          alt={alt}
          width={width}
          height={height}
          decoding="async"
          {...(priority ? { fetchPriority: 'high' as const } : eager ? {} : { loading: 'lazy' as const })}
        />
      </picture>
    </div>
  );
}

/** Card + Shot + H3 + text + link: one tile (the AI row). */
export function Tile({
  id,
  scene,
  locale,
  title,
  text,
  alt,
  href,
  more,
  badge,
  sizes,
  className,
  media,
}: {
  id?: string | undefined;
  scene?: SceneName | ScreenName | undefined;
  locale: Locale;
  title: string;
  text: string;
  alt: string;
  href?: string | undefined;
  more?: string | undefined;
  badge?: string | undefined;
  sizes: string;
  className?: string | undefined;
  /** Replaces the screenshot (e.g. a code snippet). */
  media?: ReactNode | undefined;
}) {
  return (
    <Card as="li" id={id} className={cx('tile', className)}>
      {media ?? (scene && <Shot scene={scene} locale={locale} alt={alt} sizes={sizes} />)}
      <div className="tile-copy">
        <h3 className="h3">
          {nb(title)}
          {badge && (
            <>
              {' '}
              <Badge>{badge}</Badge>
            </>
          )}
        </h3>
        <p className="tile-text">{nb(text)}</p>
        {href && more && (
          <a href={href} className="more-link">
            {more}
            <span className="sr-only">: {title}</span>
            <span aria-hidden="true"> →</span>
          </a>
        )}
      </div>
    </Card>
  );
}
