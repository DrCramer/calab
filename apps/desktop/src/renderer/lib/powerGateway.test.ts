import { describe, expect, it } from 'vitest';
import { gatewayOnPower } from './powerGateway';

describe('gatewayOnPower', () => {
  it('desktop: a wake from sleep reconnects at once, an unlock probes', () => {
    expect(gatewayOnPower('resume', false)).toBe('reconnect');
    expect(gatewayOnPower('unlock-screen', false)).toBe('wake');
  });

  it('web: `online` (sent as resume) probes the socket instead of dropping a live one', () => {
    expect(gatewayOnPower('resume', true)).toBe('wake');
  });

  it('suspend / lock leave the socket alone', () => {
    expect(gatewayOnPower('suspend', false)).toBeNull();
    expect(gatewayOnPower('lock-screen', true)).toBeNull();
  });
});
