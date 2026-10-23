import { shell } from 'electron';
import { ownLinkToDeepLink } from '../shared/ownLink';
import { currentServerUrl } from './auth';
import { handleDeepLink } from './deeplink';

/**
 * Opens an http(s) link from the app: a link to our own server's in-app route (/t/KEY, /r/…, …)
 * goes to the renderer's router (CBF-63), anything else to the system browser.
 */
export function openLink(url: string): void {
  let deep: string | null = null;
  try {
    deep = ownLinkToDeepLink(url, currentServerUrl());
  } catch {
    // no server configured yet: the browser
  }
  if (deep) handleDeepLink(deep);
  else void shell.openExternal(url);
}
