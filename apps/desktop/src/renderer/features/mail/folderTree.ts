import type { MailFolder } from '../../../shared/mail';
import { ROLE_ORDER } from './format';

/** One visible row of an account's folder tree (CBF-56). */
export interface TreeRow {
  folder: MailFolder;
  depth: number;
  /** Has subfolders (the disclosure chevron). */
  hasChildren: boolean;
}

/** Deeper than this the indent stops growing (and a broken parent chain cannot loop). */
const MAX_DEPTH = 8;
const NONE: ReadonlySet<string> = new Set();

const rank = (f: MailFolder): number => (f.role ? ROLE_ORDER.indexOf(f.role) : ROLE_ORDER.length);

function cmp(a: MailFolder, b: MailFolder): number {
  return rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.path.localeCompare(b.path);
}

/**
 * An account's folders as Apple Mail's sidebar shows them (CBF-56): the role folders at the top in
 * the fixed order (Входящие, Отмеченные, Отправленные…, never nested under another folder), then
 * the user's folders by name; every folder followed by its subfolders (by `parentId`, the IMAP
 * path). A folder whose parent is not listed (a `\Noselect` parent such as `[Gmail]`) is top-level.
 * The subtrees of `collapsed` folder ids are left out.
 */
export function folderTree(list: readonly MailFolder[], collapsed: ReadonlySet<string> = NONE): TreeRow[] {
  const byId = new Map(list.map((f) => [f.id, f]));
  const kids = new Map<string, MailFolder[]>();
  const roots: MailFolder[] = [];
  for (const f of list) {
    const parent = !f.role && f.parentId && f.parentId !== f.id ? byId.get(f.parentId) : undefined;
    if (!parent) {
      roots.push(f);
      continue;
    }
    const l = kids.get(parent.id);
    if (l) l.push(f);
    else kids.set(parent.id, [f]);
  }
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (f: MailFolder, depth: number): void => {
    if (seen.has(f.id)) return;
    seen.add(f.id);
    const children = (kids.get(f.id) ?? []).sort(cmp);
    out.push({ folder: f, depth: Math.min(depth, MAX_DEPTH), hasChildren: children.length > 0 });
    if (collapsed.has(f.id)) {
      // Hidden, but marked seen: a collapsed subtree never surfaces elsewhere.
      const hide = (x: MailFolder): void => {
        for (const c of kids.get(x.id) ?? []) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          hide(c);
        }
      };
      hide(f);
      return;
    }
    for (const c of children) walk(c, depth + 1);
  };
  for (const r of roots.sort(cmp)) walk(r, 0);
  // A parent chain that loops (a corrupt list) has no root: list what is left at the top level.
  for (const f of [...list].sort(cmp)) if (!seen.has(f.id)) walk(f, 0);
  return out;
}

/** Folder ids under `id` (the subtree), for «Удалить» (they go with it). */
export function subfolderCount(list: readonly MailFolder[], id: string): number {
  let n = 0;
  const stack = [id];
  const seen = new Set<string>([id]);
  while (stack.length) {
    const cur = stack.pop();
    for (const f of list) {
      if (f.parentId !== cur || seen.has(f.id)) continue;
      seen.add(f.id);
      n++;
      stack.push(f.id);
    }
  }
  return n;
}

/** Can the user rename / delete this folder (an ordinary folder on the server)? */
export const isOwnFolder = (f: Pick<MailFolder, 'role' | 'path'>): boolean => !f.role && f.path !== '';

/** Can a subfolder be created in it (any real folder; virtual ones have no IMAP path)? */
export const canHoldFolders = (f: Pick<MailFolder, 'role' | 'path'>): boolean => f.path !== '' && f.role !== 'trash' && f.role !== 'junk';
