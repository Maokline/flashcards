// Per-deck review intervals – an exact port of app/services/review_intervals.py.
//
//   regular(L) = min(base(L, model) × multiplier, maximum)
//   linear       base(L) = L days
//   progressive  base(L) = L^1.3 days
//   exponential  base(L) = 1.5^(L-1) days   (1.5 is fixed, not the multiplier)
//
// Integer arithmetic only (formula table in milliseconds, multiplier in
// percent, product rounded half up to whole seconds), so the phone and the
// desktop compute identical due dates.  tests/test_deck_interval_parity.py
// compares both implementations.  Linear × 1 is the original rule
// (level × 24 h).

import { addSecondsToText, pythonUtc, reviewIsDue, toMillis } from './time.js';

export const SECONDS_PER_DAY = 86400;
export const INTERVAL_MODELS = ['linear', 'progressive', 'exponential'];
export const MODEL_LABELS = { linear: 'Linear', progressive: 'Sanft progressiv', exponential: 'Exponentiell' };
export const MODEL_DESCRIPTIONS = {
  linear: 'Gleichmäßig steigende Wiederholungsabstände.',
  progressive: 'Bei höheren Leveln deutlich längere Abstände.',
  exponential: 'Besonders lange Wiederholungsabstände auf hohen Leveln.',
};
export const MODEL_FORMULAS = { linear: 'L Tage', progressive: 'L^1,3 Tage', exponential: '1,5^(L−1) Tage' };
export const MULTIPLIER_CHOICES = [100, 150, 200, 250, 300];
export const MAX_DAY_CHOICES = [30, 60, 90, 180, 365];
export const DEFAULT_SETTINGS = Object.freeze({ model: 'linear', multiplier_pct: 100, max_days: 180 });
export const INTERVAL_FIELDS = ['interval_model', 'interval_multiplier_pct', 'interval_max_days'];

// floor(formula × 86 400 000 + 0.5) ms for L = 1 … 10 (identical to the Python table).
export const BASE_INTERVAL_MS = {
  linear: [86400000, 172800000, 259200000, 345600000, 432000000, 518400000, 604800000, 691200000, 777600000, 864000000],
  progressive: [86400000, 212741755, 360388873, 523831645, 700123650, 887381495, 1084279369, 1289824808, 1503242358, 1723906640],
  exponential: [86400000, 129600000, 194400000, 291600000, 437400000, 656100000, 984150000, 1476225000, 2214337500, 3321506250],
};

export const SKIP_REASONS = {
  mastered: 'gekonnt – keine automatische Wiederholung',
  recovery: 'in Recovery – die Recovery-Regel bleibt',
  new: 'noch nie bewertet',
  no_history: 'keine passende letzte Bewertung (z. B. zurückgesetzt oder manuell geändert)',
  invalid_time: 'keine gültige Zeitangabe',
};
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function wholeNumber(value) {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value.trim());
  return null;
}

/** Strict: user input must be one of the offered choices (null = default). */
export function parseSettings({ model = null, multiplier_pct: pct = null, max_days: days = null } = {}) {
  const cleanModel = model === null || model === undefined ? DEFAULT_SETTINGS.model : String(model);
  const cleanPct = pct === null || pct === undefined ? DEFAULT_SETTINGS.multiplier_pct : wholeNumber(pct);
  const cleanDays = days === null || days === undefined ? DEFAULT_SETTINGS.max_days : wholeNumber(days);
  if (!INTERVAL_MODELS.includes(cleanModel)) throw new RangeError(`unknown interval model: ${cleanModel}`);
  if (!MULTIPLIER_CHOICES.includes(cleanPct)) throw new RangeError(`unsupported interval multiplier: ${pct}`);
  if (!MAX_DAY_CHOICES.includes(cleanDays)) throw new RangeError(`unsupported maximum interval: ${days}`);
  return { model: cleanModel, multiplier_pct: cleanPct, max_days: cleanDays };
}

