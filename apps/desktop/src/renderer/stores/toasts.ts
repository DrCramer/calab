import { create } from 'zustand';
import { describeError, errorText } from '../lib/api/errors';
import { log } from '../lib/log';
import { t } from '../i18n';
import { pushToast, type Toast, type ToastAction } from './toastQueue';

export type { Toast, ToastAction } from './toastQueue';

/**
 * Toasts (docs/09 #16): opaque popovers, top right, newest on top, auto-hide after TOAST_MS. The timer lives
 * in the view (features/shell/Toasts.tsx), which pauses it while the stack is hovered or
 * focused and while the window is hidden. An error that offers an action («Повторить») stays
 * until closed: it asks the user to decide, so it must not vanish before they read it.
 */
export const TOAST_MS = 6000;

interface ToastState {
  items: Toast[];
  push: (kind: Toast['kind'], text: string, action?: ToastAction, durationMs?: number) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>()((set, get) => ({
  items: [],
  push: (kind, text, action, durationMs) => {
    const items = pushToast(get().items, { id: nextId++, kind, text, ...(action ? { action } : {}), ...(durationMs ? { durationMs } : {}) });
    set({ items });
    return items[items.length - 1]?.id ?? 0;
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

export const toast = {
  info: (text: string): void => void useToasts.getState().push('info', text),
  success: (text: string): void => void useToasts.getState().push('success', text),
  /** A ready human text (already mapped). */
  error: (text: string, action?: ToastAction): void => void useToasts.getState().push('error', text, action),
  /**
   * A caught exception: logged raw (for bug reports), shown mapped (lib/api/errors.ts).
   * `what` — «Не удалось сохранить»; `retry` — offered only when repeating can help.
   */
  fail: (e: unknown, what?: string, retry?: () => void): void => {
    log.warn(what ?? 'error', e);
    const h = describeError(e);
    if (h.text === t('err.cancelled')) return;
    useToasts.getState().push('error', errorText(e, what), retry && h.retry ? { label: t('toast.retry'), run: retry } : undefined);
  },
};
