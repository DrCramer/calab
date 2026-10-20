import * as Base from '@radix-ui/react-popover';
import type { ComponentProps, ReactNode } from 'react';
import { BarContext } from '../ui';

export * from '@radix-ui/react-popover';

/**
 * The portal of a menu / popover / dialog opened from a header bar: React context crosses portals,
 * so without the reset its Buttons, Inputs and Selects would take the bar's 28 px size
 * (docs/08 «Шапки на десктопе»). Same API as Radix's; every feature imports this module.
 */
export function Portal({ children, ...rest }: ComponentProps<typeof Base.Portal>): ReactNode {
  return (
    <Base.Portal {...rest}>
      <BarContext.Provider value={false}>{children}</BarContext.Provider>
    </Base.Portal>
  );
}
