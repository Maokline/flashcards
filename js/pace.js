// The personal pace behind the start page's time forecast, kept in RAM.
//
// Cloud mode: every review event of this device's data set already carries
// its measured duration and travels through the existing snapshot, so the
// pace needs no storage, no writes and no extra synchronisation of its own.
// The newest PACE_WINDOW valid durations live in a ring buffer with a running
// sum: a rating applied here adds one value in O(1). The events are read
// again only when they changed in another way (start, pull from the cloud,
// restore, a merged rating of another device).
// Server mode: the server derives the same figure from its review events
// (`pace` in the statistics response).
import { paceFromEvents } from './core/pace.js';
import { state } from './store.js';

let ring = null;
let source = null;
let size = -1;

export function localPace() {
  if (!ring || source !== state.events || size !== state.events.size) {
    ring = paceFromEvents(state.events.values());
    source = state.events;
    size = state.events.size;
  }
  return ring.summary();
}

/** A rating the learning engine just stored on this device. */
export function recordLocalRating(seconds) {
  // Exactly this one event is new: one O(1) update. Anything else (no window
  // yet, a replaced or otherwise changed event set, e.g. events removed with
  // a deleted card) makes the next read rebuild the window once.
  if (ring && source === state.events && size === state.events.size - 1) {
    ring.push(seconds);
    size = state.events.size;
  } else {
    ring = null;
  }
}
