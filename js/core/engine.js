// The learning engine – an exact port of app/services/learning_engine.py.
//
// The PWA works without a server in OneDrive mode, so points, levels,
// mastery, recovery and due dates are computed here.  This module is the
// ONLY place in the JavaScript code with those formulas; every function
// mirrors its Python counterpart line by line, and
// tests/test_engine_parity.py checks both implementations against each other
// (exhaustively for the point formulas, plus long random review sequences).

import { addDays, pythonUtc, toMillis, utcIso } from './time.js';

export const MASTERED_POINTS = 351;

// Inclusive lower bounds for each level.
export const LEVEL_BOUNDS = [
  [0, 1], [11, 2], [26, 3], [46, 4], [71, 5],
  [101, 6], [136, 7], [176, 8], [221, 9], [271, 10],
];

export const LEVEL_FACTORS = {
  1: 1.0, 2: 1.25, 3: 1.5, 4: 1.75, 5: 2.0, 6: 2.25, 7: 2.5, 8: 2.75, 9: 3.0, 10: 4.0,
};

const int = (value) => Math.trunc(Number(value) || 0);

export function levelForPoints(points) {
  const value = Math.max(0, int(points));
  let level = 1;
  for (const [lower, candidate] of LEVEL_BOUNDS) {
    if (value < lower) break;
    level = candidate;
  }
  return level;
}

export function normalIntervalDays(level) {
  return Math.min(10, Math.max(1, int(level)));
}

export function successRate(history) {
  if (!history.length) return 0.0;
  return (history.filter(Boolean).length / history.length) * 100.0;
}

export function performanceMultiplier(rate) {
  const r = Number(rate);
  if (r <= 0) return 0.0;
  if (r <= 50) return (r / 50.0) ** 2;
  if (r <= 85) return 1.0 + ((r - 50.0) / 35.0) ** 1.5;
  return 2.0 + ((r - 85.0) / 15.0) ** 1.2;
}

export function streakBonus(streak) {
  const value = int(streak);
  if (value >= 20) return 3.0;
  if (value >= 15) return 2.5;
  if (value >= 10) return 2.0;
  if (value >= 5) return 1.5;
  return 1.0;
}

export function positiveGain(positiveStreak, history) {
  const raw = int(positiveStreak) * performanceMultiplier(successRate(history)) * streakBonus(positiveStreak);
  return Math.max(1, Math.trunc(raw));
}

export function brokenStreakFactor(brokenStreak) {
  const value = int(brokenStreak);
  if (value < 5) return 1.0;
  if (value < 10) return 1.5;
  if (value < 15) return 2.0;
  if (value < 20) return 3.0;
  return 4.0;
}

export function lifetimeErrorFactor(totalIncorrect) {
  const value = int(totalIncorrect);
  if (value >= 31) return 5.0;
  if (value >= 28) return 4.0;
  if (value >= 25) return 3.0;
  if (value >= 20) return 2.0;
  if (value >= 11) return 1.5;
  return 1.0;
}

export function negativePenalty(consecutive, level, brokenStreak, totalIncorrect, wasMastered = false) {
  const levelFactor = wasMastered ? 4.0 : LEVEL_FACTORS[Math.min(10, Math.max(1, int(level)))];
  return Math.trunc(int(consecutive) * levelFactor * brokenStreakFactor(brokenStreak) * lifetimeErrorFactor(totalIncorrect));
}

export function trimHistory(values) {
  return [...(values || [])].map(Boolean).slice(-10);
}

/** The normalisation Card.__post_init__ applies to every card. */
export function normalizeCard(card) {
  const result = { ...card };
  result.points = Math.max(0, int(result.points));
  result.level = Math.min(10, Math.max(1, int(result.level) || 1));
  result.mastered = Boolean(result.mastered);
  if (result.mastered || result.points >= MASTERED_POINTS) {
    result.points = MASTERED_POINTS;
    result.level = 10;
    result.mastered = true;
  }
  result.positive_streak = Math.max(0, int(result.positive_streak));
  result.negative_streak = Math.max(0, int(result.negative_streak));
  result.success_history = trimHistory(result.success_history);
  result.total_incorrect_count = Math.max(0, int(result.total_incorrect_count));
  result.consecutive_incorrect_attempts = Math.max(0, int(result.consecutive_incorrect_attempts));
  if (result.mastered) result.next_review = null;
  result.recovery_mode = Boolean(result.recovery_mode);
  result.recovery_interval = Math.max(1, int(result.recovery_interval) || 1);
  return result;
}

function randint(start, end) {
  return start + Math.floor(Math.random() * (end - start + 1));
}

/**
 * Correct answer.  `now` is a millisecond timestamp.  Returns
 * `{card, correct, points_change, retry_after_cards, immediate_retry}`.
 */
