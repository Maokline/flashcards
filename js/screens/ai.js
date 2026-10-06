// KI: the file-based draft inbox and the HTML test export.
// No AI provider is contacted.  Drafts are the job packages of the desktop's
// AI inbox (synchronised through the cloud provider, or held by the optional server);
// the test is a self-contained HTML file the user shares with a chat app.

import { api, ApiError, errorMessage, isLocal, NetworkError } from '../api.js';
import { thumbGrid } from '../images.js';
import * as store from '../store.js';
import * as sync from '../sync.js';
import { choices, confirmDialog, emptyState, field, openSheet, sectionTitle, segmented, select, toast, toggle } from '../ui.js';
import { clear, formatBytes, formatDateTime, h, icon, plural, uuid } from '../util.js';
import { aiTestPreset } from './learn.js';

const DRAFT_FILTERS = [
  { value: 'open', label: 'Offen' },
  { value: 'accepted', label: 'Übernommen' },
  { value: 'rejected', label: 'Papierkorb' },
  { value: 'all', label: 'Alle' },
];
const STATUS_TEXT = {
  pending: ['Offen', 'chip-due'],
  edited: ['Bearbeitet', 'chip-active'],
  accepted: ['Übernommen', 'chip-mastered'],
  rejected: ['Abgelehnt', 'chip-danger'],
};
let draftFilter = 'open';

function offlineNotice() {
  return h('p', { class: 'banner' }, icon('offline', 'icon-sm'), isLocal()
    ? 'Ein Teil der Entwurfsdateien ist noch nicht auf diesem Gerät – bitte kurz online gehen.'
    : 'Für KI-Entwürfe und KI-Tests wird eine Verbindung zum Server benötigt.');
}

/** Object URL for a generated file (cloud mode) or the server URL. */
async function fileHref(url) {
  if (!isLocal()) return `${url}?download=1`;
  return URL.createObjectURL(await api.blob(url));
}

function loading() {
  return h('div', { class: 'empty', role: 'status' }, h('div', { class: 'spinner' }), h('p', { text: 'Lädt …' }));
}

// -- hub -------------------------------------------------------------------------
function renderHub(view, ctx) {
  const jobsHost = h('div', { class: 'stack', id: 'job-list' }, loading());
  view.append(h('div', { class: 'stack-lg' },
    h('section', { class: 'hero' },
      h('p', { class: 'hero-eyebrow', text: 'KI-Werkzeuge' }),
      h('h2', { class: 'hero-title', text: 'Entwürfe & Tests' }),
      h('p', { class: 'hero-text', text: 'Prüfe KI-Kartenvorschläge oder erzeuge einen KI-Test als HTML-Datei für ChatGPT & Co.' })),
    h('a', { class: 'menu-item', href: '#/ki/test', id: 'ai-test-entry' },
      h('span', { class: 'stat-icon tone-mint' }, icon('target')),
      h('span', { class: 'menu-item-text' }, 'KI-Test erstellen', h('span', { class: 'menu-item-sub', text: 'Deck, Kategorie oder Karten wählen und HTML teilen' })),
      icon('chevron-right')),
    sectionTitle('KI-Entwürfe'),
    jobsHost));

  let alive = true;
  const load = async () => {
    try {
      const data = await api.get('/api/ai-drafts/jobs');
      if (!alive) return;
      clear(jobsHost);
      if (!data.items.length) {
        jobsHost.append(emptyState('inbox', 'Keine Entwürfe', isLocal()
          ? 'Lege ein Entwurfspaket am Desktop in den KI-Import-Ordner – es erscheint nach der nächsten Synchronisation hier.'
          : 'Importpakete erscheinen hier, sobald sie im Posteingang des Servers liegen.'));
        return;
      }
      for (const job of data.items) {
        const open = job.open || 0;
        const total = job.total || 0;
        const done = Math.max(0, total - open);
        const share = total ? Math.round((done / total) * 100) : 0;
        jobsHost.append(h('a', { class: 'card job-card', href: `#/ki/job/${encodeURIComponent(job.job_id)}`, dataset: { job: job.job_id } },
          h('span', { class: 'deck-icon tone-mint' }, icon('inbox')),
          h('span', { class: 'deck-main' },
            h('span', { class: 'deck-name', text: job.title || job.job_id }),
            h('span', { class: 'deck-meta', text: job.error ? 'Paket ist ungültig' : `${job.source_document || ''}${job.source_document ? ' · ' : ''}${done} von ${plural(total, 'Entwurf', 'Entwürfen')} geprüft` }),
            job.error ? null : h('span', { class: 'progress', 'aria-hidden': 'true' }, h('span', { class: 'progress-bar', vars: { '--value': `${share}%` } }))),
          job.error
            ? h('span', { class: 'chip chip-danger', text: 'Fehler' })
            : h('span', { class: `deck-due${open ? '' : ' is-zero'}`, text: String(open), title: 'offen' })));
      }
    } catch (error) {
      if (!alive) return;
      clear(jobsHost);
      jobsHost.append(error instanceof NetworkError ? offlineNotice() : h('p', { class: 'form-error', text: errorMessage(error) }));
    }
  };
  load();
  return { cleanup: () => { alive = false; }, onData: () => { if (isLocal()) load(); } };
}

