// Touch-friendly card editor for new and existing cards.
//
// Cloud mode: saving works offline on the active device; the change is
// committed to the cloud in the background.  Server mode: saving needs a
// connection; new cards carry a client-generated ID (a retried save never
// creates a duplicate) and edits send the content hash they started from –
// when another device changed the card meanwhile, the user decides.

import { api, ApiError, errorMessage, NetworkError } from '../api.js';
import { isCloud } from '../config.js';
import { fileInput, imageElement, mediaUrl, openLightbox, pickImageSources, uploadImage } from '../images.js';
import * as store from '../store.js';
import * as sync from '../sync.js';
import { confirmDialog, field, openSheet, toast } from '../ui.js';
import { clear, h, icon, uuid } from '../util.js';

const NEW = '__new__';

function initialDraft(card) {
  if (!card) {
    const decks = store.decks();
    const lastDeck = sessionStorageGet('fc-last-deck');
    const deckId = decks.some((deck) => deck.id === lastDeck) ? lastDeck : (decks[0] ? decks[0].id : NEW);
    return {
      clientId: uuid(),
      question: '',
      answer: '',
      questionImages: [],
      answerImages: [],
      deckId,
      deckName: '',
      categoryId: '',
      categoryName: '',
      subcategoryId: '',
      subcategoryName: '',
    };
  }
  return {
    clientId: card.id,
    question: card.question,
    answer: card.answer,
    questionImages: [...(card.question_images || [])],
    answerImages: [...(card.answer_images || [])],
    deckId: card.deck_id,
    deckName: '',
    categoryId: card.category_id || '',
    categoryName: '',
    subcategoryId: card.subcategory_id || '',
    subcategoryName: '',
  };
}

function sessionStorageGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function sessionStorageSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* private mode */ }
}

