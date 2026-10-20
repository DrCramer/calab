import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import { WorkspaceRole, canvasPermissions } from '@calaba/protocol';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n';
import { canWrite, dropPlan, zoneAt } from '../../lib/canvas/tree';
import { moveItem, openCanvasSection } from '../../services/canvas';
import { useCanvas } from '../../stores/canvas';
import { TREE_MAX, TREE_MIN, useCanvasUi } from '../../stores/canvasUi';
import { myUserId } from '../../stores/session';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { CanvasDialogs } from './Dialogs';
import { CanvasMain } from './CanvasMain';
import { CanvasTree, DragChip, useCanvasDrag } from './CanvasTree';
import { preloadCanvasView } from './lazy';

/**
 * «Холст» on the desktop (ADR-0114 §5, docs/08): one panel in place of the column and the centre —
 * the tree column (resizable 220–360 px) and the open canvas. Mounted only while the section is
 * open: a hidden section holds no subscriptions, no timers and no sync socket.
 */
export function CanvasScreen({ workspaceId }: { workspaceId: string }): ReactNode {
  const roles = useMemberRoles(workspaceId, myUserId());
  const guest = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.GUEST);
  const canCreate = canWrite(canvasPermissions(roles, { guest }));
  const width = useCanvasUi((s) => s.treeWidth);

  useEffect(() => {
    void openCanvasSection(workspaceId);
    preloadCanvasView();
  }, [workspaceId]);

  // Tree rows dragged with the mouse (6 px): before / inside / after the row under the pointer.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragged, setDragged] = useState<string | null>(null);
  const zoneOf = (e: DragMoveEvent | DragEndEvent) => {
    const over = e.over;
    const data = over?.data.current as { itemId?: string; folder?: boolean } | undefined;
    const start = e.activatorEvent as PointerEvent | null;
    if (!over || !data?.itemId || !start || data.itemId === String(e.active.id)) return null;
    return {
      id: data.itemId,
      zone: zoneAt(start.clientY + e.delta.y, over.rect.top, over.rect.height, !!data.folder),
    };
  };
  const onDragStart = (e: DragStartEvent): void => setDragged(String(e.active.id));
  const onDragMove = (e: DragMoveEvent): void => {
    const z = zoneOf(e);
    useCanvasDrag.getState().set(z?.id ?? null, z?.zone ?? null);
  };
  const onDragEnd = (e: DragEndEvent): void => {
    setDragged(null);
    useCanvasDrag.getState().set(null, null);
    const z = zoneOf(e);
    if (!z) return;
    const plan = dropPlan(useCanvas.getState(), String(e.active.id), z.id, z.zone);
    if (plan) void moveItem(String(e.active.id), plan.parentId, plan.position);
  };
  const onDragCancel = (): void => {
    setDragged(null);
    useCanvasDrag.getState().set(null, null);
  };

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
      <section className="mat-content relative flex min-w-0 flex-1" aria-label={t('canvas.section')} data-testid="canvas">
        <aside className="flex shrink-0 flex-col border-r border-line" style={{ width }} data-testid="canvas-column">
          <CanvasTree workspaceId={workspaceId} canCreate={canCreate} />
        </aside>
        <TreeResize />
        <CanvasMain workspaceId={workspaceId} canCreate={canCreate} />
        <CanvasDialogs workspaceId={workspaceId} />
      </section>
      {createPortal(<DragOverlay dropAnimation={null}>{dragged ? <DragChip id={dragged} /> : null}</DragOverlay>, document.body)}
    </DndContext>
  );
}

/** The tree column's edge: drag or ←/→ (persisted, 220–360 px). */
function TreeResize(): ReactNode {
  const start = useRef<{ x: number; w: number } | null>(null);
  const set = (w: number): void => useCanvasUi.getState().setTreeWidth(w);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('shell.resize')}
      aria-valuemin={TREE_MIN}
      aria-valuemax={TREE_MAX}
      aria-valuenow={useCanvasUi.getState().treeWidth}
      tabIndex={0}
      onKeyDown={(e) => {
        const w = useCanvasUi.getState().treeWidth;
        if (e.key === 'ArrowLeft') set(w - 8);
        if (e.key === 'ArrowRight') set(w + 8);
      }}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        start.current = { x: e.clientX, w: useCanvasUi.getState().treeWidth };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current) set(start.current.w + e.clientX - start.current.x);
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      className="relative z-[var(--z-sticky)] -ml-[3px] -mr-[3px] w-[6px] shrink-0 cursor-col-resize after:absolute after:inset-y-0 after:left-[2.5px] after:w-px hover:after:bg-accent focus-visible:after:bg-accent"
      data-testid="canvas-resize"
    />
  );
}
