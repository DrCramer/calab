import { beforeEach, describe, expect, it } from 'vitest';
import { NO_FILTERS } from '../lib/search/query';
import { useBoards } from './boards';
import { MY_TASKS, useBoardsUi } from './boardsUi';
import { useSearchPanel, type SearchFeed } from './searchPanel';
import { useUi } from './ui';

const feed = (key: string): SearchFeed => ({ key, hits: [], cursor: 'c2', done: false, total: 40, timedOut: false, failed: false, emptyRun: 0 });

// ADR-0105: the results panel keeps its search across the boards view and back; a new search resets it.
describe('search panel state', () => {
  beforeEach(() => {
    useBoardsUi.setState({ active: false, boardOf: {}, taskId: null });
    useUi.setState({ activeWorkspaceId: 'ws', calDay: null, calEvent: null });
    useBoards.setState({ boards: {} });
    useSearchPanel.setState({ open: false, seq: 0, q: '', scope: 'all', tab: 'messages', filters: NO_FILTERS, homeBoard: '', view: null });
  });

  it('keeps query, tab, filters and the loaded list across a trip to the boards', () => {
    useSearchPanel.getState().show('релиз', 'all', 'messages');
    const p = useSearchPanel.getState();
    p.setFilter('author', 'u1');
    p.setFilter('sort', 'new');
    p.saveView({ seq: p.seq, feed: feed('k'), scrollTop: 320 });

    useBoardsUi.getState().setActive(true);
    useBoardsUi.getState().setActive(false);

    const s = useSearchPanel.getState();
    expect(s.open).toBe(true);
    expect(s.q).toBe('релиз');
    expect(s.tab).toBe('messages');
    expect(s.filters).toMatchObject({ author: 'u1', sort: 'new' });
    expect(s.view).toMatchObject({ seq: s.seq, scrollTop: 320, feed: { key: 'k', cursor: 'c2' } });
  });

  it('a new search resets filters and the saved list; a stale save is ignored', () => {
    useSearchPanel.getState().show('a', 'all', 'messages');
    const old = useSearchPanel.getState().seq;
    useSearchPanel.getState().setFilter('author', 'u1');
    useSearchPanel.getState().show('b', 'all', 'messages');
    // The previous panel unmounts after the new search began: its list must not be restored.
    useSearchPanel.getState().saveView({ seq: old, feed: feed('a'), scrollTop: 100 });
    const s = useSearchPanel.getState();
    expect(s.seq).toBe(old + 1);
    expect(s.q).toBe('b');
    expect(s.filters).toEqual(NO_FILTERS);
    expect(s.view).toBeNull();
  });

  it('close drops the saved list', () => {
    useSearchPanel.getState().show('a', 'all', 'messages');
    const { seq } = useSearchPanel.getState();
    useSearchPanel.getState().saveView({ seq, feed: feed('a'), scrollTop: 10 });
    useSearchPanel.getState().close();
    expect(useSearchPanel.getState().view).toBeNull();
    useSearchPanel.getState().saveView({ seq, feed: feed('a'), scrollTop: 10 });
    expect(useSearchPanel.getState().view).toBeNull();
  });

  it('the tasks tab stays in (or enters) the boards view instead of a chat', () => {
    useSearchPanel.getState().show('x', 'all', 'tasks');
    expect(useBoardsUi.getState().active).toBe(true);

    useBoardsUi.getState().setActive(false);
    useSearchPanel.getState().setTab('messages');
    expect(useBoardsUi.getState().active).toBe(false);
    useSearchPanel.getState().setTab('tasks');
    expect(useBoardsUi.getState().active).toBe(true);
  });

  it('a message search started in the boards keeps the boards on', () => {
    useBoardsUi.setState({ active: true });
    useSearchPanel.getState().show('x', 'all', 'messages');
    expect(useBoardsUi.getState().active).toBe(true);
    expect(useSearchPanel.getState().scope).toBe('all');
  });

  it('started in the boards: the tasks of this workspace and board first', () => {
    useBoards.setState({ boards: { b1: { id: 'b1', workspaceId: 'ws', name: 'Dev' } as never } });
    useBoardsUi.setState({ active: true, boardOf: { ws: 'b1' } });
    useSearchPanel.getState().show('x', 'all', 'tasks');
    let s = useSearchPanel.getState();
    expect(s.scope).toBe('ws');
    expect(s.filters.place).toBe('b1');
    // Another tab has no board filter; back on tasks the board comes back.
    s.setTab('messages');
    expect(useSearchPanel.getState().filters.place).toBe('');
    useSearchPanel.getState().setTab('tasks');
    expect(useSearchPanel.getState().filters.place).toBe('b1');
    // «Сбросить» widens it.
    useSearchPanel.getState().resetFilters();
    s = useSearchPanel.getState();
    expect(s.filters.place).toBe('');
  });

  it('«Мои задачи» or a search from a chat: no board filter, scope as asked', () => {
    useBoardsUi.setState({ active: true, boardOf: { ws: MY_TASKS } });
    useSearchPanel.getState().show('x', 'all', 'tasks');
    expect(useSearchPanel.getState().filters.place).toBe('');
    expect(useSearchPanel.getState().scope).toBe('ws');

    useBoardsUi.setState({ active: false });
    useSearchPanel.getState().show('x', 'all', 'tasks');
    expect(useSearchPanel.getState().scope).toBe('all');
    expect(useSearchPanel.getState().homeBoard).toBe('');
  });
});
