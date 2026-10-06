// Shared selection pieces of the learning setup and the card list: the deck
// picker (bottom sheet with checkboxes), card counts per deck / category /
// subcategory from one pass over the cards, and category selects that keep
// equally named categories of different decks apart.

import * as store from './store.js';
import { openSheet } from './ui.js';
import { clear, h, icon, plural } from './util.js';

/**
 * Count the cards per deck, category and subcategory in one pass.
 * `match(card)` decides which cards count (e.g. "only due ones").
 */
export function countIndex(cards, match = () => true) {
  const index = { total: 0, decks: new Map(), categories: new Map(), subcategories: new Map() };
  const bump = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
  for (const card of cards) {
    if (!match(card)) continue;
    index.total += 1;
    bump(index.decks, card.deck_id);
    bump(index.categories, card.category_id);
    bump(index.subcategories, card.subcategory_id);
  }
  return index;
}

/** Visible text for a deck selection ([] = all decks). */
export function deckSummary(deckIds) {
  const names = deckIds.map((id) => store.deck(id)?.name).filter(Boolean);
  if (!names.length) return { main: 'Alle Decks', sub: plural(store.state.decks.size, 'Deck', 'Decks') };
  if (names.length === 1) return { main: names[0], sub: '1 Deck ausgewählt' };
  return { main: `${names.length} ausgewählt`, sub: names.join(' · ') };
}

/** Deck ids that still exist; a selection of every deck is stored as [] (= all). */
export function normalizeDeckIds(deckIds) {
  const existing = (deckIds || []).filter((id) => store.deck(id));
  return existing.length && existing.length === store.state.decks.size ? [] : existing;
}

/** The categories of the chosen decks ([] = all decks). */
export function categoriesFor(deckIds) {
  if (!deckIds.length) return store.categoriesOf(null);
  const chosen = new Set(deckIds);
  return store.categoriesOf(null).filter((item) => chosen.has(item.deck_id));
}

function counted(label, count) {
  return count === undefined ? label : `${label} (${count})`;
}

/**
 * Fill a <select> with the categories of the chosen decks.  With more than one
 * deck in play the categories are grouped by deck (<optgroup>), so two
 * "Finanzierung" of different decks can never be confused.
 */
export function fillCategorySelect(element, { deckIds, value, counts, allLabel = 'Alle Kategorien' }) {
  clear(element);
  element.append(h('option', { value: '', text: counted(allLabel, counts && counts.total) }));
  const categories = categoriesFor(deckIds);
  const deckOf = new Map();
  for (const item of categories) {
    if (!deckOf.has(item.deck_id)) deckOf.set(item.deck_id, []);
    deckOf.get(item.deck_id).push(item);
  }
  const option = (item) => h('option', { value: item.id, text: counted(item.name, counts ? counts.categories.get(item.id) || 0 : undefined) });
  if (deckOf.size > 1) {
    const decks = [...deckOf.keys()].map((id) => store.deck(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    for (const deck of decks) {
      element.append(h('optgroup', { label: deck.name }, deckOf.get(deck.id).map(option)));
    }
  } else {
    element.append(...categories.map(option));
  }
  const valid = categories.some((item) => item.id === value);
  element.value = valid ? value : '';
  return element.value;
}

export function fillSubcategorySelect(element, { categoryId, value, counts, allLabel = 'Alle Unterkategorien' }) {
  clear(element);
  const items = categoryId ? store.subcategoriesOf(categoryId) : [];
  const total = counts && categoryId ? counts.categories.get(categoryId) || 0 : counts && counts.total;
  element.append(h('option', { value: '', text: counted(allLabel, total) }));
  for (const item of items) {
    element.append(h('option', { value: item.id, text: counted(item.name, counts ? counts.subcategories.get(item.id) || 0 : undefined) }));
  }
  element.disabled = !categoryId || !items.length;
  element.value = items.some((item) => item.id === value) ? value : '';
  return element.value;
}

function checkRow({ id, label, count, checked, onChange, strong = false }) {
  const input = h('input', { type: 'checkbox', class: 'check-input', id, checked });
  input.addEventListener('change', () => onChange(input.checked));
  const row = h('label', { class: `check-row${strong ? ' is-strong' : ''}`, for: id },
    input,
    h('span', { class: 'check-box', 'aria-hidden': 'true' }, icon('check')),
    h('span', { class: 'check-label', text: label }),
    count === undefined ? null : h('span', { class: 'check-count', text: String(count), 'aria-label': plural(count, 'Karte', 'Karten') }));
  return { row, input };
}

/**
 * Bottom sheet with one checkbox per deck.  `selected` [] means all decks;
 * `onDone(ids)` receives [] again when every deck is ticked.
 */
export function openDeckPicker({ selected = [], counts = null, title = 'Decks auswählen', onDone }) {
  const decks = store.decks();
  const chosen = new Set(selected.length ? selected.filter((id) => store.deck(id)) : decks.map((deck) => deck.id));
  const status = h('p', { class: 'deck-pick-status', id: 'deck-pick-status', 'aria-live': 'polite' });
  const all = checkRow({
    id: 'deck-pick-all',
    label: 'Alle Decks',
    count: counts ? counts.total : undefined,
    checked: chosen.size === decks.length,
    strong: true,
    onChange: (checked) => {
      chosen.clear();
      if (checked) for (const deck of decks) chosen.add(deck.id);
      sync();
    },
  });
  const rows = decks.map((deck) => ({
    deck,
    ...checkRow({
      id: `deck-pick-${deck.id}`,
      label: deck.name,
      count: counts ? counts.decks.get(deck.id) || 0 : undefined,
      checked: chosen.has(deck.id),
      onChange: (checked) => {
        if (checked) chosen.add(deck.id);
        else chosen.delete(deck.id);
        sync();
      },
    }),
  }));
  for (const { row, deck } of rows) row.dataset.deck = deck.id;
  let sheet = null;
  function sync() {
    for (const { input, deck } of rows) input.checked = chosen.has(deck.id);
    all.input.checked = chosen.size === decks.length;
    all.input.indeterminate = chosen.size > 0 && chosen.size < decks.length;
    status.textContent = !chosen.size
      ? 'Kein Deck ausgewählt'
      : chosen.size === decks.length
        ? `Alle ${plural(decks.length, 'Deck', 'Decks')} ausgewählt`
        : `${plural(chosen.size, 'Deck', 'Decks')} ausgewählt`;
    const done = sheet && sheet.element.querySelector('#deck-pick-done');
    if (done) done.disabled = !chosen.size;
  }
  sheet = openSheet({
    title,
    className: 'sheet-picker',
    body: [
      status,
      h('div', { class: 'pick-tools' },
        h('button', { class: 'btn btn-soft', type: 'button', id: 'deck-pick-select-all', on: { click: () => { for (const deck of decks) chosen.add(deck.id); sync(); } } }, 'Alle auswählen'),
        h('button', { class: 'btn btn-soft', type: 'button', id: 'deck-pick-clear', on: { click: () => { chosen.clear(); sync(); } } }, 'Auswahl löschen')),
      h('div', { class: 'check-list', role: 'group', 'aria-label': 'Decks' }, all.row, rows.map((item) => item.row)),
    ],
    actions: [{
      label: 'Fertig',
      icon: 'check',
      variant: 'btn-primary',
      id: 'deck-pick-done',
      onClick: (current) => {
        if (!chosen.size) return;
        const ids = decks.filter((deck) => chosen.has(deck.id)).map((deck) => deck.id);
        current.close('done');
        onDone(ids.length === decks.length ? [] : ids);
      },
    }],
  });
  sync();
  return sheet;
}
