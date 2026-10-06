// Karten: mobile list (no table) with image previews, quick status chips,
// search, filter sheet (sorting: Fälligkeit, Level, Punkte), long-press
// multi-selection with bulk actions, and the card detail view.

import { api, ApiError, errorMessage } from '../api.js';
import { isCloud } from '../config.js';
import { cardImages, imageElement, thumbGrid } from '../images.js';
import * as store from '../store.js';
import * as sync from '../sync.js';
import { confirmDialog, emptyState, field, levelBadge, openSheet, segmented, select, toast } from '../ui.js';
import { clear, debounce, dueLabel, formatDate, formatDateTime, h, icon, plural } from '../util.js';
import { startWithIds } from './learn.js';

const PAGE_SIZE = 40;
const STATUS_ITEMS = [
  { value: '', label: 'Alle' },
  { value: 'due', label: 'Fällig' },
  { value: 'new', label: 'Neu' },
  { value: 'active', label: 'Aktiv' },
  { value: 'mastered', label: 'Gekonnt' },
];
const SORT_ITEMS = [
  { value: 'due', label: 'Fälligkeit' },
  { value: 'level', label: 'Level' },
  { value: 'points', label: 'Punkte' },
];
const SORT_LABELS = { due: 'Fälligkeit', level: 'Level', points: 'Punkte' };
const STATUS_CHIP = { new: 'chip-new', due: 'chip-due', active: 'chip-active', mastered: 'chip-mastered' };

const listState = {
  search: '',
  deckId: '',
  categoryId: '',
  subcategoryId: '',
  status: '',
  sort: 'due',
  descending: false,
  pages: 1,
  selecting: false,
  selected: new Set(),
};

function activeFilterCount() {
  return ['deckId', 'categoryId', 'subcategoryId'].filter((key) => listState[key]).length + (listState.sort !== 'due' || listState.descending ? 1 : 0);
}

function baseCards() {
  const needle = listState.search.trim().toLocaleLowerCase('de');
  return store.cards().filter((card) => {
    if (listState.deckId && card.deck_id !== listState.deckId) return false;
    if (listState.categoryId && card.category_id !== listState.categoryId) return false;
    if (listState.subcategoryId && card.subcategory_id !== listState.subcategoryId) return false;
    if (needle) {
      const haystack = `${card.question}\n${card.answer}\n${card.category || ''}\n${card.subcategory || ''}`.toLocaleLowerCase('de');
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

function filteredCards(base = baseCards()) {
  const now = new Date();
  const result = base.filter((card) => !listState.status || store.statusOf(card, now) === listState.status);
  const direction = listState.descending ? -1 : 1;
  const dueValue = (card) => (card.next_review ? new Date(card.next_review).getTime() : Number.MAX_SAFE_INTEGER);
  result.sort((a, b) => {
    let diff = 0;
    if (listState.sort === 'level') diff = (a.mastered - b.mastered) || (a.level - b.level) || (a.points - b.points);
    else if (listState.sort === 'points') diff = (a.points - b.points) || (a.level - b.level);
    else diff = dueValue(a) - dueValue(b);
    return diff * direction || String(a.question).localeCompare(String(b.question), 'de');
  });
  return result;
}

function cardRow(card, onActivate, onLongPress) {
  const status = store.statusOf(card);
  const path = [store.deckName(card), card.category, card.subcategory].filter(Boolean).join(' › ');
  const images = [...(card.question_images || []), ...(card.answer_images || [])];
  const selected = listState.selected.has(card.id);
  const level = Math.min(10, Math.max(1, Number(card.level) || 1));
  const thumb = images.length
    ? h('span', { class: 'card-row-thumb', 'aria-hidden': 'true' },
      imageElement({ url: `/api/media/${encodeURIComponent(images[0])}`, mediaId: images[0], alt: '' }),
      images.length > 1 ? h('span', { class: 'thumb-count', text: `+${images.length - 1}` }) : null)
    : null;
  const row = h('button', {
    class: `card-row${selected ? ' is-selected' : ''}`,
    type: 'button',
    dataset: { id: card.id },
    vars: { '--lv': card.mastered ? 'var(--mastered)' : `var(--lv-${level})` },
    'aria-pressed': listState.selecting ? String(selected) : undefined,
  },
  h('span', { class: 'card-row-rail', 'aria-hidden': 'true' }),
  h('span', { class: 'card-row-check', 'aria-hidden': 'true' }, icon('check')),
  h('span', { class: 'card-row-body' },
    h('span', { class: 'card-row-question', text: card.question }),
    h('span', { class: 'card-row-path', text: path }),
    h('span', { class: 'card-row-meta' },
      levelBadge(card),
      h('span', { class: 'chip', text: `${card.points} P.` }),
      h('span', { class: `chip ${STATUS_CHIP[status]}`, text: status === 'mastered' ? 'Gekonnt' : dueLabel(card) }))),
  thumb);

  let timer = null;
  let longPressed = false;
  let startX = 0;
  let startY = 0;
  row.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    longPressed = false;
    startX = event.clientX;
    startY = event.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => {
      longPressed = true;
      try { if (navigator.vibrate) navigator.vibrate(14); } catch { /* not supported */ }
      onLongPress(card);
    }, 460);
  });
  row.addEventListener('pointermove', (event) => {
    if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) clearTimeout(timer);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) row.addEventListener(type, () => clearTimeout(timer));
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!longPressed) {
      longPressed = true;
      onLongPress(card);
    }
  });
  row.addEventListener('click', (event) => {
    if (longPressed) {
      event.preventDefault();
      longPressed = false;
      return;
    }
    onActivate(card);
  });
  return row;
}

