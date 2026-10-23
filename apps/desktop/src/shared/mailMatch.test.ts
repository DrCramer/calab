import { describe, expect, it } from 'vitest';
import { conditionHit, matchSmart } from './mailMatch';

const m = { fromName: 'Анна Петрова', fromAddress: 'anna@example.ru', subject: 'Re: Счёт за октябрь', to: 'Бухгалтерия\nbuh@example.ru' };

describe('conditionHit', () => {
  it('looks in the named field only, case-insensitively', () => {
    expect(conditionHit({ field: 'from', contains: 'АННА' }, m)).toBe(true);
    expect(conditionHit({ field: 'from', contains: '@EXAMPLE.ru' }, m)).toBe(true);
    expect(conditionHit({ field: 'subject', contains: 'счёт' }, m)).toBe(true);
    expect(conditionHit({ field: 'subject', contains: 'anna' }, m)).toBe(false);
    expect(conditionHit({ field: 'to', contains: 'buh@' }, m)).toBe(true);
  });
  it('an empty needle and unknown recipients never match', () => {
    expect(conditionHit({ field: 'subject', contains: '  ' }, m)).toBe(false);
    const { to: _to, ...noTo } = m;
    expect(conditionHit({ field: 'to', contains: 'buh' }, noTo)).toBe(false);
  });
});

describe('matchSmart', () => {
  it('all = every condition, any = at least one', () => {
    const conditions = [
      { field: 'from' as const, contains: 'anna' },
      { field: 'subject' as const, contains: 'invoice' },
    ];
    expect(matchSmart({ match: 'all', conditions }, m)).toBe(false);
    expect(matchSmart({ match: 'any', conditions }, m)).toBe(true);
  });
  it('blank conditions are skipped; none left matches nothing', () => {
    expect(
      matchSmart(
        {
          match: 'all',
          conditions: [
            { field: 'from', contains: 'anna' },
            { field: 'subject', contains: ' ' },
          ],
        },
        m,
      ),
    ).toBe(true);
    expect(matchSmart({ match: 'any', conditions: [{ field: 'subject', contains: '' }] }, m)).toBe(false);
  });
});
