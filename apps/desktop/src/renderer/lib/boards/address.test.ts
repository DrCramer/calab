import { describe, expect, it } from 'vitest';
import { MY_TASKS } from '../../stores/boardsUi';
import { boardsPath, isManagedPath } from './address';

describe('boardsPath', () => {
  it('boards mode off is the root', () => {
    expect(boardsPath({ active: false, boardId: 'b1', taskKey: 'CAL-3' })).toBe('/');
  });
  it('an open board', () => {
    expect(boardsPath({ active: true, boardId: 'b1', taskKey: undefined })).toBe('/b/b1');
  });
  it('an open task wins over its board', () => {
    expect(boardsPath({ active: true, boardId: 'b1', taskKey: 'CAL-12' })).toBe('/t/CAL-12');
  });
  it('«Мои задачи» and no board have no link', () => {
    expect(boardsPath({ active: true, boardId: MY_TASKS, taskKey: undefined })).toBe('/');
    expect(boardsPath({ active: true, boardId: undefined, taskKey: undefined })).toBe('/');
  });
});

describe('isManagedPath', () => {
  it('manages only /, /b/… and /t/…', () => {
    for (const p of ['/', '/b/abc', '/t/CAL-1', '/t/CAL-1/']) expect(isManagedPath(p)).toBe(true);
    for (const p of ['/wiki/6f1d3a1e-0000-0000-0000-000000000000', '/r/abcd', '/e/xyz', '/join/abcd', '/m/a/b', '/admin', '/b/', '/b/a/c']) expect(isManagedPath(p)).toBe(false);
  });
});
