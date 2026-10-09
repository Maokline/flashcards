// Start: today's progress, the big "Jetzt lernen", sync/device status, key
// numbers, quick actions and the decks.

import { on } from '../bus.js';
import { isCloud } from '../config.js';
import * as cloud from '../cloud/sync.js';
import * as store from '../store.js';
import * as sync from '../sync.js';
import { errorMessage } from '../api.js';
import { readFocus, resolveFocus, saveFocus } from '../learning_focus.js';
import { emptyState, sectionTitle, toast } from '../ui.js';
import { clear, formatDateTime, formatDuration, greeting, h, icon, percent as formatPercent, plural, softColor, todayText } from '../util.js';
import { openDueCards, openMasteredCards } from './cards.js';
import { openLearnSetup } from './learn.js';
import { openSwitchSheet } from './onboarding.js';
import { openFocusDeckPicker, stageProgressCard } from './focus_ui.js';
import { fetchAdvanced, openStatistics } from './statistics.js';

function statTile({ id, label, value, hint, iconName, tone, onClick, actionLabel }) {
  const content = [
    h('span', { class: 'stat-head' },
      h('span', { class: 'stat-label', text: label }),
      h('span', { class: `stat-icon ${tone}` }, icon(iconName, 'icon-sm'))),
    h('span', { class: 'stat-value', text: value }),
    hint ? h('span', { class: 'stat-hint', text: hint }) : null,
  ];
  if (!onClick) return h('div', { class: 'stat', id, role: 'listitem' }, content);
  // A tappable tile (e.g. "Heute fällig" opens the due cards).
  return h('div', { class: 'stat-item', role: 'listitem' },
    h('button', { class: 'stat stat-link', type: 'button', id, 'aria-label': actionLabel, on: { click: onClick } },
      content,
      h('span', { class: 'stat-more', 'aria-hidden': 'true' }, 'Anzeigen', icon('chevron-right', 'icon-sm'))));
}

function deckStats() {
  const now = new Date();
  const stats = new Map();
  for (const card of store.state.cards.values()) {
    const entry = stats.get(card.deck_id) || { total: 0, due: 0, mastered: 0 };
    entry.total += 1;
    if (card.mastered) entry.mastered += 1;
    else if (store.isDue(card, now)) entry.due += 1;
    stats.set(card.deck_id, entry);
  }
  return stats;
}

export function deckCard(deck, entry, onClick) {
  const color = deck.color || '#3F64DF';
  const share = entry.total ? Math.round((entry.mastered / entry.total) * 100) : 0;
  return h('button', {
    class: 'deck-card',
    type: 'button',
    vars: { '--deck-color': color, '--deck-soft': softColor(color, 0.14) },
    'aria-label': `${deck.name}: ${plural(entry.total, 'Karte', 'Karten')}, ${entry.due} fällig. Lernen`,
    on: { click: onClick },
  },
  h('span', { class: 'deck-icon' }, icon('layers')),
  h('span', { class: 'deck-main' },
    h('span', { class: 'deck-name', text: deck.name }),
    h('span', { class: 'deck-meta', text: `${plural(entry.total, 'Karte', 'Karten')} · ${share} % gekonnt` }),
    h('span', { class: 'progress', 'aria-hidden': 'true' },
      h('span', { class: 'progress-bar', vars: { '--value': `${share}%`, '--bar-color': color } }))),
  h('span', { class: `deck-due${entry.due ? '' : ' is-zero'}`, text: String(entry.due), title: 'fällig' }));
}

function syncWidget(ctx) {
  if (!isCloud()) return null;
  const status = cloud.status;
  const label = status.label || 'Cloud';
  const last = status.lastSync ? `zuletzt ${formatDateTime(status.lastSync)}` : 'noch nicht synchronisiert';
  const variants = {
    active: ['tone-learn', 'check', 'Dieses Gerät ist aktiv', `Synchron mit ${label} · ${last}`, ''],
    inactive: ['tone-apricot', 'lock', `Aktiv: ${cloud.describeDevice(status.activeDevice)}`, 'Hier nur lesen – übernehmen?', 'is-readonly'],
    switching: ['tone-blue', 'swap', 'Gerätewechsel …', 'Der neueste Stand wird geladen.', ''],
    offline: ['tone-slate', 'offline', cloud.isActive() ? 'Offline – lernen geht weiter' : 'Offline', cloud.isActive() ? 'Wird gespeichert, sobald wieder Netz da ist.' : last, ''],
    conflict: ['tone-danger', 'info', 'Entscheidung nötig', 'Nicht übertragene Änderungen klären', 'is-alert'],
    auth: ['tone-danger', 'lock', 'Anmeldung erneuern', `Bei ${status.vendor || label} anmelden – Änderungen bleiben hier`, 'is-alert'],
    not_initialized: ['tone-apricot', 'cloud', `${label} ist noch leer`, 'Verbinde zuerst die Desktop-App', 'is-readonly'],
    moved: ['tone-apricot', 'swap', `Umgezogen zu ${(status.movedTo && status.movedTo.label) || 'neuem Anbieter'}`, 'Jetzt hier umstellen', 'is-readonly'],
    error: ['tone-danger', 'info', 'Sync gestört', status.message || '', 'is-alert'],
  };
  const [tone, iconName, title, sub, extra] = variants[status.state] || ['tone-slate', 'cloud', 'Verbinde …', '', ''];
  const action = status.state === 'inactive'
    ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', id: 'home-activate', on: { click: (event) => { event.stopPropagation(); openSwitchSheet({ start: true }); } } }, 'Aktivieren')
    : icon('chevron-right');
  return h('button', { class: `sync-widget ${extra}`.trim(), type: 'button', id: 'home-sync', on: { click: () => ctx.navigate('#/mehr/sync') } },
    h('span', { class: `stat-icon ${tone}` }, icon(iconName)),
    h('span', { class: 'spacer' },
      h('span', { class: 'sync-widget-title', id: 'home-sync-title', text: title }),
      h('span', { class: 'sync-widget-sub', text: sub })),
    action);
}

