import { describe, expect, it } from 'vitest';
import { MAX_ASSIGNEES, MAX_NOTE, addAssignee, draftsOf, meFirst, normalize, only, removeAssignee, setLead, setNote, toggleAssignee, type AssigneeDraft } from './assignees';

const leads = (l: AssigneeDraft[]): string[] => l.filter((a) => a.isLead).map((a) => a.userId);

describe('assignees: exactly one lead when not empty, lead first', () => {
  it('makes the first person the lead and keeps one lead through every edit', () => {
    let l = addAssignee([], 'a');
    expect(l).toEqual([{ userId: 'a', isLead: true, note: '' }]);
    l = addAssignee(l, 'b', 'Бэкенд');
    expect(leads(l)).toEqual(['a']);
    l = setLead(l, 'b');
    expect(l.map((x) => x.userId)).toEqual(['b', 'a']);
    expect(leads(l)).toEqual(['b']);
    // Removing the lead passes the role on.
    l = removeAssignee(l, 'b');
    expect(leads(l)).toEqual(['a']);
    l = toggleAssignee(l, 'a');
    expect(l).toEqual([]);
    expect(only('z')).toEqual([{ userId: 'z', isLead: true, note: '' }]);
  });

  it('repairs any input: no lead, several leads, duplicates, too many, long notes', () => {
    expect(leads(normalize([{ userId: 'a', isLead: false, note: '' }, { userId: 'b', isLead: false, note: '' }]))).toEqual(['a']);
    expect(leads(normalize([{ userId: 'a', isLead: true, note: '' }, { userId: 'b', isLead: true, note: '' }]))).toEqual(['a']);
    expect(normalize([{ userId: 'a', isLead: false, note: '' }, { userId: 'a', isLead: true, note: 'x' }])).toHaveLength(1);
    const many = Array.from({ length: 12 }, (_, i) => ({ userId: `u${i}`, isLead: i === 11, note: '' }));
    const n = normalize(many);
    expect(n).toHaveLength(MAX_ASSIGNEES);
    expect(leads(n)).toHaveLength(1);
    expect(normalize([{ userId: 'a', isLead: true, note: 'x'.repeat(200) }])[0]?.note).toHaveLength(MAX_NOTE);
    expect(setNote([{ userId: 'a', isLead: true, note: '' }], 'a', '  Дизайн  ')[0]?.note).toBe('Дизайн');
    // A lead flag on someone else's list entry that is not there changes nothing.
    expect(setLead([{ userId: 'a', isLead: true, note: '' }], 'nobody')).toEqual([{ userId: 'a', isLead: true, note: '' }]);
    expect(draftsOf([{ userId: 'b', isLead: false, note: '' }, { userId: 'a', isLead: true, note: 'n' }]).map((x) => x.userId)).toEqual(['a', 'b']);
  });
});

describe('meFirst (people pickers offer the viewer on top)', () => {
  const ppl = [{ id: 'anna' }, { id: 'boris' }, { id: 'olga' }, { id: 'zoya' }];
  const id = (p: { id: string }): string => p.id;
  it('moves the viewer to the top, keeps the rest in order', () => {
    expect(meFirst(ppl, 'olga', id).map(id)).toEqual(['olga', 'anna', 'boris', 'zoya']);
  });
  it('already first, absent or unknown viewer: an unchanged copy', () => {
    expect(meFirst(ppl, 'anna', id).map(id)).toEqual(['anna', 'boris', 'olga', 'zoya']);
    expect(meFirst(ppl, 'nobody', id).map(id)).toEqual(['anna', 'boris', 'olga', 'zoya']);
    expect(meFirst(ppl, '', id)).not.toBe(ppl);
  });
});
