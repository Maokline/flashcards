// Synchronisation facade used by the screens.
//
// * Cloud mode (Google Drive by default, or OneDrive): ratings are applied locally by the learning
//   engine (core/dataset.js) and the data set is synchronised through the
//   user's cloud (cloud/sync.js).
// * Server mode (optional): the existing sync-server client (sync-server.js).

import { emit, on } from './bus.js';
import { isCloud } from './config.js';
import * as dataset from './core/dataset.js';
import { levelRanges, MASTERED_POINTS } from './core/engine.js';
import * as statistics from './core/statistics.js';
import * as cloud from './cloud/sync.js';
import * as server from './sync-server.js';
import { setMeta, setSummary, state } from './store.js';

export const status = new Proxy({}, {
  get: (_target, key) => (isCloud() ? cloud.status : server.status)[key],
});

export function pull() {
  return isCloud() ? cloud.check() : server.pull();
}

export async function refreshSummary() {
  if (!isCloud()) return server.refreshSummary();
  const summary = statistics.summary({
    decks: [...state.decks.values()],
    cards: [...state.cards.values()],
    events: [...state.events.values()],
    days: 14,
  });
  await setSummary({ ...summary, fetched_at: new Date().toISOString() });
  emit('summary', summary);
  return summary;
}

export async function loadMeta() {
  if (!isCloud()) return server.loadMeta();
  await setMeta('levels', levelRanges());
  await setMeta('mastered_points', MASTERED_POINTS);
  await setMeta('app_version', cloud.status.label || 'Cloud');
  return undefined;
}

/**
 * Rate a card.  Cloud mode: the engine applies it right away on this
 * device (the active one) – the outcome carries the real points.
 */
export async function submitReview(event) {
  if (!isCloud()) return server.submitReview(event);
  const outcome = await dataset.review(event);
  emit('review-synced', outcome);
  return outcome;
}

export function syncNow() {
  return isCloud() ? cloud.syncNow().catch(() => cloud.status.state) : server.syncNow();
}

export function startSyncLoop() {
  if (!isCloud()) server.startSyncLoop();
}

export function stopSyncLoop() {
  if (!isCloud()) server.stopSyncLoop();
}

export function flush() {
  return isCloud() ? cloud.commit() : server.flush();
}

export function pendingCount() {
  return isCloud() ? cloud.status.pending : server.pendingCount();
}

on('sync-notice', () => {
  if (isCloud()) refreshSummary();
});
