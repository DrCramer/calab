import { describe, expect, it } from 'vitest';
import { SOFT_PREFIX, type ObjectRec } from '../../../lib/canvas/types';
import { panelModelOf, samePanelModel } from './selectionModel';

const base = { x: 0, y: 0, w: 100, h: 60, z: 'a0' };
const sticky = (over: Partial<Extract<ObjectRec, { kind: 'sticky' }>> = {}): ObjectRec => ({ ...base, id: 's1', kind: 'sticky', color: 'yellow', text: '', ...over });
const shape = (over: Partial<Extract<ObjectRec, { kind: 'shape' }>> = {}): ObjectRec => ({
  ...base, id: 'h1', kind: 'shape', shape: 'rect', fill: 'blue', stroke: 'blue', strokeWidth: 2, text: '', ...over,
});
const ink = (over: Partial<Extract<ObjectRec, { kind: 'ink' }>> = {}): ObjectRec => ({
  ...base, id: 'i1', kind: 'ink', points: [0, 0, 10, 10], stroke: 'red', strokeWidth: 3, ...over,
});

describe('panelModelOf', () => {
  it('nothing selected is no model', () => {
    expect(panelModelOf([])).toBeNull();
  });

  it('counts the kinds in a mixed selection and does not call a locked mix locked', () => {
    const m = panelModelOf([sticky(), ink(), shape({ locked: true })]);
    expect(m).toMatchObject({ count: 3, hasSticky: true, hasInk: true, hasShape: true, hasText: false, hasConnector: false, locked: false });
  });

  it('is locked only when every selected object is locked', () => {
    expect(panelModelOf([sticky({ locked: true }), ink({ locked: true })])?.locked).toBe(true);
    expect(panelModelOf([sticky({ locked: true }), ink()])?.locked).toBe(false);
  });

  it('shows a value only where the selected objects agree', () => {
    expect(panelModelOf([sticky({ color: 'yellow' }), sticky({ id: 's2', color: 'yellow' })])?.stickyColor).toBe('yellow');
    expect(panelModelOf([sticky({ color: 'yellow' }), sticky({ id: 's2', color: 'mint' })])?.stickyColor).toBeUndefined();
  });

  it('a soft shape reports the soft fill; a soft and a plain shape of one hue do not agree', () => {
    expect(panelModelOf([shape({ fill: 'blue', soft: true })])?.fill).toBe(`${SOFT_PREFIX}blue`);
    expect(panelModelOf([shape({ fill: 'blue' }), shape({ id: 'h2', fill: 'blue', soft: true })])?.fill).toBeUndefined();
  });

  it('reads the stroke color, width and marker of the selected strokes', () => {
    const m = panelModelOf([ink({ stroke: 'red', strokeWidth: 3, marker: true }), ink({ id: 'i2', stroke: 'red', strokeWidth: 3, marker: true })]);
    expect(m).toMatchObject({ inkColor: 'red', inkWidth: 3, inkMarker: true });
    expect(panelModelOf([ink({ marker: true }), ink({ id: 'i2' })])?.inkMarker).toBeUndefined();
  });

  it('can group two or more objects, and cannot group a single one', () => {
    expect(panelModelOf([sticky(), shape()])?.canGroup).toBe(true);
    expect(panelModelOf([sticky()])?.canGroup).toBe(false);
  });

  it('can ungroup when some selected object is in a group', () => {
    expect(panelModelOf([sticky({ group: 'g1' }), shape()])?.canUngroup).toBe(true);
    expect(panelModelOf([sticky(), shape()])?.canUngroup).toBe(false);
  });

  it('counts the units to align, capped at three (three enables distribute)', () => {
    expect(panelModelOf([sticky(), shape()])?.units).toBe(2);
    expect(panelModelOf([sticky(), shape(), ink(), sticky({ id: 's2' })])?.units).toBe(3);
  });
});

describe('samePanelModel', () => {
  it('two empty selections are the same, and so are equal values in different objects', () => {
    expect(samePanelModel(null, null)).toBe(true);
    expect(samePanelModel(panelModelOf([sticky()]), panelModelOf([sticky({ id: 's9' })]))).toBe(true);
  });

  it('a change of something the panel shows is a different model; an empty and a non-empty one differ', () => {
    expect(samePanelModel(panelModelOf([sticky()]), panelModelOf([sticky({ color: 'mint' })]))).toBe(false);
    expect(samePanelModel(panelModelOf([sticky()]), null)).toBe(false);
  });
});
