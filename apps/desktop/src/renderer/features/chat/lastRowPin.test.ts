import { describe, expect, it } from 'vitest';
import { createBottomPin, initialFeedLocation, lastRowChange, type FeedGeometry } from './lastRowPin';

/** A feed of `content` px in a scroller of `view` px, scrolled to `top`. */
const g = (content: number, view: number, top: number): FeedGeometry => ({ scrollHeight: content, clientHeight: view, scrollTop: top });
/** The same feed scrolled to its bottom. */
const atEnd = (content: number, view: number): FeedGeometry => g(content, view, content - view);

function stuckAtBottom(): ReturnType<typeof createBottomPin> {
  const pin = createBottomPin();
  pin.scrolled(atEnd(2000, 600));
  return pin;
}

describe('createBottomPin (docs/09 #149)', () => {
  it('pins when a reaction row grows the last message', () => {
    const pin = stuckAtBottom();
    expect(pin.resized(g(2028, 600, 1400))).toBe(true);
  });

  it('pins when an attachment grows far past the at-bottom threshold (upload → preview, image load)', () => {
    const pin = stuckAtBottom();
    expect(pin.resized(g(2320, 600, 1400))).toBe(true);
    // A second change before our scroll landed (the preview's real aspect) still pins.
    expect(pin.resized(g(2360, 600, 1400))).toBe(true);
  });

  it('pins when the composer grows and the scroller shrinks', () => {
    const pin = stuckAtBottom();
    expect(pin.resized(g(2000, 520, 1400))).toBe(true);
  });

  it('our own pin scroll keeps it stuck for the next growth', () => {
    const pin = stuckAtBottom();
    expect(pin.resized(g(2100, 600, 1400))).toBe(true);
    pin.scrolled(atEnd(2100, 600));
    expect(pin.resized(g(2150, 600, 1500))).toBe(true);
  });

  it('does not jump when the reader has scrolled up', () => {
    const pin = stuckAtBottom();
    pin.scrolled(g(2000, 600, 1100));
    expect(pin.resized(g(2028, 600, 1100))).toBe(false); // a reaction on the last message
    expect(pin.resized(g(2028, 480, 1100))).toBe(false); // the composer grows
  });

  it('sub-pixel rounding at the bottom stays stuck', () => {
    const pin = stuckAtBottom();
    pin.scrolled(g(2000, 600, 1399.5));
    expect(pin.resized(g(2028, 600, 1399.5))).toBe(true);
  });

  it('arriving a few px short of the bottom while scrolling down sticks', () => {
    const pin = createBottomPin();
    pin.scrolled(g(2000, 600, 1000));
    pin.scrolled(g(2000, 600, 1395));
    expect(pin.resized(g(2028, 600, 1395))).toBe(true);
  });

  it('any upward scroll of the reader unsticks, even a small one (no fighting a slow touchpad)', () => {
    const pin = stuckAtBottom();
    pin.scrolled(g(2000, 600, 1397));
    expect(pin.resized(g(2028, 600, 1397))).toBe(false); // a row mounted above: no snap back
  });

  it('a smooth scroll down still on its way keeps the pin', () => {
    const pin = stuckAtBottom();
    pin.scrolled(g(2080, 600, 1420)); // a new message, followOutput animating down
    expect(pin.resized(g(2300, 600, 1440))).toBe(true); // its image loads mid-animation
  });

  it('nothing to do when already at the bottom (the observer’s initial report)', () => {
    const pin = stuckAtBottom();
    expect(pin.resized(atEnd(2000, 600))).toBe(false);
  });

  it('never pins before the reader has been at the bottom (opened at the first unread)', () => {
    const pin = createBottomPin();
    pin.scrolled(g(5000, 600, 2000));
    expect(pin.resized(g(5040, 600, 2000))).toBe(false);
  });

  it('a short feed that is at its bottom on the first report sticks', () => {
    const pin = createBottomPin();
    expect(pin.resized(g(400, 600, 0))).toBe(false);
    expect(pin.resized(g(700, 600, 0))).toBe(true);
  });

  it('does not pin while newer history is not loaded', () => {
    const pin = stuckAtBottom();
    pin.setLive(false);
    expect(pin.resized(g(2400, 600, 1400))).toBe(false);
    pin.setLive(true);
    expect(pin.resized(g(2450, 600, 1400))).toBe(false); // left the bottom meanwhile
  });

  // 2.4.1 regression «the feed flickers / jumps while scrolling» — the exact sequence recorded in
  // Chromium with react-virtuoso: the reader scrolls up 75 px from the bottom; a row mounted above
  // the viewport measures shorter than Virtuoso's estimate, the content shrinks below the reader's
  // offset, the browser clamps scrollTop onto the bottom (a resize, then a scroll event), then
  // Virtuoso restores the reader's offset. The old pin re-stuck on the clamp and snapped the reader
  // back to the bottom on the restore.
  it('a transient clamp onto the bottom while scrolling up does not throw the reader back', () => {
    const pin = stuckAtBottom();
    pin.scrolled(g(138560, 600, 137960)); // at the bottom
    pin.scrolled(g(138560, 600, 137885)); // the reader: 75 px up
    expect(pin.resized(g(138141, 600, 137541))).toBe(false); // content shrank, clamped to the bottom
    pin.scrolled(g(138141, 600, 137541)); // the clamp's scroll event: up, landing on the bottom
    expect(pin.resized(g(138141, 600, 137466))).toBe(false); // Virtuoso restores the offset
    pin.scrolled(g(138141, 600, 137466));
    expect(pin.resized(g(138200, 600, 137466))).toBe(false); // and nothing later pins either
  });

  it('a clamp onto the bottom while stuck keeps it stuck (content or the composer shrank)', () => {
    const pin = stuckAtBottom();
    expect(pin.resized(g(1960, 600, 1360))).toBe(false); // a reaction removed: clamped, at the bottom
    pin.scrolled(g(1960, 600, 1360));
    expect(pin.resized(g(2100, 600, 1360))).toBe(true); // the next growth still pins
  });

  it('a programmatic jump up (reply quote, search) unsticks', () => {
    const pin = stuckAtBottom();
    pin.scrolled(g(2000, 600, 300));
    expect(pin.resized(g(2050, 600, 300))).toBe(false);
  });

  it('opened at the bottom: growth before the first scroll event pins (images measured late)', () => {
    const pin = createBottomPin(true);
    expect(pin.resized(g(5000, 600, 4400))).toBe(false); // already there
    expect(pin.resized(g(5400, 600, 4400))).toBe(true); // the last row's image loaded
    pin.scrolled(g(5400, 600, 4800)); // our pin's scroll
    expect(pin.resized(g(5450, 600, 4800))).toBe(true);
  });

  it('opened at the bottom: Virtuoso settling (a clamp up onto the bottom) keeps it stuck', () => {
    const pin = createBottomPin(true);
    pin.scrolled(g(5000, 600, 4400));
    pin.scrolled(g(4900, 600, 4300)); // estimates corrected, the bottom moved up
    expect(pin.resized(g(5300, 600, 4300))).toBe(true);
  });
});

