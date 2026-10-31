import { WorkspaceRole } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { holdPlanAfterCreate, parsePlansLink, routePlansLink, takePlanAfterCreate } from './planLink';

describe('parsePlansLink', () => {
  it('reads the plan of the web and the desktop link', () => {
    expect(parsePlansLink('https://app.calab.io/plans?plan=team')).toEqual({ plan: 'team' });
    expect(parsePlansLink('https://app.calab.io/plans/?plan=Business')).toEqual({ plan: 'business' });
    expect(parsePlansLink('calab://plans?plan=business')).toEqual({ plan: 'business' });
    expect(parsePlansLink('calaba://plans?plan=team#x')).toEqual({ plan: 'team' });
  });

  it('an unknown or missing plan is still a plans link, unmarked', () => {
    expect(parsePlansLink('https://app.calab.io/plans?plan=gold')).toEqual({ plan: null });
    expect(parsePlansLink('https://app.calab.io/plans?plan=free')).toEqual({ plan: null });
    expect(parsePlansLink('https://app.calab.io/plans')).toEqual({ plan: null });
    expect(parsePlansLink('calab://plans')).toEqual({ plan: null });
  });

  it('other addresses are not plans links', () => {
    expect(parsePlansLink('https://app.calab.io/plansx?plan=team')).toBeNull();
    expect(parsePlansLink('https://app.calab.io/x/plans?plan=team')).toBeNull();
    expect(parsePlansLink('https://app.calab.io/join/AbC123xYz')).toBeNull();
    expect(parsePlansLink('AbC123xYz')).toBeNull();
  });
});

describe('routePlansLink', () => {
  const ws = (id: string, role: WorkspaceRole) => ({ id, role });
  it('opens the active workspace', () => {
    expect(routePlansLink([ws('a', WorkspaceRole.OWNER), ws('b', WorkspaceRole.MEMBER)], 'b')).toEqual({ kind: 'open', workspaceId: 'b' });
  });
  it('without an active one: the owned workspace, else the first; guests are skipped', () => {
    expect(routePlansLink([ws('a', WorkspaceRole.MEMBER), ws('b', WorkspaceRole.OWNER)], '@me')).toEqual({ kind: 'open', workspaceId: 'b' });
    expect(routePlansLink([ws('g', WorkspaceRole.GUEST), ws('a', WorkspaceRole.MEMBER)], null)).toEqual({ kind: 'open', workspaceId: 'a' });
  });
  it('no workspace: the creation flow first', () => {
    expect(routePlansLink([], null)).toEqual({ kind: 'create' });
    expect(routePlansLink([ws('g', WorkspaceRole.GUEST)], 'g')).toEqual({ kind: 'create' });
  });
});

describe('plan after creation', () => {
  it('is handed to the next plans dialog once', () => {
    expect(takePlanAfterCreate()).toBeUndefined();
    holdPlanAfterCreate('team');
    expect(takePlanAfterCreate()).toBe('team');
    expect(takePlanAfterCreate()).toBeUndefined();
  });
});
