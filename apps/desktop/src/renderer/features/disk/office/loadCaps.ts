import { OfficeCapabilitiesResponseSchema } from '@calaba/protocol';
import { call } from '../../../lib/api/client';
import { platform } from '../../../platform';
import { setOfficeCaps, useOfficeCaps } from './caps';

let inflight: Promise<void> | null = null;

/**
 * GET /api/office/capabilities (ADR-0143) at every READY: the server may have turned the editor on or
 * off. A failure keeps what was known. With the editor on, Electron warms the editors this person has
 * opened before (main/officeWarm.ts: after a pause, once per Document Server version).
 */
export function loadOfficeCaps(): Promise<void> {
  inflight ??= call('GET', '/api/office/capabilities', OfficeCapabilitiesResponseSchema)
    .then((r) => {
      setOfficeCaps(r);
      if (useOfficeCaps.getState().enabled) void platform.office?.warm('ready');
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
