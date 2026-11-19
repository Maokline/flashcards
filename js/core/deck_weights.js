// Weighted multi-deck sessions – port of app/services/deck_weights.py.
//
// A session over several decks may give every deck a share in percent.  This
// module decides HOW MANY cards each deck contributes; which cards are
// eligible stays with the existing filters, the order of the session with
// orderSessionCards().  Everything is integer arithmetic, so the desktop
// returns exactly the same numbers (same vectors: tests/deck_weight_vectors.json).
//
// Ties (equal remainders) go to the deck that comes first in `order`; both
// apps build that order with tieOrder() (deck name, then ID, by UTF-16 code
// units), so identical inputs give identical sessions.

import { DEFAULT_ORDER, orderSessionCards } from './selection.js';

export const TOTAL_PERCENT = 100;
export const DOCUMENT_VERSION = 1;
// The newest combinations are kept; older ones are dropped when saving.
export const MAX_COMBINATIONS = 60;
const MAX_DECKS_PER_COMBINATION = 2000;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (order) => [...new Set([...(order || [])].map(String))];
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const whole = (value) => (typeof value === 'number' && Number.isInteger(value) ? value : null);

/** A non-negative whole number from a record (missing or invalid = 0). */
function share(weights, deckId) {
  const value = whole(isRecord(weights) ? weights[deckId] : 0);
  return value === null ? 0 : Math.max(0, value);
}

/** Deck IDs in the order that settles ties: by name, then by ID. */
export function tieOrder(decks) {
  const names = new Map();
  for (const deck of decks || []) {
    const [id, name] = Array.isArray(deck) ? deck : [deck.id, deck.name];
    names.set(String(id), String(name));
  }
  return [...names.keys()].sort((a, b) => compare(names.get(a), names.get(b)) || compare(a, b));
}

/** The canonical form of a deck combination: unique IDs, sorted. */
export function combinationIds(deckIds) {
  return unique(deckIds).sort(compare);
}

/**
 * Split `total` units by `weights` (largest-remainder method).  Every ID of
 * `order` gets an entry.  The quota of a deck is total × weight / sum; its
 * whole part is assigned first, the units left over go to the largest
 * fractional parts, ties to the earlier deck.  Weight 0 never receives a unit.
 */
export function apportion(total, weights, order) {
  const ids = unique(order);
  const result = Object.fromEntries(ids.map((id) => [id, 0]));
  const amount = Math.max(0, Math.trunc(Number(total)) || 0);
  const shares = ids.map((id) => share(weights, id));
  const weightSum = shares.reduce((sum, value) => sum + value, 0);
  if (!amount || !weightSum) return result;
  const remainders = [];
  let assigned = 0;
  ids.forEach((id, index) => {
    const product = amount * shares[index];
    const remainder = product % weightSum;
    result[id] = (product - remainder) / weightSum;
    assigned += result[id];
    remainders.push([remainder, index]);
  });
  remainders.sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]));
  for (const [, index] of remainders.slice(0, amount - assigned)) result[ids[index]] += 1;
  return result;
}

/** Shares as even as possible: 50/50, 34/33/33, 25/25/25/25. */
export function equalWeights(order) {
  const ids = unique(order);
  return apportion(TOTAL_PERCENT, Object.fromEntries(ids.map((id) => [id, 1])), ids);
}

/** Exactly the decks of `order`, whole shares 0…100, sum exactly 100. */
export function isValid(weights, order) {
  const ids = unique(order);
  if (!ids.length || !isRecord(weights)) return false;
  if (Object.keys(weights).length !== ids.length) return false;
  let total = 0;
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(weights, id)) return false;
    const value = whole(weights[id]);
    if (value === null || value < 0 || value > TOTAL_PERCENT) return false;
    total += value;
  }
  return total === TOTAL_PERCENT;
}