// -- list ----------------------------------------------------------------------
function renderList(view, ctx) {
  const listHost = h('div', { class: 'card-list', id: 'card-list', role: 'list' });
  const countEl = h('p', { class: 'result-count', id: 'card-count', 'aria-live': 'polite' });
  const footer = h('div', { class: 'list-footer', id: 'card-list-end' });
  const chipsHost = h('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Status' });
  const badge = h('span', { class: 'btn-badge', hidden: true });
  const filterButton = h('button', { class: 'btn btn-icon relative', type: 'button', id: 'card-filter', 'aria-label': 'Filter und Sortierung', on: { click: () => openFilterSheet(update) } }, icon('filter'), badge);
  const searchInput = h('input', {
    class: 'input', type: 'search', id: 'card-search', placeholder: 'Karten durchsuchen', value: listState.search,
    autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Karten durchsuchen',
  });
  searchInput.addEventListener('input', debounce(() => {
    listState.search = searchInput.value;
    listState.pages = 1;
    update();
  }, 150));
  let bulkbar = null;
  let rendered = 0;
  let current = [];

  const appendPage = () => {
    const next = current.slice(rendered, rendered + PAGE_SIZE);
    const fragment = document.createDocumentFragment();
    for (const card of next) fragment.append(h('div', { role: 'listitem' }, cardRow(card, activate, longPress)));
    listHost.append(fragment);
    rendered += next.length;
    clear(footer);
    if (rendered < current.length) {
      footer.append(h('button', { class: 'btn btn-secondary', type: 'button', id: 'card-more', on: { click: appendPage } }, `Weitere ${Math.min(PAGE_SIZE, current.length - rendered)} anzeigen`));
    }
  };

  // Infinite scroll: the next page appears before the end is reached.
  const observer = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && rendered < current.length) appendPage();
  }, { rootMargin: '600px 0px' }) : null;
  if (observer) observer.observe(footer);

  function renderChips(base) {
    clear(chipsHost);
    const now = new Date();
    const counts = { '': base.length, due: 0, new: 0, active: 0, mastered: 0 };
    for (const card of base) counts[store.statusOf(card, now)] += 1;
    for (const item of STATUS_ITEMS) {
      chipsHost.append(h('button', {
        class: 'filter-chip', type: 'button', dataset: { status: item.value || 'all' }, id: `card-status-${item.value || 'all'}`,
        'aria-pressed': String(listState.status === item.value),
        on: { click: () => { listState.status = item.value; listState.pages = 1; update(); } },
      }, item.label, h('span', { class: 'count', text: String(counts[item.value]) })));
    }
  }

  function update() {
    const base = baseCards();
    current = filteredCards(base);
    renderChips(base);
    const filters = activeFilterCount();
    badge.hidden = !filters;
    badge.textContent = String(filters);
    filterButton.classList.toggle('is-active', Boolean(filters));
    countEl.textContent = `${plural(current.length, 'Karte', 'Karten')} · sortiert nach ${SORT_LABELS[listState.sort]} ${listState.descending ? '↓' : '↑'}`;
    clear(listHost);
    rendered = 0;
    listHost.classList.toggle('is-selecting', listState.selecting);
    if (!store.state.cards.size) {
      listHost.append(emptyState('cards', 'Noch keine Karten', 'Lege deine erste Karte an – sie erscheint nach dem Speichern auch auf deinen anderen Geräten.',
        h('a', { class: 'btn btn-primary', href: '#/karten/neu' }, icon('plus'), 'Neue Karte')));
    } else if (!current.length) {
      listHost.append(emptyState('search', 'Keine Treffer', 'Suche oder Filter anpassen.'));
    }
    appendPage();
    while (rendered < Math.min(current.length, listState.pages * PAGE_SIZE)) appendPage();
    renderBulkbar();
  }

  function activate(card) {
    if (listState.selecting) toggleSelection(card.id);
    else ctx.navigate(`#/karten/${encodeURIComponent(card.id)}`);
  }

  function longPress(card) {
    if (!listState.selecting) {
      listState.selecting = true;
      listState.selected = new Set();
    }
    toggleSelection(card.id, true);
  }

  function toggleSelection(id, forceOn = false) {
    if (listState.selected.has(id) && !forceOn) listState.selected.delete(id);
    else listState.selected.add(id);
    if (!listState.selected.size) listState.selecting = false;
    refreshSelection();
  }

  // Update the rows in place: no re-render, the scroll position stays.
  function refreshSelection() {
    listHost.classList.toggle('is-selecting', listState.selecting);
    for (const row of listHost.querySelectorAll('.card-row')) {
      const selected = listState.selected.has(row.dataset.id);
      row.classList.toggle('is-selected', selected);
      if (listState.selecting) row.setAttribute('aria-pressed', String(selected));
      else row.removeAttribute('aria-pressed');
    }
    renderBulkbar();
  }

  function endSelection() {
    listState.selecting = false;
    listState.selected = new Set();
    update();
  }

  function renderBulkbar() {
    if (bulkbar) bulkbar.remove();
    bulkbar = null;
    if (!listState.selecting) return;
    const ids = [...listState.selected].filter((id) => store.card(id));
    const count = ids.length;
    bulkbar = h('div', { class: 'bulkbar', id: 'bulkbar', role: 'toolbar', 'aria-label': 'Aktionen für ausgewählte Karten' },
      h('div', { class: 'bulkbar-head' },
        h('span', { id: 'bulk-count', text: `${count} ausgewählt` }),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Alle sichtbaren auswählen', on: { click: () => { for (const card of current) listState.selected.add(card.id); refreshSelection(); } } }, icon('select')),
          h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Auswahl beenden', id: 'bulk-cancel', on: { click: endSelection } }, icon('x')))),
      h('div', { class: 'bulkbar-actions' },
        bulkButton('move', 'Verschieben', 'move', count, () => openMoveSheet(ids, false, endSelection)),
        bulkButton('category', 'Kategorie', 'label', count, () => openMoveSheet(ids, true, endSelection)),
        bulkButton('mastered', 'Gekonnt', 'star', count, () => bulkMastered(ids, endSelection)),
        bulkButton('delete', 'Löschen', 'trash', count, () => bulkDelete(ids, endSelection), true)));
    document.body.append(bulkbar);
  }

  const selectButton = h('button', {
    class: 'btn btn-icon', type: 'button', id: 'card-select-mode', 'aria-label': 'Mehrere Karten auswählen',
    on: { click: () => { listState.selecting = !listState.selecting; listState.selected = new Set(); update(); } },
  }, icon('select'));
  const newButton = h('a', { class: 'btn btn-icon', href: '#/karten/neu', id: 'card-new', 'aria-label': 'Neue Karte' }, icon('plus'));
  ctx.setTopbar({ title: 'Karten', eyebrow: 'Verwaltung', actions: [selectButton, newButton] });

  view.append(
    h('div', { class: 'search', role: 'search' },
      h('div', { class: 'search-field' }, icon('search'), searchInput),
      filterButton),
    chipsHost,
    h('div', { class: 'stack' }, countEl, listHost, footer));
  update();
  return {
    onData: update,
    cleanup: () => {
      if (bulkbar) bulkbar.remove();
      if (observer) observer.disconnect();
    },
  };
}

