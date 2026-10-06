// Lernen: session setup (filter sheet), the one-handed learning session and
// the session summary.
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
import { choices, confirmDialog, emptyState, field, levelBadge, openSheet, select, toast, toggle } from '../ui.js';
import { clear, h, icon, plural, pointsText, uuid } from '../util.js';

const LIMITS = [
  { value: '10', label: '10' },
  { value: '20', label: '20' },
  { value: '30', label: '30' },
  { value: '50', label: '50' },
  { value: 'all', label: 'Alle' },
];
const MAX_RETRIES_PER_CARD = 3;

export const filters = { deckId: '', categoryId: '', subcategoryId: '', dueOnly: true, limit: '20' };

let session = null;
let pendingSheetPreset = null;
let navigateRef = null;

function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* not supported */ }
}

// -- selection -----------------------------------------------------------------
function selectionPayload(values) {
  return {
    deck_ids: values.deckId ? [values.deckId] : [],
    category_ids: values.categoryId ? [values.categoryId] : [],
    subcategory_ids: values.subcategoryId ? [values.subcategoryId] : [],
    due_only: values.dueOnly,
    include_mastered: false,
    limit: values.limit === 'all' ? null : Number(values.limit),
  };
}

function localCount(values) {
  return store.localSelection({
    deckIds: values.deckId ? [values.deckId] : [],
    categoryIds: values.categoryId ? [values.categoryId] : [],
    subcategoryIds: values.subcategoryId ? [values.subcategoryId] : [],
    dueOnly: values.dueOnly,
  }).length;
}

async function selectCards(values) {
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
    const payload = selectionPayload(values);
    return store.localSelection({
      deckIds: payload.deck_ids,
      categoryIds: payload.category_ids,
      subcategoryIds: payload.subcategory_ids,
      dueOnly: payload.due_only,
      limit: payload.limit,
    }).map((card) => card.id);
  }
}

