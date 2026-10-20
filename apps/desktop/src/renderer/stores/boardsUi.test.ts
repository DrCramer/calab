import { beforeEach, describe, expect, it } from 'vitest';
import { MY_TASKS, useBoardsUi } from './boardsUi';

describe('boardsUi task vs board navigation', () => {
  beforeEach(() => useBoardsUi.setState({ active: false, boardOf: {}, taskId: null }));

  it('switching to another board closes the open task', () => {
    const ui = useBoardsUi.getState();
    ui.openBoard('w', 'b1');
    ui.openTask('t1');
    ui.openBoard('w', 'b2');
    expect(useBoardsUi.getState().taskId).toBeNull();
  });

  it('re-opening the same board keeps the task; openTask after openBoard sticks', () => {
    const ui = useBoardsUi.getState();
    ui.openBoard('w', 'b1');
    ui.openTask('t1');
    ui.openBoard('w', 'b1');
    expect(useBoardsUi.getState().taskId).toBe('t1');
    ui.openBoard('w', 'b2');
    ui.openTask('t2');
    expect(useBoardsUi.getState().taskId).toBe('t2');
  });

  it('openBoard to MY_TASKS while a task is open over it needs an explicit close', () => {
    const ui = useBoardsUi.getState();
    ui.openBoard('w', MY_TASKS);
    ui.openTask('t1');
    ui.openBoard('w', MY_TASKS);
    expect(useBoardsUi.getState().taskId).toBe('t1');
    ui.openTask(null);
    expect(useBoardsUi.getState().taskId).toBeNull();
    expect(useBoardsUi.getState().boardOf['w']).toBe(MY_TASKS);
  });

  it('closing the task keeps the board view state (prefs, focus)', () => {
    const ui = useBoardsUi.getState();
    ui.openBoard('w', 'b1');
    ui.setPrefs('b1', { kind: 'list', groupBy: 'priority' });
    ui.setFocused('t1');
    ui.openTask('t1');
    ui.openTask(null);
    const s = useBoardsUi.getState();
    expect(s.taskId).toBeNull();
    expect(s.focused).toBe('t1');
    expect(s.prefs['b1']?.groupBy).toBe('priority');
  });
});
