// Mehr: statistics, sync & devices, settings and backups.

import { api, errorMessage, isLocal, NetworkError } from '../api.js';
import { emit } from '../bus.js';
import { isCloud } from '../config.js';
import * as db from '../db.js';
import * as cloud from '../cloud/sync.js';
import * as store from '../store.js';
import * as sync from '../sync.js';
import { confirmDialog, emptyState, sectionTitle, toast } from '../ui.js';
import { clear, formatBytes, formatDateTime, formatDuration, h, icon, percent, plural, softColor } from '../util.js';
import { APP_VERSION, installPrompt, isStandalone, logout } from '../app.js';

function menuItem(href, iconName, tone, title, sub, id) {
  return h('a', { class: 'menu-item', href, id },
    h('span', { class: `stat-icon ${tone}` }, icon(iconName)),
    h('span', { class: 'menu-item-text' }, title, h('span', { class: 'menu-item-sub', text: sub })),
    icon('chevron-right'));
}

function profileCard() {
  if (isCloud()) {
    const status = cloud.status;
    const account = status.account || {};
    const name = account.name || account.email || account.username || status.label || 'Cloud';
    const initial = name.trim().charAt(0).toUpperCase() || 'F';
    const line = status.state === 'active'
      ? 'Dieses Gerät ist aktiv · synchron'
      : status.state === 'inactive' ? `Nur lesen · aktiv: ${cloud.describeDevice(status.activeDevice)}` : status.message;
    return h('a', { class: 'profile-card', href: '#/mehr/sync', id: 'more-profile' },
      h('span', { class: 'profile-avatar', 'aria-hidden': 'true', text: initial }),
      h('span', { class: 'spacer' },
        h('span', { class: 'strong', text: name }),
        h('span', { class: 'menu-item-sub', text: line })),
      icon('chevron-right'));
  }
  const status = sync.status;
  const text = !status.online ? 'Offline' : status.pending ? `${status.pending} Bewertungen warten` : 'Alles synchron';
  return h('section', { class: 'card row' },
    h('span', { class: `stat-icon ${status.online ? 'tone-learn' : 'tone-slate'}` }, icon(status.online ? 'cloud' : 'offline')),
    h('div', { class: 'spacer' },
      h('p', { class: 'strong', text }),
      h('p', { class: 'tiny muted', text: store.state.meta.lastSync ? `Zuletzt synchronisiert ${formatDateTime(store.state.meta.lastSync)}` : 'Noch nicht synchronisiert' })),
    h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Jetzt synchronisieren', on: { click: async () => { await sync.syncNow(); toast(sync.status.online ? 'Synchronisiert' : 'Server nicht erreichbar', { tone: sync.status.online ? 'success' : 'error' }); } } }, icon('refresh')));
}

function renderMenu(view) {
  view.append(h('div', { class: 'stack-lg' },
    profileCard(),
    h('div', { class: 'menu-list' },
      menuItem('#/mehr/statistik', 'chart', 'tone-apricot', 'Statistik', 'Fortschritt, Erfolgsquote, Lernzeit', 'more-stats'),
      isCloud() ? menuItem('#/mehr/sync', 'swap', 'tone-learn', 'Sync & Geräte', `Aktives Gerät, Gerätewechsel, ${cloud.status.label}`, 'more-sync') : null,
      menuItem('#/mehr/einstellungen', 'settings', 'tone-slate', 'Einstellungen', isCloud() ? 'App installieren, Über die App' : 'Gerät, Synchronisation, Abmelden', 'more-settings'),
      menuItem('#/mehr/daten', 'database', 'tone-blue', 'Daten / Backup', isCloud() ? `Sicherungen in ${cloud.status.label}` : 'Sicherungen erstellen und herunterladen', 'more-data')),
    h('p', { class: 'tiny muted center', text: `FlashCard App · Version ${APP_VERSION} · ${isCloud() ? `${cloud.status.label}-Synchronisation` : 'Server-Modus'}` })));
  return {};
}

// -- statistics -------------------------------------------------------------------
function tile(label, value, hint, iconName, tone, id) {
  return h('div', { class: 'stat', id },
    h('div', { class: 'stat-head' }, h('span', { class: 'stat-label', text: label }), h('span', { class: `stat-icon ${tone}` }, icon(iconName, 'icon-sm'))),
    h('span', { class: 'stat-value', text: value }),
    hint ? h('span', { class: 'stat-hint', text: hint }) : null);
}

function levelChart(levels, mastered) {
  const counts = [];
  for (let level = 1; level <= 10; level += 1) counts.push(Number(levels[String(level)] || 0));
  // Mastered cards are stored at level 10; show them as their own column.
  counts[9] = Math.max(0, counts[9] - mastered);
  const columns = [...counts.map((count, index) => ({ label: `L${index + 1}`, count, color: `var(--lv-${index + 1})` })), { label: '★', count: mastered, color: 'var(--mastered)' }];
  const max = Math.max(1, ...columns.map((column) => column.count));
  return h('div', { class: 'bars', role: 'img', 'aria-label': columns.map((column) => `${column.label === '★' ? 'Gekonnt' : column.label}: ${column.count}`).join(', ') },
    columns.map((column) => h('div', { class: 'bar-col' },
      h('span', { class: 'bar-value', text: String(column.count) }),
      h('span', { class: 'bar', vars: { '--h': `${Math.round((column.count / max) * 100)}%`, '--bar-color': column.color } }),
      h('span', { class: 'bar-label', text: column.label }))));
}

function activityChart(items, days = 14) {
  const byDay = new Map(items.map((item) => [item.day, item]));
  const columns = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    const item = byDay.get(key);
    columns.push({ key, date, reviews: item ? item.reviews : 0 });
  }
  const max = Math.max(1, ...columns.map((column) => column.reviews));
  return h('div', { class: 'activity', role: 'img', 'aria-label': `Bewertungen der letzten ${days} Tage` },
    columns.map((column) => h('div', { class: 'bar-col', title: `${column.date.toLocaleDateString('de-DE')}: ${column.reviews}` },
      h('span', { class: 'bar', vars: { '--h': `${Math.round((column.reviews / max) * 100)}%`, '--bar-color': 'var(--area-accent)' } }),
      h('span', { class: 'bar-label', text: column.date.toLocaleDateString('de-DE', { weekday: 'narrow' }) }))));
}