export function startWithIds(ids, navigate) {
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
  };
  prefetchImages(unique);
  (navigate || navigateRef)('#/lernen/session');
  return true;
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
    const ids = await selectCards(values);
    if (!ids.length) {
      toast(values.dueOnly ? 'Keine fälligen Karten für diese Auswahl.' : 'Keine Karten für diese Auswahl.');
      return false;
    }
    return startWithIds(ids, navigate);
  } catch (error) {
    toast(error.message || 'Session konnte nicht gestartet werden.', { tone: 'error' });
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

// -- filter sheet ----------------------------------------------------------------
export function openLearnSheet(preset = {}) {
  pendingSheetPreset = preset;
  if (navigateRef && location.hash === '#/lernen') {
    const values = pendingSheetPreset;
    pendingSheetPreset = null;
    showFilterSheet(values, navigateRef);
  }
}

function showFilterSheet(preset, navigate, onApplied) {
  const values = { ...filters, ...Object.fromEntries(Object.entries(preset).filter(([, value]) => value !== undefined)) };
  if (preset.deckId !== undefined && preset.deckId !== filters.deckId) {
    values.categoryId = '';
    values.subcategoryId = '';
  }
  const deckSelect = select([], '', { id: 'filter-deck' });
  const categorySelect = select([], '', { id: 'filter-category' });
  const subcategorySelect = select([], '', { id: 'filter-subcategory' });
  const due = toggle('Nur fällige Karten', values.dueOnly, { id: 'filter-due' });
  const countText = h('p', { class: 'form-info', id: 'filter-count', 'aria-live': 'polite' });

  const fill = (element, options, value) => {
    clear(element);
    for (const option of options) element.append(h('option', { value: option.value, text: option.label }));
    element.value = options.some((option) => option.value === value) ? value : '';
  };
  const refresh = () => {
    fill(deckSelect, [{ value: '', label: 'Alle Decks' }, ...store.decks().map((deck) => ({ value: deck.id, label: deck.name }))], values.deckId);
    values.deckId = deckSelect.value;
    const categories = store.categoriesOf(values.deckId || null);
    fill(categorySelect, [{ value: '', label: 'Alle Kategorien' }, ...categories.map((item) => ({ value: item.id, label: values.deckId ? item.name : `${item.name} · ${store.deck(item.deck_id)?.name || ''}` }))], values.categoryId);
    values.categoryId = categorySelect.value;
    const subcategories = values.categoryId ? store.subcategoriesOf(values.categoryId) : [];
    fill(subcategorySelect, [{ value: '', label: 'Alle Unterkategorien' }, ...subcategories.map((item) => ({ value: item.id, label: item.name }))], values.subcategoryId);
    subcategorySelect.disabled = !values.categoryId;
    values.subcategoryId = subcategorySelect.value;
    const available = localCount(values);
    const planned = values.limit === 'all' ? available : Math.min(available, Number(values.limit));
    countText.textContent = available
      ? `${plural(available, 'Karte passt', 'Karten passen')} – die Session enthält ${plural(planned, 'Karte', 'Karten')}.`
      : (values.dueOnly ? 'Keine fälligen Karten in dieser Auswahl.' : 'Keine Karten in dieser Auswahl.');
  };
  deckSelect.addEventListener('change', () => { values.deckId = deckSelect.value; values.categoryId = ''; values.subcategoryId = ''; refresh(); });
  categorySelect.addEventListener('change', () => { values.categoryId = categorySelect.value; values.subcategoryId = ''; refresh(); });
  subcategorySelect.addEventListener('change', () => { values.subcategoryId = subcategorySelect.value; refresh(); });
  due.input.addEventListener('change', () => { values.dueOnly = due.input.checked; refresh(); });
  refresh();

  openSheet({
    title: 'Lernsession',
    body: [
      field('Deck', deckSelect),
      field('Kategorie', categorySelect),
      field('Unterkategorie', subcategorySelect),
      due.element,
      h('div', { class: 'field' },
        h('span', { class: 'field-label', id: 'limit-label', text: 'Kartenanzahl' }),
        choices(LIMITS, values.limit, (value) => { values.limit = value; refresh(); }, 'Kartenanzahl')),
      countText,
    ],
    actions: [{
      label: 'Session starten',
      icon: 'play',
      variant: 'btn-primary btn-xl',
      id: 'sheet-start',
      onClick: async (sheet) => {
        Object.assign(filters, values);
        sheet.setBusy(true);
        const ok = await startFromFilters(values, navigate);
        sheet.setBusy(false);
        if (ok) sheet.close('start');
        else if (onApplied) onApplied();
      },
    }],
    onClose: () => { if (onApplied) onApplied(); },
  });
}

// -- setup screen ----------------------------------------------------------------
function filterSummary() {
  const parts = [];
  const deck = filters.deckId && store.deck(filters.deckId);
  parts.push(deck ? deck.name : 'Alle Decks');
  const category = filters.categoryId && store.state.categories.get(filters.categoryId);
  if (category) parts.push(category.name);
  const subcategory = filters.subcategoryId && store.state.subcategories.get(filters.subcategoryId);
  if (subcategory) parts.push(subcategory.name);
  parts.push(filters.dueOnly ? 'nur fällige' : 'alle Karten');
  parts.push(filters.limit === 'all' ? 'alle' : `${filters.limit} Karten`);
  return parts;
}

function renderSetup(view, ctx) {
  navigateRef = ctx.navigate;
  const dueAll = store.localOverview().due_cards;
  const available = localCount(filters);
  const startButton = h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'button', id: 'learn-start' }, icon('play'), 'Session starten');
  startButton.addEventListener('click', () => startFromFilters(filters, ctx.navigate, startButton));
  const engineText = isCloud()
    ? 'Bewerte jede Karte ehrlich – Punkte, Level und der nächste Termin werden sofort berechnet, genau wie am Desktop.'
    : 'Bewerte jede Karte ehrlich – der Server berechnet Punkte, Level und den nächsten Termin.';

  view.append(h('div', { class: 'stack-lg' },
    h('section', { class: 'hero' },
      h('p', { class: 'hero-eyebrow', text: 'Lernsession' }),
      h('h2', { class: 'hero-title', text: dueAll ? `${dueAll} fällig` : 'Alles erledigt' }),
      h('p', { class: 'hero-text', text: dueAll ? engineText : 'Keine Karte ist gerade fällig. Du kannst trotzdem frei üben.' })),
    session && !session.finished
      ? h('a', { class: 'banner is-info', href: '#/lernen/session', id: 'learn-resume' }, icon('play', 'icon-sm'), `Laufende Session fortsetzen (${Math.min(session.index + 1, session.queue.length)} / ${session.queue.length})`)
      : null,
    h('div', { class: 'card stack' },
      h('div', { class: 'row' },
        h('div', { class: 'spacer' },
          h('p', { class: 'strong', text: 'Auswahl' }),
          h('p', { class: 'muted small', id: 'learn-filter-summary', text: filterSummary().join(' · ') })),
        h('button', { class: 'btn btn-soft btn-sm', type: 'button', id: 'learn-filter', on: { click: () => showFilterSheet({}, ctx.navigate, () => ctx.rerender()) } }, icon('filter', 'icon-sm'), 'Ändern')),
      h('p', { class: 'small muted', text: available ? `${plural(available, 'Karte passt', 'Karten passen')} zur Auswahl.` : 'Keine Karte passt zur aktuellen Auswahl.' }),
      startButton),
    h('a', { class: 'menu-item', href: '#/ki/test', id: 'learn-ai-test' },
      h('span', { class: 'stat-icon tone-mint' }, icon('target')),
      h('span', { class: 'menu-item-text' }, 'KI-Test erstellen', h('span', { class: 'menu-item-sub', text: 'HTML-Datei für ChatGPT & Co. erzeugen und teilen' })),
      icon('chevron-right'))));

  if (pendingSheetPreset) {
    const preset = pendingSheetPreset;
    pendingSheetPreset = null;
    requestAnimationFrame(() => showFilterSheet(preset, ctx.navigate, () => ctx.rerender()));
  }
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
