import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Columns3, Grid2x2, LayoutTemplate, MessagesSquare, Network, Workflow, X, type LucideIcon } from 'lucide-react';
import { memo, useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { IconButton, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import type { CanvasSync } from '../../../lib/canvasSync';
import { TEMPLATE_IDS, type TemplateId, type TemplateKey } from '../../../lib/canvas/templates';
import { toast } from '../../../stores/toasts';
import type { CanvasEngine } from '../engine';
import { MENU_BOX, PANEL, keepFocus } from './chrome';
import { useSyncStatus } from './StatusBanner';

const ICON: Record<TemplateId, LucideIcon> = { kanban: Columns3, retro: MessagesSquare, swot: Grid2x2, mindmap: Network, flow: Workflow };

const text = (key: TemplateKey, params?: Record<string, string | number>): string => t(`canvasBoard.templates.${key}`, params);

/** Inserts a template at the center of the view; the canvas may be full (5000 objects), then nothing is inserted and the person is told. */
export function useInsertTemplate(engine: CanvasEngine, focusCanvas: () => void): (id: TemplateId) => void {
  return useCallback(
    (id) => {
      if (engine.insertTemplate(id, text).length === 0) toast.error(t('canvasBoard.templates.limit'));
      focusCanvas();
    },
    [engine, focusCanvas],
  );
}

/** «Шаблоны» in the toolbar: one button, the five templates in a small menu. */
export const TemplatesMenu = memo(function TemplatesMenu({ engine, focusCanvas }: { engine: CanvasEngine; focusCanvas: () => void }): ReactNode {
  useLocale();
  const insert = useInsertTemplate(engine, focusCanvas);
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton label={t('canvasBoard.templates.menu')} onMouseDown={keepFocus} data-testid="canvas-templates-button">
          <LayoutTemplate className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          side="right"
          align="end"
          sideOffset={8}
          className={cx(MENU_BOX, 'w-72')}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusCanvas();
          }}
          data-testid="canvas-templates-menu"
        >
          <Dropdown.Label className="px-2.5 py-1 text-caption text-muted">{t('canvasBoard.templates.title')}</Dropdown.Label>
          {TEMPLATE_IDS.map((id) => (
            <TemplateRow key={id} id={id} onPick={() => insert(id)} as="item" />
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
});

function TemplateRow({ id, onPick, as }: { id: TemplateId; onPick: () => void; as: 'item' | 'button' }): ReactNode {
  const Icon = ICON[id];
  const body = (
    <>
      <Icon className="size-[18px] shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
      <span className="flex min-w-0 flex-col text-left">
        <span className="text-body text-fg">{t(`canvasBoard.templates.name.${id}`)}</span>
        <span className="text-caption text-muted">{t(`canvasBoard.templates.desc.${id}`)}</span>
      </span>
    </>
  );
  const cls = 'flex w-full cursor-default items-center gap-3 rounded-[6px] px-2.5 py-1.5 outline-none hover:bg-hover data-[highlighted]:bg-hover';
  return as === 'item' ? (
    <Dropdown.Item className={cls} onSelect={onPick} data-testid={`canvas-template-${id}`}>
      {body}
    </Dropdown.Item>
  ) : (
    <button type="button" className={cls} onMouseDown={keepFocus} onClick={onPick} data-testid={`canvas-template-${id}`}>
      {body}
    </button>
  );
}

/**
 * The card on an empty canvas: the same five templates. «Empty» is the scene's: it shows once the document has
 * arrived (a canvas still loading is empty too), until the first object appears or it is closed. Its box takes
 * pointer events; the rest of the canvas keeps them (double-click for a text still works around it).
 */
export const TemplatesCard = memo(function TemplatesCard({ engine, sync, focusCanvas }: { engine: CanvasEngine; sync: CanvasSync; focusCanvas: () => void }): ReactNode {
  useLocale();
  const empty = useSyncExternalStore(
    (cb) => engine.scene.subscribe(() => cb()),
    () => engine.scene.size === 0,
  );
  const synced = useSyncStatus(sync) === 'synced';
  const [closed, setClosed] = useState(false);
  const insert = useInsertTemplate(engine, focusCanvas);
  if (!empty || !synced || closed) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center px-24" data-testid="canvas-templates-card-host">
      <div className={cx(PANEL, 'pointer-events-auto flex w-[min(420px,100%)] flex-col gap-1 p-2')} role="region" aria-label={t('canvasBoard.templates.title')} data-testid="canvas-templates-card">
        <div className="flex items-center justify-between px-2.5 pt-1">
          <div className="flex flex-col">
            <span className="text-title text-fg">{t('canvasBoard.templates.title')}</span>
            <span className="text-caption text-muted">{t('canvasBoard.templates.hint')}</span>
          </div>
          <IconButton label={t('canvasBoard.templates.close')} size="sm" onMouseDown={keepFocus} onClick={() => setClosed(true)} data-testid="canvas-templates-close">
            <X className="size-4" strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
        {TEMPLATE_IDS.map((id) => (
          <TemplateRow key={id} id={id} onPick={() => insert(id)} as="button" />
        ))}
      </div>
    </div>
  );
});