function render(view, ctx, cardId) {
  const existing = cardId ? store.card(cardId) : null;
  if (cardId && !existing) {
    view.append(h('p', { class: 'form-error', text: 'Diese Karte gibt es nicht mehr.' }));
    return {};
  }
  const draft = initialDraft(existing);
  const original = JSON.stringify(draft);
  const uploaded = [];
  let saving = false;

  const offlineBanner = h('p', { class: 'banner', id: 'editor-offline', hidden: isCloud() || navigator.onLine },
    icon('offline', 'icon-sm'), 'Offline – Speichern und Bilder hochladen gehen erst wieder mit Verbindung.');
  const errorBox = h('p', { class: 'form-error', role: 'alert', id: 'editor-error', hidden: true });
  const onlineChange = () => { offlineBanner.hidden = isCloud() || navigator.onLine; };
  window.addEventListener('online', onlineChange);
  window.addEventListener('offline', onlineChange);

  const question = h('textarea', { class: 'textarea textarea-lg', id: 'editor-question', rows: '4', placeholder: 'Was möchtest du wissen?', maxlength: '20000' });
  question.value = draft.question;
  question.addEventListener('input', () => { draft.question = question.value; });
  const answer = h('textarea', { class: 'textarea', id: 'editor-answer', rows: '5', placeholder: 'Antwort (oder nur Bilder)', maxlength: '50000' });
  answer.value = draft.answer;
  answer.addEventListener('input', () => { draft.answer = answer.value; });

  const questionGallery = imageEditor('question', draft.questionImages, uploaded);
  const answerGallery = imageEditor('answer', draft.answerImages, uploaded);

  // -- hierarchy pickers ------------------------------------------------------
  const deckSelect = h('select', { class: 'select', id: 'editor-deck' });
  const deckNew = h('input', { class: 'input', id: 'editor-deck-new', placeholder: 'Name des neuen Decks', maxlength: '200', hidden: true });
  const categorySelect = h('select', { class: 'select', id: 'editor-category' });
  const categoryNew = h('input', { class: 'input', id: 'editor-category-new', placeholder: 'Name der neuen Kategorie', maxlength: '200', hidden: true });
  const subcategorySelect = h('select', { class: 'select', id: 'editor-subcategory' });
  const subcategoryNew = h('input', { class: 'input', id: 'editor-subcategory-new', placeholder: 'Name der neuen Unterkategorie', maxlength: '200', hidden: true });

  const fill = (element, options, value) => {
    clear(element);
    for (const option of options) element.append(h('option', { value: option.value, text: option.label }));
    element.value = options.some((option) => option.value === value) ? value : options[0].value;
  };
  const refreshPickers = () => {
    fill(deckSelect, [...store.decks().map((deck) => ({ value: deck.id, label: deck.name })), { value: NEW, label: '＋ Neues Deck …' }], draft.deckId);
    draft.deckId = deckSelect.value;
    deckNew.hidden = draft.deckId !== NEW;
    const categories = draft.deckId === NEW ? [] : store.categoriesOf(draft.deckId);
    fill(categorySelect, [{ value: '', label: 'Keine Kategorie' }, ...categories.map((item) => ({ value: item.id, label: item.name })), { value: NEW, label: '＋ Neue Kategorie …' }], draft.categoryId);
    draft.categoryId = categorySelect.value;
    categoryNew.hidden = draft.categoryId !== NEW;
    const subcategories = draft.categoryId && draft.categoryId !== NEW ? store.subcategoriesOf(draft.categoryId) : [];
    fill(subcategorySelect, [{ value: '', label: 'Keine Unterkategorie' }, ...subcategories.map((item) => ({ value: item.id, label: item.name })), { value: NEW, label: '＋ Neue Unterkategorie …' }], draft.subcategoryId);
    subcategorySelect.disabled = !draft.categoryId;
    draft.subcategoryId = draft.categoryId ? subcategorySelect.value : '';
    subcategoryNew.hidden = draft.subcategoryId !== NEW;
  };
  deckSelect.addEventListener('change', () => {
    draft.deckId = deckSelect.value;
    draft.categoryId = '';
    draft.subcategoryId = '';
    refreshPickers();
    if (draft.deckId === NEW) deckNew.focus();
  });
  categorySelect.addEventListener('change', () => {
    draft.categoryId = categorySelect.value;
    draft.subcategoryId = '';
    refreshPickers();
    if (draft.categoryId === NEW) categoryNew.focus();
  });
  subcategorySelect.addEventListener('change', () => {
    draft.subcategoryId = subcategorySelect.value;
    refreshPickers();
    if (draft.subcategoryId === NEW) subcategoryNew.focus();
  });
  deckNew.addEventListener('input', () => { draft.deckName = deckNew.value; });
  categoryNew.addEventListener('input', () => { draft.categoryName = categoryNew.value; });
  subcategoryNew.addEventListener('input', () => { draft.subcategoryName = subcategoryNew.value; });
  refreshPickers();

  // -- save ----------------------------------------------------------------------
  const isDirty = () => JSON.stringify(draft) !== original;
  const leave = () => {
    if (existing) ctx.navigate(`#/karten/${encodeURIComponent(existing.id)}`, { replace: true });
    else history.length > 1 ? history.back() : ctx.navigate('#/karten');
  };
  const cancel = async () => {
    if (isDirty()) {
      const ok = await confirmDialog({ title: 'Änderungen verwerfen?', text: 'Deine Eingaben gehen verloren.', confirm: 'Verwerfen', danger: true });
      if (!ok) return;
    }
    // Images added for this unsaved card are not attached anywhere.
    for (const mediaId of uploaded) api.del(`/api/media/${encodeURIComponent(mediaId)}`).catch(() => {});
    leave();
  };

  const hierarchyPayload = () => {
    const payload = {};
    if (draft.deckId === NEW) payload.deck_name = draft.deckName.trim();
    else payload.deck_id = draft.deckId;
    if (draft.categoryId === NEW) payload.category_name = draft.categoryName.trim();
    else payload.category_id = draft.categoryId || null;
    if (draft.subcategoryId === NEW) payload.subcategory_name = draft.subcategoryName.trim();
    else payload.subcategory_id = draft.subcategoryId || null;
    return payload;
  };

  const validate = () => {
    if (!draft.question.trim()) return 'Bitte eine Frage eingeben.';
    if (!draft.answer.trim() && !draft.answerImages.length) return 'Bitte eine Antwort eingeben oder ein Antwortbild hinzufügen.';
    if (draft.deckId === NEW && !draft.deckName.trim()) return 'Bitte einen Namen für das neue Deck eingeben.';
    if (draft.categoryId === NEW && !draft.categoryName.trim()) return 'Bitte einen Namen für die neue Kategorie eingeben.';
    if (draft.subcategoryId === NEW && !draft.subcategoryName.trim()) return 'Bitte einen Namen für die neue Unterkategorie eingeben.';
    return '';
  };

  const save = async (force = false) => {
    if (saving) return;
    const problem = validate();
    errorBox.hidden = !problem;
    errorBox.textContent = problem;
    if (problem) {
      errorBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    saving = true;
    saveButton.disabled = true;
    try {
      const content = {
        question: draft.question,
        answer: draft.answer,
        question_images: draft.questionImages,
        answer_images: draft.answerImages,
        ...hierarchyPayload(),
      };
      let card;
      if (existing) {
        card = await api.patch(`/api/cards/${encodeURIComponent(existing.id)}`, {
          ...content,
          base_version: existing.version,
          base_content_hash: existing.content_hash,
          force,
        });
      } else {
        card = await api.post('/api/cards', { id: draft.clientId, ...content });
      }
      if (!isCloud()) await store.rememberCard(card);
      sessionStorageSet('fc-last-deck', card.deck_id);
      uploaded.length = 0;
      toast(existing ? 'Änderungen gespeichert' : 'Karte angelegt', { tone: 'success' });
      if (!isCloud()) sync.pull().catch(() => {});
      ctx.navigate(`#/karten/${encodeURIComponent(card.id)}`, { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && existing) {
        showConflict(error.body.current, draft, existing, ctx, () => save(true));
      } else if (error instanceof NetworkError) {
        errorBox.textContent = 'Keine Verbindung – die Karte wurde nicht gespeichert. Bitte erneut versuchen, sobald du online bist.';
        errorBox.hidden = false;
      } else {
        errorBox.textContent = errorMessage(error);
        errorBox.hidden = false;
      }
    } finally {
      saving = false;
      saveButton.disabled = false;
    }
  };

  const saveButton = h('button', { class: 'btn btn-primary btn-lg', type: 'button', id: 'editor-save', on: { click: () => save(false) } }, icon('check'), 'Speichern');
  ctx.setTopbar({
    title: existing ? 'Karte bearbeiten' : 'Neue Karte',
    eyebrow: 'Karten',
    back: existing ? `#/karten/${encodeURIComponent(existing.id)}` : '#/karten',
  });

  view.append(h('form', { class: 'stack-lg', id: 'editor', novalidate: true, on: { submit: (event) => { event.preventDefault(); save(false); } } },
    offlineBanner,
    errorBox,
    h('section', { class: 'card stack' },
      field('Frage', question),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Fragebilder' }), questionGallery.element)),
    h('section', { class: 'card stack' },
      field('Antwort', answer),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Antwortbilder' }), answerGallery.element)),
    h('section', { class: 'card stack' },
      field('Deck', deckSelect), deckNew,
      field('Kategorie', categorySelect), categoryNew,
      field('Unterkategorie', subcategorySelect), subcategoryNew),
    h('div', { class: 'action-bar' },
      h('button', { class: 'btn btn-secondary btn-lg', type: 'button', id: 'editor-cancel', on: { click: cancel } }, 'Abbrechen'),
      saveButton)));

  // Keep the two image lists of the draft in sync with their editors.
  questionGallery.bind((ids) => { draft.questionImages = ids; });
  answerGallery.bind((ids) => { draft.answerImages = ids; });

  if (!existing) requestAnimationFrame(() => question.focus());
  return {
    cleanup: () => {
      window.removeEventListener('online', onlineChange);
      window.removeEventListener('offline', onlineChange);
    },
  };
}

function imageEditor(side, ids, uploadedRegistry) {
  const label = side === 'answer' ? 'Antwortbild' : 'Fragebild';
  const list = [...ids];
  let onChange = () => {};
  let busy = 0;
  const grid = h('div', { class: 'edit-strip', id: `editor-${side}-images` });
  const inputs = h('div', {});
  const sources = pickImageSources();
  const inputByKey = new Map(sources.map((source) => {
    const input = fileInput(source, (files) => addFiles(files));
    input.id = `editor-${side}-input-${source.key}`;
    inputs.append(input);
    return [source.key, input];
  }));

  async function addFiles(files) {
    if (!isCloud() && !navigator.onLine) {
      toast('Bilder können nur mit Verbindung hochgeladen werden.', { tone: 'error' });
      return;
    }
    for (const file of files) {
      busy += 1;
      draw();
      try {
        const media = await uploadImage(file);
        list.push(media.id);
        uploadedRegistry.push(media.id);
        onChange([...list]);
      } catch (error) {
        toast(`${file.name || 'Bild'}: ${errorMessage(error)}`, { tone: 'error' });
      } finally {
        busy -= 1;
        draw();
      }
    }
  }

  function chooseSource() {
    const sheet = openSheet({
      title: `${label} hinzufügen`,
      body: [h('div', { class: 'menu-list' }, sources.map((source) => h('button', {
        class: 'menu-item', type: 'button', id: `source-${side}-${source.key}`,
        on: { click: () => { sheet.close(); inputByKey.get(source.key).click(); } },
      },
      h('span', { class: 'stat-icon tone-blue' }, icon(source.icon)),
      h('span', { class: 'menu-item-text' }, source.label, h('span', { class: 'menu-item-sub', text: source.sub })))))],
    });
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    onChange([...list]);
    draw();
  }

  function remove(index) {
    list.splice(index, 1);
    onChange([...list]);
    draw();
  }

  function draw() {
    clear(grid);
    const items = list.map((id, index) => ({ url: mediaUrl(id), mediaId: id, alt: `${label} ${index + 1}` }));
    list.forEach((id, index) => {
      const img = imageElement(items[index]);
      grid.append(h('div', { class: 'edit-thumb', dataset: { mediaId: id } },
        h('button', { class: 'thumb', type: 'button', 'aria-label': `${label} ${index + 1} vergrößern`, on: { click: () => openLightbox(items, index) } }, img),
        h('div', { class: 'edit-thumb-tools' },
          h('button', { class: 'mini-btn', type: 'button', 'aria-label': `${label} ${index + 1} nach vorne`, disabled: index === 0, on: { click: () => move(index, -1) } }, icon('chevron-left')),
          h('button', { class: 'mini-btn is-danger', type: 'button', 'aria-label': `${label} ${index + 1} entfernen`, on: { click: () => remove(index) } }, icon('trash')),
          h('button', { class: 'mini-btn', type: 'button', 'aria-label': `${label} ${index + 1} nach hinten`, disabled: index === list.length - 1, on: { click: () => move(index, 1) } }, icon('chevron-right')))));
    });
    for (let index = 0; index < busy; index += 1) {
      grid.append(h('div', { class: 'upload-tile is-busy', role: 'status' }, h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), isCloud() ? 'Speichert …' : 'Lädt hoch …'));
    }
    grid.append(h('button', { class: 'upload-tile', type: 'button', id: `editor-${side}-add`, on: { click: chooseSource } }, icon('camera'), list.length ? 'Weiteres Bild' : 'Bild hinzufügen'));
  }

  draw();
  return {
    element: h('div', {}, grid, inputs),
    bind(callback) { onChange = callback; },
  };
}

function showConflict(current, draft, existing, ctx, saveAnyway) {
  const box = (title, question, answer, tone) => h('div', { class: `conflict-box ${tone}` },
    h('p', { class: 'detail-label', text: title }),
    h('p', { class: 'strong pre', text: question }),
    h('p', { class: 'pre small', text: answer || '(nur Bilder)' }));
  openSheet({
    title: 'Karte wurde inzwischen geändert',
    body: [
      h('p', { class: 'muted', text: 'Auf einem anderen Gerät wurde diese Karte bearbeitet, nachdem du sie geöffnet hast. Welche Version soll gelten?' }),
      h('div', { class: 'conflict-grid' },
        current ? box('Server-Version', current.question, current.answer, 'is-server') : null,
        box('Deine Änderung', draft.question, draft.answer, 'is-mine')),
    ],
    stacked: true,
    actions: [
      {
        label: 'Server-Version übernehmen',
        variant: 'btn-secondary',
        id: 'conflict-server',
        onClick: async (sheet) => {
          if (current) await store.rememberCard(current);
          sheet.close();
          ctx.navigate(`#/karten/${encodeURIComponent(existing.id)}`, { replace: true });
        },
      },
      {
        label: 'Meine Änderung speichern',
        variant: 'btn-primary',
        id: 'conflict-mine',
        onClick: (sheet) => {
          sheet.close();
          saveAnyway();
        },
      },
    ],
  });
}

export default {
  create: {
    area: 'cards',
    tab: 'karten',
    editing: true,
    title: () => ({ title: 'Neue Karte', eyebrow: 'Karten', back: '#/karten' }),
    render: (view, ctx) => render(view, ctx, null),
  },
  edit: {
    area: 'cards',
    tab: 'karten',
    editing: true,
    title: () => ({ title: 'Karte bearbeiten', eyebrow: 'Karten' }),
    render: (view, ctx, cardId) => render(view, ctx, cardId),
  },
};
