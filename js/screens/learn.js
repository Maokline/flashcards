// Lernen: session setup (decks, filters, order), the one-handed learning
// session and the session summary.
//
// Ratings go to sync.submitReview().  Cloud mode: the learning engine
// (js/core/engine.js, identical to the desktop's) applies them right away on
// this device.  Server mode: they are review events for the server's engine.

import { api, NetworkError } from '../api.js';
import { on } from '../bus.js';
import { isCloud } from '../config.js';
import { cardImages, thumbGrid } from '../images.js';
import * as store from '../store.js';
import * as sync from '../sync.js';
import { DEFAULT_ORDER, orderSessionCards } from '../core/selection.js';
import { countIndex, deckSummary, fillCategorySelect, fillSubcategorySelect, normalizeDeckIds, openDeckPicker } from '../pickers.js';
import { choices, confirmDialog, emptyState, field, levelBadge, openSheet, select, toast } from '../ui.js';
import { clear, h, icon, plural, pointsText, uuid } from '../util.js';

const LIMITS = [
  { value: '10', label: '10' },
  { value: '20', label: '20' },
  { value: '30', label: '30' },
  { value: '50', label: '50' },
  { value: 'all', label: 'Alle' },
];
export const ORDERS = [
  { value: 'mixed', label: 'Gemischt', sub: 'Decks und Karten zufällig mischen' },
  { value: 'due', label: 'Fälligkeit zuerst', sub: 'Überfällige Karten zuerst' },
  { value: 'level_asc', label: 'Level aufsteigend', sub: 'Schwächere Karten zuerst' },
  { value: 'level_desc', label: 'Level absteigend', sub: 'Stärkere Karten zuerst' },
];
const MAX_RETRIES_PER_CARD = 3;

// The setup's selection: local UI state of this device, never synchronised.
// deckIds [] = all decks.  `preset` holds the exact card set handed over by
// the card list ("Diese Karten lernen") until it is changed or used.
export const filters = { deckIds: [], categoryId: '', subcategoryId: '', dueOnly: true, limit: '20', order: DEFAULT_ORDER, preset: null };

let session = null;
let navigateRef = null;

function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* not supported */ }
}

function randomSeed() {
  try { return crypto.getRandomValues(new Uint32Array(1))[0]; } catch { return Math.floor(Math.random() * 4294967296); }
}

// -- selection -----------------------------------------------------------------
function selectionPayload(values) {
  return {
    deck_ids: [...values.deckIds],
    category_ids: values.categoryId ? [values.categoryId] : [],
    subcategory_ids: values.subcategoryId ? [values.subcategoryId] : [],
    due_only: values.dueOnly,
    tz_offset: -new Date().getTimezoneOffset(),
    include_mastered: false,
    // The order applies to the whole candidate list; the limit comes after it.
    limit: null,
  };
}

function localCandidates(values) {
  if (values.preset) return values.preset.cardIds.map((id) => store.card(id)).filter(Boolean);
  const payload = selectionPayload(values);
  return store.localSelection({
    deckIds: payload.deck_ids,
    categoryIds: payload.category_ids,
    subcategoryIds: payload.subcategory_ids,
    dueOnly: payload.due_only,
  });
}

async function candidateIds(values) {
  if (values.preset) return values.preset.cardIds.filter((id) => store.card(id));
  try {
    const result = await api.post('/api/sessions/select', selectionPayload(values), { timeout: 10000 });
    let ids = result.card_ids || [];
    if (!isCloud() && ids.some((id) => !store.card(id))) {
      try { await sync.pull(); } catch { /* use what we have */ }
      ids = ids.filter((id) => store.card(id));
    }
    return ids;
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    // Offline (server mode): same documented selection rule on the local copy.
    return localCandidates(values).map((card) => card.id);
  }
}

/** The session's cards: every candidate in the chosen order, then the limit. */
export function arrangeSession(ids, { order = DEFAULT_ORDER, limit = 'all', seed = 0, now = Date.now() } = {}) {
  const cards = [...new Set(ids)].map((id) => store.card(id)).filter(Boolean);
  const ordered = orderSessionCards(cards, order, { seed, now });
  const count = limit === 'all' || limit === null || limit === undefined ? ordered.length : Math.max(0, Number(limit));
  return ordered.slice(0, count).map((card) => card.id);
}

