import { shell } from 'electron';
import { classifyLink, ownOrigins, parseOriginList } from '../shared/ownLink';
import { currentServerUrl } from './auth';
import { handleDeepLink } from './deeplink';
import { getSettings } from './settings';

/**
 * The app origins of this deployment (docs/06 «Домены»: the main host and its eternal aliases),
 * space-separated: CALABA_APP_ORIGINS at runtime, MAIN_VITE_APP_ORIGINS at build time.
 */
export const APP_ORIGINS: readonly string[] = parseOriginList(process.env['CALABA_APP_ORIGINS'] ?? import.meta.env.MAIN_VITE_APP_ORIGINS);

/** Our origins now: the session's server, the configured one and, for them, the deployment's aliases. */
export function linkOrigins(): string[] {
  let session = '';
  try {
    session = currentServerUrl();
  } catch {
    // no server configured yet
  }
  return ownOrigins([session, getSettings().serverUrl], APP_ORIGINS);
}

/**
 * Opens an http(s) link from the app (shared/ownLink.ts classifyLink): an in-app route of our own
 * server (/t/KEY, /r/…, …) goes to the renderer's router (CBF-63), anything else to the system browser.
 */
export function openLink(url: string): void {
  const c = classifyLink(url, linkOrigins());
  if (c.kind === 'app') handleDeepLink(c.deepLink);
  else if (c.kind !== 'invalid') void shell.openExternal(c.url);
}
