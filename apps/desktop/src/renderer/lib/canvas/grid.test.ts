import { describe, expect, it } from 'vitest';
import { SpatialGrid } from './grid';

describe('SpatialGrid', () => {
  it('queries by rect', () => {
    const g = new SpatialGrid();
    g.insert('a', { x: 0, y: 0, w: 100, h: 100 });
    g.insert('b', { x: 2000, y: 2000, w: 50, h: 50 });
    g.insert('c', { x: -3000, y: 10, w: 50, h: 50 });
    expect(g.query({ x: 50, y: 50, w: 10, h: 10 })).toEqual(['a']);
    expect(g.query({ x: 1900, y: 1900, w: 200, h: 200 })).toEqual(['b']);
    expect(g.query({ x: -3100, y: 0, w: 200, h: 100 })).toEqual(['c']);
    expect(g.query({ x: 500, y: 500, w: 10, h: 10 })).toEqual([]);
    expect(g.size).toBe(3);
  });
  it('reports an object spanning many cells once', () => {
    const g = new SpatialGrid();
    g.insert('wide', { x: 0, y: 0, w: 3000, h: 100 });
    expect(g.query({ x: 0, y: 0, w: 5000, h: 5000 })).toEqual(['wide']);
  });
  it('filters by the exact rect inside a cell', () => {
    const g = new SpatialGrid();
    g.insert('a', { x: 0, y: 0, w: 10, h: 10 });
    expect(g.query({ x: 100, y: 100, w: 10, h: 10 })).toEqual([]);
  });
  it('updates and removes', () => {
    const g = new SpatialGrid();
    g.insert('a', { x: 0, y: 0, w: 10, h: 10 });
    g.update('a', { x: 5000, y: 5000, w: 10, h: 10 });
    expect(g.query({ x: 0, y: 0, w: 20, h: 20 })).toEqual([]);
    expect(g.query({ x: 4990, y: 4990, w: 30, h: 30 })).toEqual(['a']);
    g.remove('a');
    expect(g.query({ x: 4990, y: 4990, w: 30, h: 30 })).toEqual([]);
    expect(g.has('a')).toBe(false);
    g.remove('missing');
  });
  it('keeps huge objects in the big list and still finds them', () => {
    const g = new SpatialGrid();
    g.insert('huge', { x: -100000, y: -100000, w: 200000, h: 200000 });
    g.insert('small', { x: 10, y: 10, w: 5, h: 5 });
    expect(g.query({ x: 0, y: 0, w: 20, h: 20 }).sort()).toEqual(['huge', 'small']);
    g.remove('huge');
    expect(g.query({ x: 0, y: 0, w: 20, h: 20 })).toEqual(['small']);
  });
  it('a viewport wider than the populated area still works', () => {
    const g = new SpatialGrid();
    for (let i = 0; i < 20; i++) g.insert(`o${i}`, { x: i * 600, y: 0, w: 10, h: 10 });
    expect(g.query({ x: -1e6, y: -1e6, w: 2e6, h: 2e6 })).toHaveLength(20);
  });
  it('stays fast for 5000 objects', () => {
    const g = new SpatialGrid();
    for (let i = 0; i < 5000; i++) g.insert(`o${i}`, { x: (i % 100) * 300, y: Math.floor(i / 100) * 200, w: 160, h: 100 });
    const hits = g.query({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(hits.length).toBeGreaterThan(20);
    expect(hits.length).toBeLessThan(120);
  });
});
