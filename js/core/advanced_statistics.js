// Read-only advanced statistics. Periods apply to reviews, current card state
// remains independent of the period. Never changes learning points or rules.
import { dueDayEnd, toMillis } from './time.js';

const id = (value) => String(value ?? '');
const levelOf = (card) => card.mastered ? 10 : Math.max(1, Math.min(10, Number(card.level) || 1));
const percent = (count, total) => total ? count / total * 100 : 0;
const byId = (a, b) => id(a.id) < id(b.id) ? -1 : id(a.id) > id(b.id) ? 1 : 0;
const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const secondsOf = (event) => Math.max(0, Number(event.duration_seconds) || 0);

export function stageProgress(cards) {
  const total = cards.length;
  if (!total) return { current_stage: null, next_stage: null, target: null,
    progress_percent: 0, reached_cards: 0, total_cards: 0, all_mastered: false, empty: true };
  let current = 10;
  let allMastered = true;
  for (const card of cards) {
    current = Math.min(current, levelOf(card));
    allMastered = allMastered && Boolean(card.mastered);
  }
  const next = current === 10 ? null : current + 1;
  const reached = cards.filter((card) => current === 10 ? Boolean(card.mastered) : levelOf(card) >= next).length;
  return { current_stage: current, next_stage: next, target: current === 10 ? 'mastered' : 'level',
    progress_percent: percent(reached, total), reached_cards: reached, total_cards: total,
    all_mastered: allMastered, empty: false };
}

function historyOf(card) {
  let history = card.success_history || [];
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch { history = []; }
  }
  return Array.isArray(history) ? history.slice(-10).map(Boolean) : [];
}

function eventMetrics(rows) {
  let correct = 0;
  let seconds = 0;
  for (const event of rows) {
    if (event.correct) correct += 1;
    seconds += secondsOf(event);
  }
  return { total: rows.length, correct, accuracy: percent(correct, rows.length), seconds };
}