/** A typed share as whole percent, null while it is not a number. */
export function clampPercent(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  let number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    number = Math.trunc(value);
  } else {
    const text = String(value).trim();
    if (!/^[0-9]+$/.test(text)) return null;
    const digits = text.replace(/^0+/, '');
    number = digits.length > 3 ? TOTAL_PERCENT : Number(digits || '0');
  }
  return Math.max(0, Math.min(TOTAL_PERCENT, number));
}

/**
 * Set one deck to `value` percent; the other decks make up the rest.
 *
 * What was set by hand stays: `kept` names the decks whose share the user
 * chose before, oldest first.  They keep their share as long as the rest
 * allows it – if it does not, the deck set longest ago gives way first.
 *
 * The remaining decks follow automatically.  They split what is left in the
 * proportions of `basis` (the shares before the editing began; by default
 * `weights`): a deck at 0 there stays at 0, and if all of them are at 0 the
 * rest is spread evenly.  If no deck is left to follow, the deck set longest
 * ago takes the rest.
 *
 * The result always sums to 100.  Without `kept` all other decks simply keep
 * their proportions.
 */
export function rebalance(weights, order, changed, value, kept = [], basis = null) {
  const ids = unique(order);
  const target = String(changed);
  if (!ids.includes(target)) return fitWeights(weights, ids);
  const others = ids.filter((id) => id !== target);
  if (!others.length) return { [target]: TOTAL_PERCENT };
  const own = Math.max(0, Math.min(TOTAL_PERCENT, Math.trunc(Number(value)) || 0));
  let left = TOTAL_PERCENT - own;
  const result = { [target]: own };
  const pinned = unique(kept).filter((id) => others.includes(id));
  for (const id of [...pinned].reverse()) { // the newest choice is honoured first
    result[id] = Math.min(share(weights, id), left);
    left -= result[id];
  }
  const free = others.filter((id) => !pinned.includes(id));
  if (free.length) {
    const source = isRecord(basis) ? basis : weights;
    let base = Object.fromEntries(free.map((id) => [id, share(source, id)]));
    if (!free.some((id) => base[id] > 0)) base = Object.fromEntries(free.map((id) => [id, 1]));
    Object.assign(result, apportion(left, base, free));
  } else if (left > 0) {
    const growing = pinned.find((id) => result[id] > 0);
    if (growing !== undefined) result[growing] += left;
    else Object.assign(result, apportion(left, Object.fromEntries(others.map((id) => [id, 1])), others));
  }
  return Object.fromEntries(ids.map((id) => [id, result[id]]));
}

const hasOwn = (record, key) => Object.prototype.hasOwnProperty.call(record, key);

/** The hand-set decks a change had to move (see rebalance), oldest first. */
export function gaveWay(kept, changed, before, after) {
  const target = String(changed);
  const now = isRecord(after) ? after : {};
  return unique(kept).filter((id) => id !== target && hasOwn(now, id) && share(before, id) !== share(now, id));
}

/**
 * The hand-set decks once `changed` was set, oldest first.  `changed` is the
 * newest of them.  A deck that had to give way no longer has the share the
 * user chose: it follows automatically again.
 */
export function keptAfter(kept, changed, before, after) {
  const target = String(changed);
  const now = isRecord(after) ? after : {};
  const moved = gaveWay(kept, target, before, now);
  return [...unique(kept).filter((id) => id !== target && hasOwn(now, id) && !moved.includes(id)), target];
}

/**
 * Carry shares over to a changed deck selection.  Removed decks disappear and
 * the remaining shares are scaled back to 100 (50/30/20 without the last deck
 * → 63/37).  A deck that was not part of `previous` gets the even share of
 * the new selection; the known decks split the rest by their old proportions.
 */
