import { describe, expect, it } from 'vitest';
import { contactLetter, contactSubtitle, contactTitle, groupContacts } from './model';

const c = (id: string, name: string, company = '') => ({ id, name, company });

describe('the phone book list', () => {
  it('titles a contact by its name, else its company', () => {
    expect(contactTitle(c('1', 'Анна Петрова', 'ООО Ромашка'))).toBe('Анна Петрова');
    expect(contactSubtitle(c('1', 'Анна Петрова', 'ООО Ромашка'))).toBe('ООО Ромашка');
    expect(contactTitle(c('2', '', 'ООО Лютик'))).toBe('ООО Лютик');
    expect(contactSubtitle(c('2', '', 'ООО Лютик'))).toBe('');
  });

  it('lists under А–Я (Ё with Е), A–Z, «#»', () => {
    expect(contactLetter(c('1', 'анна'))).toBe('А');
    expect(contactLetter(c('2', 'Ёлкин'))).toBe('Е');
    expect(contactLetter(c('3', 'bob'))).toBe('B');
    expect(contactLetter(c('4', '', '«Альфа»'))).toBe('#');
    expect(contactLetter(c('5', '7 ветров'))).toBe('#');
  });

  it('groups the loaded list in its order, one header per run', () => {
    const groups = groupContacts([c('1', 'Анна'), c('2', 'Алексей'), c('3', 'Борис'), c('4', 'Alice'), c('5', '', '1С')]);
    expect(groups).toEqual([
      { letter: 'А', ids: ['1', '2'] },
      { letter: 'Б', ids: ['3'] },
      { letter: 'A', ids: ['4'] },
      { letter: '#', ids: ['5'] },
    ]);
  });
});
