/**
 * What a click on a streaming member's row (the LIVE badge) does (CBF-67). The stream stage lives in
 * the voice room's own view, so with another chat selected the room is opened first; the stream
 * can be watched only from the room we are connected to.
 */
export type StreamClickPlan = { openRoom: boolean; watch: boolean };

export function streamClickPlan(p: { streaming: boolean; hasTrack: boolean; inSameRoom: boolean }): StreamClickPlan {
  if (!p.streaming && !p.hasTrack) return { openRoom: false, watch: false };
  return { openRoom: true, watch: p.hasTrack && p.inSameRoom };
}