export function fitWeights(previous, order) {
  const ids = unique(order);
  if (!ids.length) return {};
  if (ids.length === 1) return { [ids[0]]: TOTAL_PERCENT };
  const has = (id) => isRecord(previous) && Object.prototype.hasOwnProperty.call(previous, id);
  const known = ids.filter(has);
  if (!known.length) return equalWeights(ids);
  const even = equalWeights(ids);
  const result = {};
  let rest = TOTAL_PERCENT;
  for (const id of ids) {
    if (!has(id)) {
      result[id] = even[id];
      rest -= even[id];
    }
  }
  let basis = Object.fromEntries(known.map((id) => [id, share(previous, id)]));
  if (!known.some((id) => basis[id] > 0)) basis = Object.fromEntries(known.map((id) => [id, 1]));
  Object.assign(result, apportion(rest, basis, known));
  return Object.fromEntries(ids.map((id) => [id, result[id]]));
}

/** Wanted cards per deck: size × share / 100, rounded to whole cards. */
export function allocate(size, weights, order) {
  return apportion(size, weights, order);
}

/**
 * Cards per deck when a deck may have fewer eligible cards than wanted.
 *
 * 1. Every deck gives its wanted cards (allocate) as far as it has them –
 *    never more than `available`.
 * 2. The places that stay open go to the decks that still have cards, by
 *    their relative shares (again by largest remainder); a deck that runs out
 *    on the way passes the rest on.
 *
 * So a deck with enough cards never gets fewer than it asked for, and the
 * session has min(size, eligible) cards.  A deck at 0 % gives no cards.
 */
export function distribute(size, weights, available, order) {
  const ids = unique(order);
  const requested = Math.max(0, Math.trunc(Number(size)) || 0);
  const desired = apportion(requested, weights, ids);
  const shares = Object.fromEntries(ids.map((id) => [id, share(weights, id)]));
  const caps = Object.fromEntries(ids.map((id) => [id, share(available, id)]));
  const eligible = ids.reduce((sum, id) => sum + (shares[id] > 0 ? caps[id] : 0), 0);
  const actual = Object.fromEntries(ids.map((id) => [id, Math.min(desired[id], caps[id])]));
  let openPlaces = Math.min(requested, eligible) - ids.reduce((sum, id) => sum + actual[id], 0);
  let active = ids.filter((id) => shares[id] > 0 && caps[id] > actual[id]);
  while (active.length && openPlaces > 0) {
    const part = apportion(openPlaces, Object.fromEntries(active.map((id) => [id, shares[id]])), active);
    const full = active.filter((id) => part[id] > caps[id] - actual[id]);
    if (!full.length) {
      for (const id of active) actual[id] += part[id];
      break;
    }
    for (const id of full) {
      openPlaces -= caps[id] - actual[id];
      actual[id] = caps[id];
    }
    active = active.filter((id) => !full.includes(id));
  }
  return {
    requested,
    desired,
    actual,
    available: caps,
    total: ids.reduce((sum, id) => sum + actual[id], 0),
    eligible,
  };
}

/**
 * Walk the cards in their order and take each deck's first `counts` cards.
 * The result keeps the given order; a card ID is taken at most once.
 */
export function takeByQuota(orderedCards, counts, deckOf = (card) => card.deck_id) {
  const left = new Map(Object.keys(counts || {}).map((id) => [id, share(counts, id)]));
  const chosen = [];
  const seen = new Set();
  for (const card of orderedCards) {
    const deckId = String(deckOf(card));
    if (!(left.get(deckId) > 0)) continue;
    const cardId = String(card.id);
    if (seen.has(cardId)) continue;
    seen.add(cardId);
    left.set(deckId, left.get(deckId) - 1);
    chosen.push(card);
  }
  return chosen;
}

/**
 * The cards of a weighted session and its distribution.  `candidates` are the
 * eligible cards (all filters applied, no limit).  They are arranged by the
 * existing session order; each deck then keeps its first cards up to its
 * count.  `size` null means all candidates.
 */
