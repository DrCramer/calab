/**
 * Which components rendered: a React DevTools hook for the canvas benches (the same fiber walk as tools/perf-call.ts,
 * without the «why»). Must be evaluated before react-dom: import it first. `window.__who.start()` resets,
 * `stop()` returns `{ commits, renders: { Component: count } }` for what rendered in between (mounts included).
 */
type F = {
  tag: number;
  flags: number;
  type: unknown;
  child: F | null;
  sibling: F | null;
  alternate: F | null;
};

/** Function, class, forwardRef, memo and simple memo components. */
const COMP = [0, 1, 11, 14, 15];
const nameOf = (f: F): string | null => {
  const t = f.type as { displayName?: string; name?: string; render?: { name?: string; displayName?: string }; type?: { name?: string; displayName?: string } } | null;
  if (!t) return null;
  if (typeof t === 'function') return t.displayName || t.name || 'anon';
  if (typeof t === 'object') return t.displayName || (t.render ? t.render.displayName || t.render.name || 'anon' : t.type ? t.type.displayName || t.type.name || 'anon' : null);
  return null;
};

export interface Who {
  commits: number;
  renders: Record<string, number>;
}

const st = { on: false, commits: 0, renders: {} as Record<string, number> };
(window as unknown as Record<string, unknown>)['__REACT_DEVTOOLS_GLOBAL_HOOK__'] = {
  supportsFiber: true,
  renderers: new Map(),
  inject(r: unknown) {
    const m = this.renderers as Map<number, unknown>;
    m.set(m.size + 1, r);
    return m.size;
  },
  checkDCE() {},
  onScheduleFiberRoot() {},
  onCommitFiberUnmount() {},
  onPostCommitFiberRoot() {},
  onCommitFiberRoot(_id: number, root: { current: F }) {
    if (!st.on) return;
    st.commits++;
    // A subtree whose child list is the previous tree's was not cloned: nothing in it rendered (React DevTools' rule).
    const stack: F[] = [root.current];
    while (stack.length) {
      const f = stack.pop() as F;
      if (COMP.includes(f.tag) && f.flags & 1) {
        const k = nameOf(f);
        if (k) st.renders[k] = (st.renders[k] ?? 0) + 1;
      }
      if (f.sibling && f !== root.current) stack.push(f.sibling);
      if (f.child && (!f.alternate || f.child !== f.alternate.child)) stack.push(f.child);
    }
  },
};

export const who = {
  start(): void {
    st.on = true;
    st.commits = 0;
    st.renders = {};
  },
  stop(): Who {
    st.on = false;
    return { commits: st.commits, renders: { ...st.renders } };
  },
};
