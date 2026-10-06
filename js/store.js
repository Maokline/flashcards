// In-memory mirror of the data, loaded from IndexedDB at start.  Screens read
// from here.  Server mode: kept current by the change feed (sync-server.js).
// Cloud mode: this is the device's working copy, changed by
// js/core/dataset.js and synchronised by js/cloud/sync.js.

import * as db from './db.js';

export const state = {
  decks: new Map(),
  categories: new Map(),
  subcategories: new Map(),
  cards: new Map(),
  media: new Map(),
  // Cloud mode only: review events and the AI file index.
  events: new Map(),
  files: new Map(),
  meta: { epoch: null, cursor: null, lastSync: null, levels: null, mastered_points: null, device: '' },
  summary: null,
  loaded: false,
};

const STORE_MAPS = {
  decks: 'decks',
  categories: 'categories',
  subcategories: 'subcategories',
  cards: 'cards',
  media: 'media',
};

export async function load() {
  for (const name of Object.keys(STORE_MAPS)) {
    const items = await db.getAll(name);
    state[name] = new Map(items.map((item) => [item.id, item]));
  }
  state.events = new Map((await db.getAll('events')).map((item) => [item.id, item]));
  state.files = new Map((await db.getAll('files')).map((item) => [item.path, { sha256: item.sha256, size: item.size }]));
  for (const key of ['epoch', 'cursor', 'lastSync', 'levels', 'mastered_points', 'device', 'summary']) {
    const value = await db.getMeta(key);
    if (value !== undefined) {
      if (key === 'summary') state.summary = value;
      else state.meta[key] = value;
    }
  }
  state.loaded = true;
}

export function applyToMemory({ reset, upserts, deleted }) {
  if (reset) for (const name of Object.keys(STORE_MAPS)) state[name] = new Map();
  for (const [name, items] of Object.entries(upserts)) for (const item of items) state[name].set(item.id, item);
  for (const [name, ids] of Object.entries(deleted)) for (const id of ids) state[name].delete(id);
}

export async function rememberCard(card) {
  if (!card || !card.id) return;
  state.cards.set(card.id, card);
  await db.putEntity('cards', card);
}

export async function forgetCards(ids) {
  for (const id of ids) state.cards.delete(id);
  await db.deleteEntities('cards', ids);
}

export async function rememberMedia(media) {
  if (!media || !media.id) return;
  state.media.set(media.id, media);
  await db.putEntity('media', media);
}

export async function setMeta(key, value) {
  state.meta[key] = value;
  await db.setMeta(key, value);
}

export async function setSummary(summary) {
  state.summary = summary;
  await db.setMeta('summary', summary);
}

export function resetMemory() {
  for (const name of Object.keys(STORE_MAPS)) state[name] = new Map();
  state.events = new Map();
  state.files = new Map();
  state.meta = { epoch: null, cursor: null, lastSync: null, levels: null, mastered_points: null, device: '' };
  state.summary = null;
}

// -- read helpers -------------------------------------------------------
const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'de', { sensitivity: 'base' });

export function decks() {
  return [...state.decks.values()].sort(byName);
}

export function categoriesOf(deckId) {
  return [...state.categories.values()].filter((item) => !deckId || item.deck_id === deckId).sort(byName);
}

export function subcategoriesOf(categoryId) {
  return [...state.subcategories.values()].filter((item) => !categoryId || item.category_id === categoryId).sort(byName);
}

export function deck(id) { return state.decks.get(id) || null; }
export function card(id) { return state.cards.get(id) || null; }
export function cards() { return [...state.cards.values()]; }

export function deckName(card) {
  const item = state.decks.get(card.deck_id);
  return (item && item.name) || card.deck_name || 'Ohne Deck';
}

export function deckColor(deckId) {
  const item = state.decks.get(deckId);
  return (item && item.color) || '#3F64DF';
}

export function isDue(card, now = new Date()) {
  if (!card.next_review) return !card.mastered;
  return new Date(card.next_review) <= now;
}

// Display status, identical vocabulary to the desktop table and the API's
// card status filter: Neu / Fällig / Aktiv / Gekonnt.
export function statusOf(card, now = new Date()) {
  if (card.mastered) return 'mastered';
  if (card.next_review && new Date(card.next_review) <= now) return 'due';
  return card.last_reviewed ? 'active' : 'new';
}

export const STATUS_LABELS = { new: 'Neu', due: 'Fällig', active: 'Aktiv', mastered: 'Gekonnt' };

export function levelRange(level) {
  const levels = state.meta.levels || [];
  return levels.find((item) => item.level === level) || null;
}

/*
 * SELECTION-ONLY OFFLINE FALLBACK (server mode).
 * Online, session cards are chosen by the server (POST /api/sessions/select,
 * app/services/session_selection.py).  Without a connection the app applies
 * the identical documented rule to its local copy (cloud mode always uses
 * js/core/selection.js, the tested port of the same rule):
 *   - deck/category/subcategory filters,
 *   - mastered cards excluded unless include_mastered,
 *   - due_only: no next_review yet, or next_review <= now,
 *   - earliest due date first (cards without a date first), then created_at,
 *   - at most `limit` cards.
 * This decides WHICH cards are asked.  Points, levels and due dates are never
 * computed here – every rating is sent to the server's LearningEngine.
 */
export function localSelection({ deckIds = [], categoryIds = [], subcategoryIds = [], dueOnly = true, includeMastered = false, limit = null } = {}) {
  const now = new Date();
  const selected = cards().filter((item) => {
    if (item.mastered && !includeMastered) return false;
    if (deckIds.length && !deckIds.includes(item.deck_id)) return false;
    if (categoryIds.length && !categoryIds.includes(item.category_id || '')) return false;
    if (subcategoryIds.length && !subcategoryIds.includes(item.subcategory_id || '')) return false;
    if (dueOnly && !item.mastered && !isDue(item, now)) return false;
    return true;
  });
  selected.sort((a, b) => {
    const aHas = a.next_review ? 1 : 0;
    const bHas = b.next_review ? 1 : 0;
    if (aHas !== bHas) return aHas - bHas;
    const aTime = a.next_review ? new Date(a.next_review).getTime() : 0;
    const bTime = b.next_review ? new Date(b.next_review).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime;
    return String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id));
  });
  return limit ? selected.slice(0, limit) : selected;
}

export function localOverview() {
  const now = new Date();
  let due = 0;
  let mastered = 0;
  for (const item of state.cards.values()) {
    if (item.mastered) mastered += 1;
    else if (item.next_review && new Date(item.next_review) <= now) due += 1;
  }
  return { total_cards: state.cards.size, due_cards: due, mastered_cards: mastered };
}
