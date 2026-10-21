import { CanvasItemKind, canvasStructureAllowed, CANVAS_BITS, type CanvasItem } from '@calaba/protocol';

/**
 * Canvas (ADR-0114) — pure helpers of the desktop section: the keys of the lazily loaded child
 * lists, the normalized store's reducers (stores/canvas.ts), ancestors for the crumbs, the drop plan
 * of a dragged tree row, the name filter and the rights shortcuts. Same shape as lib/wiki/tree.ts,
 * except that only folders hold children. No store or React imports.
 */

/** The top level's parent id (CanvasItem.parent_id is empty for it). */
export const TOP = '';

/** The key of a child list in the store: the children of a folder (or the top level) of a workspace. */
export const childKey = (wsId: string, parentId: string): string => `${wsId}/${parentId || 'top'}`;
export const trashKey = (wsId: string): string => `${wsId}/trash`;

export interface CanvasData {
  items: Readonly<Record<string, CanvasItem>>;
  /** childKey / trashKey → item ids in the server's order (position; the trash newest first). */
  lists: Readonly<Record<string, readonly string[]>>;
}

export const isFolder = (i: Pick<CanvasItem, 'kind'> | undefined): boolean => i?.kind === CanvasItemKind.FOLDER;

/** A loaded child list (or the trash): its items are stored, the list replaced. */
export function applyList(s: CanvasData, key: string, items: readonly CanvasItem[]): CanvasData {
  const next = { ...s.items };
  for (const i of items) next[i.id] = freshest(s.items[i.id], i);
  return { items: next, lists: { ...s.lists, [key]: items.map((i) => i.id) } };
}

const stamp = (i: CanvasItem): bigint => (i.updatedAt ? i.updatedAt.seconds * 1_000_000_000n + BigInt(i.updatedAt.nanos) : 0n);

/**
 * A fetched list row against the stored item: a list read that started before an event (a rename
 * a moment after the item was created) may arrive after it — the newer content stays, the fetched
 * rights and sharing are taken.
 */
function freshest(prev: CanvasItem | undefined, i: CanvasItem): CanvasItem {
  return prev && stamp(prev) > stamp(i) ? { ...prev, myBits: i.myBits, shared: i.shared } : i;
}

/** An event's item normally carries my_bits (the gateway fills them); a 0 keeps the known ones. */
function keepBits(prev: CanvasItem | undefined, i: CanvasItem, fromEvent = false): CanvasItem {
  return fromEvent && prev && i.myBits === 0n ? { ...i, myBits: prev.myBits } : i;
}

const without = (ids: readonly string[], id: string): readonly string[] => (ids.includes(id) ? ids.filter((x) => x !== id) : ids);

/**
 * CANVAS_ITEM_UPSERT or a local answer: the item is stored and moved between the loaded lists of
 * its workspace — out of every list it no longer belongs to, into its parent's list before the
 * first sibling ordered after it by (position, id) (or the trash's front, for a trash root). The parent folder learns it has children.
 */
export function applyUpsert(s: CanvasData, item: CanvasItem, fromEvent = false): CanvasData {
  const prev = s.items[item.id];
  const stored = keepBits(prev, item, fromEvent);
  const ws = item.workspaceId;
  const home = item.trashedAt ? (item.trashedRoot ? trashKey(ws) : null) : childKey(ws, item.parentId);
  const lists: Record<string, readonly string[]> = {};
  let changed = false;
  for (const [key, ids] of Object.entries(s.lists)) {
    if (!key.startsWith(`${ws}/`)) {
      lists[key] = ids;
      continue;
    }
    let next = key === home && key === trashKey(ws) ? ids : without(ids, item.id);
    if (key === home && !next.includes(item.id)) {
      if (key === trashKey(ws)) next = [item.id, ...next];
      else {
        // The server's order is (position, id) with gaps between positions, not an index; a
        // reorder among the same siblings moves the item too.
        const after = (id: string): boolean => {
          const o = s.items[id];
          return !!o && (o.position > item.position || (o.position === item.position && o.id > item.id));
        };
        const i = next.findIndex(after);
        const at = i < 0 ? next.length : i;
        next = [...next.slice(0, at), item.id, ...next.slice(at)];
        if (next.length === ids.length && next.every((x, j) => x === ids[j])) next = ids;
      }
    }
    if (next !== ids) changed = true;
    lists[key] = next;
  }
  const items: Record<string, CanvasItem> = { ...s.items, [item.id]: stored };
  const parent = !item.trashedAt && item.parentId ? items[item.parentId] : undefined;
  if (parent && !parent.hasChildren) items[parent.id] = { ...parent, hasChildren: true };
  return { items, lists: changed ? lists : s.lists };
}

/** CANVAS_ITEM_REMOVE (deleted forever, or my access gone): the item and its loaded subtree go. */
export function applyRemove(s: CanvasData, id: string): CanvasData {
  const item = s.items[id];
  if (!item && !Object.values(s.lists).some((ids) => ids.includes(id))) return s;
  const gone = new Set<string>([id]);
  if (item) {
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const c of s.lists[childKey(item.workspaceId, cur)] ?? []) {
        if (!gone.has(c)) {
          gone.add(c);
          stack.push(c);
        }
      }
    }
  }
  const items = { ...s.items };
  for (const g of gone) delete items[g];
  const lists: Record<string, readonly string[]> = {};
  for (const [key, ids] of Object.entries(s.lists)) {
    const slash = key.indexOf('/');
    if (gone.has(key.slice(slash + 1))) continue;
    lists[key] = ids.some((x) => gone.has(x)) ? ids.filter((x) => !gone.has(x)) : ids;
  }
  return { items, lists };
}

