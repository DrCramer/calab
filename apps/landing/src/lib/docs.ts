// Developer docs content model (ADR-0099): Markdown files in src/content/docs/{ru,en}/<section>/<page>.md,
// navigation in src/content/docs/nav.ts. Everything is computed once per build process; the build
// fails on a broken internal link or anchor, a missing nav label, a nav page without a file, or a
// file that is not in the nav.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import routesJson from '../content/docs/_routes.json';
import { nav as NAV } from '../content/docs/nav';
import type { Locale } from '../i18n/locales';
import { renderMarkdown, type BotRoute, type Rendered, type SearchSection } from './docs-markdown';
import { docLang, docsUi, UNTRANSLATED_NOTICE, type DocLang } from './docs-ui';

export type Nav = typeof NAV;
export type NavSection = Nav[number];
export const DOC_LANGS: readonly DocLang[] = ['ru', 'en'];
export const ROUTES = routesJson as BotRoute[];

/** Repo-relative directory of the docs content (for «Edit on GitHub»). */
export const CONTENT_REPO_DIR = 'apps/landing/src/content/docs';

export type SourceFile = { lang: DocLang; slug: string; path: string; source: string; lastModified: string };
export type DocEntry = Rendered & { lang: DocLang; slug: string; path: string; lastModified: string };

export type PageLink = { slug: string; title: string };
export type ResolvedPage = {
  entry: DocEntry;
  /** Interface language (es/zh → en). */
  ui: DocLang;
  notice: string | null;
  section: { slug: string; title: string };
  prev: PageLink | null;
  next: PageLink | null;
  /** Locales whose own language has this page (hreflang). */
  languages: DocLang[];
};

export type SearchEntry = { u: string; t: string; s: string; h: { i: string; t: string; x: string }[] };

export type DocsSite = {
  nav: Nav;
  /** '' (docs home), `section`, `section/page`. */
  slugs: string[];
  pages: string[];
  page: (locale: Locale, slug: string) => ResolvedPage | null;
  /** Page entry in a given content language, if that file exists. */
  entry: (lang: DocLang, slug: string) => DocEntry | null;
  sectionTitle: (lang: DocLang, section: string) => string;
  pageTitle: (lang: DocLang, slug: string) => string;
  searchIndex: (locale: Locale) => SearchEntry[];
};

