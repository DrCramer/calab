import { describe, expect, it } from 'vitest';
import { heldNotificationCount, holdNotification } from './notifyHold';

describe('holdNotification', () => {
  it('holds until click, close or error', () => {
    const base = heldNotificationCount();
    const a = holdNotification(new EventTarget());
    const b = holdNotification(new EventTarget());
    const c = holdNotification(new EventTarget());
    expect(heldNotificationCount()).toBe(base + 3);
    a.dispatchEvent(new Event('click'));
    b.dispatchEvent(new Event('close'));
    c.dispatchEvent(new Event('error'));
    expect(heldNotificationCount()).toBe(base);
  });
});