// Owner, 15.10: «sent a text / sticker / image — the feed is not at the bottom».
describe('createBottomPin: my own send sticks (stick())', () => {
  it('scrolled far up: the send pins through the row’s real height, its image and the composer shrinking', () => {
    const pin = createBottomPin();
    pin.scrolled(g(2000, 600, 1400));
    pin.scrolled(g(2000, 600, 300)); // far up in history
    pin.stick(); // my pending row appeared
    // followOutput('auto') landed on the estimate, 40 px short of the real bottom: still pinned.
    pin.scrolled(g(2060, 600, 1420));
    expect(pin.resized(g(2100, 600, 1420))).toBe(true);
    pin.scrolled(atEnd(2100, 600));
    expect(pin.resized(g(2400, 600, 1500))).toBe(true); // the image decoded / upload → preview
    pin.scrolled(atEnd(2400, 600));
    expect(pin.resized(g(2400, 680, 1800))).toBe(false); // the composer shrank: clamped, at the bottom
    pin.scrolled(g(2400, 680, 1720));
    expect(pin.resized(g(2440, 680, 1720))).toBe(true); // the echo re-rendered taller
  });

  it('opened at the first unread and never scrolled: the send sticks', () => {
    const pin = createBottomPin();
    pin.stick();
    expect(pin.resized(g(5040, 600, 2000))).toBe(true);
  });

  it('a few px short of the bottom (never stuck): the send sticks', () => {
    const pin = createBottomPin();
    pin.scrolled(g(2000, 600, 1380)); // 20 px short, arrived moving down: not stuck
    expect(pin.resized(g(2028, 600, 1380))).toBe(false);
    pin.stick();
    expect(pin.resized(g(2100, 600, 1380))).toBe(true);
  });

  it('the reader scrolling up after the send unsticks', () => {
    const pin = createBottomPin();
    pin.stick();
    pin.scrolled(atEnd(2100, 600));
    pin.scrolled(g(2100, 600, 1200));
    expect(pin.resized(g(2400, 600, 1200))).toBe(false); // the image loads: no jump
  });

  it('sent from an old window: stays stuck until the present is loaded, then pins', () => {
    const pin = createBottomPin();
    pin.scrolled(g(8000, 600, 1000));
    pin.setLive(false);
    pin.stick();
    expect(pin.resized(g(8100, 600, 1000))).toBe(false); // the old window: nothing to pin to
    pin.setLive(true); // the present loaded
    expect(pin.resized(g(9000, 600, 1000))).toBe(true);
  });

  it('sent from an old window, then scrolled up there: the intent is gone', () => {
    const pin = createBottomPin();
    pin.scrolled(g(8000, 600, 1000));
    pin.setLive(false);
    pin.stick();
    pin.scrolled(g(8000, 600, 700));
    pin.setLive(true);
    expect(pin.resized(g(9000, 600, 700))).toBe(false);
  });

  it('a send does not make a later old window stick (the intent is spent once live)', () => {
    const pin = createBottomPin();
    pin.stick();
    expect(pin.resized(g(2100, 600, 1400))).toBe(true);
    pin.setLive(false); // jumped to an old window while still at the bottom
    expect(pin.resized(g(2200, 600, 1500))).toBe(false);
    pin.setLive(true);
    expect(pin.resized(g(2300, 600, 1500))).toBe(false);
  });

  it('the 2.4.1 clamp still does not stick after a send was scrolled away from', () => {
    const pin = createBottomPin();
    pin.stick();
    pin.scrolled(g(138560, 600, 137960)); // at the bottom
    pin.scrolled(g(138560, 600, 137885)); // the reader: 75 px up
    expect(pin.resized(g(138141, 600, 137541))).toBe(false);
    pin.scrolled(g(138141, 600, 137541)); // the clamp: up, onto the bottom
    expect(pin.resized(g(138141, 600, 137466))).toBe(false);
    pin.scrolled(g(138141, 600, 137466));
    expect(pin.resized(g(138200, 600, 137466))).toBe(false);
  });
});

