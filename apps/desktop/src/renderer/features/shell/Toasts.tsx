import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { CloseButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import type { DeviceSwitch } from '../../lib/deviceSwitch';
import { announceDeviceSwitch } from '../../services/deviceToast';
import { useSession } from '../../stores/session';
import { isSticky, newestFirst, stackInteraction, type Toast, type ToastAction } from '../../stores/toastQueue';
import { TOAST_MS, useToasts } from '../../stores/toasts';

declare global {
  interface Window {
    /** Visual tests only (CALABA_VISUAL_TEST / ?visual-test): raise a toast without a real failure. */
    __calabaToast?: (kind: Toast['kind'], text: string, action?: ToastAction) => void;
    /** Visual tests only: the «the OS switched the audio device» toast (docs/09 #49) without a real device change. */
    __calabaDeviceToast?: (kind: DeviceSwitch['kind'], label: string) => void;
  }
}

/**
 * Toast stack (docs/09 #16, docs/08 «Тосты»): opaque mat-popover cards at the top right under the
 * title bar (right margin = the page gutter), ≤ 420 px wide, newest on top, growing downwards;
 * pure CSS placement (no measuring). With the inbox popover open the stack steps left of it; phones:
 * under the top bar. Each toast hides after TOAST_MS; the countdown pauses while the pointer or
 * keyboard focus is in the stack and while the window is hidden (a toast raised in the
 * background waits to be seen). Errors are announced assertively (role="alert"), the rest
 * politely. Esc on a focused toast closes it.
 */
export function Toasts(): ReactNode {
  const items = useToasts((s) => s.items);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  const stack = useRef<HTMLElement>(null);
  const [{ hover, focus }, interact] = useReducer(stackInteraction, { hover: false, focus: false });
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);

  useEffect(() => {
    const on = (): void => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => {
    if (!visualTest) return;
    window.__calabaToast = (kind, text, action) => void useToasts.getState().push(kind, text, action);
    window.__calabaDeviceToast = (kind, label) => announceDeviceSwitch({ kind, label });
    return () => {
      delete window.__calabaToast;
      delete window.__calabaDeviceToast;
    };
  }, [visualTest]);

  useLayoutEffect(() => {
    // Removing the toast under the pointer or focus (dismiss, dedupe or queue eviction) emits
    // no pointerleave/blur: reconcile with the surviving DOM so the stack cannot stay paused
    // indefinitely (#45). A pointer that is still over the stack re-arms hover on its next move.
    interact({ type: 'items', focusInside: stack.current?.contains(document.activeElement) ?? false });
  }, [items]);

  const paused = hover || focus || hidden || visualTest;
  const ordered = useMemo(() => newestFirst(items), [items]);
  return (
    <section
      ref={stack}
      aria-label={t('toast.region')}
      // A web app's native view steps aside while the stack shows (features/webapps/AppScreen).
      data-app-occluder
      data-toast-stack
      // Desktop: top right under the title bar; the inbox popover moves it aside (styles.css). Phones:
      // under the top bar and under the drawers and sheets, which the user is working in.
      className="pointer-events-none fixed right-4 top-[calc(var(--titlebar-height)+8px)] z-[var(--z-toast)] flex w-[420px] max-w-[calc(100vw-var(--rail-width)-32px)] flex-col items-stretch gap-2 [:root.web_&]:top-[calc(var(--titlebar-height-web)+8px)] mobile:left-4 mobile:right-4 mobile:top-[calc(var(--safe-top)+56px)] mobile:z-[var(--z-popover)] mobile:w-auto mobile:max-w-none mobile:[:root.web_&]:top-[calc(var(--safe-top)+56px)]"
      onPointerEnter={() => interact({ type: 'enter' })}
      onPointerMove={() => interact({ type: 'enter' })}
      onPointerLeave={() => interact({ type: 'leave' })}
      onFocus={() => interact({ type: 'focus' })}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) interact({ type: 'blur' });
      }}
    >
      {ordered.map((x) => (
        <ToastItem key={x.id} toast={x} paused={paused} />
      ))}
    </section>
  );
}

const ICON = { error: CircleAlert, success: CircleCheck, info: Info } as const;

function ToastItem({ toast: x, paused }: { toast: Toast; paused: boolean }): ReactNode {
  const dismiss = useToasts((s) => s.dismiss);
  const left = useRef(x.durationMs ?? TOAST_MS);
  const sticky = isSticky(x);

  useEffect(() => {
    if (paused || sticky) return;
    const started = Date.now();
    const id = window.setTimeout(() => dismiss(x.id), left.current);
    return () => {
      window.clearTimeout(id);
      left.current = Math.max(1000, left.current - (Date.now() - started));
    };
  }, [paused, sticky, dismiss, x.id]);

  const Icon = ICON[x.kind];
  return (
    <div
      role={x.kind === 'error' ? 'alert' : 'status'}
      aria-live={x.kind === 'error' ? 'assertive' : 'polite'}
      data-testid="toast"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          dismiss(x.id);
        }
      }}
      className="mat-popover toast-card pointer-events-auto flex items-center gap-2.5 rounded-[20px] py-2.5 pl-4 pr-2.5 text-body text-fg"
    >
      <Icon className={cx('size-[18px] shrink-0', x.kind === 'error' ? 'text-danger' : x.kind === 'success' ? 'text-ok' : 'text-accent')} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <span className="selectable break-words [overflow-wrap:anywhere]">
          {x.text}
          {x.count && x.count > 1 ? <span className="ml-1.5 text-caption text-muted">×{x.count}</span> : null}
        </span>
        {x.action ? (
          <button
            type="button"
            className="-ml-1 rounded-[var(--radius-control)] px-1 text-body font-medium text-accent-text hover:underline"
            onClick={() => {
              dismiss(x.id);
              x.action?.run();
            }}
          >
            {x.action.label}
          </button>
        ) : null}
      </div>
      <CloseButton label={t('toast.close')} shortcut="" className="size-6" onClick={() => dismiss(x.id)} />
    </div>
  );
}
