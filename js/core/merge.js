// Three-way merge for stranded offline changes – port of app/cloudsync/merge.py.
// Same rules, same order of operations; tests/test_engine_parity.py feeds
// identical inputs to both implementations and compares the results.

import { learningStateJson, processCorrect, processIncorrect } from './engine.js';
import { later, toMillis, utcIso } from './time.js';

const CARD_CONTENT_FIELDS = ['deck_id', 'question', 'answer', 'category', 'category_id', 'subcategory', 'subcategory_id', 'question_images', 'answer_images'];
const LEARNING_FIELDS = ['points', 'level', 'mastered', 'positive_streak', 'negative_streak', 'success_history', 'total_incorrect_count', 'consecutive_incorrect_attempts', 'last_reviewed', 'next_review', 'recovery_mode', 'recovery_interval'];
const DECK_KEYS = ['name', 'description', 'color', 'created_at', 'updated_at'];
const CATEGORY_KEYS = ['deck_id', 'name', 'created_at', 'updated_at'];
const SUBCATEGORY_KEYS = ['category_id', 'name', 'created_at', 'updated_at'];
const MEDIA_KEYS = ['relative_path', 'original_name', 'mime_type', 'size_bytes', 'sha256', 'created_at'];
const CARD_META_KEYS = ['created_at'];

const equal = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function sorted(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = sorted(value[key]);
    return result;
  }
  return value;
}

const byId = (items) => new Map((items || []).map((item) => [String(item.id), { ...item }]));
const compareIds = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const idsOf = (...maps) => [...new Set(maps.flatMap((map) => [...map.keys()]))].sort(compareIds);

function threeWay(base, local, remote, keys, report) {
  if (equal(local ?? null, base ?? null)) return remote ?? null;
  report.local_changes += 1;
  if (equal(remote ?? null, base ?? null) || equal(local ?? null, remote ?? null)) return local ?? null;
  report.both_changed += 1;
  if (!local) return remote ?? null;
  if (!remote || !base) return local;
  const merged = { ...remote };
  for (const key of keys) merged[key] = equal(local[key], base[key]) ? remote[key] : local[key];
  return merged;
}

const learning = (card) => (card ? Object.fromEntries(LEARNING_FIELDS.map((key) => [key, card[key] ?? null])) : null);

export function replayReviews(cardData, events, firstId) {
  let card = { ...cardData };
  const newEvents = [];
  let nextId = firstId;
  for (const event of events) {
    let reviewed = toMillis(event.reviewed_at);
    if (reviewed === null) reviewed = Date.now();
    const last = toMillis(card.last_reviewed);
    if (last !== null && reviewed < last) reviewed = last;
    const previous = card;
    const correct = Boolean(event.correct);
    const retry = Boolean(correct && event.immediate_retry);
    const result = correct ? processCorrect(previous, reviewed, { immediateRetry: retry }) : processIncorrect(previous, reviewed);
    card = result.card;
    newEvents.push({
      id: nextId,
      card_id: card.id,
      reviewed_at: card.last_reviewed || card.updated_at,
      correct,
      immediate_retry: retry,
      points_before: previous.points,
      points_after: card.points,
      level_before: previous.level,
      level_after: card.level,
      duration_seconds: Number(event.duration_seconds) || 0,
      before_state_json: learningStateJson(previous),
      after_state_json: learningStateJson(card),
    });
    nextId += 1;
  }
  const merged = { ...cardData };
  for (const key of LEARNING_FIELDS) merged[key] = card[key];
  merged.updated_at = card.updated_at;
  return { card: merged, events: newEvents };
}