/** Lenient: a deck of an older data set (no fields) keeps the default. */
export function settingsOf(deck) {
  if (!deck) return { ...DEFAULT_SETTINGS };
  const model = deck.interval_model;
  const pct = wholeNumber(deck.interval_multiplier_pct);
  const days = wholeNumber(deck.interval_max_days);
  return {
    model: INTERVAL_MODELS.includes(model) ? model : DEFAULT_SETTINGS.model,
    multiplier_pct: MULTIPLIER_CHOICES.includes(pct) ? pct : DEFAULT_SETTINGS.multiplier_pct,
    max_days: MAX_DAY_CHOICES.includes(days) ? days : DEFAULT_SETTINGS.max_days,
  };
}

export function sameSettings(a, b) {
  return a.model === b.model && a.multiplier_pct === b.multiplier_pct && a.max_days === b.max_days;
}

export function isDefault(settings) {
  return sameSettings(settings, DEFAULT_SETTINGS);
}

/** Deck fields for snapshots: only values that differ from the default. */
export function snapshotFields(settings) {
  const result = {};
  if (settings.model !== DEFAULT_SETTINGS.model) result.interval_model = settings.model;
  if (settings.multiplier_pct !== DEFAULT_SETTINGS.multiplier_pct) result.interval_multiplier_pct = settings.multiplier_pct;
  if (settings.max_days !== DEFAULT_SETTINGS.max_days) result.interval_max_days = settings.max_days;
  return result;
}

/** Deck fields of the API (all three, like serialize_deck). */
export function apiFields(settings) {
  return { interval_model: settings.model, interval_multiplier_pct: settings.multiplier_pct, interval_max_days: settings.max_days };
}

// -- intervals ---------------------------------------------------------------------
const clampLevel = (level) => Math.min(10, Math.max(1, Math.trunc(Number(level) || 1)));

export function baseIntervalMs(level, model = 'linear') {
  return BASE_INTERVAL_MS[model][clampLevel(level) - 1];
}

export function uncappedIntervalSeconds(level, settings = DEFAULT_SETTINGS) {
  const chosen = settings || DEFAULT_SETTINGS;
  // ≤ 3.4e9 ms × 300 stays far below 2^53: exact in doubles.
  return Math.floor((baseIntervalMs(level, chosen.model) * chosen.multiplier_pct + 50000) / 100000);
}

export function regularIntervalSeconds(level, settings = DEFAULT_SETTINGS) {
  const chosen = settings || DEFAULT_SETTINGS;
  return Math.min(uncappedIntervalSeconds(level, chosen), chosen.max_days * SECONDS_PER_DAY);
}

export function intervalIsCapped(level, settings = DEFAULT_SETTINGS) {
  const chosen = settings || DEFAULT_SETTINGS;
  return uncappedIntervalSeconds(level, chosen) > chosen.max_days * SECONDS_PER_DAY;
}

// -- display -------------------------------------------------------------------------
function hundredths(value) {
  const whole = Math.floor(value / 100);
  const fraction = value % 100;
  if (!fraction) return String(whole);
  return `${whole},${String(fraction).padStart(2, '0').replace(/0+$/, '')}`;
}

export function formatMultiplier(pct) {
  return `${hundredths(pct)}×`;
}

/** "1 Tag", "1,5 Tage", "2,46 Tage" – days with up to two decimals. */
export function formatInterval(seconds) {
  const value = Math.floor((Math.trunc(seconds) * 100 + SECONDS_PER_DAY / 2) / SECONDS_PER_DAY);
  return `${hundredths(value)} ${value === 100 ? 'Tag' : 'Tage'}`;
}

/** Whole days and hours, e.g. "1 T 12 Std" (rounded to the hour). */
export function formatDaysHours(seconds) {
  const hours = Math.floor((Math.trunc(seconds) + 1800) / 3600);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  if (!rest) return `${days} T`;
  return days ? `${days} T ${rest} Std` : `${rest} Std`;
}

export function summary(settings) {
  return `${MODEL_LABELS[settings.model]} · ${formatMultiplier(settings.multiplier_pct)} · max. ${settings.max_days} Tage`;
}

