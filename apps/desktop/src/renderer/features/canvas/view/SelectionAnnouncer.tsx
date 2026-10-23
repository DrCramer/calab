import { memo, type ReactNode } from 'react';
import { t, useLocale } from '../../../i18n';
import type { ObjectRec } from '../../../lib/canvas/types';
import type { CanvasEngine } from '../engine';
import { useEngineValue } from './hooks';
import { SHAPE_DEFS } from './model';

/** Long texts are cut: a screen reader reads the start, the rest is one Enter away (the text editor). */
const MAX_TEXT = 160;

function kindLabel(o: ObjectRec): string {
  switch (o.kind) {
    case 'sticky': return t('canvasBoard.tool.sticky');
    case 'text': return t('canvasBoard.tool.text');
    case 'connector': return t('canvasBoard.tool.connector');
    case 'shape': {
      const def = SHAPE_DEFS.find((d) => d.kind === o.shape);
      return def ? t(def.label) : t('canvasBoard.tool.shape');
    }
  }
}

/** «Стикер: Решения», «Эллипс: без текста, заблокирован». */
export function describeObject(o: ObjectRec): string {
  const raw = (o.kind === 'connector' ? o.label : o.text).replace(/\s+/g, ' ').trim();
  const text = raw ? (raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}…` : raw) : t('canvasBoard.a11y.noText');
  const line = t('canvasBoard.a11y.object', { kind: kindLabel(o), text });
  return o.locked ? `${line}, ${t('canvasBoard.a11y.locked')}` : line;
}

/**
 * The canvas is one `<canvas>`: what Tab (or a click) selects is said by this polite live region, so the keyboard walk
 * over objects (engine/input.ts) is not silent for a screen reader. A leaf with primitives only: it re-renders when the
 * selection changes, never for pan, drag or a co-author's edit; nothing is said while the text editor is open (the
 * textarea speaks for itself).
 */
export const SelectionAnnouncer = memo(function SelectionAnnouncer({ engine }: { engine: CanvasEngine }): ReactNode {
  useLocale();
  const id = useEngineValue(engine, (s) => s.selectedId);
  const count = useEngineValue(engine, (s) => s.selectionCount);
  const editing = useEngineValue(engine, (s) => s.editing);
  let text = '';
  if (!editing) {
    if (count > 1) text = t('canvasBoard.a11y.many', { n: count });
    else if (id !== null) {
      const o = engine.scene.get(id);
      if (o) text = describeObject(o);
    }
  }
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="canvas-announce">
      {text}
    </div>
  );
});