function bulkButton(key, label, iconName, count, onClick, danger = false) {
  return h('button', {
    class: `bulk-action${danger ? ' is-danger' : ''}`, type: 'button', id: `bulk-${key}`, disabled: !count,
    on: {
      click: () => {
        if (!isCloud() && !navigator.onLine) {
          toast('Für diese Aktion wird eine Verbindung benötigt.', { tone: 'error' });
          return;
        }
        onClick();
      },
    },
  }, icon(iconName), label);
}

async function runBulk(body, successText, done) {
  try {
    const result = await api.post('/api/cards/bulk', body);
    toast(`${successText} (${result.affected})`, { tone: 'success' });
    await done();
    if (!isCloud()) await sync.pull().catch(() => {});
  } catch (error) {
    toast(errorMessage(error), { tone: 'error' });
  }
}

function openMoveSheet(ids, requireCategory, done) {
  const decks = store.decks();
  if (!decks.length) return;
  const deckSelect = select(decks.map((deck) => ({ value: deck.id, label: deck.name })), decks[0].id, { id: 'move-deck' });
  const categorySelect = select([], '', { id: 'move-category' });
  const subcategorySelect = select([], '', { id: 'move-subcategory' });
  const fillCategories = () => {
    clear(categorySelect);
    categorySelect.append(h('option', { value: '', text: requireCategory ? 'Kategorie wählen …' : 'Keine Kategorie' }));
    for (const item of store.categoriesOf(deckSelect.value)) categorySelect.append(h('option', { value: item.id, text: item.name }));
    fillSubcategories();
  };
  const fillSubcategories = () => {
    clear(subcategorySelect);
    subcategorySelect.append(h('option', { value: '', text: 'Keine Unterkategorie' }));
    for (const item of store.subcategoriesOf(categorySelect.value)) subcategorySelect.append(h('option', { value: item.id, text: item.name }));
    subcategorySelect.disabled = !categorySelect.value;
  };
  deckSelect.addEventListener('change', fillCategories);
  categorySelect.addEventListener('change', fillSubcategories);
  fillCategories();
  const hint = h('p', { class: 'muted small', text: requireCategory
    ? 'Kategorien gehören zu einem Deck. Die Karten werden dafür in das gewählte Deck übernommen.'
    : 'Die Karten wechseln in das gewählte Deck. Lernstand und Bilder bleiben erhalten.' });
  openSheet({
    title: requireCategory ? `Kategorie für ${plural(ids.length, 'Karte', 'Karten')}` : `${plural(ids.length, 'Karte', 'Karten')} verschieben`,
    body: [hint, field('Deck', deckSelect), field('Kategorie', categorySelect), field('Unterkategorie', subcategorySelect)],
    actions: [{
      label: requireCategory ? 'Kategorie setzen' : 'Verschieben',
      variant: 'btn-primary',
      id: 'move-confirm',
      onClick: async (sheet) => {
        if (requireCategory && !categorySelect.value) {
          toast('Bitte eine Kategorie wählen.');
          return;
        }
        sheet.setBusy(true);
        await runBulk({
          action: 'move',
          card_ids: ids,
          deck_id: deckSelect.value,
          category_id: categorySelect.value || null,
          subcategory_id: subcategorySelect.value || null,
        }, requireCategory ? 'Kategorie gesetzt' : 'Verschoben', done);
        sheet.close();
      },
    }],
  });
}