// -- one job ---------------------------------------------------------------------
function draftTarget(draft) {
  return [draft.suggested_deck, draft.suggested_category, draft.suggested_subcategory].filter(Boolean).join(' › ');
}

function renderJob(view, ctx, jobId) {
  const host = h('div', { class: 'stack', id: 'draft-list' }, loading());
  const filterBar = segmented(DRAFT_FILTERS, draftFilter, (value) => { draftFilter = value; draw(); }, 'Entwürfe filtern', { fit: true });
  const toolbar = h('div', { class: 'stack' }, filterBar);
  view.append(h('div', { class: 'stack-lg' }, toolbar, host));
  let job = null;
  let alive = true;

  const load = async () => {
    try {
      job = await api.get(`/api/ai-drafts/jobs/${encodeURIComponent(jobId)}`);
      if (!alive) return;
      ctx.setTopbar({ title: job.title || jobId, eyebrow: 'KI-Entwürfe', back: '#/ki' });
      draw();
    } catch (error) {
      if (!alive) return;
      clear(host);
      host.append(error instanceof NetworkError ? offlineNotice() : h('p', { class: 'form-error', text: errorMessage(error) }));
    }
  };

  function visibleDrafts() {
    const drafts = job ? job.drafts : [];
    if (draftFilter === 'open') return drafts.filter((draft) => draft.status === 'pending' || draft.status === 'edited');
    if (draftFilter === 'accepted') return drafts.filter((draft) => draft.status === 'accepted');
    if (draftFilter === 'rejected') return drafts.filter((draft) => draft.status === 'rejected');
    return drafts;
  }

  function draw() {
    if (!job) return;
    clear(host);
    const drafts = visibleDrafts();
    if (draftFilter === 'rejected' && drafts.length) {
      host.append(h('button', { class: 'btn btn-danger-soft btn-block', type: 'button', id: 'empty-trash', on: { click: emptyTrash } }, icon('trash'), 'Papierkorb leeren'));
    }
    if (!drafts.length) {
      const texts = {
        open: ['Alles geprüft', 'Keine offenen Entwürfe in diesem Paket.'],
        accepted: ['Noch nichts übernommen', ''],
        rejected: ['Papierkorb ist leer', ''],
        all: ['Keine Entwürfe', ''],
      }[draftFilter];
      host.append(emptyState('inbox', texts[0], texts[1]));
      return;
    }
    for (const draft of drafts) host.append(draftCard(draft));
  }

  function draftCard(draft) {
    const [statusText, statusClass] = STATUS_TEXT[draft.status] || [draft.status, 'chip'];
    const source = [job.source_document, draft.source_note, draft.source_page ? `S. ${draft.source_page}` : ''].filter(Boolean).join(' · ');
    const images = (list, side) => thumbGrid(list.map((item, index) => ({ url: item.url, file: item.file, alt: `${side} ${index + 1}` })), { label: `${side}er` });
    const actions = [];
    if (draft.status === 'pending' || draft.status === 'edited') {
      actions.push(
        h('button', { class: 'btn btn-success', type: 'button', dataset: { action: 'accept' }, on: { click: () => accept(draft) } }, icon('check'), 'Annehmen'),
        h('button', { class: 'btn btn-secondary', type: 'button', dataset: { action: 'edit' }, on: { click: () => edit(draft) } }, icon('edit'), 'Bearbeiten'),
        h('button', { class: 'btn btn-danger-soft', type: 'button', dataset: { action: 'reject' }, on: { click: () => reject(draft) } }, icon('x'), 'Ablehnen'));
    } else if (draft.status === 'rejected') {
      actions.push(
        h('button', { class: 'btn btn-secondary', type: 'button', dataset: { action: 'restore' }, on: { click: () => restore(draft) } }, icon('undo'), 'Zurückholen'),
        h('button', { class: 'btn btn-success', type: 'button', dataset: { action: 'accept' }, on: { click: () => accept(draft) } }, icon('check'), 'Annehmen'));
    } else if (draft.status === 'accepted' && draft.accepted_card_id) {
      actions.push(h('a', { class: 'btn btn-soft', href: `#/karten/${encodeURIComponent(draft.accepted_card_id)}` }, icon('cards'), 'Karte öffnen'));
    }
    return h('article', { class: 'card draft-card', dataset: { draft: draft.draft_id } },
      h('div', { class: 'draft-head' },
        h('div', { class: 'draft-source spacer' }, icon('file', 'icon-sm'), h('span', { text: source || 'Quelle unbekannt' })),
        h('span', { class: `chip ${statusClass}`, text: statusText })),
      h('p', { class: 'draft-q', text: draft.question }),
      images(draft.question_images, 'Fragebild'),
      draft.answer ? h('p', { class: 'draft-a', text: draft.answer }) : null,
      images(draft.answer_images, 'Antwortbild'),
      h('div', { class: 'draft-target' }, h('span', { class: 'chip chip-area' }, icon('layers'), draftTarget(draft) || 'Kein Ziel')),
      actions.length ? h('div', { class: 'draft-actions' }, actions) : null);
  }

  async function guarded(work) {
    try {
      await work();
    } catch (error) {
      toast(errorMessage(error), { tone: 'error' });
    }
  }

  const url = (draft, suffix = '') => `/api/ai-drafts/jobs/${encodeURIComponent(jobId)}/drafts/${encodeURIComponent(draft.draft_id)}${suffix}`;

  function accept(draft) {
    return guarded(async () => {
      const result = await api.post(url(draft, '/accept'), {});
      if (!isLocal()) await store.rememberCard(result.card);
      toast('Karte erstellt', {
        tone: 'success',
        action: { label: 'Öffnen', onClick: () => ctx.navigate(`#/karten/${encodeURIComponent(result.card_id)}`) },
      });
      if (!isLocal()) sync.pull().catch(() => {});
      await load();
    });
  }

  function reject(draft) {
    return guarded(async () => {
      await api.post(url(draft, '/reject'), { reason: '' });
      toast('Entwurf abgelehnt', { action: { label: 'Rückgängig', onClick: () => restore(draft) } });
      await load();
    });
  }

  function restore(draft) {
    return guarded(async () => {
      await api.post(url(draft, '/restore'), {});
      toast('Entwurf zurückgeholt');
      await load();
    });
  }

  async function emptyTrash() {
    const ok = await confirmDialog({ title: 'Papierkorb leeren?', text: 'Abgelehnte Entwürfe dieses Pakets können danach nicht mehr übernommen werden.', confirm: 'Endgültig leeren', danger: true });
    if (!ok) return;
    await guarded(async () => {
      await api.post(`/api/ai-drafts/jobs/${encodeURIComponent(jobId)}/empty-trash`, {});
      await load();
    });
  }

  function edit(draft) {
    const question = h('textarea', { class: 'textarea', id: 'draft-question', rows: '3' });
    question.value = draft.question;
    const answer = h('textarea', { class: 'textarea', id: 'draft-answer', rows: '4' });
    answer.value = draft.answer;
    const listId = `decks-${uuid()}`;
    const deck = h('input', { class: 'input', id: 'draft-deck', list: listId, value: draft.suggested_deck, maxlength: '200' });
    const category = h('input', { class: 'input', id: 'draft-category', value: draft.suggested_category, maxlength: '200' });
    const subcategory = h('input', { class: 'input', id: 'draft-subcategory', value: draft.suggested_subcategory, maxlength: '200' });
    const datalist = h('datalist', { id: listId }, store.decks().map((item) => h('option', { value: item.name })));
    const error = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    openSheet({
      title: 'Entwurf bearbeiten',
      body: [error, field('Frage', question), field('Antwort', answer), field('Ziel-Deck', deck), datalist, field('Kategorie', category), field('Unterkategorie', subcategory, 'Leer lassen, wenn keine Kategorie gewünscht ist.')],
      actions: [
        { label: 'Abbrechen', variant: 'btn-secondary', onClick: (sheet) => sheet.close() },
        {
          label: 'Speichern',
          variant: 'btn-primary',
          id: 'draft-save',
          onClick: async (sheet) => {
            sheet.setBusy(true);
            try {
              await api.patch(url(draft), {
                changes: {
                  question: question.value,
                  answer: answer.value,
                  suggested_deck: deck.value.trim(),
                  suggested_category: category.value.trim(),
                  suggested_subcategory: category.value.trim() ? subcategory.value.trim() : '',
                },
              });
              sheet.close();
              toast('Entwurf gespeichert', { tone: 'success' });
              await load();
            } catch (failure) {
              error.textContent = errorMessage(failure);
              error.hidden = false;
              sheet.setBusy(false);
            }
          },
        },
      ],
    });
  }

  load();
  return { cleanup: () => { alive = false; }, onData: () => {} };
}

