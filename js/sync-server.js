// Server mode (optional): synchronisation with the self-hosted sync server.
//
// Pull:   GET /api/sync/changes delivers everything after our cursor
//         (or a complete snapshot when `reset` is set, e.g. after a restore).
// Push:   Server-Sent Events (/api/sync/events) announce new changes the
//         moment any device – including the desktop app – writes data.
//         Pulls also run on start, focus, visibility, reconnect and every 60 s.
// Reviews: every rating gets a UUID and is stored in IndexedDB *before* it is
//         sent.  It leaves the queue only after the server confirmed it
//         (applied / duplicate / rejected / invalid).  The server applies an
//         event ID at most once, so re-sending after a lost response or after
//         being offline can never award points twice.

import { api, ApiError, NetworkError, query } from './api.js';
import { emit, on } from './bus.js';
import * as db from './db.js';
import { applyToMemory, rememberCard, setMeta, setSummary, state } from './store.js';
import { tzOffset } from './util.js';

const ENTITY_STORE = { deck: 'decks', category: 'categories', subcategory: 'subcategories', card: 'cards', media: 'media' };
const SETTLED = new Set(['applied', 'rejected', 'undone', 'invalid']);
const FALLBACK_INTERVAL = 60000;

export const status = {
  online: navigator.onLine,
  syncing: false,
  live: false,
  pending: 0,
  lastSync: null,
  lastError: '',
};

function setStatus(patch) {
  Object.assign(status, patch);
  emit('status', { ...status });
}

on('network', ({ ok }) => {
  if (ok !== status.online) setStatus({ online: ok });
});

// -- pull ------------------------------------------------------------------
let pullPromise = null;
let pullAgain = false;

export function pull() {
  if (pullPromise) {
    pullAgain = true;
    return pullPromise;
  }
  pullPromise = (async () => {
    try {
      do {
        pullAgain = false;
        await pullOnce();
      } while (pullAgain);
    } finally {
      pullPromise = null;
    }
  })();
  return pullPromise;
}

async function pullOnce() {
  setStatus({ syncing: true });
  let changed = false;
  try {
    let since = state.meta.cursor;
    let epoch = state.meta.epoch;
    for (let page = 0; page < 500; page += 1) {
      const data = await api.get(
        `/api/sync/changes${query({ since: since ?? undefined, epoch: epoch ?? undefined, limit: 1000 })}`,
      );
      const upserts = {
        decks: data.decks || [],
        categories: data.categories || [],
        subcategories: data.subcategories || [],
        cards: data.cards || [],
        media: data.media || [],
      };
      const deleted = { decks: [], categories: [], subcategories: [], cards: [], media: [] };
      for (const tombstone of data.deleted || []) {
        const store = ENTITY_STORE[tombstone.entity];
        if (store) deleted[store].push(tombstone.id);
      }
      const lastSync = new Date().toISOString();
      const meta = { cursor: data.cursor, epoch: data.epoch, lastSync };
      await db.applyChanges({ reset: data.reset, upserts, deleted, meta });
      applyToMemory({ reset: data.reset, upserts, deleted });
      Object.assign(state.meta, meta);
      // Shared app preferences can advance the existing cursor without an
      // entity row. Refresh consumers after that change as well.
      changed = changed || data.reset || data.cursor !== since
        || Object.values(upserts).some((items) => items.length)
        || Object.values(deleted).some((items) => items.length);
      since = data.cursor;
      epoch = data.epoch;
      if (!data.has_more) break;
    }
    setStatus({ syncing: false, online: true, lastSync: state.meta.lastSync, lastError: '' });
  } catch (error) {
    setStatus({ syncing: false, lastError: error.message || String(error) });
    if (!(error instanceof NetworkError) && !(error instanceof ApiError && error.status === 401)) {
      console.warn('Sync fehlgeschlagen', error);
    }
    throw error;
  } finally {
    if (changed) emit('data-changed', {});
  }
}

export async function refreshSummary() {
  try {
    const summary = await api.get(`/api/statistics/summary${query({ tz_offset: tzOffset(), days: 14 })}`);
    await setSummary({ ...summary, fetched_at: new Date().toISOString() });
    emit('summary', summary);
    return summary;
  } catch (error) {
    if (!(error instanceof NetworkError)) console.warn('Statistik nicht geladen', error);
    return state.summary;
  }
}

export async function loadMeta() {
  try {
    const meta = await api.get('/api/meta');
    await setMeta('levels', meta.levels);
    await setMeta('mastered_points', meta.mastered_points);
    await setMeta('app_version', meta.app_version);
  } catch {
    // Cached values remain in use.
  }
}

// -- review queue ------------------------------------------------------------
let lock = Promise.resolve();
let orderCounter = 0;

function withLock(work) {
  const run = lock.then(work, work);
  lock = run.catch(() => {});
  return run;
}

function payload(entry) {
  return {
    event_id: entry.event_id,
    card_id: entry.card_id,
    correct: entry.correct,
    immediate_retry: Boolean(entry.immediate_retry),
    duration_seconds: Math.max(0, Number(entry.duration_seconds) || 0),
    reviewed_at: entry.reviewed_at,
  };
}