async function bulkMastered(ids, done) {
  const ok = await confirmDialog({
    title: `${plural(ids.length, 'Karte', 'Karten')} als gekonnt markieren?`,
    text: `Gekonnte Karten erhalten die Höchstpunktzahl${store.state.meta.mastered_points ? ` (${store.state.meta.mastered_points})` : ''} und werden nicht mehr automatisch wiederholt.`,
    confirm: 'Als gekonnt markieren',
    icon: 'star',
  });
  if (ok) await runBulk({ action: 'mastered', card_ids: ids }, 'Als gekonnt markiert', done);
}

async function bulkDelete(ids, done) {
  const ok = await confirmDialog({
    title: `${plural(ids.length, 'Karte', 'Karten')} löschen?`,
    text: 'Die Karten werden auf allen Geräten endgültig gelöscht.',
    confirm: 'Endgültig löschen',
    danger: true,
    icon: 'trash',
  });
  if (!ok) return;
  await runBulk({ action: 'delete', card_ids: ids }, 'Gelöscht', async () => {
    if (!isCloud()) await store.forgetCards(ids);
    done();
  });
}

function openFilterSheet(onApply) {
  const values = { ...listState };
  const deckSelect = select([], '', { id: 'cf-deck' });
  const categorySelect = select([], '', { id: 'cf-category' });
  const subcategorySelect = select([], '', { id: 'cf-subcategory' });
  const fill = (element, options, value) => {
    clear(element);
    for (const option of options) element.append(h('option', { value: option.value, text: option.label }));
    element.value = options.some((option) => option.value === value) ? value : '';
  };
  const refresh = () => {
    fill(deckSelect, [{ value: '', label: 'Alle Decks' }, ...store.decks().map((deck) => ({ value: deck.id, label: deck.name }))], values.deckId);
    values.deckId = deckSelect.value;
    fill(categorySelect, [{ value: '', label: 'Alle Kategorien' }, ...store.categoriesOf(values.deckId || null).map((item) => ({ value: item.id, label: item.name }))], values.categoryId);
    values.categoryId = categorySelect.value;
    fill(subcategorySelect, [{ value: '', label: 'Alle Unterkategorien' }, ...(values.categoryId ? store.subcategoriesOf(values.categoryId) : []).map((item) => ({ value: item.id, label: item.name }))], values.subcategoryId);
    subcategorySelect.disabled = !values.categoryId;
    values.subcategoryId = subcategorySelect.value;
  };
  deckSelect.addEventListener('change', () => { values.deckId = deckSelect.value; values.categoryId = ''; values.subcategoryId = ''; refresh(); });
  categorySelect.addEventListener('change', () => { values.categoryId = categorySelect.value; values.subcategoryId = ''; refresh(); });
  subcategorySelect.addEventListener('change', () => { values.subcategoryId = subcategorySelect.value; });
  refresh();
  const directionButton = h('button', {
    class: 'btn btn-secondary btn-sm', type: 'button', id: 'cf-direction',
    text: values.descending ? 'Absteigend ↓' : 'Aufsteigend ↑',
    on: { click: () => { values.descending = !values.descending; directionButton.textContent = values.descending ? 'Absteigend ↓' : 'Aufsteigend ↑'; } },
  });
  const apply = (sheet) => {
    Object.assign(listState, {
      deckId: values.deckId,
      categoryId: values.categoryId,
      subcategoryId: values.subcategoryId,
      status: values.status,
      sort: values.sort,
      descending: values.descending,
      pages: 1,
    });
    sheet.close();
    onApply();
  };
  openSheet({
    title: 'Filter & Sortierung',
    body: [
      field('Deck', deckSelect),
      field('Kategorie', categorySelect),
      field('Unterkategorie', subcategorySelect),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Status' }),
        segmented(STATUS_ITEMS, values.status, (value) => { values.status = value; }, 'Status', { fit: true })),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Sortierung' }),
        segmented(SORT_ITEMS, values.sort, (value) => { values.sort = value; }, 'Sortierung'),
        h('div', { class: 'row' }, directionButton)),
    ],
    actions: [
      {
        label: 'Zurücksetzen',
        variant: 'btn-secondary',
        id: 'cf-reset',
        onClick: (sheet) => {
          Object.assign(values, { deckId: '', categoryId: '', subcategoryId: '', status: '', sort: 'due', descending: false });
          apply(sheet);
        },
      },
      { label: 'Anwenden', variant: 'btn-primary', id: 'cf-apply', onClick: apply },
    ],
  });
}