export function preview(settings = DEFAULT_SETTINGS) {
  const rows = [];
  for (let level = 1; level <= 10; level += 1) {
    const seconds = regularIntervalSeconds(level, settings);
    rows.push({
      level,
      seconds,
      uncapped_seconds: uncappedIntervalSeconds(level, settings),
      capped: intervalIsCapped(level, settings),
      text: formatInterval(seconds),
      detail: formatDaysHours(seconds),
    });
  }
  return rows;
}

// -- recalculation of existing due dates -------------------------------------------------
function sameInstant(text, value) {
  const a = toMillis(text);
  const b = toMillis(value);
  return a !== null && b !== null && a === b;
}

/** Python's last_regular_review_matches (see review_intervals.py). */
export function lastRegularReviewMatches(card, event) {
  if (!event || !event.correct || event.immediate_retry) return false;
  if (!sameInstant(event.reviewed_at, card.last_reviewed)) return false;
  let after;
  try {
    after = JSON.parse(String(event.after_state_json || ''));
  } catch {
    return false;
  }
  if (!after || typeof after !== 'object' || Array.isArray(after)) return false;
  const level = Number(after.level);
  return Number.isInteger(level) && level === Number(card.level) && !after.mastered && !after.recovery_mode;
}

/** The newest review event of each card (largest ID), like MAX(id) in SQLite. */
export function lastEvents(events, cardIds) {
  const wanted = new Set(cardIds);
  const latest = new Map();
  for (const event of events) {
    if (!wanted.has(event.card_id)) continue;
    const known = latest.get(event.card_id);
    if (!known || Number(event.id) > Number(known.id)) latest.set(event.card_id, event);
  }
  return latest;
}

/**
 * Preview new due dates for a deck's cards: last regular review + regular
 * interval of the card's level.  The current time is never the start.
 */
export function planReschedule(deckId, cards, latest, settings, now = Date.now()) {
  const moment = toMillis(now);
  const changes = [];
  const skipped = Object.fromEntries(Object.keys(SKIP_REASONS).map((key) => [key, 0]));
  let unchanged = 0;
  const sorted = [...cards].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const card of sorted) {
    const last = toMillis(card.last_reviewed);
    const next = toMillis(card.next_review);
    if (card.mastered) { skipped.mastered += 1; continue; }
    if (card.recovery_mode) { skipped.recovery += 1; continue; }
    if (last === null) { skipped.new += 1; continue; }
    if (next === null || last > moment + FUTURE_TOLERANCE_MS) { skipped.invalid_time += 1; continue; }
    if (!lastRegularReviewMatches(card, latest.get(card.id))) { skipped.no_history += 1; continue; }
    const seconds = regularIntervalSeconds(card.level, settings);
    const newText = addSecondsToText(card.last_reviewed, seconds);
    const newNext = toMillis(newText);
    if (newText === pythonUtc(card.next_review)) { unchanged += 1; continue; }
    changes.push({
      card_id: card.id,
      level: Number(card.level),
      last_reviewed: card.last_reviewed,
      old_next_review: card.next_review,
      new_next_review: newText,
      due_before: reviewIsDue(next, moment),
      due_after: reviewIsDue(newNext, moment),
      newMillis: newNext,
      oldMillis: next,
    });
  }
  return {
    deck_id: deckId,
    settings: apiFields(settings),
    total_cards: sorted.length,
    affected: changes.length,
    eligible: changes.length + unchanged,
    unchanged,
    earlier: changes.filter((item) => item.newMillis < item.oldMillis).length,
    later: changes.filter((item) => item.newMillis > item.oldMillis).length,
    newly_due: changes.filter((item) => item.due_after && !item.due_before).length,
    no_longer_due: changes.filter((item) => item.due_before && !item.due_after).length,
    skipped,
    changes,
  };
}

/** Identifies exactly one preview (deck, setting, every planned change). */
export function planToken(plan) {
  const parts = [plan.deck_id, plan.settings.interval_model, plan.settings.interval_multiplier_pct, plan.settings.interval_max_days,
    ...plan.changes.map((item) => `${item.card_id}|${pythonUtc(item.old_next_review)}|${item.new_next_review}`)];
  return parts.join('\n');
}