// -- AI test export ------------------------------------------------------------
const TEST_LIMITS = [
  { value: '10', label: '10' },
  { value: '20', label: '20' },
  { value: '30', label: '30' },
  { value: '50', label: '50' },
  { value: 'all', label: 'Alle' },
];

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { class: 'visually-hidden', readonly: true });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

function downloadBlob(blob, name) {
  const link = h('a', { href: URL.createObjectURL(blob), download: name, class: 'visually-hidden' });
  document.body.append(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 2000);
}

async function shareTest(result) {
  try {
    const blob = await api.blob(result.url);
    const file = new File([blob], result.file_name, { type: 'text/html' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'FlashCard KI-Test', text: result.start_text });
      return;
    }
    downloadBlob(blob, result.file_name);
    toast('Teilen wird hier nicht unterstützt – die Datei wurde gespeichert.');
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    toast(errorMessage(error), { tone: 'error' });
  }
}

function openLink(result) {
  const link = h('a', { class: 'btn btn-secondary btn-lg btn-block', href: isLocal() ? '#' : `${result.url}?download=1`, download: result.file_name, id: 'ai-test-open' }, icon('download'), 'Datei öffnen');
  if (isLocal()) {
    link.setAttribute('aria-disabled', 'true');
    fileHref(result.url).then((href) => {
      link.setAttribute('href', href);
      link.removeAttribute('aria-disabled');
    }).catch(() => {});
  }
  return link;
}