// -- detail --------------------------------------------------------------------
function fact(label, value, wide = false) {
  return h('div', { class: `fact${wide ? ' fact-wide' : ''}` }, h('dt', { text: label }), h('dd', {}, value));
}

function renderDetail(view, ctx, cardId) {
  const card = store.card(cardId);
  if (!card) {
    view.append(emptyState('cards', 'Karte nicht gefunden', 'Sie wurde vielleicht auf einem anderen Gerät gelöscht.',
      h('a', { class: 'btn btn-secondary', href: '#/karten' }, 'Zur Kartenliste')));
    return {};
  }
  const status = store.statusOf(card);
  const range = store.levelRange(card.level);
  const progress = card.mastered ? 100 : range ? Math.round(((card.points - range.min_points) / Math.max(1, range.max_points - range.min_points + 1)) * 100) : 0;
  const levelText = card.mastered ? 'Gekonnt' : `Level ${card.level}${range ? ` · ${range.min_points}–${range.max_points} Punkte` : ''}`;
  const editButton = h('a', { class: 'btn btn-icon', href: `#/karten/${encodeURIComponent(card.id)}/bearbeiten`, 'aria-label': 'Karte bearbeiten' }, icon('edit'));
  ctx.setTopbar({ title: 'Karte', eyebrow: store.deckName(card), back: '#/karten', actions: [editButton] });

  view.append(h('div', { class: 'stack-lg', id: 'card-detail' },
    h('section', { class: 'card detail-section' },
      h('h2', { class: 'detail-label', text: 'Frage' }),
      h('p', { class: 'detail-text is-question', id: 'detail-question', text: card.question }),
      thumbGrid(cardImages(card.question_images, 'question'), { label: 'Fragebilder' })),
    h('section', { class: 'card detail-section' },
      h('h2', { class: 'detail-label', text: 'Antwort' }),
      card.answer ? h('p', { class: 'detail-text', id: 'detail-answer', text: card.answer }) : h('p', { class: 'muted', text: 'Nur Bildantwort' }),
      thumbGrid(cardImages(card.answer_images, 'answer'), { label: 'Antwortbilder' })),
    h('section', { class: 'card detail-section' },
      h('h2', { class: 'detail-label', text: 'Lernstand' }),
      h('div', { class: 'level-hero' },
        h('div', { class: 'ring', role: 'img', 'aria-label': levelText, vars: { '--value': String(Math.max(0, Math.min(100, progress))), '--fill': card.mastered ? 'var(--mastered)' : `var(--lv-${Math.min(10, Math.max(1, card.level))})` } },
          h('span', {}, card.mastered ? '★' : `L${card.level}`)),
        h('div', { class: 'spacer' },
          h('p', { class: 'strong', text: levelText }),
          h('p', { class: 'small muted', text: `${card.points} Punkte · ${store.STATUS_LABELS[status]}` }),
          h('p', { class: 'small muted', text: card.mastered ? 'Keine automatische Wiederholung' : `${dueLabel(card)} · ${formatDate(card.next_review)}` }))),
      h('dl', { class: 'facts' },
        fact('Deck', store.deckName(card)),
        fact('Kategorie', [card.category, card.subcategory].filter(Boolean).join(' › ') || '–'),
        fact('Serie richtig', String(card.positive_streak)),
        fact('Fehler gesamt', String(card.total_incorrect_count)),
        fact('Zuletzt gelernt', card.last_reviewed ? formatDateTime(card.last_reviewed) : 'Noch nie', true),
        card.recovery_mode ? fact('Erholung', `Intervall ${card.recovery_interval} Tag(e)`, true) : null)),
    h('button', { class: 'btn btn-danger-soft btn-block', type: 'button', id: 'detail-delete', on: { click: () => deleteCard(card, ctx) } }, icon('trash'), 'Karte löschen'),
    h('div', { class: 'action-bar' },
      h('a', { class: 'btn btn-secondary btn-lg', href: `#/karten/${encodeURIComponent(card.id)}/bearbeiten`, id: 'detail-edit' }, icon('edit'), 'Bearbeiten'),
      h('button', { class: 'btn btn-primary btn-lg', type: 'button', id: 'detail-learn', on: { click: () => startWithIds([card.id], ctx.navigate) } }, icon('play'), 'Jetzt lernen'))));
  return {};
}