/** Everything of a workspace dropped (left it, deleted). */
export function dropWorkspace(s: CanvasData, wsId: string): CanvasData {
  const items: Record<string, CanvasItem> = {};
  for (const [id, i] of Object.entries(s.items)) if (i.workspaceId !== wsId) items[id] = i;
  const lists: Record<string, readonly string[]> = {};
  for (const [key, ids] of Object.entries(s.lists)) if (!key.startsWith(`${wsId}/`)) lists[key] = ids;
  return { items, lists };
}

/** The ancestors of an item, the top-level one first (stops at an unknown one); empty for the top level. */
export function ancestorsOf(items: Readonly<Record<string, CanvasItem>>, id: string): string[] {
  const out: string[] = [];
  let cur = items[id]?.parentId ?? '';
  for (let i = 0; cur && i < 40; i++) {
    out.unshift(cur);
    cur = items[cur]?.parentId ?? '';
  }
  return out;
}

/** Is `id` the item `root` or inside its subtree (by the known parents)? */
export function isInSubtree(items: Readonly<Record<string, CanvasItem>>, id: string, root: string): boolean {
  let cur = id;
  for (let i = 0; cur && i < 40; i++) {
    if (cur === root) return true;
    cur = items[cur]?.parentId ?? '';
  }
  return false;
}

// ---------------------------------------------------------------- drag and drop in the tree

/** Where a dragged row lands relative to the row under the pointer. */
export type DropZone = 'before' | 'inside' | 'after';

/**
 * The zone from the pointer's height inside the row. A folder row: the top and bottom quarters go
 * between rows, the middle inside it. A canvas row holds nothing: its halves are before / after.
 */
export function zoneAt(pointerY: number, top: number, height: number, folder = true): DropZone {
  const f = height > 0 ? (pointerY - top) / height : 0.5;
  if (!folder) return f < 0.5 ? 'before' : 'after';
  return f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'inside';
}

export interface DropPlan {
  parentId: string;
  /** The index among the new siblings (the dragged item itself not counted), as PATCH takes it. */
  position: number;
}

/**
 * The PATCH a drop asks for, or null when it is a no-op or not allowed (into itself or its own
 * subtree, into a canvas). `inside` appends to the folder's loaded children (first when they are
 * not loaded).
 */
export function dropPlan(s: CanvasData, dragId: string, overId: string, zone: DropZone): DropPlan | null {
  const drag = s.items[dragId];
  const over = s.items[overId];
  if (!drag || !over || dragId === overId) return null;
  if (zone === 'inside' && !isFolder(over)) return null;
  const ws = drag.workspaceId;
  const parentId = zone === 'inside' ? over.id : over.parentId;
  if (parentId && isInSubtree(s.items, parentId, dragId)) return null;
  const siblings = (s.lists[childKey(ws, parentId)] ?? []).filter((x) => x !== dragId);
  let position: number;
  if (zone === 'inside') position = s.lists[childKey(ws, parentId)] ? siblings.length : 0;
  else {
    const i = siblings.indexOf(over.id);
    if (i < 0) return null;
    position = zone === 'before' ? i : i + 1;
  }
  if (parentId === drag.parentId) {
    const cur = (s.lists[childKey(ws, parentId)] ?? []).indexOf(dragId);
    if (cur === position) return null;
  }
  return { parentId, position };
}

// ---------------------------------------------------------------- search, rights

/** Case-insensitive substring match of the name. */
export function matchesName(name: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || name.toLocaleLowerCase().includes(q);
}

/** Loaded live items of a workspace whose name matches (the tree's filter), at most `limit`. */
export function filterItems(items: Readonly<Record<string, CanvasItem>>, wsId: string, query: string, limit = 50): string[] {
  if (!query.trim()) return [];
  const out: string[] = [];
  for (const i of Object.values(items)) {
    if (i.workspaceId !== wsId || i.trashedAt || !matchesName(i.name, query)) continue;
    out.push(i.id);
    if (out.length >= limit) break;
  }
  return out;
}

/** `more` appended to `list` without the ids it already has (a page fetched twice adds nothing); the same array when nothing is new. */
export function mergeById<T extends { id: string }>(list: readonly T[], more: readonly T[]): readonly T[] {
  const have = new Set(list.map((x) => x.id));
  const fresh = more.filter((x) => !have.has(x.id) && have.add(x.id));
  return fresh.length ? [...list, ...fresh] : list;
}

export const canView = (bits: bigint): boolean => (bits & CANVAS_BITS.VIEW) !== 0n;
/** Edit the content of a canvas and create items in a folder (ADR-0114 §2). */
export const canWrite = (bits: bigint): boolean => (bits & (CANVAS_BITS.WRITE | CANVAS_BITS.MANAGE)) !== 0n;
export const canManage = (bits: bigint): boolean => (bits & CANVAS_BITS.MANAGE) !== 0n;
/** Rename, move, trash, restore, delete and access: the owner or CANVAS_MANAGE. */
export const canStructure = (i: Pick<CanvasItem, 'ownerId' | 'myBits'>, me: string): boolean => canvasStructureAllowed(i.myBits, i.ownerId !== '' && i.ownerId === me);