describe('lastRowChange', () => {
  const row = (key: string, own: boolean, pending: boolean, nonce = '') => ({ key, own, pending, nonce });

  it('my optimistic row appearing is a send', () => {
    expect(lastRowChange('m1', row('local:n1', true, true, 'n1'))).toBe('send');
    expect(lastRowChange('local:n1', row('local:n2', true, true, 'n2'))).toBe('send'); // two sends in a row
  });

  it('the server echo of my last row is an echo, not fresh', () => {
    expect(lastRowChange('local:n1', row('m2', true, false, 'n1'))).toBe('echo');
  });

  it('someone else’s new message stays fresh (left to the smooth follow)', () => {
    expect(lastRowChange('m1', row('m2', false, false, 'x9'))).toBe('fresh');
    expect(lastRowChange('m1', row('m2', false, false))).toBe('fresh');
  });

  it('my own message from another device (already sent) is fresh', () => {
    expect(lastRowChange('m1', row('m2', true, false, 'n7'))).toBe('fresh');
  });

  it('a removed last row exposing an older one is fresh', () => {
    expect(lastRowChange('m2', row('m1', false, false))).toBe('fresh');
  });
});

describe('createBottomPin: an unfold the reader clicked lets go (release())', () => {
  it('the last row unfolding at the bottom is not pinned: it grows down from where they read', () => {
    const pin = stuckAtBottom();
    pin.release();
    expect(pin.resized(g(4600, 600, 1400))).toBe(false);
    expect(pin.isStuck()).toBe(false);
  });

  it('scrolling down to the new bottom sticks again', () => {
    const pin = stuckAtBottom();
    pin.release();
    pin.resized(g(4600, 600, 1400));
    pin.scrolled(g(4600, 600, 2500));
    expect(pin.isStuck()).toBe(false);
    pin.scrolled(atEnd(4600, 600));
    expect(pin.resized(g(4628, 600, 4000))).toBe(true);
  });

  it('also drops a send still waiting for the present', () => {
    const pin = stuckAtBottom();
    pin.stick();
    pin.setLive(false);
    pin.release();
    pin.setLive(true);
    expect(pin.resized(g(2400, 600, 1400))).toBe(false);
  });
});

describe('initialFeedLocation', () => {
  it('no unread: the last row aligned by its bottom (a tall last message is not cut off), stuck', () => {
    expect(initialFeedLocation(-1, false)).toEqual({ location: { index: 'LAST', align: 'end' }, stuck: true });
  });

  it('first unread: its top under the banner, not stuck (opening must not mark it read)', () => {
    expect(initialFeedLocation(12, false)).toEqual({ location: { index: 12, align: 'start', offset: -40 }, stuck: false });
  });

  it('a window away from the present opens at its last row but does not stick', () => {
    expect(initialFeedLocation(-1, true).stuck).toBe(false);
  });
});
