import { describe, expect, it } from 'vitest';
import { ownBoardLink } from './ownBoardLink';

describe('ownBoardLink (a /t/ or /b/ link the viewer cannot open: «Задача недоступна»)', () => {
  const server = 'https://app.calab.io';
  it('recognizes this server\'s task and board links', () => {
    expect(ownBoardLink('https://app.calab.io/t/FNG-12', server, '')).toBe('task');
    expect(ownBoardLink('https://app.calab.io/b/0190-abc', server, '')).toBe('board');
    expect(ownBoardLink('http://localhost:5173/t/FNG-1', '', 'http://localhost:5173')).toBe('task');
  });
  it('ignores other hosts, paths and garbage', () => {
    expect(ownBoardLink('https://evil.example/t/FNG-12', server, '')).toBeNull();
    expect(ownBoardLink('https://app.calab.io/t/FNG-12/x', server, '')).toBeNull();
    expect(ownBoardLink('https://app.calab.io/w/abc', server, '')).toBeNull();
    expect(ownBoardLink('not a url', server, '')).toBeNull();
  });
});