export function advanced({ cards, decks, categories = [], events, deckIds = null,
  categoryId = null, days = 30, now = new Date() }) {
  if (days !== null && (!Number.isInteger(days) || days < 1)) {
    throw new RangeError('days must be a positive integer or null');
  }
  const reference = new Date(toMillis(now));
  const today = new Date(reference);
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + 1);
  const start = days === null ? null : new Date(today);
  if (start) start.setDate(start.getDate() - days + 1);
  const selected = deckIds === null ? null : new Set(deckIds.map(id));
  const chosen = cards.filter((card) => (selected === null || selected.has(id(card.deck_id)))
    && (categoryId === null || card.category_id === id(categoryId))).sort(byId);
  const cardMap = new Map(chosen.map((card) => [id(card.id), card]));
  const ownDecks = decks.filter((deck) => selected === null || selected.has(id(deck.id)))
    .sort((a, b) => {
      const left = id(a.name).toLowerCase();
      const right = id(b.name).toLowerCase();
      return left < right ? -1 : left > right ? 1 : byId(a, b);
    });
  const deckMap = new Map(ownDecks.map((deck) => [id(deck.id), deck]));
  const categoryMap = new Map(categories.map((category) => [id(category.id), category]));
  const counts = new Map();
  const periodEvents = [];
  const todayEvents = [];
  const buckets = new Map();
  const perDeck = new Map();
  for (const event of events) {
    const cardId = id(event.card_id);
    const card = cardMap.get(cardId);
    const when = toMillis(event.reviewed_at);
    if (!card || when === null) continue;
    counts.set(cardId, (counts.get(cardId) || 0) + 1);
    if (when >= today.getTime() && when < end.getTime()) todayEvents.push(event);
    if (when >= end.getTime() || (start && when < start.getTime())) continue;
    periodEvents.push(event);
    const deckId = id(card.deck_id);
    if (!perDeck.has(deckId)) perDeck.set(deckId, []);
    perDeck.get(deckId).push(event);
    const day = dayKey(new Date(when));
    const bucket = buckets.get(day) || { day, cards: new Set(), reviews: 0, correct: 0, duration_seconds: 0 };
    bucket.cards.add(cardId);
    bucket.reviews += 1;
    if (event.correct) bucket.correct += 1;
    bucket.duration_seconds += secondsOf(event);
    buckets.set(day, bucket);
  }
  const period = eventMetrics(periodEvents);
  const todayMetrics = eventMetrics(todayEvents);
  const cutoff = dueDayEnd(reference);
  const isDue = (card) => {
    const next = toMillis(card.next_review);
    return !card.mastered && next !== null && next < cutoff;
  };
  const overview = {
    total_cards: chosen.length,
    due_cards: chosen.filter(isDue).length,
    mastered_cards: chosen.filter((card) => card.mastered).length,
    cards_learned_today: new Set(todayEvents.map((event) => id(event.card_id))).size,
    reviews_today: todayMetrics.total, correct_today: todayMetrics.correct,
    accuracy_today: todayMetrics.accuracy, learning_seconds_today: todayMetrics.seconds,
    total_reviews: period.total, correct_reviews: period.correct,
    incorrect_reviews: period.total - period.correct, accuracy_total: period.accuracy,
    learning_seconds_total: period.seconds,
  };
  const levels = [...Array.from({ length: 10 }, (_, index) => index + 1), 'mastered'].map((level) => {
    const ids = chosen.filter((card) => level === 'mastered' ? Boolean(card.mastered)
      : !card.mastered && levelOf(card) === level).map((card) => id(card.id));
    return { level, count: ids.length, card_ids: ids };
  });
  const cumulative = [...Array.from({ length: 9 }, (_, index) => index + 2), 'mastered'].map((level) => {
    const ids = chosen.filter((card) => level === 'mastered' ? Boolean(card.mastered)
      : levelOf(card) >= level).map((card) => id(card.id));
    return { level, count: ids.length, percent: percent(ids.length, chosen.length), card_ids: ids };
  });
  if (start) {
    const day = new Date(start);
    while (day <= today) {
      const key = dayKey(day);
      if (!buckets.has(key)) buckets.set(key, { day: key, cards: new Set(), reviews: 0, correct: 0, duration_seconds: 0 });
      day.setDate(day.getDate() + 1);
    }
  }
  const activity = [...buckets.values()].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0)
    .map((bucket) => ({ ...bucket, cards: bucket.cards.size, incorrect: bucket.reviews - bucket.correct,
      accuracy: percent(bucket.correct, bucket.reviews) }));
  const deckCards = new Map();
  for (const card of chosen) {
    const key = id(card.deck_id);
    if (!deckCards.has(key)) deckCards.set(key, []);
    deckCards.get(key).push(card);
  }
  const deckRows = ownDecks.map((deck) => {
    const deckId = id(deck.id);
    const own = deckCards.get(deckId) || [];
    const metrics = eventMetrics(perDeck.get(deckId) || []);
    return { deck_id: deckId, deck_name: id(deck.name), color: deck.color || '#4A90E2',
      total_cards: own.length, due_cards: own.filter(isDue).length,
      mastered_cards: own.filter((card) => card.mastered).length,
      average_level: own.length ? own.reduce((sum, card) => sum + levelOf(card), 0) / own.length : 0,
      accuracy: metrics.accuracy, learning_seconds: metrics.seconds, card_ids: own.map((card) => id(card.id)) };
  });
  const problems = [];
  for (const card of chosen) {
    if (card.mastered) continue;
    const history = historyOf(card);
    const errors = Math.max(0, Number(card.total_incorrect_count) || 0);
    const recovery = Boolean(card.recovery_mode);
    const ratio = history.length ? history.filter((value) => !value).length / history.length : 0;
    // A low level alone does not make a new or consistently correct card a problem.
    if (!errors && !ratio && !recovery) continue;
    const cardId = id(card.id);
    const reviews = Math.max(counts.get(cardId) || 0, history.length);
    const level = levelOf(card);
    const score = 2 * errors + 40 * ratio + 15 * Number(recovery) + Math.min(reviews, 20) * (10 - level) / 10;
    const deckId = id(card.deck_id);
    problems.push({ card_id: cardId, question: id(card.question), deck_id: deckId,
      deck_name: id(deckMap.get(deckId)?.name), category_id: card.category_id ?? null,
      category_name: id(categoryMap.get(id(card.category_id))?.name ?? card.category ?? ''),
      level, total_incorrect_count: errors, accuracy: history.length ? (1 - ratio) * 100 : null,
      recovery, score });
  }
  problems.sort((a, b) => b.score - a.score || (a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0));
  return { overview, stage: stageProgress(chosen), levels, cumulative, activity,
    decks: deckRows, problems, card_ids: [...cardMap.keys()] };
}