function renderStatistics(view) {
  const host = h('div', { class: 'stack-lg', id: 'statistics' });
  view.append(host);
  const draw = (summary) => {
    clear(host);
    const local = store.localOverview();
    if (!summary) {
      host.append(h('p', { class: 'banner' }, icon('offline', 'icon-sm'), 'Statistik ist offline nur eingeschränkt verfügbar.'),
        h('div', { class: 'stats-grid' },
          tile('Fällig', String(local.due_cards), '', 'clock', 'tone-apricot'),
          tile('Gekonnt', String(local.mastered_cards), '', 'star', 'tone-gold'),
          tile('Karten', String(local.total_cards), '', 'cards', 'tone-blue')));
      return;
    }
    const overview = summary.overview || {};
    host.append(
      h('div', { class: 'stats-grid' },
        tile('Heute gelernt', String(overview.cards_learned_today ?? 0), plural(overview.reviews_today ?? 0, 'Bewertung', 'Bewertungen'), 'check', 'tone-learn', 'st-learned'),
        tile('Fällig', String(overview.due_cards ?? local.due_cards), 'jetzt', 'clock', 'tone-apricot', 'st-due'),
        tile('Gekonnt', String(overview.mastered_cards ?? 0), `von ${overview.total_cards ?? 0} Karten`, 'star', 'tone-gold', 'st-mastered'),
        tile('Erfolgsquote', percent(overview.accuracy_total), `heute ${percent(overview.accuracy_today)}`, 'target', 'tone-blue', 'st-accuracy'),
        tile('Lernzeit heute', formatDuration(overview.learning_seconds_today), `gesamt ${formatDuration(overview.learning_seconds_total)}`, 'clock', 'tone-slate', 'st-time'),
        tile('Bewertungen', String(overview.total_reviews ?? 0), 'insgesamt', 'chart', 'tone-apricot', 'st-reviews')),
      sectionTitle('Levelverteilung'),
      h('section', { class: 'card' }, levelChart(summary.levels || {}, Number(overview.mastered_cards || 0))),
      sectionTitle('Aktivität (14 Tage)'),
      h('section', { class: 'card' }, activityChart(summary.activity || [])),
      sectionTitle('Decks'),
      (summary.decks || []).length
        ? h('div', { class: 'deck-list' }, summary.decks.map((deck) => {
          const share = deck.total_cards ? Math.round((deck.mastered_cards / deck.total_cards) * 100) : 0;
          return h('section', { class: 'card stack', vars: { '--deck-color': deck.color, '--deck-soft': softColor(deck.color, 0.14) } },
            h('div', { class: 'row' },
              h('span', { class: 'deck-icon' }, icon('layers')),
              h('div', { class: 'deck-main' },
                h('p', { class: 'deck-name', text: deck.deck_name }),
                h('p', { class: 'deck-meta', text: `${plural(deck.total_cards, 'Karte', 'Karten')} · Ø Level ${deck.average_level.toFixed(1).replace('.', ',')}` }))),
            h('div', { class: 'row-wrap' },
              h('span', { class: 'chip chip-due', text: `${deck.due_cards} fällig` }),
              h('span', { class: 'chip chip-mastered', text: `${deck.mastered_cards} gekonnt` })),
            h('div', { class: 'progress', 'aria-label': `${share} % gekonnt`, role: 'img' },
              h('div', { class: 'progress-bar', vars: { '--value': `${share}%`, '--bar-color': deck.color } })));
        }))
        : emptyState('layers', 'Noch keine Decks', ''));
  };
  draw(store.state.summary);
  let alive = true;
  sync.refreshSummary().then((summary) => { if (alive && summary) draw(summary); });
  return { cleanup: () => { alive = false; }, onData: () => draw(store.state.summary) };
}

