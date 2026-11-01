import { describe, expect, it } from 'vitest';
import { mayReadAllCalls, telephonyVisible, type TelephonyAccessInput } from './telephonyAccess';

const base: TelephonyAccessInput = { guest: false, sipEnabled: true, placeCalls: false, extension: '', viewJournals: false, manageIntegrations: false, planTelephony: true };

describe('telephonyVisible (ADR-0137 §5)', () => {
  it('a member with nothing to do there does not see it', () => {
    expect(telephonyVisible(base)).toBe(false);
  });

  it.each([
    ['PLACE_CALLS', { placeCalls: true }],
    ['an internal number', { extension: '101' }],
    ['VIEW_JOURNALS', { viewJournals: true }],
    ['MANAGE_INTEGRATIONS', { manageIntegrations: true }],
  ])('%s opens it while telephony is connected', (_name, patch) => {
    expect(telephonyVisible({ ...base, ...patch })).toBe(true);
  });

  it.each([
    ['PLACE_CALLS', { placeCalls: true }],
    ['an internal number', { extension: '101' }],
    ['VIEW_JOURNALS', { viewJournals: true }],
  ])('%s alone does not open it before telephony is connected', (_name, patch) => {
    expect(telephonyVisible({ ...base, ...patch, sipEnabled: false })).toBe(false);
  });

  it('the administrator finds it before anything is connected, on a plan with telephony', () => {
    expect(telephonyVisible({ ...base, sipEnabled: false, manageIntegrations: true })).toBe(true);
    expect(telephonyVisible({ ...base, sipEnabled: false, manageIntegrations: true, planTelephony: false })).toBe(false);
  });

  it('a lapsed plan with the account still on keeps it (the pages under PlanLock)', () => {
    expect(telephonyVisible({ ...base, manageIntegrations: true, planTelephony: false })).toBe(true);
    expect(telephonyVisible({ ...base, placeCalls: true, planTelephony: false })).toBe(true);
  });

  it('a guest never sees it, whatever the rights', () => {
    expect(telephonyVisible({ ...base, guest: true, placeCalls: true, extension: '100', viewJournals: true, manageIntegrations: true })).toBe(false);
  });

  it('all calls only with VIEW_JOURNALS', () => {
    expect(mayReadAllCalls({ viewJournals: true })).toBe(true);
    expect(mayReadAllCalls({ viewJournals: false })).toBe(false);
  });
});