async function updatePendingCount() {
  const pending = await db.listPending();
  setStatus({ pending: pending.length });
  emit('pending-changed', { count: pending.length });
  return pending;
}

async function settle(entries, results) {
  const done = [];
  const outcomes = new Map();
  for (const result of results) {
    if (!result || !result.event_id) continue;
    outcomes.set(result.event_id, result);
    if (SETTLED.has(result.status) || result.duplicate) {
      done.push(result.event_id);
      if (result.card) await rememberCard(result.card);
      emit('review-synced', result);
    }
  }
  // An entry the server could not read at all ("invalid" without an ID echo)
  // is matched by position.
  entries.forEach((entry, index) => {
    const result = results[index];
    if (result && result.status === 'invalid' && !outcomes.has(entry.event_id)) {
      done.push(entry.event_id);
      emit('review-synced', { ...result, event_id: entry.event_id, card_id: entry.card_id });
    }
  });
  if (done.length) await db.removePending(done);
  return outcomes;
}

/**
 * Queue a rating and try to deliver it right away.
 * Resolves with the server outcome, or `{status: 'queued'}` when offline.
 */
export async function submitReview(event) {
  const entry = { ...event, order: Date.now() * 1000 + (orderCounter += 1), queued_at: new Date().toISOString() };
  await db.addPending(entry);
  await updatePendingCount();
  return withLock(async () => {
    const pending = await db.listPending();
    if (!pending.some((item) => item.event_id === entry.event_id)) {
      return { status: 'queued', event_id: entry.event_id };
    }
    try {
      let outcome;
      if (pending.length === 1) {
        const result = await api.post('/api/reviews', payload(entry), { timeout: 8000 });
        outcome = (await settle([entry], [result])).get(entry.event_id);
      } else {
        // Older offline ratings go first, in their original order.
        const outcomes = await sendBatches(pending);
        outcome = outcomes.get(entry.event_id);
      }
      await updatePendingCount();
      emit('data-changed', { source: 'review' });
      return outcome || { status: 'queued', event_id: entry.event_id };
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        await db.removePending([entry.event_id]);
        await updatePendingCount();
        return { status: 'invalid', event_id: entry.event_id, reason: error.message };
      }
      await updatePendingCount();
      return { status: 'queued', event_id: entry.event_id };
    }
  });
}

async function sendBatches(pending) {
  const outcomes = new Map();
  for (let start = 0; start < pending.length; start += 100) {
    const chunk = pending.slice(start, start + 100);
    const response = await api.post('/api/reviews/batch', { events: chunk.map(payload) }, { timeout: 30000 });
    const settled = await settle(chunk, response.results || []);
    for (const [key, value] of settled) outcomes.set(key, value);
  }
  return outcomes;
}

export function flush() {
  return withLock(async () => {
    const pending = await db.listPending();
    if (!pending.length) {
      setStatus({ pending: 0 });
      return 0;
    }
    try {
      await sendBatches(pending);
      emit('data-changed', { source: 'review' });
    } catch (error) {
      if (!(error instanceof NetworkError) && !(error instanceof ApiError && error.status === 401)) {
        console.warn('Bewertungen nicht übertragen', error);
      }
    }
    const rest = await updatePendingCount();
    return pending.length - rest.length;
  });
}

// -- live push -------------------------------------------------------------
let source = null;
let reconnectTimer = null;

export function startLive() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/sync/events');
  source.addEventListener('state', (event) => {
    let data = {};
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    setStatus({ live: true, online: true });
    if (data.epoch !== state.meta.epoch || data.cursor !== state.meta.cursor) {
      pull().catch(() => {});
    }
  });
  source.addEventListener('logout', () => {
    stopLive();
    emit('auth-required', {});
  });
  source.onerror = () => {
    setStatus({ live: false });
    if (source && source.readyState === EventSource.CLOSED) {
      source = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (navigator.onLine) startLive();
      }, 8000);
    }
  };
}

export function stopLive() {
  clearTimeout(reconnectTimer);
  if (source) source.close();
  source = null;
  setStatus({ live: false });
}

// -- triggers --------------------------------------------------------------
let active = false;
let listenersInstalled = false;
let intervalId = null;

export async function syncNow() {
  await flush();
  try {
    await pull();
  } catch {
    // Status already reflects the failure.
  }
}

function kick() {
  if (!active) return;
  syncNow();
  refreshSummary();
}

function installListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  window.addEventListener('online', () => {
    setStatus({ online: true });
    if (!active) return;
    startLive();
    kick();
  });
  window.addEventListener('offline', () => setStatus({ online: false, live: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  window.addEventListener('focus', kick);
}

export function startSyncLoop() {
  if (active) return;
  active = true;
  installListeners();
  clearInterval(intervalId);
  intervalId = setInterval(kick, FALLBACK_INTERVAL);
  startLive();
  updatePendingCount();
}

export function stopSyncLoop() {
  active = false;
  stopLive();
  clearInterval(intervalId);
}

export function pendingCount() {
  return status.pending;
}
