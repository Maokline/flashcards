// Mehr → Wiederholungsintervalle: per deck the growth model, the multiplier
// and the maximum interval, with a live preview of levels 1–10 and the
// explicit, confirmed recalculation of existing due dates.
//
// The preview is computed in memory when a choice changes; nothing is
// stored until "Speichern".  A new setting applies to future reviews only.

import { api, errorMessage } from '../api.js';
import { isCloud } from '../config.js';
import * as cloud from '../cloud/sync.js';
import {
  INTERVAL_MODELS, MAX_DAY_CHOICES, MODEL_DESCRIPTIONS, MODEL_FORMULAS, MODEL_LABELS, MULTIPLIER_CHOICES, SKIP_REASONS,
  formatMultiplier, preview, sameSettings, settingsOf, summary,
} from '../core/intervals.js';
import * as store from '../store.js';
import * as sync from '../sync.js';
import { emptyState, openSheet, sectionTitle, segmented, toast } from '../ui.js';
import { clear, h, icon, plural, softColor } from '../util.js';

const tzQuery = () => `?tz_offset=${-new Date().getTimezoneOffset()}`;

async function afterServerWrite() {
  if (!isCloud()) await sync.pull().catch(() => {});
}

function deckRow(deck, onClick) {
  const color = deck.color || '#3F64DF';
  const cards = [...store.state.cards.values()].filter((card) => card.deck_id === deck.id).length;
  return h('button', {
    class: 'deck-card',
    type: 'button',
    id: `interval-deck-${deck.id}`,
    vars: { '--deck-color': color, '--deck-soft': softColor(color, 0.14) },
    'aria-label': `${deck.name}: ${summary(settingsOf(deck))}. Wiederholungsintervalle bearbeiten`,
    on: { click: onClick },
  },
  h('span', { class: 'deck-icon' }, icon('layers')),
  h('span', { class: 'deck-main' },
    h('span', { class: 'deck-name', text: deck.name }),
    h('span', { class: 'deck-meta interval-summary', text: summary(settingsOf(deck)) }),
    h('span', { class: 'tiny muted', text: plural(cards, 'Karte', 'Karten') })),
  icon('chevron-right'));
}

function previewRows(settings) {
  return preview(settings).map((row) => h('div', { class: `kv-row${row.capped ? ' is-capped' : ''}`, dataset: { level: row.level } },
    h('dt', { text: `Level ${row.level}` }),
    h('dd', {},
      h('span', { class: 'interval-value', text: row.text }),
      h('span', { class: 'interval-detail', text: row.detail }),
      row.capped ? h('span', { class: 'chip chip-due interval-cap', text: 'begrenzt' }) : null)));
}

function capNote(settings) {
  const capped = preview(settings).filter((row) => row.capped);
  if (!capped.length) return null;
  const levels = capped.length === 1 ? `Level ${capped[0].level}` : `Level ${capped[0].level}–${capped[capped.length - 1].level}`;
  return h('p', { class: 'banner is-info', id: 'interval-cap-note' }, icon('info', 'icon-sm'),
    `Das Höchstintervall von ${settings.max_days} Tagen begrenzt ${levels}.`);
}