export function processCorrect(card, now = Date.now(), { immediateRetry = false } = {}) {
  const reviewed = now;
  const reviewedText = utcIso(reviewed);
  const history = trimHistory([...(card.success_history || []), true]);

  if (immediateRetry) {
    // An immediate retry confirms recall but grants no points and keeps the
    // just-created recovery state.
    const updated = normalizeCard({
      ...card,
      success_history: history,
      last_reviewed: reviewedText,
      next_review: utcIso(addDays(reviewed, Math.max(1, int(card.recovery_interval)))),
      recovery_mode: true,
      updated_at: reviewedText,
    });
    return { card: updated, correct: true, points_change: 0, retry_after_cards: null, immediate_retry: true };
  }

  const newStreak = int(card.positive_streak) + 1;
  const gain = positiveGain(newStreak, history);
  const newPoints = Math.min(MASTERED_POINTS, int(card.points) + gain);
  const newLevel = levelForPoints(newPoints);
  const mastered = newPoints >= MASTERED_POINTS;

  let recoveryMode = Boolean(card.recovery_mode);
  let recoveryInterval = Math.max(1, int(card.recovery_interval));
  let nextReview;
  if (mastered) {
    recoveryMode = false;
    nextReview = null;
  } else if (recoveryMode) {
    const normal = normalIntervalDays(newLevel);
    recoveryInterval = Math.min(recoveryInterval * 2, normal);
    recoveryMode = recoveryInterval < normal;
    nextReview = utcIso(addDays(reviewed, recoveryInterval));
  } else {
    nextReview = utcIso(addDays(reviewed, normalIntervalDays(newLevel)));
  }

  const updated = normalizeCard({
    ...card,
    points: newPoints,
    level: newLevel,
    mastered,
    positive_streak: newStreak,
    negative_streak: 0,
    success_history: history,
    consecutive_incorrect_attempts: 0,
    last_reviewed: reviewedText,
    next_review: nextReview,
    recovery_mode: recoveryMode,
    recovery_interval: recoveryInterval,
    updated_at: reviewedText,
  });
  return { card: updated, correct: true, points_change: updated.points - int(card.points), retry_after_cards: null, immediate_retry: false };
}

export function processIncorrect(card, now = Date.now(), { random = randint } = {}) {
  const reviewedText = utcIso(now);
  const brokenStreak = int(card.positive_streak);
  const newTotal = int(card.total_incorrect_count) + 1;
  const newConsecutive = int(card.consecutive_incorrect_attempts) + 1;
  const penalty = negativePenalty(newConsecutive, card.level, brokenStreak, newTotal, Boolean(card.mastered));
  const newPoints = Math.max(0, int(card.points) - penalty);
  const updated = normalizeCard({
    ...card,
    points: newPoints,
    level: levelForPoints(newPoints),
    mastered: false,
    positive_streak: 0,
    negative_streak: int(card.negative_streak) + 1,
    success_history: trimHistory([...(card.success_history || []), false]),
    total_incorrect_count: newTotal,
    consecutive_incorrect_attempts: newConsecutive,
    last_reviewed: reviewedText,
    next_review: reviewedText,
    recovery_mode: true,
    recovery_interval: 1,
    updated_at: reviewedText,
  });
  return {
    card: updated,
    correct: false,
    points_change: updated.points - int(card.points),
    retry_after_cards: random(3, 5),
    immediate_retry: false,
  };
}

/**
 * The review event service's rule for the effective review time: the
 * device's time, never in the future, never before the card's last review.
 */
export function effectiveTime(reviewedAt, card, now = Date.now()) {
  let candidate = toMillis(reviewedAt);
  if (candidate === null) candidate = now;
  if (candidate > now) candidate = now;
  const last = toMillis(card.last_reviewed);
  if (last !== null && candidate < last) candidate = last;
  return candidate;
}

/** Same JSON as CardService._learning_state_json (sorted keys, no spaces). */
export function learningStateJson(card) {
  const state = {
    consecutive_incorrect_attempts: int(card.consecutive_incorrect_attempts),
    last_reviewed: pythonUtc(card.last_reviewed),
    level: int(card.level),
    mastered: Boolean(card.mastered),
    negative_streak: int(card.negative_streak),
    next_review: pythonUtc(card.next_review),
    points: int(card.points),
    positive_streak: int(card.positive_streak),
    recovery_interval: int(card.recovery_interval),
    recovery_mode: Boolean(card.recovery_mode),
    success_history: trimHistory(card.success_history),
    total_incorrect_count: int(card.total_incorrect_count),
    updated_at: pythonUtc(card.updated_at),
  };
  return JSON.stringify(state);
}

export function applyLearningState(card, state) {
  return normalizeCard({
    ...card,
    points: state.points,
    level: state.level,
    mastered: state.mastered,
    positive_streak: state.positive_streak,
    negative_streak: state.negative_streak,
    success_history: state.success_history,
    total_incorrect_count: state.total_incorrect_count,
    consecutive_incorrect_attempts: state.consecutive_incorrect_attempts,
    last_reviewed: state.last_reviewed || null,
    next_review: state.next_review || null,
    recovery_mode: state.recovery_mode,
    recovery_interval: state.recovery_interval,
    updated_at: state.updated_at || utcIso(),
  });
}

export function levelRanges() {
  return LEVEL_BOUNDS.map(([lower, level], index) => ({
    level,
    min_points: lower,
    max_points: index + 1 < LEVEL_BOUNDS.length ? LEVEL_BOUNDS[index + 1][0] - 1 : MASTERED_POINTS - 1,
    review_days: normalIntervalDays(level),
  }));
}