export function startWithIds(ids, navigate, config = null) {
  const unique = [...new Set(ids)].filter((id) => store.card(id));
  if (!unique.length) {
    toast('Für diese Auswahl sind keine Karten verfügbar.');
    return false;
  }
  session = {
    id: uuid(),
    queue: unique.map((id) => ({ id, retry: false })),
    uniqueIds: unique,
    index: 0,
    revealed: false,
    busy: false,
    shownAt: Date.now(),
    attempts: [],
    retries: new Map(),
    finished: false,
    leaving: null,
    // Frozen at the start: later syncs neither re-sort the queue nor add cards.
    config: config ? Object.freeze({ ...config, deckIds: Object.freeze([...(config.deckIds || [])]) }) : null,
  };
  prefetchImages(unique);
  (navigate || navigateRef)('#/lernen/session');
  return true;
}

/** Read-only view of the running session (diagnostics and tests). */
export function sessionInfo() {
  if (!session) return null;
  return {
    ids: session.queue.map((entry) => entry.id),
    retry: session.queue.map((entry) => entry.retry),
    index: session.index,
    finished: session.finished,
    config: session.config,
  };
}

// Make every image of the session available up front, so it survives a
// dropped connection halfway through.
function prefetchImages(ids) {
  if (!navigator.onLine) return;
  const paths = ids.flatMap((id) => {
    const card = store.card(id);
    return card ? [...(card.question_images || []), ...(card.answer_images || [])].map((media) => `/api/media/${encodeURIComponent(media)}`) : [];
  });
  if (paths.length) api.warm(paths);
}