// -- settings ---------------------------------------------------------------------
function installSection() {
  const install = installPrompt();
  return h('section', { class: 'card stack' },
    isStandalone()
      ? h('p', { class: 'banner is-success' }, icon('check', 'icon-sm'), 'Die App ist installiert und läuft im Vollbild.')
      : null,
    install
      ? h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', id: 'settings-install', on: { click: () => install.prompt() } }, icon('download'), 'App installieren')
      : null,
    h('p', { class: 'small', text: 'Android (Chrome): Menü ⋮ → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.' }),
    h('p', { class: 'small', text: 'iPhone (Safari): Teilen-Symbol → „Zum Home-Bildschirm“. Danach startet die App mit eigenem Symbol im Vollbild.' }));
}

function renderSettings(view, ctx) {
  if (isCloud()) {
    const status = cloud.status;
    const rows = [
      ['Sync-Anbieter', `${status.label}${status.provider === 'gdrive' ? ' (Standard)' : ''}`],
      ['Dieses Gerät', (status.thisDevice && status.thisDevice.device_name) || '–'],
      ['Aktives Gerät', status.state === 'active' ? 'dieses Gerät' : cloud.describeDevice(status.activeDevice)],
      ['Letzte Synchronisation', status.lastSync ? formatDateTime(status.lastSync) : 'noch nicht'],
      ['Karten auf diesem Gerät', String(store.state.cards.size)],
      ['Darstellung', isStandalone() ? 'Installierte App (Vollbild)' : 'Browser'],
      ['App-Version', APP_VERSION],
    ];
    view.append(h('div', { class: 'stack-lg' },
      sectionTitle('Synchronisation'),
      h('section', { class: 'card' }, h('dl', { class: 'kv', id: 'settings-kv' }, rows.map(([key, value]) => h('div', { class: 'kv-row' }, h('dt', { text: key }), h('dd', { text: value }))))),
      h('a', { class: 'btn btn-secondary btn-lg btn-block', href: '#/mehr/sync', id: 'settings-sync' }, icon('swap'), 'Sync & Geräte öffnen'),
      sectionTitle('App installieren'),
      installSection(),
      sectionTitle('Konto'),
      h('button', { class: 'btn btn-danger-soft btn-lg btn-block', type: 'button', id: 'settings-logout', on: { click: logout } }, icon('logout'), `${status.label} trennen`)));
    return { onData: () => {} };
  }
  const status = sync.status;
  const rows = [
    ['Gerät', store.state.meta.device || '–'],
    ['Server', location.host],
    ['Verbindung', status.online ? 'Online' : 'Offline'],
    ['Live-Aktualisierung', status.live ? 'Aktiv' : 'Nicht verbunden'],
    ['Letzte Synchronisation', store.state.meta.lastSync ? formatDateTime(store.state.meta.lastSync) : 'Noch nie'],
    ['Karten auf diesem Gerät', String(store.state.cards.size)],
    ['Wartende Bewertungen', String(status.pending)],
    ['App-Version', APP_VERSION],
    ['Server-Version', store.state.meta.app_version || '–'],
  ];
  view.append(h('div', { class: 'stack-lg' },
    sectionTitle('Gerät & Synchronisation'),
    h('section', { class: 'card' }, h('dl', { class: 'kv', id: 'settings-kv' }, rows.map(([key, value]) => h('div', { class: 'kv-row' }, h('dt', { text: key }), h('dd', { text: value }))))),
    h('div', { class: 'stack' },
      h('button', { class: 'btn btn-secondary btn-lg btn-block', type: 'button', id: 'settings-sync', on: { click: async () => { await sync.syncNow(); ctx.rerender(); toast(sync.status.online ? 'Synchronisiert' : 'Server nicht erreichbar'); } } }, icon('refresh'), 'Jetzt synchronisieren'),
      h('button', {
        class: 'btn btn-secondary btn-lg btn-block', type: 'button', id: 'settings-reload',
        on: {
          click: async () => {
            const ok = await confirmDialog({ title: 'Lokale Daten neu laden?', text: 'Die Kopie auf diesem Gerät wird verworfen und vollständig vom Server geladen. Wartende Bewertungen bleiben erhalten.', confirm: 'Neu laden' });
            if (!ok) return;
            await db.clearEntities();
            store.applyToMemory({ reset: true, upserts: {}, deleted: {} });
            store.state.meta.cursor = null;
            store.state.meta.epoch = null;
            emit('data-changed', {});
            try {
              await sync.pull();
              toast('Daten neu geladen', { tone: 'success' });
            } catch (error) {
              toast(errorMessage(error), { tone: 'error' });
            }
            ctx.rerender();
          },
        },
      }, icon('database'), 'Lokale Daten neu laden')),
    sectionTitle('App installieren'),
    installSection(),
    sectionTitle('Konto'),
    h('button', { class: 'btn btn-danger-soft btn-lg btn-block', type: 'button', id: 'settings-logout', on: { click: logout } }, icon('logout'), 'Abmelden')));
  return { onData: () => {} };
}

