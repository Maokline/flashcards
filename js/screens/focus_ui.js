// The same compact deck sheet serves the global focus and temporary statistics
// filters. An explicit empty selection stays empty, unlike session filters.
import * as store from '../store.js';
import { errorMessage } from '../api.js';
import { openSheet, toast } from '../ui.js';
import { h, icon, plural } from '../util.js';

export function openFocusDeckPicker({ selected = [], title = 'Lernfokus', onApply, idPrefix = 'focus' }) {
  const decks = store.decks();
  const chosen = new Set(selected.filter((id) => store.deck(id)));
  const status = h('p', { class: 'deck-pick-status', id: `${idPrefix}-status`, 'aria-live': 'polite' });
  const rows = decks.map((deck) => {
    const id = `${idPrefix}-deck-${deck.id}`;
    const input = h('input', { type: 'checkbox', class: 'check-input', id, checked: chosen.has(deck.id) });
    input.addEventListener('change', () => { if (input.checked) chosen.add(deck.id); else chosen.delete(deck.id); refresh(); });
    return { deck, input, row: h('label', { class: 'check-row', for: id, dataset: { deck: deck.id } },
      input, h('span', { class: 'check-box', 'aria-hidden': 'true' }, icon('check')),
      h('span', { class: 'check-label', text: deck.name })) };
  });
  function refresh() {
    for (const { input, deck } of rows) input.checked = chosen.has(deck.id);
    status.textContent = chosen.size ? `${plural(chosen.size, 'Deck', 'Decks')} ausgewählt` : idPrefix === 'focus' ? 'Kein Deck ausgewählt. Dein Lernfokus bleibt dann leer.' : 'Keine Decks ausgewählt. Die Statistik zeigt dann eine leere Auswahl.';
  }
  const sheet = openSheet({
    title,
    className: 'sheet-picker focus-sheet',
    body: [status,
      h('div', { class: 'pick-tools' },
        h('button', { class: 'btn btn-soft', type: 'button', id: `${idPrefix}-all`, on: { click: () => { for (const deck of decks) chosen.add(deck.id); refresh(); } } }, 'Alle auswählen'),
        h('button', { class: 'btn btn-soft', type: 'button', id: `${idPrefix}-clear`, on: { click: () => { chosen.clear(); refresh(); } } }, 'Auswahl löschen')),
      h('div', { class: 'check-list', role: 'group', 'aria-label': title }, rows.map((row) => row.row)),
      decks.length ? null : h('p', { class: 'muted', text: 'Sobald du ein Deck anlegst, kannst du es hier auswählen.' })],
    actions: [{ label: 'Übernehmen', icon: 'check', variant: 'btn-primary', id: `${idPrefix}-apply`, onClick: async (current) => {
      current.setBusy(true);
      try {
        await onApply(decks.filter((deck) => chosen.has(deck.id)).map((deck) => deck.id));
        current.close('apply');
      } catch (error) { toast(errorMessage(error), { tone: 'error' }); }
      finally { current.setBusy(false); }
    } }],
    onClose: () => {
      const trigger = document.getElementById(idPrefix === 'focus' ? 'home-focus' : 'statistics-decks');
      if (trigger && (!document.activeElement || document.activeElement === document.body)) trigger.focus({ preventScroll: true });
    },
  });
  refresh();
  return sheet;
}

export function stageProgressCard(stage, { id = 'stage-progress', deckCount = null, onClick = null, context = 'Lernfokus' } = {}) {
  const value = Math.min(100, Math.max(0, Number(stage?.progress_percent) || 0));
  const empty = !stage || stage.empty;
  const title = empty ? `Keine Karten ${context === 'Lernfokus' ? 'im Lernfokus' : 'in der Auswahl'}` : stage.all_mastered ? 'Alle Karten gemeistert' : `Stufe ${stage.current_stage}`;
  const direction = empty ? 'Wähle Decks mit Karten für deinen Lernfortschritt.' : stage.all_mastered ? 'Dein Lernfokus ist vollständig gekonnt.' : stage.target === 'mastered' ? 'Richtung Gekonnt' : `Richtung Level ${stage.next_stage}`;
  const root = h(onClick ? 'button' : 'section', {
    class: `card stage-card${onClick ? ' stage-card-link' : ''}`, id,
    type: onClick ? 'button' : undefined,
    'aria-label': onClick ? `Lernfortschritt: ${title}. ${Math.round(value)} Prozent. Fortschritt anzeigen` : undefined,
    on: onClick ? { click: onClick } : undefined,
  },
  h('span', { class: 'stage-eyebrow', text: 'Lernfortschritt' }),
  h('span', { class: 'stage-heading' }, h('span', { class: 'stage-title', text: title }), onClick ? icon('chevron-right') : icon(stage?.all_mastered ? 'star' : 'chart')),
  empty ? null : h('span', { class: 'stage-bar-row' },
    h('span', { class: 'progress', role: 'progressbar', 'aria-label': direction, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(value) },
      h('span', { class: 'progress-bar', vars: { '--value': `${value}%`, '--bar-color': 'var(--area-strong)' } })),
    h('span', { class: 'stage-percent', text: `${Math.round(value)} %` })),
  h('span', { class: 'small muted', text: direction }),
  deckCount === null ? null : h('span', { class: 'tiny muted', text: `Lernfokus · ${plural(deckCount, 'Deck', 'Decks')}` }));
  return root;
}