/** The settings sheet of one deck. */
export function openIntervalSheet(deck, { onSaved } = {}) {
  const saved = settingsOf(deck);
  const draft = { ...saved };
  const previewList = h('dl', { class: 'kv kv-compact interval-preview', id: 'interval-preview' });
  const capHost = h('div', { id: 'interval-cap-host' });
  const recalcButton = h('button', { class: 'btn btn-secondary btn-lg btn-block', type: 'button', id: 'interval-recalc' }, icon('refresh'), 'Bestehende Fälligkeiten neu berechnen');
  const recalcHint = h('p', { class: 'field-hint', id: 'interval-recalc-hint' });
  let current = { ...saved };

  function render() {
    clear(previewList);
    previewList.append(...previewRows(draft));
    clear(capHost);
    const note = capNote(draft);
    if (note) capHost.append(note);
    const dirty = !sameSettings(draft, current);
    recalcButton.disabled = dirty;
    recalcHint.textContent = dirty
      ? 'Erst speichern – die Neuberechnung nutzt die gespeicherte Einstellung.'
      : 'Bereits geplante Wiederholungen bleiben, bis du sie hier ausdrücklich neu berechnest.';
  }

  const modelRows = INTERVAL_MODELS.map((model) => {
    const id = `interval-model-${model}`;
    const input = h('input', { type: 'radio', class: 'radio-input', name: 'interval-model', value: model, id, checked: model === draft.model });
    input.addEventListener('change', () => { if (input.checked) { draft.model = model; render(); } });
    return h('label', { class: 'option-row', for: id, dataset: { model } },
      input,
      h('span', { class: 'radio-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'option-text' },
        h('span', { class: 'option-title', text: MODEL_LABELS[model] }),
        h('span', { class: 'option-sub', text: `${MODEL_DESCRIPTIONS[model]} Grundintervall ${MODEL_FORMULAS[model]}.` })));
  });

  const multiplier = segmented(MULTIPLIER_CHOICES.map((pct) => ({ value: pct, label: formatMultiplier(pct) })), draft.multiplier_pct,
    (value) => { draft.multiplier_pct = value; render(); }, 'Multiplikator', { fit: true });
  multiplier.id = 'interval-multiplier';
  const maximum = segmented(MAX_DAY_CHOICES.map((days) => ({ value: days, label: `${days} T` })), draft.max_days,
    (value) => { draft.max_days = value; render(); }, 'Maximales Intervall', { fit: true });
  maximum.id = 'interval-max';

  const sheet = openSheet({
    title: 'Wiederholungsintervalle',
    className: 'interval-sheet',
    body: [
      h('p', { class: 'strong', id: 'interval-deck-name', text: `Deck: ${deck.name}` }),
      h('p', { class: 'small muted', text: 'Gilt für künftige reguläre Wiederholungen dieses Decks. Punkte, Level, Fehler, Recovery und „Gekonnt“ behalten ihre Regeln.' }),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Multiplikator' }), multiplier),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Wachstumsmodell' }),
        h('div', { class: 'option-list', role: 'radiogroup', 'aria-label': 'Wachstumsmodell', id: 'interval-models' }, modelRows)),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Maximales Intervall' }), maximum),
      sectionTitle('Vorschau Level 1–10'),
      h('section', { class: 'card card-tight' }, previewList),
      capHost,
      sectionTitle('Bestehende Fälligkeiten'),
      recalcButton,
      recalcHint,
    ],
    actions: [
      { label: 'Abbrechen', variant: 'btn-secondary', id: 'interval-cancel', onClick: (s) => s.close('cancel') },
      { label: 'Speichern', icon: 'check', variant: 'btn-primary', id: 'interval-save', onClick: async (s) => {
        if (sameSettings(draft, current)) { s.close('save'); return; }
        s.setBusy(true);
        try {
          await api.patch(`/api/decks/${encodeURIComponent(deck.id)}`, {
            interval_model: draft.model, interval_multiplier_pct: draft.multiplier_pct, interval_max_days: draft.max_days,
          });
          await afterServerWrite();
          current = { ...draft };
          render();
          toast('Intervalle gespeichert – gilt für künftige Wiederholungen', { tone: 'success' });
          if (onSaved) onSaved();
        } catch (error) {
          toast(errorMessage(error), { tone: 'error' });
        } finally {
          s.setBusy(false);
        }
      } },
    ],
  });
  recalcButton.addEventListener('click', () => openRecalcSheet(deck));
  render();
  return sheet;
}

function planFacts(plan) {
  const facts = [
    ['Betroffene Karten', String(plan.affected), 'recalc-affected'],
    ['Früher fällig', String(plan.earlier), 'recalc-earlier'],
    ['Später fällig', String(plan.later), 'recalc-later'],
    ['Danach sofort fällig', String(plan.newly_due), 'recalc-newly-due'],
    ['Nicht mehr fällig', String(plan.no_longer_due), 'recalc-no-longer-due'],
    ['Schon passend', String(plan.unchanged), 'recalc-unchanged'],
  ];
  return h('dl', { class: 'facts', id: 'recalc-facts' }, facts.map(([label, value, id]) => h('div', { class: 'fact', id },
    h('dt', { text: label }), h('dd', { text: value }))));
}

