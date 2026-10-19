/**
 * What the properties panel shows for the current selection, as a small immutable snapshot that is
 * replaced only when something the panel displays changes. The engine reports every change to a
 * selected object (a drag moves it 60 times a second); the panel must not re-render for x/y, so the
 * snapshot is compared by value and the same object is returned while it is equal.
 */
import type { Arrow, ObjectRec, RouteKind, ShapeKind } from '../../../lib/canvas/types';
import type { CanvasEngine } from '../engine';

export interface PanelModel {
  count: number;
  hasSticky: boolean;
  hasText: boolean;
  hasShape: boolean;
  hasConnector: boolean;
  /** Uniform values of the selection; undefined where the selected objects differ (or do not have the field). */
  stickyColor?: string;
  textColor?: string;
  textSize?: number;
  shape?: ShapeKind;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  arrow?: Arrow;
  route?: RouteKind;
}

function uniform<T>(values: readonly T[]): T | undefined {
  const first = values[0];
  return first !== undefined && values.every((v) => v === first) ? first : undefined;
}

export function panelModelOf(objs: readonly ObjectRec[]): PanelModel | null {
  if (objs.length === 0) return null;
  const sticky = objs.flatMap((o) => (o.kind === 'sticky' ? [o] : []));
  const text = objs.flatMap((o) => (o.kind === 'text' ? [o] : []));
  const shape = objs.flatMap((o) => (o.kind === 'shape' ? [o] : []));
  const conn = objs.flatMap((o) => (o.kind === 'connector' ? [o] : []));
  const out: PanelModel = {
    count: objs.length,
    hasSticky: sticky.length > 0,
    hasText: text.length > 0,
    hasShape: shape.length > 0,
    hasConnector: conn.length > 0,
  };
  const set = <K extends keyof PanelModel>(k: K, v: PanelModel[K] | undefined): void => {
    if (v !== undefined) out[k] = v;
  };
  set('stickyColor', uniform(sticky.map((o) => o.color)));
  set('textColor', uniform(text.map((o) => o.color)));
  set('textSize', uniform(text.map((o) => o.size)));
  set('shape', uniform(shape.map((o) => o.shape)));
  set('fill', uniform(shape.map((o) => o.fill)));
  set('stroke', uniform([...shape.map((o) => o.stroke), ...conn.map((o) => o.stroke)]));
  set('strokeWidth', uniform([...shape.map((o) => o.strokeWidth), ...conn.map((o) => o.strokeWidth)]));
  set('arrow', uniform(conn.map((o) => o.arrow)));
  set('route', uniform(conn.map((o) => o.route)));
  return out;
}

const KEYS: readonly (keyof PanelModel)[] = [
  'count', 'hasSticky', 'hasText', 'hasShape', 'hasConnector', 'stickyColor', 'textColor', 'textSize', 'shape', 'fill', 'stroke', 'strokeWidth', 'arrow', 'route',
];

export const samePanelModel = (a: PanelModel | null, b: PanelModel | null): boolean =>
  a === b || (!!a && !!b && KEYS.every((k) => a[k] === b[k]));

/** A `useSyncExternalStore` source: `null` = nothing selected. */
export interface SelectionModelStore {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => PanelModel | null;
}

export function createSelectionModel(engine: Pick<CanvasEngine, 'subscribeSelection' | 'getSelected'>): SelectionModelStore {
  let current: PanelModel | null = panelModelOf(engine.getSelected());
  return {
    subscribe(cb) {
      return engine.subscribeSelection((objs) => {
        const next = panelModelOf(objs);
        if (samePanelModel(next, current)) return;
        current = next;
        cb();
      });
    },
    getSnapshot() {
      // The snapshot may be read before the first change event (mount): resync lazily.
      const fresh = panelModelOf(engine.getSelected());
      if (!samePanelModel(fresh, current)) current = fresh;
      return current;
    },
  };
}
