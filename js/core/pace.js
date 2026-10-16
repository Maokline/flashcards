// Personal answer pace for the session time forecast: the arithmetic mean of
// the newest valid rating durations. Pure; the Python twin is
// app/services/advanced_statistics.py `study_pace` (parity-tested).
//
// The duration of a rating is already part of every review event
// (`duration_seconds`), so no additional data is stored anywhere.
// Valid: PACE_MIN_SECONDS <= duration <= PACE_MAX_SECONDS. Shorter values are
// measuring glitches (a rating needs revealing and deciding), longer ones are
// interruptions with the card left open. Both stay untouched in the event
// (learning time statistics) but never enter the mean.
// Sums run in whole milliseconds: exact, so values leaving the window never
// make the running sum drift.
import { toMillis } from './time.js';

export const PACE_WINDOW = 300;
export const PACE_MIN_SECONDS = 0.5;
export const PACE_MAX_SECONDS = 300;
// Fewer valid ratings than this: the forecast is shown as provisional.
export const PACE_SETTLED = 10;

const wholeMillis = (seconds) => Math.floor(seconds * 1000 + 0.5);

export function validDuration(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return false;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= PACE_MIN_SECONDS && seconds <= PACE_MAX_SECONDS;
}

/** Ring buffer of the newest durations with a running sum: push is O(1). */
export class PaceWindow {
  constructor(capacity = PACE_WINDOW) {
    this.capacity = capacity;
    this.values = new Uint32Array(capacity);
    this.start = 0;
    this.count = 0;
    this.sumMillis = 0;
  }

  /** Add the newest duration; invalid values are ignored (returns false). */
  push(seconds) {
    if (!validDuration(seconds)) return false;
    const value = wholeMillis(Number(seconds));
    if (this.count < this.capacity) {
      this.values[(this.start + this.count) % this.capacity] = value;
      this.count += 1;
    } else {
      this.sumMillis -= this.values[this.start];
      this.values[this.start] = value;
      this.start = (this.start + 1) % this.capacity;
    }
    this.sumMillis += value;
    return true;
  }

  summary() {
    return {
      average_seconds: this.count ? this.sumMillis / this.count / 1000 : null,
      samples: this.count,
      window: this.capacity,
      provisional: this.count > 0 && this.count < PACE_SETTLED,
    };
  }
}

/** The newest `capacity` valid durations by review time (input order breaks ties). */
export function paceFromEvents(events, capacity = PACE_WINDOW) {
  const rows = [];
  let index = 0;
  for (const event of events) {
    const when = toMillis(event.reviewed_at);
    if (when !== null && validDuration(event.duration_seconds)) rows.push([when, index, Number(event.duration_seconds)]);
    index += 1;
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const window = new PaceWindow(capacity);
  for (let position = Math.max(0, rows.length - capacity); position < rows.length; position += 1) window.push(rows[position][2]);
  return window;
}

/** Forecast in whole seconds: mean × planned cards; null without measurements. */
export function forecastSeconds(pace, cards) {
  const count = Number(cards);
  if (!pace || !pace.samples || !Number.isFinite(pace.average_seconds) || !(count > 0)) return null;
  return Math.round(pace.average_seconds * count);
}

/** M:SS, e.g. 3:07 or 12:05 (minutes keep counting beyond one hour). */
export function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The start page wording: "ca. 4:00 Min", provisional or still unknown. */
export function estimateText(cards, pace) {
  const seconds = forecastSeconds(pace, cards);
  if (seconds === null) return 'Zeit wird ermittelt';
  return `ca. ${formatClock(seconds)} Min${pace.provisional ? ' (vorläufig)' : ''}`;
}