function skippedList(plan) {
  const items = Object.entries(SKIP_REASONS).filter(([key]) => Number(plan.skipped[key]) > 0);
  if (!items.length) return null;
  return h('section', { class: 'card card-tight stack', id: 'recalc-skipped' },
    h('p', { class: 'strong', text: 'Bleiben unverändert' }),
    h('dl', { class: 'kv kv-compact' }, items.map(([key, text]) => h('div', { class: 'kv-row', dataset: { reason: key } },
      h('dt', { text }), h('dd', { text: String(plan.skipped[key]) })))));
}

/** Preview → confirmation → backup → apply. */
async function openRecalcSheet(deck) {
  let plan;
  try {
    plan = await api.post(`/api/decks/${encodeURIComponent(deck.id)}/reschedule${tzQuery()}`, {});
  } catch (error) {
    toast(errorMessage(error), { tone: 'error' });
    return;
  }
  const backupText = isCloud()
    ? `Vorher wird automatisch eine Sicherung in ${cloud.status.label || 'der Cloud'} angelegt.`
    : 'Vorher legt der Server automatisch ein Backup an.';
  const body = [
    h('p', { class: 'strong', text: `Deck: ${deck.name}` }),
    h('p', { class: 'small muted', text: `Neue Fälligkeit = letzte reguläre Bewertung + Intervall nach „${summary(settingsOf(plan.settings))}“. Das heutige Datum ist kein neuer Startpunkt.` }),
    planFacts(plan),
    skippedList(plan),
    plan.affected
      ? h('p', { class: 'banner is-info' }, icon('info', 'icon-sm'), `${backupText} Punkte, Level, Recovery und der Lernverlauf bleiben unverändert.`)
      : h('p', { class: 'banner is-success', id: 'recalc-nothing' }, icon('check', 'icon-sm'), 'Keine Fälligkeit ändert sich.'),
  ];
  const actions = plan.affected
    ? [
      { label: 'Abbrechen', variant: 'btn-secondary', id: 'recalc-cancel', onClick: (s) => s.close('cancel') },
      { label: 'Neu berechnen', icon: 'refresh', variant: 'btn-primary', id: 'recalc-confirm', onClick: async (s) => {
        s.setBusy(true);
        try {
          const result = await api.post(`/api/decks/${encodeURIComponent(deck.id)}/reschedule${tzQuery()}`, { token: plan.token }, { timeout: 120000 });
          await afterServerWrite();
          toast(`${plural(result.affected, 'Fälligkeit', 'Fälligkeiten')} neu berechnet`, { tone: 'success' });
          s.close('confirm');
        } catch (error) {
          toast(errorMessage(error), { tone: 'error' });
          s.setBusy(false);
        }
      } },
    ]
    : [{ label: 'Schließen', variant: 'btn-secondary', id: 'recalc-cancel', onClick: (s) => s.close('cancel') }];
  openSheet({ title: 'Fälligkeiten neu berechnen', className: 'recalc-sheet', body, actions });
}

function render(view) {
  const host = h('div', { class: 'stack-lg', id: 'interval-decks' });
  view.append(host);
  const draw = () => {
    clear(host);
    const decks = store.decks();
    host.append(
      h('section', { class: 'hero' },
        h('p', { class: 'hero-eyebrow', text: 'Lernsystem' }),
        h('h2', { class: 'hero-title', text: 'Wiederholungsintervalle' }),
        h('p', { class: 'hero-text', text: 'Lege je Deck fest, wie schnell die Abstände zwischen den Wiederholungen wachsen. Neue Einstellungen gelten für künftige Bewertungen; bestehende Fälligkeiten änderst du nur ausdrücklich.' })),
      sectionTitle('Decks'),
      decks.length
        ? h('div', { class: 'deck-list', id: 'interval-deck-list' }, decks.map((deck) => deckRow(deck, () => openIntervalSheet(store.deck(deck.id) || deck, { onSaved: draw }))))
        : emptyState('layers', 'Noch keine Decks', 'Sobald du Karten in einem Deck anlegst, kannst du hier seine Intervalle einstellen.'));
  };
  draw();
  return { onData: draw };
}

export default {
  list: {
    area: 'more',
    tab: 'mehr',
    title: () => ({ title: 'Wiederholungsintervalle', eyebrow: 'Mehr', back: '#/mehr' }),
    render,
  },
};
