'use client';

import { useEffect } from 'react';

// Support chat (ChatDeck widget, chatdeck.ru). Loads on every landing page; the widget mounts itself in a
// Shadow DOM, so the site's styles are untouched. CSP for it (script, API + socket, attachment images) is in
// infra/docker/caddy/sites.caddy. The key is publishable — it only identifies the support workspace.
const SRC = 'https://chatdeck.ru/widget.js';
const KEY = 'pk_30d6494c9d7d1f6777c62d65aa6e18f0';

export function SupportChat() {
  useEffect(() => {
    if (document.querySelector(`script[data-chatdeck-key="${KEY}"]`)) return;
    const script = document.createElement('script');
    script.src = SRC;
    script.async = true;
    script.dataset.chatdeckKey = KEY;
    // The ChatDeck workspace hides its default launcher (custom buttons elsewhere); on this site we want it.
    script.dataset.chatdeckLauncher = 'show';
    document.body.appendChild(script);
  }, []);
  return null;
}