const safeDecode = (s: string): string => {
  try { return decodeURI(s); } catch { return s; }
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** URL of a docs slug relative to a page at /<locale>/docs/<section>/<page>/ (works for every locale). */
export const relativeDocHref = (slug: string, anchor: string | null): string =>
  `../../${slug === '' ? '' : `${slug}/`}${anchor === null ? '' : `#${encodeURIComponent(anchor)}`}`;

/** Absolute path of a docs slug under a locale. */
export const docPath = (locale: Locale, slug: string): string => `/${locale}/docs/${slug === '' ? '' : `${slug}/`}`;

export function validateNav(nav: Nav): string[] {
  const errors: string[] = [];
  const sections = new Set<string>();
  for (const s of nav) {
    if (!SLUG.test(s.slug)) errors.push(`nav: invalid section slug "${s.slug}"`);
    if (sections.has(s.slug)) errors.push(`nav: duplicate section "${s.slug}"`);
    sections.add(s.slug);
    for (const lang of DOC_LANGS) if (s.section[lang].trim() === '') errors.push(`nav: section "${s.slug}" has no ${lang} label`);
    if (s.pages.length === 0) errors.push(`nav: section "${s.slug}" has no pages`);
    const pages = new Set<string>();
    for (const p of s.pages) {
      if (!SLUG.test(p.slug)) errors.push(`nav: invalid page slug "${s.slug}/${p.slug}"`);
      if (pages.has(p.slug)) errors.push(`nav: duplicate page "${s.slug}/${p.slug}"`);
      pages.add(p.slug);
      for (const lang of DOC_LANGS) if (p[lang].trim() === '') errors.push(`nav: page "${s.slug}/${p.slug}" has no ${lang} label`);
    }
  }
  return errors;
}

/** Renders every file and checks the whole site. Throws one error listing every problem. */
export async function compileDocs(files: SourceFile[], nav: Nav, routes: readonly BotRoute[]): Promise<DocsSite> {
  const errors = validateNav(nav);
  const pages = nav.flatMap((s) => s.pages.map((p) => `${s.slug}/${p.slug}`));
  const known = new Set(['', ...nav.map((s) => s.slug), ...pages]);
  const entries = new Map<string, DocEntry>();
  const key = (lang: DocLang, slug: string) => `${lang}:${slug}`;

  for (const f of files) {
    if (!pages.includes(f.slug)) {
      errors.push(`${f.path}: not listed in nav.ts`);
      continue;
    }
    try {
      const rendered = await renderMarkdown(f.source, { lang: f.lang, slug: f.slug, routes, href: relativeDocHref });
      entries.set(key(f.lang, f.slug), { ...rendered, lang: f.lang, slug: f.slug, path: f.path, lastModified: f.lastModified });
    } catch (e) {
      errors.push(`${f.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const slug of pages) {
    if (!DOC_LANGS.some((l) => entries.has(key(l, slug)))) errors.push(`nav: page "${slug}" has no file in ru/ or en/`);
  }

  const entry = (lang: DocLang, slug: string): DocEntry | null => entries.get(key(lang, slug)) ?? null;
  /** The version a reader of `lang` sees: their language, else the other one. */
  const shown = (lang: DocLang, slug: string): DocEntry | null => entry(lang, slug) ?? entry(lang === 'ru' ? 'en' : 'ru', slug);

  for (const e of entries.values()) {
    for (const link of e.links) {
      const raw = safeDecode(link.raw);
      if (!known.has(link.slug)) {
        errors.push(`${e.path}: broken link "${raw}" (no docs page "${link.slug || '/'}")`);
        continue;
      }
      if (link.anchor === null) continue;
      if (!pages.includes(link.slug)) {
        errors.push(`${e.path}: link "${raw}" has an anchor, but "${link.slug || '/'}" is an index page`);
        continue;
      }
      const target = shown(e.lang, link.slug);
      if (target === null) errors.push(`${e.path}: link "${raw}" points to a page without content`);
      else if (!target.ids.includes(link.anchor)) errors.push(`${e.path}: broken anchor "${raw}" (no #${link.anchor} in ${target.path})`);
    }
  }
  if (errors.length > 0) throw new Error(`Docs check failed (${errors.length}):\n  ${errors.join('\n  ')}`);

  const sectionTitle = (lang: DocLang, section: string) => nav.find((s) => s.slug === section)?.section[lang] ?? section;
  const pageTitle = (lang: DocLang, slug: string) => {
    const [s, p] = slug.split('/');
    return nav.find((x) => x.slug === s)?.pages.find((x) => x.slug === p)?.[lang] ?? slug;
  };

  const page = (locale: Locale, slug: string): ResolvedPage | null => {
    const at = pages.indexOf(slug);
    if (at < 0) return null;
    const ui = docLang(locale);
    const e = shown(ui, slug);
    if (e === null) return null;
    const notices = [UNTRANSLATED_NOTICE[locale], e.lang !== ui ? docsUi(ui).otherLanguage : undefined].filter((n) => n !== undefined);
    const link = (i: number): PageLink | null => {
      const s = pages[i];
      return s === undefined ? null : { slug: s, title: pageTitle(ui, s) };
    };
    const section = slug.split('/')[0] ?? '';
    return {
      entry: e,
      ui,
      notice: notices.length > 0 ? notices.join(' ') : null,
      section: { slug: section, title: sectionTitle(ui, section) },
      prev: link(at - 1),
      next: link(at + 1),
      languages: DOC_LANGS.filter((l) => entry(l, slug) !== null),
    };
  };

  const searchIndex = (locale: Locale): SearchEntry[] => pages.flatMap((slug) => {
    const p = page(locale, slug);
    if (p === null) return [];
    const sections: SearchSection[] = p.entry.sections;
    return [{
      u: docPath(locale, slug),
      t: p.entry.frontmatter.title,
      s: p.section.title,
      h: sections.map((s) => ({ i: s.id, t: s.id === '' ? p.entry.frontmatter.title : s.heading, x: s.id === '' && s.text === '' ? p.entry.frontmatter.description : s.text })),
    }];
  });

  return { nav, slugs: [...known], pages, page, entry, sectionTitle, pageTitle, searchIndex };
}

// ---------------------------------------------------------------------------------------------
// Files on disk

const CONTENT_DIR = join(process.cwd(), 'src/content/docs');
const REPO_ROOT = join(process.cwd(), '../..');
const BUILD_DATE = new Date().toISOString();

/** Date of the last commit that touched the file; the build date for new, uncommitted files. */
function lastModified(file: string): string {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === '' ? BUILD_DATE : out;
  } catch {
    return BUILD_DATE;
  }
}

export function readSources(dir = CONTENT_DIR): SourceFile[] {
  const files: SourceFile[] = [];
  for (const lang of DOC_LANGS) {
    const root = join(dir, lang);
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const abs = join(d, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (name.endsWith('.md')) {
          files.push({
            lang,
            slug: relative(root, abs).replace(/\\/g, '/').replace(/\.md$/, ''),
            path: relative(REPO_ROOT, abs).replace(/\\/g, '/'),
            source: readFileSync(abs, 'utf8'),
            lastModified: lastModified(abs),
          });
        }
      }
    };
    try { walk(root); } catch { /* no files in this language yet */ }
  }
  return files;
}

let site: Promise<DocsSite> | null = null;
export const getDocs = (): Promise<DocsSite> => (site ??= compileDocs(readSources(), NAV, ROUTES));
