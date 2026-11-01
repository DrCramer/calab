'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

const AUTO = 3500;
/** The finite autoplay: one pass over the first three scenes, then it stops for good. */
const AUTO_LAST = 2;

/**
 * Hero «одно окно — семь сцен» (§4.1): chips are a tablist (arrows, Home/End), the window cross-fades 250 ms.
 * Without JS only the first scene is in the HTML. The other scenes mount after the page has loaded and gone
 * idle (the LCP shot loads alone). Autoplay: once, while the hero is on screen and the tab is visible; any
 * pointer or key action, leaving the screen for good or reduced motion stops it.
 * Desktop: the window stands tilted in perspective (CSS); a click zooms it to fit the viewport, a second one returns it.
 */
export function SceneSwitcher({
  copy,
  label,
  chips,
  panels,
}: {
  /** The title, lead and buttons: the left column on desktop, above the window on phones. */
  copy: ReactNode;
  label: string;
  chips: { key: string; label: string; icon: ReactNode }[];
  panels: ReactNode[];
}) {
  const [active, setActive] = useState(0);
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const tilt = useRef<HTMLDivElement>(null);
  const stopAuto = () => {
    auto.current.done = true;
    window.clearTimeout(auto.current.timer);
  };
  const auto = useRef({ done: false, timer: 0, visible: false, step: 0 });

  useEffect(() => {
    const mount = () => {
      const idle = (cb: () => void) => {
        if ('requestIdleCallback' in window) window.requestIdleCallback(cb, { timeout: 2000 });
        else setTimeout(cb, 200);
      };
      idle(() => { setReady(true); });
    };
    if (document.readyState === 'complete') mount();
    else window.addEventListener('load', mount, { once: true });
    return () => { window.removeEventListener('load', mount); };
  }, []);

  useEffect(() => {
    const node = root.current;
    const a = auto.current;
    if (!node || !ready) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stopTimer = () => {
      window.clearTimeout(a.timer);
      a.timer = 0;
    };
    const finish = () => {
      a.done = true;
      stopTimer();
    };
    const schedule = () => {
      stopTimer();
      if (a.done || !a.visible || document.hidden || reduce.matches) return;
      a.timer = window.setTimeout(() => {
        a.step += 1;
        setActive(a.step);
        if (a.step >= AUTO_LAST) finish();
        else schedule();
      }, AUTO);
    };
    const observer = new IntersectionObserver(([entry]) => {
      a.visible = !!entry?.isIntersecting && entry.intersectionRatio >= 0.4;
      schedule();
    }, { threshold: [0, 0.4] });
    observer.observe(node);
    const onVisibility = () => { schedule(); };
    document.addEventListener('visibilitychange', onVisibility);
    reduce.addEventListener('change', finish);
    return () => {
      observer.disconnect();
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibility);
      reduce.removeEventListener('change', finish);
    };
  }, [ready]);

  // Zoom: a click centres the window and fits it to the viewport over a dimmed page; a second click, Escape,
  // a scroll or a resize send it back. Transform only (the CSS transition animates both ways).
  const [zoomed, setZoomed] = useState(false);
  const toggleZoom = () => {
    const win = tilt.current;
    const stage = win?.parentElement;
    if (!win || !stage) return;
    stopAuto();
    if (zoomed) { setZoomed(false); return; }
    const box = stage.getBoundingClientRect();
    const w = win.offsetWidth;
    const h = win.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const scale = Math.min((vw - 48) / w, (vh - 48) / h);
    // transform-origin is (0, 50%): solve for the translate that puts the scaled box in the middle of the viewport.
    const x = (vw - w * scale) / 2 - box.left;
    const y = (vh - h * scale) / 2 - box.top - h / 2 + (h * scale) / 2;
    win.style.setProperty('--zoom-x', `${x.toFixed(1)}px`);
    win.style.setProperty('--zoom-y', `${y.toFixed(1)}px`);
    win.style.setProperty('--zoom-s', scale.toFixed(4));
    setZoomed(true);
  };
  useEffect(() => {
    if (!zoomed) return;
    const close = () => { setZoomed(false); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    document.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', key);
    };
  }, [zoomed]);

  const choose = (i: number, focus = false) => {
    stopAuto();
    setActive(i);
    if (focus) tabs.current[i]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = chips.length - 1;
    const to = { ArrowRight: active + 1, ArrowDown: active + 1, ArrowLeft: active - 1, ArrowUp: active - 1, Home: 0, End: last }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    choose(to > last ? 0 : to < 0 ? last : to, true);
  };

  return (
    <div ref={root} className="hero-layout" data-zoomed={zoomed || undefined} onPointerDown={stopAuto}>
      <div className="hero-copy">{copy}</div>
      <div className="hero-stage">
        <div ref={tilt} className="scenes-window" onClick={toggleZoom}>
          {panels.map((panel, i) =>
            i === 0 || ready ? (
              <div
                key={chips[i]?.key}
                id={`scene-${chips[i]?.key}`}
                role="tabpanel"
                aria-labelledby={`scene-tab-${chips[i]?.key}`}
                className="scene"
                data-active={i === active}
                hidden={ready ? undefined : i !== 0}
                inert={i !== active}
              >
                {panel}
              </div>
            ) : null,
          )}
        </div>
      </div>
      <div className="hero-dim" aria-hidden="true" onClick={() => { setZoomed(false); }} />
      <div className="scene-nav">
        <div role="tablist" aria-label={label} className="scene-chips" onKeyDown={onKey}>
          {chips.map((c, i) => (
            <button
              key={c.key}
              ref={(el) => { tabs.current[i] = el; }}
              id={`scene-tab-${c.key}`}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-controls={ready || i === 0 ? `scene-${c.key}` : undefined}
              tabIndex={i === active ? 0 : -1}
              className="chip chip-quiet"
              onClick={() => { choose(i); }}
            >
              {c.icon}
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