function render(view, ctx) {
  const host = h('div', { class: 'stack-lg', id: 'home-dashboard' });
  view.append(host);
  host.append(h('section', { class: 'card row', role: 'status' }, h('span', { class: 'spinner spinner-sm' }), 'Dein Lernfokus wird geladen …'));
  let alive = true;
  let generation = 0;
  let focusIds = [];
  function focusSheet() {
    return openFocusDeckPicker({ selected: focusIds, onApply: async (ids) => {
      await saveFocus(ids);
      await load();
      toast('Lernfokus gespeichert', { tone: 'success' });
    } });
  }
  function requireFocus(action) {
    if (!focusIds.length) { focusSheet(); return; }
    action();
  }
  function draw(summary) {
    const overview = summary.overview || {};
    const learnedToday = Number(overview.cards_learned_today) || 0;
    const due = Number(overview.due_cards) || 0;
    const total = Number(overview.total_cards) || 0;
    const mastered = Number(overview.mastered_cards) || 0;
    const status = !focusIds.length ? 'Wähle Decks für deinen Lernfokus.' : due
      ? `${plural(due, 'Karte ist', 'Karten sind')} heute fällig.`
      : total ? 'Für heute ist alles erledigt. Stark!' : 'In deinem Lernfokus sind noch keine Karten.';
    const goal = learnedToday + due;
    const percent = goal ? Math.round((learnedToday / goal) * 100) : (total ? 100 : 0);
    const minutes = Math.max(1, Math.round(Math.min(due, 20) * 0.35));
    clear(host);
    host.append(...[
    h('button', { class: 'focus-summary', type: 'button', id: 'home-focus', 'aria-haspopup': 'dialog', on: { click: focusSheet } },
      h('span', {}, icon('layers', 'icon-sm'), `Lernfokus · ${plural(focusIds.length, 'Deck', 'Decks')}`), icon('chevron-down', 'icon-sm')),
    h('section', { class: 'home-hero', 'aria-labelledby': 'home-greeting' },
      h('div', { class: 'home-hero-top' },
        h('div', { class: 'ring', role: 'img', 'aria-label': `${percent} Prozent des heutigen Pensums`, vars: { '--value': String(percent) } },
          h('span', {}, `${learnedToday}`, h('small', { text: 'gelernt' }))),
        h('div', { class: 'spacer' },
          h('p', { class: 'home-date', text: todayText() }),
          h('h2', { class: 'home-greeting', id: 'home-greeting', text: greeting() }),
          h('p', { class: 'home-status', id: 'home-status', text: status }))),
      h('button', {
        class: 'home-cta',
        type: 'button',
        id: 'home-learn',
        on: { click: () => total ? openLearnSetup({ deckIds: focusIds, dueOnly: Boolean(due), cardIds: due ? undefined : summary.card_ids, label: 'Lernfokus' }, ctx.navigate) : focusSheet() },
      }, icon('play'), !focusIds.length ? 'Lernfokus wählen' : due ? 'Jetzt lernen' : total ? 'Frei üben' : 'Lernfokus ändern'),
      h('p', { class: 'home-cta-sub', text: due ? `${plural(Math.min(due, 20), 'Karte', 'Karten')} · ca. ${minutes} Min.` : total ? 'Keine Karte fällig – wiederhole nach Lust und Laune.' : 'Dein Lernfokus bestimmt Kennzahlen und Lernfortschritt.' })),
    syncWidget(ctx),
    isCloud() ? null : (sync.status.pending
      ? h('p', { class: 'banner' }, icon('clock', 'icon-sm'), `${plural(sync.status.pending, 'Bewertung wartet', 'Bewertungen warten')} auf Übertragung.`)
      : null),
    summary.offline ? h('p', { class: 'banner', text: 'Offline: Fortschritt aus der lokalen Kopie; Aktivität kann unvollständig sein.' }) : null,
    stageProgressCard(summary.stage, { id: 'home-stage-progress', deckCount: focusIds.length, onClick: () => openStatistics(ctx.navigate, { tab: 'progress' }) }),
    h('div', { class: 'stats-grid', role: 'list' },
      statTile({
        id: 'stat-due', label: 'Heute fällig', value: String(due), iconName: 'clock', tone: 'tone-apricot',
        actionLabel: `${plural(due, 'Karte', 'Karten')} heute fällig – fällige Karten anzeigen`,
        onClick: () => requireFocus(() => openDueCards(ctx.navigate, focusIds)),
      }),
      statTile({ id: 'stat-learned', label: 'Heute gelernt', value: String(learnedToday), hint: plural(overview.reviews_today || 0, 'Bewertung', 'Bewertungen'), iconName: 'check', tone: 'tone-learn', actionLabel: 'Heute gelernte Karten: Aktivität anzeigen', onClick: () => openStatistics(ctx.navigate, { tab: 'activity', todayOnly: true, days: '7' }) }),
      statTile({ id: 'stat-mastered', label: 'Gekonnt', value: String(mastered), hint: `von ${total} Karten`, iconName: 'star', tone: 'tone-gold', actionLabel: 'Gekonnte Karten im Lernfokus anzeigen', onClick: () => requireFocus(() => openMasteredCards(ctx.navigate, focusIds)) }),
      statTile({ id: 'stat-total', label: 'Karten insgesamt', value: String(total), hint: plural(focusIds.length, 'Deck', 'Decks'), iconName: 'cards', tone: 'tone-blue' }),
      statTile({ id: 'stat-accuracy', label: 'Trefferquote', value: formatPercent(overview.accuracy_total), hint: 'im Lernfokus', iconName: 'target', tone: 'tone-blue' }),
      statTile({ id: 'stat-time', label: 'Lernzeit heute', value: formatDuration(overview.learning_seconds_today), hint: 'im Lernfokus', iconName: 'clock', tone: 'tone-slate' })),
    h('div', { class: 'quick-actions' },
      h('a', { class: 'quick-action', href: '#/karten/neu', id: 'qa-new' }, h('span', { class: 'stat-icon tone-blue' }, icon('plus')), 'Neue Karte'),
      h('a', { class: 'quick-action', href: '#/ki', id: 'qa-drafts' }, h('span', { class: 'stat-icon tone-mint' }, icon('inbox')), 'KI-Entwürfe'),
      h('a', { class: 'quick-action', href: '#/ki/test', id: 'qa-test' }, h('span', { class: 'stat-icon tone-apricot' }, icon('target')), 'KI-Test')),
    sectionTitle('Decks im Lernfokus', h('a', { href: '#/karten', class: 'small', text: 'Alle Karten' })),
    renderDecks(ctx, focusIds, summary.decks || []),
    ].filter((node) => node !== null && node !== undefined));
  }
  async function load() {
    const request = ++generation;
    try {
      const focus = await readFocus();
      if (!alive || request !== generation) return;
      const ids = resolveFocus(focus, store.decks());
      const summary = await fetchAdvanced({ deckIds: ids, days: 'all' });
      if (!alive || request !== generation) return;
      focusIds = ids;
      draw(summary);
    } catch (error) {
      if (!alive || request !== generation) return;
      clear(host); host.append(h('p', { class: 'banner', text: errorMessage(error) }), h('button', { class: 'btn btn-secondary', type: 'button', on: { click: load } }, 'Erneut laden'));
    }
  }
  load();
  // The sync widget follows the cloud state (active / read-only / offline).
  let lastState = isCloud() ? cloud.status.state : '';
  const off = on('status', (status) => {
    if (!isCloud() || status.state === lastState) return;
    lastState = status.state;
    const current = view.querySelector('#home-sync');
    const next = syncWidget(ctx);
    if (current && next) current.replaceWith(next);
  });
  return { cleanup: () => { alive = false; generation += 1; off(); }, onData: load };
}

function renderDecks(ctx, focusIds, entries) {
  const chosen = new Set(focusIds);
  const decks = store.decks().filter((deck) => chosen.has(deck.id));
  if (!decks.length) {
    return emptyState('layers', 'Kein Deck im Lernfokus', 'Über „Lernfokus“ kannst du Decks auswählen. Auch eine leere Auswahl wird gespeichert.');
  }
  const stats = new Map(entries.map((entry) => [entry.deck_id, { total: entry.total_cards, due: entry.due_cards, mastered: entry.mastered_cards }]));
  return h('div', { class: 'deck-list', id: 'deck-list' }, decks.map((deck) => deckCard(
    deck,
    stats.get(deck.id) || { total: 0, due: 0, mastered: 0 },
    () => openLearnSetup({ deckIds: [deck.id] }, ctx.navigate),
  )));
}

export default {
  start: {
    area: 'home',
    tab: 'start',
    live: true,
    title: () => ({ title: 'Start', eyebrow: 'FlashCard App' }),
    render,
  },
};
