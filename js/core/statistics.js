// Statistics – port of app/services/statistics_service.py and the summary
// endpoint of the server (server/routes/statistics.py).

import { toMillis } from './time.js';

function dayBounds(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.getTime(), end.getTime()];
}

export function overview({ cards, events, deckId = null, now = Date.now() }) {
  const chosen = cards.filter((card) => deckId === null || card.deck_id === deckId);
  const cardIds = new Map(cards.map((card) => [card.id, card]));
  let mastered = 0;
  let due = 0;
  let points = 0;
  for (const card of chosen) {
    if (card.mastered) mastered += 1;
    else if (card.next_review && toMillis(card.next_review) <= now) due += 1;
    points += Number(card.points) || 0;
  }
  const [dayStart, dayEnd] = dayBounds(now);
  let reviewsToday = 0;
  let correctToday = 0;
  let secondsToday = 0;
  const learnedToday = new Set();
  let total = 0;
  let correctTotal = 0;
  let secondsTotal = 0;
  for (const event of events) {
    const card = cardIds.get(event.card_id);
    if (!card) continue; // events of deleted cards do not count (JOIN cards)
    if (deckId !== null && card.deck_id !== deckId) continue;
    total += 1;
    if (event.correct) correctTotal += 1;
    secondsTotal += Number(event.duration_seconds) || 0;
    const when = toMillis(event.reviewed_at);
    if (when !== null && when >= dayStart && when < dayEnd) {
      reviewsToday += 1;
      learnedToday.add(event.card_id);
      if (event.correct) correctToday += 1;
      secondsToday += Number(event.duration_seconds) || 0;
    }
  }
  return {
    total_cards: chosen.length,
    mastered_cards: mastered,
    due_cards: due,
    total_points: points,
    reviews_today: reviewsToday,
    learned_today: reviewsToday,
    cards_learned_today: learnedToday.size,
    correct_today: correctToday,
    accuracy_today: reviewsToday ? (correctToday / reviewsToday) * 100 : 0,
    learning_seconds_today: secondsToday,
    total_reviews: total,
    correct_reviews: correctTotal,
    accuracy_total: total ? (correctTotal / total) * 100 : 0,
    learning_seconds_total: secondsTotal,
  };
}

export function byLevel(cards, deckId = null) {
  const result = {};
  for (let level = 1; level <= 10; level += 1) result[String(level)] = 0;
  for (const card of cards) {
    if (deckId !== null && card.deck_id !== deckId) continue;
    result[String(card.level)] = (result[String(card.level)] || 0) + 1;
  }
  return result;
}

const byName = (a, b) => {
  const left = String(a.name).toLocaleLowerCase('de');
  const right = String(b.name).toLocaleLowerCase('de');
  return left < right ? -1 : left > right ? 1 : (a.id < b.id ? -1 : 1);
};

export function deckStatistics(decks, cards, now = Date.now()) {
  return [...decks].sort(byName).map((deck) => {
    const own = cards.filter((card) => card.deck_id === deck.id);
    const due = own.filter((card) => !card.mastered && card.next_review && toMillis(card.next_review) <= now).length;
    const mastered = own.filter((card) => card.mastered).length;
    const average = own.length ? own.reduce((sum, card) => sum + Number(card.level || 0), 0) / own.length : 0;
    return {
      deck_id: deck.id,
      deck: deck.name,
      deck_name: deck.name,
      color: deck.color,
      total_cards: own.length,
      due_cards: due,
      mastered_cards: mastered,
      average_level: average,
    };
  });
}

export function reviewActivity(events, cards, start, end, deckId = null) {
  const cardIds = new Map(cards.map((card) => [card.id, card]));
  const days = new Map();
  for (const event of events) {
    const card = cardIds.get(event.card_id);
    if (!card || (deckId !== null && card.deck_id !== deckId)) continue;
    const when = toMillis(event.reviewed_at);
    if (when === null || when < start || when >= end) continue;
    const day = String(event.reviewed_at).slice(0, 10);
    const entry = days.get(day) || { day, reviews: 0, correct: 0, cards: new Set(), duration_seconds: 0 };
    entry.reviews += 1;
    if (event.correct) entry.correct += 1;
    entry.cards.add(event.card_id);
    entry.duration_seconds += Number(event.duration_seconds) || 0;
    days.set(day, entry);
  }
  return [...days.values()]
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .map((entry) => ({ ...entry, cards: entry.cards.size }));
}

export function summary({ decks, cards, events, days = 14, now = Date.now(), deckId = null }) {
  const stop = now + 24 * 60 * 60 * 1000;
  return {
    overview: overview({ cards, events, deckId, now }),
    levels: byLevel(cards, deckId),
    decks: deckStatistics(decks, cards, now),
    activity: reviewActivity(events, cards, stop - days * 24 * 60 * 60 * 1000, stop, deckId),
  };
}
