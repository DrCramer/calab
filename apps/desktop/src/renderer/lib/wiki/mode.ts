/**
 * Read / edit mode of a wiki page (owner 14.10: pages open for reading so links are clickable;
 * editing is a button). The mode is local UI state — one page id being edited at a time, never
 * persisted and never in the Yjs doc. Pure transitions; `stores/wikiUi` holds the value.
 *
 * - open (any existing page, from the tree, a link, a deep link, the phone list): read mode, except
 *   re-opening the page already being edited;
 * - create (root «+», «Добавить подстраницу», `/`-insert of a subpage): edit mode at once;
 * - toggle («Редактировать» / «Готово», Esc): only with WRITE;
 * - leave (the page closes): its edit mode ends.
 */
export type ModeEvent =
  | { kind: 'open'; id: string }
  | { kind: 'create'; id: string }
  | { kind: 'toggle'; id: string; canWrite: boolean }
  | { kind: 'leave'; id: string };

export function nextEditing(cur: string | null, ev: ModeEvent): string | null {
  switch (ev.kind) {
    case 'open':
      return cur === ev.id ? cur : null;
    case 'create':
      return ev.id;
    case 'toggle':
      if (!ev.canWrite) return cur === ev.id ? null : cur;
      return cur === ev.id ? null : ev.id;
    case 'leave':
      return cur === ev.id ? null : cur;
  }
}
