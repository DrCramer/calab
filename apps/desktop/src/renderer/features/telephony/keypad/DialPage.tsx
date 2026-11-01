import type { ReactNode } from 'react';
import { DialPad } from './DialPad';

/** «Набор» on the desktop (ADR-0137 §6): the dial card in the centre. */
export function DialPage({ workspaceId }: { workspaceId: string; floating: boolean }): ReactNode {
  return <DialPad key={workspaceId} ws={workspaceId} phone={false} />;
}

/** «Набор» on the phone (ADR-0137 §7): the FAB's pushed screen. */
export function PhoneDial({ ws }: { ws: string }): ReactNode {
  return <DialPad key={ws} ws={ws} phone />;
}
