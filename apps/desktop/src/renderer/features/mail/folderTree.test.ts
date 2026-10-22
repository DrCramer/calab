import { describe, expect, it } from 'vitest';
import type { MailFolder, MailFolderRole } from '../../../shared/mail';
import { canHoldFolders, folderTree, isOwnFolder, subfolderCount } from './folderTree';

const f = (id: string, name: string, o: { role?: MailFolderRole; parentId?: string; path?: string } = {}): MailFolder => ({
  id,
  accountId: 'a',
  path: o.path ?? name,
  name,
  role: o.role ?? null,
  parentId: o.parentId ?? null,
  unread: 0,
  total: 0,
});

const names = (rows: ReturnType<typeof folderTree>): string[] => rows.map((r) => `${'  '.repeat(r.depth)}${r.folder.name}${r.hasChildren ? ' +' : ''}`);

describe('folderTree', () => {
  const list = [
    f('w', 'Work'),
    f('t', 'Trash', { role: 'trash' }),
    f('w2', 'Old', { parentId: 'w', path: 'Work/Old' }),
    f('i', 'INBOX', { role: 'inbox' }),
    f('ib', 'Банк', { parentId: 'i', path: 'INBOX/Банк' }),
    f('s', 'Sent', { role: 'sent', parentId: 'i', path: 'INBOX/Sent' }),
    f('a', 'archive 10'),
    f('b', 'Archive 9'),
    f('o', 'Outbox', { role: 'outbox', path: '' }),
  ];

  it('role folders first in Apple Mail order (never nested), then own folders by name, subfolders under their parent', () => {
    expect(names(folderTree(list))).toEqual(['INBOX +', '  Банк', 'Sent', 'Outbox', 'Trash', 'Archive 9', 'archive 10', 'Work +', '  Old']);
  });

  it('a collapsed folder hides its subtree only', () => {
    expect(names(folderTree(list, new Set(['w', 'i'])))).toEqual(['INBOX +', 'Sent', 'Outbox', 'Trash', 'Archive 9', 'archive 10', 'Work +']);
  });

  it('a folder whose parent is not listed (\\Noselect [Gmail]) is top-level; a looping chain still lists everything once', () => {
    expect(names(folderTree([f('x', 'Important', { parentId: 'gmail' })]))).toEqual(['Important']);
    const loop = [f('p', 'P', { parentId: 'q' }), f('q', 'Q', { parentId: 'p' })];
    expect(folderTree(loop).map((r) => r.folder.id).sort()).toEqual(['p', 'q']);
  });

  it('subfolderCount, own and container folders', () => {
    expect(subfolderCount(list, 'w')).toBe(1);
    expect(subfolderCount(list, 'a')).toBe(0);
    expect(isOwnFolder(list[0] as MailFolder)).toBe(true);
    expect(isOwnFolder(list[3] as MailFolder)).toBe(false);
    expect(canHoldFolders(list[3] as MailFolder)).toBe(true);
    expect(canHoldFolders(list[1] as MailFolder)).toBe(false);
    expect(canHoldFolders(list[8] as MailFolder)).toBe(false);
  });
});