export function selectWeightedSession(candidates, {
  size = null, weights, deckOrder, mode = DEFAULT_ORDER, seed = 0, now = Date.now(),
} = {}) {
  const byId = new Map();
  for (const card of candidates) byId.set(card.id, card);
  const ordered = orderSessionCards([...byId.values()], mode, { seed, now });
  const available = {};
  for (const card of ordered) available[card.deck_id] = (available[card.deck_id] || 0) + 1;
  const wanted = size === null || size === undefined ? ordered.length : Number(size);
  const plan = distribute(wanted, weights, available, deckOrder);
  return { cards: takeByQuota(ordered, plan.actual), plan };
}

// -- stored shares --------------------------------------------------------------
export function emptyDocument() {
  return { version: DOCUMENT_VERSION, combinations: [] };
}

function validEntry(entry) {
  if (!isRecord(entry) || !isRecord(entry.weights)) return null;
  const keys = Object.keys(entry.weights);
  if (keys.length < 2 || keys.length > MAX_DECKS_PER_COMBINATION || keys.some((id) => !id)) return null;
  const ids = combinationIds(keys);
  if (!isValid(entry.weights, ids)) return null;
  return {
    weights: Object.fromEntries(ids.map((id) => [id, entry.weights[id]])),
    updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : '',
  };
}

function compareKeys(a, b) {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const result = compare(a[index], b[index]);
    if (result) return result;
  }
  return a.length - b.length;
}

function entryMap(document) {
  const entries = new Map();
  const raw = isRecord(document) ? document.combinations : null;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const entry = validEntry(item);
      if (!entry) continue;
      const key = JSON.stringify(Object.keys(entry.weights));
      const known = entries.get(key);
      if (!known || entry.updated_at >= known.updated_at) entries.set(key, entry);
    }
  }
  return entries;
}

const sortedEntries = (entries) => [...entries.values()]
  .sort((a, b) => compareKeys(Object.keys(a.weights), Object.keys(b.weights)));

/**
 * A readable document from anything stored; invalid entries are dropped.
 * Reading never fails: a missing, damaged or foreign file simply means that
 * no shares are stored yet.  For one combination the newest entry wins.
 */
export function normalizeDocument(value) {
  return { version: DOCUMENT_VERSION, combinations: sortedEntries(entryMap(value)) };
}

/** The stored shares of exactly this deck combination (order is irrelevant). */
export function findWeights(document, deckIds) {
  const ids = combinationIds(deckIds);
  if (ids.length < 2 || !isRecord(document) || !Array.isArray(document.combinations)) return null;
  for (const entry of document.combinations) {
    const weights = isRecord(entry) ? entry.weights : null;
    if (isRecord(weights) && isValid(weights, ids)) return Object.fromEntries(ids.map((id) => [id, weights[id]]));
  }
  return null;
}

/**
 * The document with these shares stored for their deck combination.
 * Combinations of decks that no longer exist are removed, and only the
 * MAX_COMBINATIONS most recently used ones are kept.
 */
export function withCombination(document, weights, updatedAt, { existingDeckIds = null } = {}) {
  const entry = validEntry({ weights, updated_at: String(updatedAt) });
  if (!entry) throw new Error('invalid deck weights');
  const key = JSON.stringify(Object.keys(entry.weights));
  const entries = entryMap(document);
  entries.set(key, entry);
  if (existingDeckIds !== null && existingDeckIds !== undefined) {
    const existing = new Set([...existingDeckIds].map(String));
    for (const [other, item] of [...entries]) {
      if (other !== key && !Object.keys(item.weights).every((id) => existing.has(id))) entries.delete(other);
    }
  }
  if (entries.size > MAX_COMBINATIONS) {
    // Oldest first (by timestamp text, then by combination); keep the tail.
    const others = [...entries].filter(([other]) => other !== key)
      .sort(([, a], [, b]) => compare(a.updated_at, b.updated_at) || compareKeys(Object.keys(a.weights), Object.keys(b.weights)));
    for (const [other] of others.slice(0, others.length - (MAX_COMBINATIONS - 1))) entries.delete(other);
  }
  return { version: DOCUMENT_VERSION, combinations: sortedEntries(entries) };
}