function resultBox(result) {
  const copyButton = h('button', { class: 'btn btn-secondary btn-lg btn-block', type: 'button', id: 'ai-test-copy' }, icon('copy'), 'Starttext kopieren');
  copyButton.addEventListener('click', async () => {
    const ok = await copyText(result.start_text);
    toast(ok ? 'Starttext kopiert' : 'Kopieren nicht möglich – bitte Text markieren.', { tone: ok ? 'success' : 'error' });
  });
  return h('section', { class: 'result-box', id: 'ai-test-result', 'aria-live': 'polite' },
    h('div', { class: 'row' },
      h('span', { class: 'stat-icon tone-mint' }, icon('check')),
      h('div', { class: 'spacer' },
        h('p', { class: 'strong', text: `KI-Test mit ${plural(result.card_count, 'Karte', 'Karten')} erstellt` }),
        h('p', { class: 'tiny muted', id: 'ai-test-file', text: `${result.file_name} · ${formatBytes(result.size_bytes)}` }))),
    h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', id: 'ai-test-share', on: { click: () => shareTest(result) } }, icon('share'), 'Teilen'),
    openLink(result),
    copyButton,
    h('p', { class: 'field-label', text: 'Starttext' }),
    h('p', { class: 'start-text', id: 'ai-test-start-text', text: result.start_text }),
    h('p', { class: 'tiny muted', text: 'In ChatGPT: Modell wählen, die HTML-Datei anhängen und den Starttext senden. Der Test verändert deinen Lernstand nicht.' }));
}

