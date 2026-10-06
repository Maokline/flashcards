// Start: today's progress, the big "Jetzt lernen", sync/device status, key
// numbers, quick actions and the decks.

import { on } from '../bus.js';
import { isCloud } from '../config.js';
import * as cloud from '../cloud/sync.js';
import * as store from '../store.js';
import * as sync from '../sync.js';
import { emptyState, sectionTitle } from '../ui.js';
import { formatDateTime, greeting, h, icon, plural, softColor, todayText } from '../util.js';
import { openLearnSheet } from './learn.js';
import { openSwitchSheet } from './onboarding.js';

function statTile({ id, label, value, hint, iconName, tone }) {
  return h('div', { class: 'stat', id, role: 'listitem' },
    h('div', { class: 'stat-head' },
      h('span', { class: 'stat-label', text: label }),
      h('span', { class: `stat-icon ${tone}` }, icon(iconName, 'icon-sm'))),
    h('span', { class: 'stat-value', text: value }),
    hint ? h('span', { class: 'stat-hint', text: hint }) : null);
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
  const local = store.localOverview();
  const summary = store.state.summary;
  const overview = (summary && summary.overview) || {};
  const learnedToday = overview.cards_learned_today;
  const due = local.due_cards;
  const fetchedAt = summary && summary.fetched_at ? new Date(summary.fetched_at).getTime() : 0;
  if (Date.now() - fetchedAt > 15000) sync.refreshSummary();

  const status = due
    ? `${plural(due, 'Karte ist', 'Karten sind')} heute fällig.`
    : local.total_cards ? 'Für heute ist alles erledigt. Stark!' : 'Lege deine erste Karte an, um loszulegen.';
  const done = Number(learnedToday) || 0;
  const goal = done + due;
  const percent = goal ? Math.round((done / goal) * 100) : (local.total_cards ? 100 : 0);
  const minutes = Math.max(1, Math.round(Math.min(due, 20) * 0.35));

  view.append(h('div', { class: 'stack-lg' },
    h('section', { class: 'home-hero', 'aria-labelledby': 'home-greeting' },
      h('div', { class: 'home-hero-top' },
        h('div', { class: 'ring', role: 'img', 'aria-label': `${percent} Prozent des heutigen Pensums`, vars: { '--value': String(percent) } },
          h('span', {}, `${done}`, h('small', { text: 'gelernt' }))),
        h('div', { class: 'spacer' },
          h('p', { class: 'home-date', text: todayText() }),
          h('h2', { class: 'home-greeting', id: 'home-greeting', text: greeting() }),
          h('p', { class: 'home-status', id: 'home-status', text: status }))),
      h('button', {
        class: 'home-cta',
        type: 'button',
        id: 'home-learn',
        on: { click: () => { ctx.navigate('#/lernen'); openLearnSheet({ dueOnly: Boolean(due) || undefined }); } },
      }, icon('play'), due ? 'Jetzt lernen' : 'Frei üben'),
      h('p', { class: 'home-cta-sub', text: due ? `${plural(Math.min(due, 20), 'Karte', 'Karten')} · ca. ${minutes} Min.` : 'Keine Karte fällig – wiederhole nach Lust und Laune.' })),
    syncWidget(ctx),
    isCloud() ? null : (sync.status.pending
      ? h('p', { class: 'banner' }, icon('clock', 'icon-sm'), `${plural(sync.status.pending, 'Bewertung wartet', 'Bewertungen warten')} auf Übertragung.`)
      : null),
    h('div', { class: 'stats-grid', role: 'list' },
      statTile({ id: 'stat-due', label: 'Heute fällig', value: String(due), iconName: 'clock', tone: 'tone-apricot' }),
      statTile({ id: 'stat-learned', label: 'Heute gelernt', value: learnedToday === undefined ? '–' : String(learnedToday), hint: overview.reviews_today !== undefined ? plural(overview.reviews_today, 'Bewertung', 'Bewertungen') : '', iconName: 'check', tone: 'tone-learn' }),
      statTile({ id: 'stat-mastered', label: 'Gekonnt', value: String(local.mastered_cards), hint: local.total_cards ? `${Math.round((local.mastered_cards / local.total_cards) * 100)} % aller Karten` : '', iconName: 'star', tone: 'tone-gold' }),
      statTile({ id: 'stat-total', label: 'Karten insgesamt', value: String(local.total_cards), hint: plural(store.state.decks.size, 'Deck', 'Decks'), iconName: 'cards', tone: 'tone-blue' })),
    h('div', { class: 'quick-actions' },
      h('a', { class: 'quick-action', href: '#/karten/neu', id: 'qa-new' }, h('span', { class: 'stat-icon tone-blue' }, icon('plus')), 'Neue Karte'),
      h('a', { class: 'quick-action', href: '#/ki', id: 'qa-drafts' }, h('span', { class: 'stat-icon tone-mint' }, icon('inbox')), 'KI-Entwürfe'),
      h('a', { class: 'quick-action', href: '#/ki/test', id: 'qa-test' }, h('span', { class: 'stat-icon tone-apricot' }, icon('target')), 'KI-Test')),
    sectionTitle('Decks', h('a', { href: '#/karten', class: 'small', text: 'Alle Karten' })),
    renderDecks(ctx)));
  // The sync widget follows the cloud state (active / read-only / offline).
  let lastState = isCloud() ? cloud.status.state : '';
  const off = on('status', (status) => {
    if (!isCloud() || status.state === lastState) return;
    lastState = status.state;
    const current = view.querySelector('#home-sync');
    const next = syncWidget(ctx);
    if (current && next) current.replaceWith(next);
  });
  return { cleanup: off };
}

function renderDecks(ctx) {
  const decks = store.decks();
  if (!decks.length) {
    return emptyState('layers', 'Noch keine Decks', 'Decks entstehen mit der ersten Karte.',
      h('a', { class: 'btn btn-primary', href: '#/karten/neu' }, icon('plus'), 'Erste Karte anlegen'));
  }
  const stats = deckStats();
  return h('div', { class: 'deck-list', id: 'deck-list' }, decks.map((deck) => deckCard(
    deck,
    stats.get(deck.id) || { total: 0, due: 0, mastered: 0 },
    () => { ctx.navigate('#/lernen'); openLearnSheet({ deckId: deck.id }); },
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
