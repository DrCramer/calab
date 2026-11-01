'use client';

import { useEffect } from 'react';
import { captureUtm, goal, goalForHref, isApp, withUtm } from '@/lib/metrika';

// Metrika goals and UTM passthrough (lib/metrika.ts) through one delegated click listener, so server
// components keep their markup. goal() is a no-op until the visitor consented to analytics.
export function GoalTracking() {
  useEffect(() => {
    captureUtm();
    let chatCounted = false;

    const onClick = (e: MouseEvent) => {
      if (e.type === 'auxclick' && e.button !== 1) return; // middle click only (opens a new tab)
      const path = e.composedPath();
      const a = path.find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement && !!n.href);
      if (!a) {
        // The support widget (ChatDeck) lives in a Shadow DOM on #chatdeck-widget and exposes no open event:
        // the first click inside it counts as opening the chat.
        if (!chatCounted && (e.target as Element | null)?.id === 'chatdeck-widget') {
          chatCounted = true;
          goal('support_chat_open');
        }
        return;
      }
      const raw = a.getAttribute('href') ?? '';
      if (isApp(raw)) a.href = withUtm(raw);
      const hit = goalForHref(raw, location.pathname);
      if (hit) goal(hit.id, hit.params);
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);

    let io: IntersectionObserver | undefined;
    const pricing = document.getElementById('pricing');
    if (pricing && 'IntersectionObserver' in window) {
      io = new IntersectionObserver((entries) => {
        if (!entries.some((en) => en.isIntersecting)) return;
        goal('pricing_view');
        io?.disconnect();
      }, { threshold: 0.2 });
      io.observe(pricing);
    }
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('auxclick', onClick, true);
      io?.disconnect();
    };
  }, []);
  return null;
}
