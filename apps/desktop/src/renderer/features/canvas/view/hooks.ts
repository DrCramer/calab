import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CanvasEngine, EngineState } from '../engine';

/**
 * One primitive of the engine's state. The component re-renders only when this value changes — never for
 * pan, drag or resize (CLAUDE.md «Ререндеры»). `pick` must return a primitive.
 */
export function useEngineValue<T extends string | number | boolean | null>(engine: CanvasEngine, pick: (s: EngineState) => T): T {
  return useSyncExternalStore(engine.subscribe, () => pick(engine.getState()));
}

/** `flag` turned `true` for at least `ms` (no flash for short states). The timer exists only while pending. */
export function useAfter(flag: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!flag) return undefined;
    const id = window.setTimeout(() => setOn(true), ms);
    return () => {
      window.clearTimeout(id);
      setOn(false);
    };
  }, [flag, ms]);
  return flag && on;
}