function renderTest(view, ctx) {
  const presetIds = aiTestPreset.ids;
  aiTestPreset.ids = null;
  const values = { deckId: '', categoryId: '', dueOnly: false, includeMastered: false, limit: '20', pick: Boolean(presetIds), picked: new Set(presetIds || []) };
  const deckSelect = select([], '', { id: 'ai-deck' });
  const categorySelect = select([], '', { id: 'ai-category' });
  const due = toggle('Nur fällige Karten', values.dueOnly, { id: 'ai-due' });
  const mastered = toggle('Gekonnte Karten einbeziehen', values.includeMastered, { id: 'ai-mastered' });
  const pick = toggle('Karten einzeln auswählen', values.pick, { id: 'ai-pick' });
  const countText = h('p', { class: 'form-info', id: 'ai-count', 'aria-live': 'polite' });
  const pickHost = h('div', { class: 'stack' });
  const resultHost = h('div', {});
  const historyHost = h('div', { class: 'card', hidden: true });

  const fill = (element, options, value) => {
    clear(element);
    for (const option of options) element.append(h('option', { value: option.value, text: option.label }));
    element.value = options.some((option) => option.value === value) ? value : '';
  };
  const matching = () => store.localSelection({
    deckIds: values.deckId ? [values.deckId] : [],
    categoryIds: values.categoryId ? [values.categoryId] : [],
    dueOnly: values.dueOnly,
    includeMastered: values.includeMastered,
  });
  const refresh = () => {
    fill(deckSelect, [{ value: '', label: 'Alle Decks' }, ...store.decks().map((deck) => ({ value: deck.id, label: deck.name }))], values.deckId);
    values.deckId = deckSelect.value;
    fill(categorySelect, [{ value: '', label: 'Alle Kategorien' }, ...store.categoriesOf(values.deckId || null).map((item) => ({ value: item.id, label: item.name }))], values.categoryId);
    values.categoryId = categorySelect.value;
    const cards = values.pick && presetIds ? presetIds.map((id) => store.card(id)).filter(Boolean) : matching();
    clear(pickHost);
    if (values.pick) {
      const shown = cards.slice(0, 300);
      pickHost.append(h('div', { class: 'row' },
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => { for (const card of shown) values.picked.add(card.id); refresh(); } } }, 'Alle wählen'),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => { values.picked.clear(); refresh(); } } }, 'Keine')));
      pickHost.append(h('div', { class: 'check-list', id: 'ai-card-list' }, shown.map((card) => {
        const box = h('input', { type: 'checkbox', checked: values.picked.has(card.id), dataset: { id: card.id } });
        box.addEventListener('change', () => {
          if (box.checked) values.picked.add(card.id); else values.picked.delete(card.id);
          updateCount(cards);
        });
        return h('label', { class: 'check-item' }, box, h('span', { text: card.question }));
      })));
    }
    updateCount(cards);
  };
  const updateCount = (cards) => {
    if (values.pick) {
      countText.textContent = `${plural(values.picked.size, 'Karte', 'Karten')} ausgewählt.`;
    } else {
      const planned = values.limit === 'all' ? cards.length : Math.min(cards.length, Number(values.limit));
      countText.textContent = cards.length ? `${plural(planned, 'Karte kommt', 'Karten kommen')} in den Test.` : 'Keine Karten in dieser Auswahl.';
    }
  };
  deckSelect.addEventListener('change', () => { values.deckId = deckSelect.value; values.categoryId = ''; refresh(); });
  categorySelect.addEventListener('change', () => { values.categoryId = categorySelect.value; refresh(); });
  due.input.addEventListener('change', () => { values.dueOnly = due.input.checked; refresh(); });
  mastered.input.addEventListener('change', () => { values.includeMastered = mastered.input.checked; refresh(); });
  pick.input.addEventListener('change', () => { values.pick = pick.input.checked; refresh(); });

  const createButton = h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'button', id: 'ai-test-create' }, icon('target'), 'HTML erzeugen');
  createButton.addEventListener('click', async () => {
    const body = values.pick
      ? { card_ids: [...values.picked] }
      : {
        deck_ids: values.deckId ? [values.deckId] : [],
        category_ids: values.categoryId ? [values.categoryId] : [],
        due_only: values.dueOnly,
        include_mastered: values.includeMastered,
        limit: values.limit === 'all' ? null : Number(values.limit),
      };
    if (values.pick && !values.picked.size) {
      toast('Bitte mindestens eine Karte auswählen.');
      return;
    }
    createButton.disabled = true;
    try {
      const result = await api.post('/api/ai-tests', body, { timeout: 60000 });
      clear(resultHost);
      resultHost.append(resultBox(result));
      resultHost.scrollIntoView({ block: 'start', behavior: 'smooth' });
      loadHistory();
    } catch (error) {
      toast(error instanceof ApiError && error.status === 422 ? error.message : errorMessage(error), { tone: 'error' });
    } finally {
      createButton.disabled = false;
    }
  });

  const loadHistory = async () => {
    try {
      const data = await api.get('/api/ai-tests');
      clear(historyHost);
      const items = data.items.slice(0, 5);
      historyHost.hidden = !items.length;
      historyHost.append(h('p', { class: 'strong', text: 'Letzte KI-Tests' }));
      for (const item of items) {
        const download = h('a', { class: 'btn btn-icon', href: isLocal() ? '#' : `${item.url}?download=1`, download: item.file_name, 'aria-label': `${item.file_name} herunterladen` }, icon('download'));
        if (isLocal()) fileHref(item.url).then((href) => download.setAttribute('href', href)).catch(() => {});
        historyHost.append(h('div', { class: 'backup-row' },
          h('span', { class: 'deck-main' }, h('span', { class: 'backup-name', text: item.file_name }), h('span', { class: 'tiny muted', text: `${formatDateTime(item.created_at)} · ${formatBytes(item.size_bytes)}` })),
          download));
      }
    } catch {
      historyHost.hidden = true;
    }
  };

  view.append(h('div', { class: 'stack-lg' },
    navigator.onLine || isLocal() ? null : offlineNotice(),
    presetIds ? h('p', { class: 'banner is-info', text: `Auf die Lernsession begrenzt (${plural(presetIds.length, 'Karte', 'Karten')}).` }) : null,
    h('section', { class: 'card stack' },
      field('Deck', deckSelect),
      field('Kategorie', categorySelect),
      due.element,
      mastered.element,
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Kartenanzahl' }),
        choices(TEST_LIMITS, values.limit, (value) => { values.limit = value; refresh(); }, 'Kartenanzahl')),
      pick.element,
      pickHost,
      countText,
      createButton),
    resultHost,
    historyHost));
  refresh();
  loadHistory();
  return { onData: () => {} };
}

export default {
  hub: {
    area: 'ai',
    tab: 'ki',
    title: () => ({ title: 'KI', eyebrow: 'Entwürfe & Tests' }),
    render: renderHub,
  },
  job: {
    area: 'ai',
    tab: 'ki',
    title: () => ({ title: 'KI-Entwürfe', eyebrow: 'Paket', back: '#/ki' }),
    render: renderJob,
  },
  test: {
    area: 'ai',
    tab: 'ki',
    title: () => ({ title: 'KI-Test', eyebrow: 'HTML-Export', back: '#/ki' }),
    render: renderTest,
  },
};
