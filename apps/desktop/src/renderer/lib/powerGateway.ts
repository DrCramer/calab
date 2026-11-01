import type { PowerEvent } from '../../shared/ipc';

/**
 * What a power event does to the gateway socket (services/session.ts). The desktop's `resume` is
 * a wake from sleep: the socket is usually dead but not closed — reconnect at once. On the web the
 * only `resume` is the browser's `online` (platform/web.ts), which also fires for a network switch
 * with a healthy socket (Wi-Fi ↔ LTE on a phone): probe it (GatewayClient.wake) instead
 * of dropping a live session. A screen unlock keeps the network: probe as well.
 */
export function gatewayOnPower(ev: PowerEvent, web: boolean): 'reconnect' | 'wake' | null {
  if (ev === 'resume') return web ? 'wake' : 'reconnect';
  if (ev === 'unlock-screen') return 'wake';
  return null;
}
