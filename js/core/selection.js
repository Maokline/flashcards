// Session selection – port of app/services/session_selection.py.

import { toMillis } from './time.js';

export function isDue(card, now = Date.now()) {
  if (!card.next_review) return !card.mastered;
  return toMillis(card.next_review) <= now;
}

export function selectSessionCards(cards, {
  deckIds = [], categoryIds = [], subcategoryIds = [], dueOnly = true, includeMastered = false, limit = null, now = Date.now(),
} = {}) {
  const decks = new Set(deckIds.map(String));
  const categories = new Set(categoryIds.map(String));
  const subcategories = new Set(subcategoryIds.map(String));
  const selected = [];
  for (const card of cards) {
    if (card.mastered && !includeMastered) continue;
    if (decks.size && !decks.has(card.deck_id)) continue;
    if (categories.size && !categories.has(card.category_id || '')) continue;
    if (subcategories.size && !subcategories.has(card.subcategory_id || '')) continue;
    if (dueOnly && !card.mastered && !isDue(card, now)) continue;
    selected.push(card);
  }
  // (next_review is not None, next_review or now, created_at, id)
  selected.sort((a, b) => {
    const aHas = a.next_review ? 1 : 0;
    const bHas = b.next_review ? 1 : 0;
    if (aHas !== bHas) return aHas - bHas;
    const aDue = a.next_review ? toMillis(a.next_review) : now;
    const bDue = b.next_review ? toMillis(b.next_review) : now;
    if (aDue !== bDue) return aDue - bDue;
    const aCreated = toMillis(a.created_at) || 0;
    const bCreated = toMillis(b.created_at) || 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (limit !== null && limit !== undefined && Number(limit) > 0) return selected.slice(0, Number(limit));
  return selected;
}

/** Card status in the vocabulary of the desktop table and the API. */
export function cardStatus(card, now = Date.now()) {
  if (card.mastered) return 'mastered';
  if (card.next_review && isDue(card, now)) return 'due';
  return card.last_reviewed ? 'active' : 'new';
}

// -- session order (port of order_session_cards) --------------------------------
// mixed: one shuffle of the whole candidate list, across all decks.
// due: longest overdue first; no date = due now, mastered without date last.
// level_asc / level_desc: by level, within a level by due date, then seeded
// random.  Mastered cards keep their level (no "level 11").
export const ORDER_MODES = ['mixed', 'due', 'level_asc', 'level_desc'];
export const DEFAULT_ORDER = 'mixed';

/** mulberry32 – the same sequence as seeded_random() in Python. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Arrange the session's cards; the result only depends on the set, mode and seed. */
export function orderSessionCards(cards, mode = DEFAULT_ORDER, { seed = 0, now = Date.now() } = {}) {
  const reference = toMillis(now);
  const random = seededRandom(seed);
  // A canonical starting order: the input order must not matter.
  const items = [...cards].sort(byId);
  if (!ORDER_MODES.includes(mode) || mode === 'mixed') {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [items[index], items[other]] = [items[other], items[index]];
    }
    return items;
  }
  const dueKey = (card) => {
    if (card.next_review) return toMillis(card.next_review);
    return card.mastered ? Infinity : reference;
  };
  if (mode === 'due') {
    return items.sort((a, b) => (dueKey(a) - dueKey(b) || 0)
      || ((toMillis(a.created_at) || 0) - (toMillis(b.created_at) || 0))
      || byId(a, b));
  }
  const rank = new Map(items.map((card) => [card.id, random()]));
  const direction = mode === 'level_asc' ? 1 : -1;
  return items.sort((a, b) => (direction * ((Number(a.level) || 1) - (Number(b.level) || 1)))
    || (dueKey(a) - dueKey(b) || 0)
    || (rank.get(a.id) - rank.get(b.id))
    || byId(a, b));
}
