import { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react';

/**
 * «Показать всё» / «Свернуть» that outlive the row (the chat feed is virtualised): Virtuoso
 * unmounts a row once it is far enough off screen, and a disclosure kept in component state came
 * back folded. Its cached height was the open one, so the feed jumped by the difference — thousands
 * of px for a long meeting summary — and re-laid out its rows several times (the «flicker»).
 *
 * Inside a feed row (`DisclosureScope` = the row's message key) the open state lives here, keyed
 * by scope + part; elsewhere (a dialog, the wiki) it stays local. Per-key subscriptions: a toggle
 * wakes only the one component that reads that key. Session memory only, the oldest keys dropped
 * past CAP.
 */
export const DisclosureScope = createContext<string | null>(null);

/** Open disclosures remembered at most (insertion order: the oldest is dropped first). */
export const CAP = 500;

const open = new Set<string>();
const subs = new Map<string, Set<() => void>>();

function notify(key: string): void {
  subs.get(key)?.forEach((f) => f());
}

export function isOpen(key: string): boolean {
  return open.has(key);
}

export function setOpen(key: string, v: boolean): void {
  if (v === open.has(key)) return;
  if (v) {
    open.add(key);
    if (open.size > CAP) {
      const oldest = open.values().next().value;
      if (oldest !== undefined) {
        open.delete(oldest);
        notify(oldest);
      }
    }
  } else {
    open.delete(key);
  }
  notify(key);
}

export function subscribe(key: string, f: () => void): () => void {
  let set = subs.get(key);
  if (!set) subs.set(key, (set = new Set()));
  set.add(f);
  return () => {
    set.delete(f);
    if (!set.size) subs.delete(key);
  };
}

/** Test hook: forget everything. */
export function resetDisclosures(): void {
  open.clear();
}

const noop = (): (() => void) => () => undefined;

/**
 * `[open, setOpen]` of the disclosure `part` (unique within its row, e.g. 'summary'): kept in the
 * store inside a feed row (DisclosureScope), in component state elsewhere.
 */
export function useDisclosure(part: string): [boolean, (v: boolean) => void] {
  const scope = useContext(DisclosureScope);
  const key = scope === null ? null : `${scope}\u0001${part}`;
  const [local, setLocal] = useState(false);
  const sub = useCallback((f: () => void) => (key === null ? noop() : subscribe(key, f)), [key]);
  const snap = useCallback(() => (key === null ? false : open.has(key)), [key]);
  const stored = useSyncExternalStore(sub, snap);
  const set = useCallback((v: boolean) => (key === null ? setLocal(v) : setOpen(key, v)), [key]);
  return [key === null ? local : stored, set];
}
