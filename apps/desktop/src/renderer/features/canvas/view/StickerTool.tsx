import type { Sticker } from '@calaba/protocol';
import { Smile } from 'lucide-react';
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import * as Popover from '../../../components/radix/popover';
import { IconButton } from '../../../components/ui';
import { ToolHint } from './ToolHint';
import { t, useLocale } from '../../../i18n';
import { useStickers } from '../../../stores/stickers';
import { StickerPanel } from '../../chat/stickers/StickerPicker';
import type { CanvasEngine } from '../engine';
import { keepFocus } from './chrome';

/**
 * «Стикер из набора» in the toolbar (K): the chat's sticker panel (the same component, the workspace's packs) in a
 * popover; a pick places the sticker as a picture at the center of the view, like a template or a paste, and selects
 * it. Shift+click keeps the panel open for several.
 */
export const StickerTool = memo(function StickerTool({ engine, workspaceId, focusCanvas }: { engine: CanvasEngine; workspaceId: string; focusCanvas: () => void }): ReactNode {
  useLocale();
  const [open, setOpen] = useState(false);
  useEffect(() => engine.onStickerKey(() => setOpen(true)), [engine]);
  const place = useCallback(
    (s: Sticker, keepOpen: boolean) => {
      if (engine.insertImage(s.url, s.width, s.height, s.id)) useStickers.getState().pushRecent(s.id);
      if (!keepOpen) setOpen(false);
    },
    [engine],
  );
  const label = t('canvasBoard.tool.sticker');
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <ToolHint id="sticker" title={label} shortcut="K" suppress={open}>
        <Popover.Trigger asChild>
          <IconButton label={label} tip={false} active={open} onMouseDown={keepFocus} data-testid="canvas-tool-sticker">
            <Smile className="size-[18px]" strokeWidth={1.75} aria-hidden />
          </IconButton>
        </Popover.Trigger>
      </ToolHint>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="center"
          sideOffset={8}
          collisionPadding={16}
          aria-label={label}
          data-testid="canvas-sticker-panel"
          className="mat-popover dense anim-in z-[var(--z-popover)] flex h-[min(520px,var(--radix-popover-content-available-height))] w-[460px] flex-col overflow-hidden rounded-[var(--radius-panel)]"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusCanvas();
          }}
        >
          <StickerPanel place={{ workspaceId }} onSend={place} onClose={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