// -- backups ---------------------------------------------------------------------
function renderData(view) {
  const listHost = h('div', { id: 'backup-list' }, h('div', { class: 'empty' }, h('div', { class: 'spinner' })));
  const createButton = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', id: 'backup-create' }, icon('database'), isLocal() ? `Sicherung in ${cloud.status.label} erstellen` : 'Backup erstellen');
  let alive = true;
  const load = async () => {
    try {
      const data = await api.get('/api/backups');
      if (!alive) return;
      clear(listHost);
      if (!data.items.length) {
        listHost.append(emptyState('database', 'Noch keine Sicherungen', isLocal() ? 'Die erste Sicherung entsteht automatisch beim ersten Speichern des Tages.' : 'Erstelle eine Sicherung des gemeinsamen Datenbestands.'));
        return;
      }
      listHost.append(h('section', { class: 'card' }, data.items.slice(0, 20).map((item) => h('div', { class: 'backup-row' },
        h('span', { class: 'stat-icon tone-blue' }, icon('database', 'icon-sm')),
        h('span', { class: 'deck-main' },
          h('span', { class: 'backup-name', text: isLocal() ? `Stand ${item.revision}${item.automatic ? ' · automatisch' : ' · manuell'}` : item.name }),
          h('span', { class: 'tiny muted', text: `${formatDateTime(item.created_at)}${item.size_bytes && !isLocal() ? ` · ${formatBytes(item.size_bytes)}` : ''}` })),
        item.url ? h('a', { class: 'btn btn-icon', href: item.url, download: item.name, 'aria-label': `${item.name} herunterladen` }, icon('download')) : null))));
    } catch (error) {
      if (!alive) return;
      clear(listHost);
      listHost.append(h('p', { class: error instanceof NetworkError ? 'banner' : 'form-error', text: error instanceof NetworkError ? 'Sicherungen sind nur mit Verbindung abrufbar.' : errorMessage(error) }));
    }
  };
  createButton.addEventListener('click', async () => {
    createButton.disabled = true;
    try {
      const item = await api.post('/api/backups', { reason: 'mobile' }, { timeout: 120000 });
      toast(isLocal() ? `Sicherung von Stand ${item.revision} erstellt` : `Backup erstellt (${formatBytes(item.size_bytes)})`, { tone: 'success' });
      await load();
    } catch (error) {
      toast(errorMessage(error), { tone: 'error' });
    } finally {
      createButton.disabled = false;
    }
  });
  view.append(h('div', { class: 'stack-lg' },
    h('section', { class: 'hero' },
      h('p', { class: 'hero-eyebrow', text: 'Datensicherung' }),
      h('h2', { class: 'hero-title', text: 'Daten / Backup' }),
      h('p', { class: 'hero-text', text: isLocal()
        ? (cloud.status.provider === 'onedrive'
          ? 'Sicherungen liegen in deinem OneDrive (Ordner „Apps/FlashCard App/backups“): täglich automatisch (die letzten 14) und auf Wunsch. Sie enthalten Karten, Bilder, Lernstand und KI-Entwürfe.'
          : 'Sicherungen liegen im versteckten App-Speicher deines Google Drive: täglich automatisch (die letzten 14) und auf Wunsch. Sie enthalten Karten, Bilder, Lernstand und KI-Entwürfe; ansehen und wiederherstellen kannst du sie hier und am Desktop.')
        : 'Backups enthalten Karten, Bilder, Lernstand und KI-Entwürfe des Servers.' })),
    createButton,
    h('p', { class: 'banner is-info' }, icon('info', 'icon-sm'), 'Wiederherstellen erfolgt bewusst am Desktop (Einstellungen → Synchronisation bzw. Daten & Sicherung), damit nichts versehentlich überschrieben wird.'),
    sectionTitle(isLocal() ? `Sicherungen in ${cloud.status.label}` : 'Vorhandene Backups'),
    listHost));
  load();
  return { cleanup: () => { alive = false; }, onData: () => {} };
}

export default {
  menu: {
    area: 'more',
    tab: 'mehr',
    live: true,
    title: () => ({ title: 'Mehr', eyebrow: 'Statistik & Einstellungen' }),
    render: renderMenu,
  },
  statistics: {
    area: 'stats',
    tab: 'mehr',
    title: () => ({ title: 'Statistik', eyebrow: 'Mehr', back: '#/mehr' }),
    render: renderStatistics,
  },
  settings: {
    area: 'more',
    tab: 'mehr',
    title: () => ({ title: 'Einstellungen', eyebrow: 'Mehr', back: '#/mehr' }),
    render: renderSettings,
  },
  data: {
    area: 'cards',
    tab: 'mehr',
    title: () => ({ title: 'Daten / Backup', eyebrow: 'Mehr', back: '#/mehr' }),
    render: renderData,
  },
};