export function mergeDatasets(base, local, remote) {
  const report = { local_changes: 0, both_changed: 0, replayed_reviews: 0, dropped_reviews: 0, resurrected: 0, joined_duplicates: 0, notes: [] };
  const merged = {};
  const indexes = {};
  for (const [name, keys] of [['decks', DECK_KEYS], ['categories', CATEGORY_KEYS], ['subcategories', SUBCATEGORY_KEYS], ['media', MEDIA_KEYS]]) {
    const b = byId(base.core[name]);
    const l = byId(local.core[name]);
    const r = byId(remote.core[name]);
    indexes[name] = [b, l, r];
    const result = new Map();
    for (const id of idsOf(b, l, r)) {
      const value = threeWay(b.get(id), l.get(id), r.get(id), keys, report);
      if (value) result.set(id, value);
    }
    merged[name] = result;
  }

  const bCards = byId(base.core.cards);
  const lCards = byId(local.core.cards);
  const rCards = byId(remote.core.cards);
  indexes.cards = [bCards, lCards, rCards];
  const baseMax = Math.max(0, ...base.events.map((event) => Number(event.id)));
  const baseIds = new Set(base.events.map((event) => Number(event.id)));
  const localIds = new Set(local.events.map((event) => Number(event.id)));
  const newLocal = local.events
    .filter((event) => Number(event.id) > baseMax)
    .sort((a, b) => (String(a.reviewed_at) < String(b.reviewed_at) ? -1 : String(a.reviewed_at) > String(b.reviewed_at) ? 1 : Number(a.id) - Number(b.id)));
  const undoneBase = [...baseIds].filter((id) => !localIds.has(id)).sort((a, b) => a - b);
  const eventsByCard = new Map();
  for (const event of newLocal) {
    const list = eventsByCard.get(String(event.card_id)) || [];
    list.push(event);
    eventsByCard.set(String(event.card_id), list);
  }

  const contentKeys = [...CARD_CONTENT_FIELDS, ...CARD_META_KEYS];
  const strip = (card) => (card ? Object.fromEntries([...contentKeys, 'id'].map((key) => [key, card[key] ?? null])) : null);
  const cards = new Map();
  for (const id of idsOf(bCards, lCards, rCards)) {
    const b = bCards.get(id);
    const l = lCards.get(id);
    const r = rCards.get(id);
    const content = threeWay(strip(b), strip(l), strip(r), contentKeys, report);
    if (!content) continue;
    let card;
    if (r && (!l || equal(strip(l), strip(b)) || equal(content, strip(r)))) card = { ...r };
    else if (l) card = { ...l };
    else card = { ...(r || b || {}) };
    Object.assign(card, content);
    if (l && r) card.updated_at = later(l.updated_at, r.updated_at);
    const localEvents = eventsByCard.get(id) || [];
    if (r && b) {
      if (!localEvents.length) {
        const lb = learning(b);
        const ll = learning(l);
        const lr = learning(r);
        if (l && !equal(ll, lb) && equal(lr, lb)) Object.assign(card, ll || {});
        else if (l && !equal(ll, lb) && !equal(lr, lb)) {
          Object.assign(card, ll || {});
          report.both_changed += 1;
        } else Object.assign(card, lr || {});
      } else {
        Object.assign(card, learning(r) || {});
      }
    } else if (!r && l) {
      Object.assign(card, learning(l) || {});
    }
    cards.set(id, card);
  }

  const remoteEvents = remote.events.map((event) => ({ ...event }));
  for (const eventId of undoneBase) {
    const index = remoteEvents.findIndex((item) => Number(item.id) === eventId);
    const event = index >= 0 ? remoteEvents[index] : null;
    const cardId = event ? String(event.card_id) : '';
    if (event && equal(learning(rCards.get(cardId)), learning(bCards.get(cardId))) && cards.has(cardId)) {
      remoteEvents.splice(index, 1);
      const localCard = lCards.get(cardId);
      if (localCard) Object.assign(cards.get(cardId), learning(localCard) || {});
    }
  }
  let nextId = Math.max(0, ...remoteEvents.map((event) => Number(event.id))) + 1;
  const replayed = [];
  const order = [...eventsByCard.keys()].sort((a, b) => {
    const left = String(eventsByCard.get(a)[0].reviewed_at);
    const right = String(eventsByCard.get(b)[0].reviewed_at);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const cardId of order) {
    const events = eventsByCard.get(cardId);
    if (!cards.has(cardId)) {
      report.dropped_reviews += events.length;
      continue;
    }
    const b = bCards.get(cardId);
    const r = rCards.get(cardId);
    if (!r || !b) {
      for (const event of events) {
        replayed.push({ ...event, id: nextId });
        nextId += 1;
      }
      report.replayed_reviews += events.length;
      continue;
    }
    const result = replayReviews(cards.get(cardId), events, nextId);
    cards.set(cardId, result.card);
    nextId += result.events.length;
    replayed.push(...result.events);
    report.replayed_reviews += result.events.length;
  }

  merged.cards = cards;
  merged.ai_files = mergeMapping(base.core.ai_files || {}, local.core.ai_files || {}, remote.core.ai_files || {}, report);
  repair(merged, indexes, report);
  const all = [...remoteEvents, ...replayed].filter((event) => merged.cards.has(String(event.card_id)));
  report.dropped_reviews += remoteEvents.length + replayed.length - all.length;
  all.sort((a, b) => Number(a.id) - Number(b.id));
  const sortById = (map) => [...map.values()].sort((a, b) => compareIds(a.id, b.id));
  return {
    dataset: {
      core: {
        decks: sortById(merged.decks),
        categories: sortById(merged.categories),
        subcategories: sortById(merged.subcategories),
        cards: sortById(merged.cards),
        media: sortById(merged.media),
        ai_files: Object.fromEntries(Object.entries(merged.ai_files).sort(([a], [b]) => compareIds(a, b))),
      },
      events: all,
    },
    report,
  };
}

function mergeMapping(base, local, remote, report) {
  const result = {};
  const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort(compareIds);
  for (const key of keys) {
    const b = base[key] ?? null;
    const l = local[key] ?? null;
    const r = remote[key] ?? null;
    let value;
    if (equal(l, b)) value = r;
    else {
      report.local_changes += 1;
      value = (equal(r, b) || equal(l, r) || l !== null) ? l : r;
    }
    if (value !== null && value !== undefined) result[key] = value;
  }
  return result;
}

function resurrect(kind, id, merged, indexes, report) {
  const [base, local, remote] = indexes[kind];
  const candidate = local.get(id) || remote.get(id) || base.get(id);
  if (!candidate) return null;
  merged[kind].set(id, { ...candidate });
  report.resurrected += 1;
  return merged[kind].get(id);
}

function joinDuplicates(entities, keyOf, remote, report) {
  const groups = new Map();
  for (const item of entities.values()) {
    const key = JSON.stringify(keyOf(item));
    const list = groups.get(key) || [];
    list.push(item);
    groups.set(key, list);
  }
  const alias = new Map();
  for (const items of groups.values()) {
    if (items.length < 2) continue;
    items.sort((a, b) => {
      const aRemote = remote.has(a.id) ? 0 : 1;
      const bRemote = remote.has(b.id) ? 0 : 1;
      if (aRemote !== bRemote) return aRemote - bRemote;
      const aCreated = String(a.created_at || '');
      const bCreated = String(b.created_at || '');
      if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
      return compareIds(a.id, b.id);
    });
    const keep = items[0];
    for (const duplicate of items.slice(1)) {
      alias.set(duplicate.id, keep.id);
      entities.delete(duplicate.id);
      report.joined_duplicates += 1;
    }
  }
  return alias;
}

// Python's str.casefold() for the names that occur in practice.
const fold = (text) => String(text).toLowerCase().replace(/ß/g, 'ss');

function repair(merged, indexes, report) {
  const { decks, categories, subcategories, cards, media } = merged;
  for (const card of cards.values()) {
    if (!decks.has(card.deck_id) && !resurrect('decks', card.deck_id, merged, indexes, report)) card.deck_id = fallbackDeck(merged);
    for (const side of ['question_images', 'answer_images']) {
      card[side] = (card[side] || []).filter((mediaId) => media.has(mediaId) || resurrect('media', mediaId, merged, indexes, report));
    }
    if (card.subcategory_id && !subcategories.has(card.subcategory_id) && !resurrect('subcategories', card.subcategory_id, merged, indexes, report)) card.subcategory_id = null;
    if (card.category_id && !categories.has(card.category_id) && !resurrect('categories', card.category_id, merged, indexes, report)) card.category_id = null;
  }
  for (const subcategory of [...subcategories.values()]) {
    if (!categories.has(subcategory.category_id) && !resurrect('categories', subcategory.category_id, merged, indexes, report)) subcategories.delete(subcategory.id);
  }
  for (const category of [...categories.values()]) {
    if (!decks.has(category.deck_id) && !resurrect('decks', category.deck_id, merged, indexes, report)) categories.delete(category.id);
  }
  const deckAlias = joinDuplicates(decks, (item) => [fold(item.name)], indexes.decks[2], report);
  for (const item of categories.values()) item.deck_id = deckAlias.get(item.deck_id) || item.deck_id;
  for (const card of cards.values()) card.deck_id = deckAlias.get(card.deck_id) || card.deck_id;
  const categoryAlias = joinDuplicates(categories, (item) => [item.deck_id, fold(item.name)], indexes.categories[2], report);
  for (const item of subcategories.values()) item.category_id = categoryAlias.get(item.category_id) || item.category_id;
  for (const card of cards.values()) if (card.category_id) card.category_id = categoryAlias.get(card.category_id) || card.category_id;
  const subAlias = joinDuplicates(subcategories, (item) => [item.category_id, fold(item.name)], indexes.subcategories[2], report);
  for (const card of cards.values()) if (card.subcategory_id) card.subcategory_id = subAlias.get(card.subcategory_id) || card.subcategory_id;
  for (const card of cards.values()) {
    let subcategory = subcategories.get(card.subcategory_id || '') || null;
    if (subcategory) card.category_id = subcategory.category_id;
    let category = categories.get(card.category_id || '') || null;
    if (!category || category.deck_id !== card.deck_id) {
      card.category_id = null;
      card.subcategory_id = null;
      category = null;
      subcategory = null;
    }
    if (subcategory && subcategory.category_id !== card.category_id) {
      card.subcategory_id = null;
      subcategory = null;
    }
    card.category = category ? String(category.name) : '';
    card.subcategory = subcategory ? String(subcategory.name) : '';
  }
}

function fallbackDeck(merged) {
  for (const deck of merged.decks.values()) if (fold(deck.name) === 'wiederhergestellt') return deck.id;
  const now = utcIso();
  const deck = { id: crypto.randomUUID(), name: 'Wiederhergestellt', description: '', color: '#4A90E2', created_at: now, updated_at: now };
  merged.decks.set(deck.id, deck);
  return deck.id;
}