async function startFromFilters(values, navigate, button) {
  if (button) button.disabled = true;
  try {
    // A statistics handoff only prepares a selection. Replace a running
    // session deliberately when the user presses start, never during handoff.
    if (session && !session.finished) {
      const replace = await confirmDialog({ title: 'Neue Session starten?', text: 'Eine Lernsession läuft noch. Bereits gespeicherte Bewertungen bleiben erhalten. Die neue Auswahl startet erst nach deiner Bestätigung.', confirm: 'Neue Session', cancel: 'Zurück' });
      if (!replace) return false;
    }
    const ids = await candidateIds(values);
    const seed = randomSeed();
    const now = Date.now();
    const chosen = arrangeSession(ids, { order: values.order, limit: values.limit, seed, now });
    if (!chosen.length) {
      toast(values.dueOnly && !values.preset ? 'Keine fälligen Karten für diese Auswahl.' : 'Keine Karten für diese Auswahl.');
      return false;
    }
    const config = {
      deckIds: values.deckIds,
      categoryId: values.categoryId,
      subcategoryId: values.subcategoryId,
      dueOnly: values.dueOnly,
      limit: values.limit,
      order: values.order,
      seed,
      startedAt: new Date(now).toISOString(),
      fromCardList: Boolean(values.preset),
      candidates: ids.length,
    };
    const ok = startWithIds(chosen, navigate, config);
    // The handed-over card set is used once; afterwards the filters apply.
    if (ok) values.preset = null;
    return ok;
  } catch (error) {
    toast(error.message || 'Session konnte nicht gestartet werden.', { tone: 'error' });
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

// -- setup ---------------------------------------------------------------------
function applyPreset(preset = {}) {
  if (preset.deckIds !== undefined || preset.deckId !== undefined) {
    filters.deckIds = normalizeDeckIds(preset.deckIds || (preset.deckId ? [preset.deckId] : []));
    filters.categoryId = '';
    filters.subcategoryId = '';
  }
  if (preset.categoryId !== undefined) filters.categoryId = preset.categoryId || '';
  if (preset.subcategoryId !== undefined) filters.subcategoryId = preset.subcategoryId || '';
  if (preset.dueOnly !== undefined) filters.dueOnly = Boolean(preset.dueOnly);
  if (preset.limit !== undefined) filters.limit = String(preset.limit);
  if (preset.order !== undefined && ORDERS.some((item) => item.value === preset.order)) filters.order = preset.order;
  filters.preset = Array.isArray(preset.cardIds)
    ? { cardIds: [...new Set(preset.cardIds)], label: preset.label || '' }
    : null;
}

/** Prefill the session setup (start page, card list) and show it. */
export function openLearnSetup(preset = {}, navigate = navigateRef) {
  applyPreset(preset);
  (navigate || navigateRef)('#/lernen');
}

function radioPill({ name, value, label, checked, id, onChange }) {
  const input = h('input', { type: 'radio', class: 'radio-input', name, value, id, checked });
  input.addEventListener('change', () => { if (input.checked) onChange(value); });
  return h('label', { class: 'radio-pill', for: id },
    input,
    h('span', { class: 'radio-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'radio-text', text: label }));
}

function setupRow({ id, label, value, valueId, sub, action, onClick, disabled = false }) {
  return h('button', { class: 'setup-row', type: 'button', id, 'aria-haspopup': 'dialog', disabled, on: { click: onClick } },
    h('span', { class: 'setup-row-text' },
      h('span', { class: 'setup-row-label', text: label }),
      h('span', { class: 'setup-row-value', id: valueId, text: value }),
      sub ? h('span', { class: 'setup-row-sub', text: sub }) : null),
    h('span', { class: 'setup-row-action' }, action));
}

function openOrderSheet(current, onPick) {
  let sheet = null;
  // Touch: one tap picks and closes.  Keyboard (arrow keys) only moves the
  // choice, so the sheet stays open until Escape / Schließen.
  let viaPointer = false;
  const rows = ORDERS.map((item) => {
    const id = `order-${item.value}`;
    const input = h('input', { type: 'radio', class: 'radio-input', name: 'learn-order', value: item.value, id, checked: item.value === current, autofocus: item.value === current });
    const pick = () => {
      onPick(item.value);
      if (viaPointer) setTimeout(() => sheet && sheet.close('pick'), 140);
      viaPointer = false;
    };
    input.addEventListener('change', () => { if (input.checked) pick(); });
    // A tap on the option that is already chosen closes the sheet as well.
    input.addEventListener('click', () => { if (viaPointer) pick(); });
    return h('label', { class: 'option-row', for: id, dataset: { order: item.value } },
      input,
      h('span', { class: 'radio-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'option-text' },
        h('span', { class: 'option-title', text: item.label }),
        h('span', { class: 'option-sub', text: item.sub })));
  });
  const list = h('div', { class: 'option-list', role: 'radiogroup', 'aria-label': 'Reihenfolge', id: 'order-options' }, rows);
  list.addEventListener('pointerdown', () => { viaPointer = true; });
  sheet = openSheet({
    title: 'Reihenfolge',
    className: 'sheet-picker',
    body: [list],
    // The setup was redrawn meanwhile: hand the focus to the new row.
    onClose: () => {
      if (!document.activeElement || document.activeElement === document.body) document.getElementById('learn-order')?.focus({ preventScroll: true });
    },
  });
  return sheet;
}

function renderSetup(view, ctx) {
  navigateRef = ctx.navigate;
  const engineText = isCloud()
    ? 'Bewerte jede Karte ehrlich – Punkte, Level und der nächste Termin werden sofort berechnet, genau wie am Desktop.'
    : 'Bewerte jede Karte ehrlich – der Server berechnet Punkte, Level und den nächsten Termin.';
  const heroTitle = h('h2', { class: 'hero-title', id: 'learn-hero-title' });
  const heroText = h('p', { class: 'hero-text' });
  const form = h('div', { class: 'card learn-setup', id: 'learn-setup' });
  const presetHost = h('div', { id: 'learn-preset-host', hidden: true });
  const countEl = h('p', { class: 'learn-count', id: 'learn-count', 'aria-live': 'polite' });
  const startButton = h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'button', id: 'learn-start' }, icon('play'), 'Session starten');
  startButton.addEventListener('click', () => startFromFilters(filters, ctx.navigate, startButton));

  const changed = (patch) => {
    Object.assign(filters, patch, { preset: null });
    draw();
  };

  function draw() {
    const dueAll = store.localOverview().due_cards;
    heroTitle.textContent = dueAll ? `${dueAll} fällig` : 'Alles erledigt';
    heroText.textContent = dueAll ? engineText : 'Keine Karte ist gerade fällig. Du kannst trotzdem frei üben.';
    filters.deckIds = normalizeDeckIds(filters.deckIds);
    const now = new Date();
    const all = store.cards();
    const mode = (card) => !card.mastered && (!filters.dueOnly || store.isDue(card, now));
    // One pass per change for the deck picker, one for the chosen decks.
    const deckCounts = countIndex(all, mode);
    const scope = new Set(filters.deckIds);
    const scoped = scope.size ? countIndex(all, (card) => scope.has(card.deck_id) && mode(card)) : deckCounts;

    const categorySelect = select([], '', { id: 'learn-category' });
    filters.categoryId = fillCategorySelect(categorySelect, { deckIds: filters.deckIds, value: filters.categoryId, counts: scoped });
    const subcategorySelect = select([], '', { id: 'learn-subcategory' });
    filters.subcategoryId = fillSubcategorySelect(subcategorySelect, { categoryId: filters.categoryId, value: filters.subcategoryId, counts: scoped });
    categorySelect.addEventListener('change', () => changed({ categoryId: categorySelect.value, subcategoryId: '' }));
    subcategorySelect.addEventListener('change', () => changed({ subcategoryId: subcategorySelect.value }));

    const available = filters.preset
      ? localCandidates(filters).length
      : filters.subcategoryId ? scoped.subcategories.get(filters.subcategoryId) || 0
        : filters.categoryId ? scoped.categories.get(filters.categoryId) || 0
          : scoped.total;
    const planned = filters.limit === 'all' ? available : Math.min(available, Number(filters.limit));
    const decks = deckSummary(filters.deckIds);
    const order = ORDERS.find((item) => item.value === filters.order) || ORDERS[0];

    clear(presetHost);
    presetHost.hidden = !filters.preset;
    if (filters.preset) {
      presetHost.append(h('div', { class: 'banner is-info preset-banner', id: 'learn-preset' },
        icon('filter', 'icon-sm'),
        h('span', { class: 'spacer' },
          h('span', { class: 'strong', text: 'Übernommene Kartenauswahl' }),
          h('span', { class: 'preset-sub', id: 'learn-preset-text', text: [plural(available, 'Karte', 'Karten'), filters.preset.label].filter(Boolean).join(' · ') })),
        h('button', { class: 'btn btn-icon', type: 'button', id: 'learn-preset-clear', 'aria-label': 'Übernommene Auswahl verwerfen', on: { click: () => changed({}) } }, icon('x'))));
    }

    // The form is rebuilt on every change: keep the keyboard focus in place.
    const active = document.activeElement;
    const focusKey = active && form.contains(active)
      ? (active.id ? `#${CSS.escape(active.id)}` : active.dataset.value !== undefined ? `.choice[data-value="${CSS.escape(active.dataset.value)}"]` : '')
      : '';
    clear(form);
    form.append(
      setupRow({
        id: 'learn-decks', label: 'Decks', value: decks.main, valueId: 'learn-decks-value', sub: decks.sub,
        action: ['Auswählen', icon('chevron-right', 'icon-sm')],
        disabled: !store.state.decks.size,
        onClick: () => openDeckPicker({ selected: filters.deckIds, counts: deckCounts, onDone: (ids) => changed({ deckIds: ids }) }),
      }),
      field('Kategorie', categorySelect),
      field('Unterkategorie', subcategorySelect),
      h('div', { class: 'field' },
        h('span', { class: 'field-label', id: 'learn-cards-label', text: 'Karten' }),
        h('div', { class: 'radio-pills', role: 'radiogroup', 'aria-labelledby': 'learn-cards-label' },
          radioPill({ name: 'learn-cards', value: 'due', label: 'Nur fällige', checked: filters.dueOnly, id: 'learn-due-only', onChange: () => changed({ dueOnly: true }) }),
          radioPill({ name: 'learn-cards', value: 'all', label: 'Auswahl wie gefiltert', checked: !filters.dueOnly, id: 'learn-all-cards', onChange: () => changed({ dueOnly: false }) }))),
      h('div', { class: 'field' },
        h('span', { class: 'field-label', id: 'limit-label', text: 'Anzahl' }),
        choices(LIMITS, filters.limit, (value) => { filters.limit = value; draw(); }, 'Anzahl')),
      setupRow({
        id: 'learn-order', label: 'Reihenfolge', value: order.label, valueId: 'learn-order-value', sub: order.sub,
        action: icon('chevron-down', 'icon-sm'),
        onClick: () => openOrderSheet(filters.order, (value) => { filters.order = value; draw(); }),
      }));
    if (focusKey) form.querySelector(focusKey)?.focus({ preventScroll: true });
    // The count sits next to the start button, so both stay in view.
    countEl.classList.toggle('is-empty', !available);
    countEl.textContent = available
      ? `${plural(available, 'Karte', 'Karten')} gefunden · Session: ${plural(planned, 'Karte', 'Karten')}`
      : (filters.dueOnly && !filters.preset ? 'Keine fälligen Karten in dieser Auswahl.' : 'Keine Karten in dieser Auswahl.');
  }
  draw();

  view.append(h('div', { class: 'stack-lg' },
    h('section', { class: 'hero hero-compact' },
      h('p', { class: 'hero-eyebrow', text: 'Lernsession' }),
      heroTitle,
      heroText),
    session && !session.finished
      ? h('a', { class: 'banner is-info', href: '#/lernen/session', id: 'learn-resume' }, icon('play', 'icon-sm'), `Laufende Session fortsetzen (${Math.min(session.index + 1, session.queue.length)} / ${session.queue.length})`)
      : null,
    presetHost,
    form,
    h('div', { class: 'action-bar is-single learn-start-bar' }, countEl, startButton),
    h('a', { class: 'menu-item', href: '#/ki/test', id: 'learn-ai-test' },
      h('span', { class: 'stat-icon tone-mint' }, icon('target')),
      h('span', { class: 'menu-item-text' }, 'KI-Test erstellen', h('span', { class: 'menu-item-sub', text: 'HTML-Datei für ChatGPT & Co. erzeugen und teilen' })),
      icon('chevron-right'))));
  // Card data arriving through a sync only refreshes the counts.
  return { onData: draw };
}

// -- session -------------------------------------------------------------------
function currentEntry() {
  return session && session.queue[session.index];
}

function showPop(content, tone) {
  document.querySelectorAll('.points-pop').forEach((item) => item.remove());
  const pop = h('div', { class: `points-pop is-${tone}`, role: 'status', id: 'points-pop' }, content);
  document.body.append(pop);
  setTimeout(() => pop.remove(), 1750);
}

function outcomeFeedback(outcome) {
  if (!outcome || outcome.status === 'queued') {
    showPop('Gespeichert – wird übertragen', 'pending');
  } else if (outcome.status === 'rejected') {
    showPop('Karte existiert nicht mehr', 'neutral');
  } else if (outcome.status === 'invalid') {
    showPop('Bewertung ungültig', 'neutral');
  } else {
    const delta = Number(outcome.points_change) || 0;
    const levelUp = outcome.level_after && outcome.level_before && outcome.level_after > outcome.level_before;
    const mastered = outcome.card && outcome.card.mastered && delta > 0;
    if (mastered) showPop([icon('star', 'icon-sm'), 'Gekonnt! ', pointsText(delta)], 'levelup');
    else if (levelUp) showPop([icon('trophy', 'icon-sm'), `Level ${outcome.level_after} · ${pointsText(delta)}`], 'levelup');
    else showPop(pointsText(delta), delta > 0 ? 'plus' : delta < 0 ? 'minus' : 'neutral');
  }
}

async function rate(correct, rerender, { swiped = false } = {}) {
  const entry = currentEntry();
  if (!entry || session.busy || !session.revealed) return;
  session.busy = true;
  vibrate(correct ? 12 : [10, 40, 10]);
  const card = store.card(entry.id);
  const event = {
    event_id: uuid(),
    card_id: entry.id,
    correct,
    immediate_retry: entry.retry,
    duration_seconds: Math.round((Date.now() - session.shownAt) / 100) / 10,
    reviewed_at: new Date().toISOString(),
  };
  const attempt = {
    event_id: event.event_id,
    card_id: entry.id,
    question: card ? card.question : '',
    correct,
    retry: entry.retry,
    status: 'pending',
    delta: null,
  };
  session.attempts.push(attempt);
  document.querySelectorAll('.rate-btn').forEach((button) => { button.disabled = true; });
  const flashcard = document.getElementById('flashcard');
  if (flashcard && !swiped) flashcard.classList.add(correct ? 'is-leaving-right' : 'is-leaving-left');

  let outcome;
  try {
    outcome = await sync.submitReview(event);
  } catch (error) {
    session.attempts.pop();
    session.busy = false;
    toast(error.message || 'Bewertung nicht gespeichert.', { tone: 'error' });
    rerender();
    return;
  }
  applyOutcome(attempt, outcome);
  outcomeFeedback(outcome);

  if (!correct && outcome.status !== 'rejected') {
    const used = session.retries.get(entry.id) || 0;
    if (used < MAX_RETRIES_PER_CARD) {
      session.retries.set(entry.id, used + 1);
      // The engine decides when a wrong card comes back (3–5 cards later).
      const gap = Number.isInteger(outcome.retry_after_cards) ? outcome.retry_after_cards : 3 + Math.floor(Math.random() * 3);
      const position = Math.min(session.queue.length, session.index + 1 + gap);
      session.queue.splice(position, 0, { id: entry.id, retry: true });
    }
  }
  session.index += 1;
  session.revealed = false;
  session.busy = false;
  session.shownAt = Date.now();
  if (session.index >= session.queue.length) session.finished = true;
  setTimeout(rerender, flashcard ? 150 : 0);
}

function applyOutcome(attempt, outcome) {
  if (!outcome) return;
  if (outcome.status === 'queued') attempt.status = 'queued';
  else if (outcome.status === 'applied' || outcome.duplicate) {
    attempt.status = 'done';
    attempt.delta = Number(outcome.points_change) || 0;
  } else attempt.status = outcome.status;
}

on('review-synced', (outcome) => {
  if (!session) return;
  const attempt = session.attempts.find((item) => item.event_id === outcome.event_id);
  if (attempt && attempt.status !== 'done') {
    applyOutcome(attempt, outcome);
    if (session.finished && location.hash === '#/lernen/session') {
      const host = document.getElementById('session-summary-list');
      if (host) host.dispatchEvent(new CustomEvent('refresh'));
    }
  }
});

function renderSession(view, ctx) {
  navigateRef = ctx.navigate;
  if (!session) {
    ctx.navigate('#/lernen', { replace: true });
    return {};
  }
  let keyHandler = null;
  let active = true;
  const rerender = () => {
    if (!active || location.hash !== '#/lernen/session') return;
    clear(view);
    keyHandler = null;
    if (!session) return;
    if (session.finished) renderSummary(view, ctx);
    else keyHandler = renderCard(view, ctx, rerender);
  };
  const keys = (event) => keyHandler && keyHandler(event);
  document.addEventListener('keydown', keys);
  rerender();
  return {
    cleanup: () => {
      active = false;
      document.removeEventListener('keydown', keys);
    },
    onData: () => {},
  };
}

function renderCard(view, ctx, rerender) {
  const entry = currentEntry();
  const card = store.card(entry.id);
  if (!card) {
    session.index += 1;
    if (session.index >= session.queue.length) session.finished = true;
    toast('Eine Karte wurde inzwischen gelöscht und übersprungen.');
    requestAnimationFrame(rerender);
    return null;
  }
  const total = session.queue.length;
  const position = session.index + 1;
  const percent = Math.round((session.index / total) * 100);
  const category = [card.category, card.subcategory].filter(Boolean).join(' › ');
  const right = session.attempts.filter((a) => a.correct && !a.retry).length;
  const wrong = session.attempts.filter((a) => !a.correct && !a.retry).length;

  const closeButton = h('button', {
    class: 'btn btn-icon', type: 'button', 'aria-label': 'Session beenden', id: 'session-close',
    on: {
      click: async () => {
        if (!session.attempts.length) {
          session = null;
          ctx.navigate('#/lernen');
          return;
        }
        const ok = await confirmDialog({ title: 'Session beenden?', text: 'Bereits bewertete Karten bleiben gespeichert. Du siehst danach die Zusammenfassung.', confirm: 'Beenden' });
        if (ok) {
          session.finished = true;
          rerender();
        }
      },
    },
  }, icon('x'));

  const answerBlock = session.revealed
    ? h('div', { class: 'flashcard-answer-block' },
      h('div', { class: 'flashcard-divider', text: 'Antwort' }),
      card.answer ? h('p', { class: 'flashcard-answer', id: 'session-answer', text: card.answer }) : null,
      thumbGrid(cardImages(card.answer_images, 'answer'), { variant: 'lg', label: 'Antwortbilder' }))
    : h('button', { class: 'flashcard-hidden', type: 'button', id: 'session-hidden', on: { click: reveal } }, icon('eye'), 'Antwort verdeckt – antippen zum Aufdecken');

  const flashcard = h('article', { class: 'flashcard', id: 'flashcard', 'aria-live': 'polite' },
    h('span', { class: 'swipe-badge is-left', 'aria-hidden': 'true' }, icon('x', 'icon-sm'), 'FALSCH'),
    h('span', { class: 'swipe-badge is-right', 'aria-hidden': 'true' }, icon('check', 'icon-sm'), 'RICHTIG'),
    h('div', { class: 'flashcard-meta' },
      h('span', { class: 'chip chip-area' }, icon('layers'), store.deckName(card)),
      category ? h('span', { class: 'chip', text: category }) : null,
      levelBadge(card),
      entry.retry ? h('span', { class: 'chip retry-flag' }, icon('refresh'), 'Wiederholung') : null),
    h('h1', { class: 'flashcard-question', id: 'session-question', text: card.question }),
    thumbGrid(cardImages(card.question_images, 'question'), { variant: 'lg', label: 'Fragebilder' }),
    answerBlock);

  function reveal() {
    if (session.revealed) return;
    session.revealed = true;
    vibrate(6);
    rerender();
    requestAnimationFrame(() => {
      const answer = document.getElementById('session-answer') || document.querySelector('.flashcard-divider');
      if (answer) answer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      document.getElementById('rate-correct')?.focus({ preventScroll: true });
    });
  }

  const actions = session.revealed
    ? h('div', { class: 'session-actions-inner' },
      h('button', { class: 'btn btn-danger btn-xl rate-btn', type: 'button', id: 'rate-wrong', 'aria-label': 'Falsch – Taste 1 oder Pfeil links', on: { click: () => rate(false, rerender) } }, icon('x'), 'Falsch'),
      h('button', { class: 'btn btn-success btn-xl rate-btn', type: 'button', id: 'rate-correct', 'aria-label': 'Richtig – Taste 2 oder Pfeil rechts', on: { click: () => rate(true, rerender) } }, icon('check'), 'Richtig'))
    : h('div', { class: 'session-actions-inner is-single' },
      h('button', { class: 'btn btn-primary btn-xl reveal-btn', type: 'button', id: 'reveal', on: { click: reveal } }, icon('eye'), 'Antwort anzeigen'));

  view.append(h('div', { class: 'session', 'data-area': 'learn' },
    h('div', { class: 'session-top' },
      h('div', { class: 'session-top-inner' },
        closeButton,
        h('div', { class: 'session-progress' },
          h('div', { class: 'session-progress-text' },
            h('span', { id: 'session-progress', text: `${position} / ${total}` }),
            h('span', { class: 'session-score', 'aria-label': `${right} richtig, ${wrong} falsch` },
              h('span', { class: 'ok', text: `✓ ${right}` }),
              h('span', { class: 'bad', text: `✗ ${wrong}` }))),
          h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(session.index), 'aria-label': 'Fortschritt' },
            h('div', { class: 'progress-bar', vars: { '--value': `${percent}%` } }))))),
    h('div', { class: 'session-body' },
      flashcard,
      session.revealed ? h('p', { class: 'swipe-hint', text: 'Tipp: nach links wischen = falsch · nach rechts = richtig' }) : null),
    h('div', { class: 'session-actions' }, actions)));

  if (session.revealed) attachSwipe(flashcard, (correct) => rate(correct, rerender, { swiped: true }));

  return (event) => {
    if (document.querySelector('.backdrop, .lightbox')) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (!session.revealed && (event.key === ' ' || event.key === 'Enter')) {
      event.preventDefault();
      reveal();
    } else if (session.revealed && (event.key === 'ArrowLeft' || event.key === '1')) {
      event.preventDefault();
      rate(false, rerender);
    } else if (session.revealed && (event.key === 'ArrowRight' || event.key === '2')) {
      event.preventDefault();
      rate(true, rerender);
    }
  };
}

// Swipe left = falsch, right = richtig.  Purely supplementary: the buttons are
// always visible.
function attachSwipe(element, onRate) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let dragging = false;
  element.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target.closest('button, a')) return;
    tracking = true;
    dragging = false;
    startX = event.clientX;
    startY = event.clientY;
    dx = 0;
  });
  element.addEventListener('pointermove', (event) => {
    if (!tracking) return;
    dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!dragging) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        dragging = true;
        element.classList.add('is-dragging');
        element.setPointerCapture?.(event.pointerId);
      } else if (Math.abs(dy) > 12) {
        tracking = false;
        return;
      } else {
        return;
      }
    }
    element.style.transform = `translateX(${dx}px) rotate(${dx / 36}deg)`;
    element.classList.toggle('swipe-right', dx > 80);
    element.classList.toggle('swipe-left', dx < -80);
  });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    element.classList.remove('is-dragging');
    if (dragging && Math.abs(dx) > 110) {
      element.classList.add(dx > 0 ? 'is-leaving-right' : 'is-leaving-left');
      element.style.transform = '';
      onRate(dx > 0);
    } else {
      element.classList.remove('swipe-left', 'swipe-right');
      element.style.transform = '';
    }
    dragging = false;
  };
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', end);
}

