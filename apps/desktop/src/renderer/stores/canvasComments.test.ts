import type { CanvasComment } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { openThreads, useCanvasComments } from './canvasComments';

const c = (id: string, parentId = '', more: Partial<CanvasComment> = {}): CanvasComment =>
  ({ id, canvasId: 'cv', parentId, body: id, authorId: 'u', resolved: false, objectId: '', x: 0, y: 0, mentions: [], ...more }) as CanvasComment;

beforeEach(() => {
  useCanvasComments.setState({ byId: {}, threads: {}, replies: {}, loaded: {}, panel: false, active: null, draft: null, focus: null, filterOpen: false });
});

describe('canvas comments store (ADR-0114 wave 4)', () => {
  it('holds threads of a read canvas; events for others are dropped', () => {
    const st = useCanvasComments.getState();
    st.upsert(c('x'));
    expect(useCanvasComments.getState().byId['x']).toBeUndefined();
    st.setCanvas('cv', [c('r1'), c('a', 'r1'), c('r2', '', { resolved: true }), c('b', 'r1')]);
    let s = useCanvasComments.getState();
    expect(s.threads['cv']).toEqual(['r1', 'r2']);
    expect(s.replies['r1']).toEqual(['a', 'b']);
    expect(openThreads(s, 'cv')).toBe(1);
    st.upsert(c('r3'));
    st.upsert(c('d', 'r3'));
    st.upsert({ ...c('a', 'r1'), body: 'edited' });
    s = useCanvasComments.getState();
    expect(s.threads['cv']).toEqual(['r1', 'r2', 'r3']);
    expect(s.replies['r3']).toEqual(['d']);
    expect(s.replies['r1']).toEqual(['a', 'b']);
    expect(s.byId['a']?.body).toBe('edited');
  });

  it('a deleted root takes its replies; forgetting a canvas drops everything of it', () => {
    const st = useCanvasComments.getState();
    st.setCanvas('cv', [c('r1'), c('a', 'r1'), c('r2')]);
    st.setActive('r1');
    st.remove('cv', 'a');
    expect(useCanvasComments.getState().replies['r1']).toEqual([]);
    st.remove('cv', 'r1');
    let s = useCanvasComments.getState();
    expect(s.threads['cv']).toEqual(['r2']);
    expect(s.byId['r1']).toBeUndefined();
    expect(s.active).toBeNull();
    st.setDraft({ canvasId: 'cv', objectId: '', x: 1, y: 2 });
    st.forget('cv');
    s = useCanvasComments.getState();
    expect(s.loaded['cv']).toBeUndefined();
    expect(s.byId['r2']).toBeUndefined();
    expect(s.draft).toBeNull();
    st.upsert(c('r9'));
    expect(useCanvasComments.getState().byId['r9']).toBeUndefined();
  });
});
