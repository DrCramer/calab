import { describe, expect, it } from 'vitest';
import { streamClickPlan } from './streamOpen';

describe('streamClickPlan', () => {
  it('opens the room and watches the stream when connected to that room', () => {
    expect(streamClickPlan({ streaming: true, hasTrack: true, inSameRoom: true })).toEqual({ openRoom: true, watch: true });
  });
  it('only opens the room when the stream cannot be watched from here', () => {
    expect(streamClickPlan({ streaming: true, hasTrack: false, inSameRoom: true })).toEqual({ openRoom: true, watch: false });
    expect(streamClickPlan({ streaming: true, hasTrack: true, inSameRoom: false })).toEqual({ openRoom: true, watch: false });
  });
  it('does nothing for a member who is not streaming', () => {
    expect(streamClickPlan({ streaming: false, hasTrack: false, inSameRoom: true })).toEqual({ openRoom: false, watch: false });
  });
});
