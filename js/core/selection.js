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