// -- summary -------------------------------------------------------------------
function renderSummary(view, ctx) {
  const perCard = new Map();
  for (const attempt of session.attempts) {
    const entry = perCard.get(attempt.card_id) || { question: attempt.question, attempts: [], delta: 0, pending: 0 };
    entry.attempts.push(attempt);
    if (attempt.status === 'done') entry.delta += attempt.delta || 0;
    else if (attempt.status === 'queued' || attempt.status === 'pending') entry.pending += 1;
    perCard.set(attempt.card_id, entry);
  }
  const firstTry = [...perCard.values()].map((entry) => entry.attempts[0]);
  const correct = firstTry.filter((attempt) => attempt.correct).length;
  const wrong = firstTry.length - correct;
  const wrongIds = [...perCard.entries()].filter(([, entry]) => !entry.attempts[0].correct).map(([id]) => id);
  const share = firstTry.length ? Math.round((correct / firstTry.length) * 100) : 0;

  const list = h('div', { id: 'session-summary-list' });
  const totalEl = h('span', { class: 'stat-value', id: 'summary-points' });
  const fillList = () => {
    clear(list);
    let total = 0;
    let pending = 0;
    for (const [cardId, entry] of perCard) {
      total += entry.delta;
      pending += entry.pending;
      const first = entry.attempts[0];
      const delta = entry.pending
        ? h('span', { class: 'delta is-pending', text: 'ausstehend' })
        : h('span', { class: `delta ${entry.delta > 0 ? 'is-plus' : entry.delta < 0 ? 'is-minus' : ''}`, text: pointsText(entry.delta) });
      list.append(h('a', { class: 'summary-row', href: `#/karten/${encodeURIComponent(cardId)}` },
        h('span', { class: `result-icon ${first.correct ? 'ok' : 'bad'}`, 'aria-label': first.correct ? 'Richtig' : 'Falsch' }, icon(first.correct ? 'check' : 'x', 'icon-sm')),
        h('span', { class: 'summary-row-main' },
          h('span', { class: 'summary-row-question', text: entry.question || 'Karte' }),
          h('span', { class: 'tiny muted', text: ` · ${plural(entry.attempts.length, 'Versuch', 'Versuche')}` })),
        delta));
    }
    totalEl.textContent = pending ? `${pointsText(total)} · ${pending} ausstehend` : pointsText(total);
  };
  list.addEventListener('refresh', fillList);

  const finish = () => {
    session = null;
    ctx.navigate('#/lernen');
  };
  view.append(h('div', { class: 'session', 'data-area': 'learn' },
    h('div', { class: 'session-top' },
      h('div', { class: 'session-top-inner' },
        h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Zusammenfassung schließen', on: { click: finish } }, icon('x')),
        h('div', { class: 'session-progress' }, h('div', { class: 'session-progress-text' }, h('span', { text: 'Session abgeschlossen' }))))),
    h('div', { class: 'session-body stack-lg', id: 'session-summary' },
      h('section', { class: 'card summary-hero' },
        h('div', { class: 'ring', role: 'img', 'aria-label': `${share} Prozent richtig`, vars: { '--value': String(share) } }, h('span', {}, `${share}%`, h('small', { text: 'richtig' }))),
        h('div', { class: 'spacer' },
          h('p', { class: 'hero-eyebrow', text: 'Zusammenfassung' }),
          h('h2', { class: 'hero-title', text: correct === firstTry.length && firstTry.length ? 'Alles richtig!' : share >= 70 ? 'Starke Runde' : 'Gut gemacht' }),
          h('p', { class: 'hero-text', text: `${plural(perCard.size, 'Karte', 'Karten')} bewertet.` }))),
      h('div', { class: 'summary-score' },
        h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Richtig' }), h('span', { class: 'stat-value', id: 'summary-correct', text: String(correct) })),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Falsch' }), h('span', { class: 'stat-value', id: 'summary-wrong', text: String(wrong) })),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Punkte' }), totalEl)),
      !isCloud() && sync.status.pending ? h('p', { class: 'banner' }, icon('clock', 'icon-sm'), 'Offline-Bewertungen werden automatisch übertragen.') : null,
      perCard.size ? h('div', { class: 'card' }, list) : emptyState('learn', 'Keine Karte bewertet', ''),
      h('div', { class: 'stack' },
        wrongIds.length ? h('button', { class: 'btn btn-soft btn-lg btn-block', type: 'button', id: 'summary-repeat', on: { click: () => startWithIds(wrongIds, ctx.navigate) } }, icon('refresh'), `Falsche wiederholen (${wrongIds.length})`) : null,
        h('button', { class: 'btn btn-secondary btn-lg btn-block', type: 'button', id: 'summary-ai', on: { click: () => { const ids = session.uniqueIds; setAiTestPreset(ids); session = null; ctx.navigate('#/ki/test'); } } }, icon('target'), 'KI-Test zu dieser Session'),
        h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'button', id: 'summary-done', on: { click: finish } }, icon('check'), 'Fertig')))));
  fillList();
}

// The KI-Test screen reads this preset to lock the export to the session.
export const aiTestPreset = { ids: null };
function setAiTestPreset(ids) {
  aiTestPreset.ids = [...ids];
}

export default {
  setup: {
    area: 'learn',
    tab: 'lernen',
    live: true,
    title: () => ({ title: 'Lernen', eyebrow: 'Session' }),
    render: renderSetup,
  },
  session: {
    area: 'learn',
    tab: 'lernen',
    immersive: true,
    live: false,
    title: () => ({ title: 'Lernsession' }),
    render: renderSession,
  },
};
