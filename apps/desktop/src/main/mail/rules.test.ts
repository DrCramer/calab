import { describe, expect, it } from 'vitest';
import type { MailRule } from '../../shared/mail';
import { matchRule } from './rules';

const rule = (o: Partial<MailRule>): MailRule => ({ id: 'r', accountId: 'a1', field: 'subject', contains: 'tracker', folderPath: 'Trackers', ...o });
const msg = { fromName: 'Jira Bot', fromAddress: 'noreply@jira.example.com', subject: 'Re: Tracker digest' };

describe('matchRule', () => {
  it('matches the subject case-insensitively', () => {
    expect(matchRule([rule({})], 'a1', msg)).toBe('Trackers');
  });
  it('matches the sender by address or name', () => {
    expect(matchRule([rule({ field: 'from', contains: '@JIRA.example', folderPath: 'Jira' })], 'a1', msg)).toBe('Jira');
    expect(matchRule([rule({ field: 'from', contains: 'jira bot', folderPath: 'Jira' })], 'a1', msg)).toBe('Jira');
  });
  it('does not look in the other field', () => {
    expect(matchRule([rule({ field: 'from', contains: 'tracker' })], 'a1', msg)).toBeNull();
  });
  it('ignores other accounts and empty needles', () => {
    expect(matchRule([rule({ accountId: 'a2' }), rule({ contains: '  ' })], 'a1', msg)).toBeNull();
  });
  it('the first matching rule wins', () => {
    expect(matchRule([rule({ contains: 'nothing' }), rule({ folderPath: 'First' }), rule({ folderPath: 'Second' })], 'a1', msg)).toBe('First');
  });
});