async function deleteCard(card, ctx, force = false) {
  if (!force) {
    const ok = await confirmDialog({ title: 'Karte löschen?', text: 'Die Karte wird auf allen Geräten endgültig gelöscht.', confirm: 'Löschen', danger: true, icon: 'trash' });
    if (!ok) return;
  }
  try {
    const params = new URLSearchParams({ base_content_hash: card.content_hash || '' });
    if (force) params.set('force', 'true');
    await api.del(`/api/cards/${encodeURIComponent(card.id)}?${params}`);
    if (!isCloud()) await store.forgetCards([card.id]);
    toast('Karte gelöscht', { tone: 'success' });
    ctx.navigate('#/karten');
    if (!isCloud()) sync.pull().catch(() => {});
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const ok = await confirmDialog({
        title: 'Karte wurde geändert',
        text: 'Die Karte wurde inzwischen auf einem anderen Gerät bearbeitet. Trotzdem löschen?',
        confirm: 'Trotzdem löschen',
        danger: true,
      });
      if (ok) await deleteCard(card, ctx, true);
      else if (error.body && error.body.current) await store.rememberCard(error.body.current);
    } else if (error instanceof ApiError && error.status === 404) {
      await store.forgetCards([card.id]);
      ctx.navigate('#/karten');
    } else {
      toast(errorMessage(error), { tone: 'error' });
    }
  }
}

export default {
  list: {
    area: 'cards',
    tab: 'karten',
    live: true,
    title: () => ({ title: 'Karten', eyebrow: 'Verwaltung' }),
    render: renderList,
  },
  detail: {
    area: 'cards',
    tab: 'karten',
    live: true,
    title: () => ({ title: 'Karte', back: '#/karten' }),
    render: renderDetail,
  },
};
