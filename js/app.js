// Boot, shell (top bar, bottom navigation), hash router, sign-in.
//
// Cloud mode (Google Drive by default, OneDrive optional): the app shows this
// device's data immediately, finishes a Google/Microsoft sign-in redirect if
// there is one, then talks to the cloud in the background – loading the
// newest state and, with the automatic device switch, making this phone the
// active device.
// Server mode (optional): password login at the self-hosted sync server.

import { api, ApiError, errorMessage, NetworkError, useLocalBackend } from './api.js';
import { emit, on } from './bus.js';
import { startCalendarWatch } from './calendar.js';
import { config, isCloud, loadConfig } from './config.js';
import * as dataset from './core/dataset.js';
import * as db from './db.js';
import { localBackend } from './local/backend.js';
import * as cloud from './cloud/sync.js';
import * as providers from './cloud/providers.js';
import { load, resetMemory, setMeta, state } from './store.js';
import * as sync from './sync.js';
import { confirmDialog, field, openSheet, toast } from './ui.js';
import { clear, deviceGuess, formatDateTime, h, icon, plural } from './util.js';

import home from './screens/home.js';
import learn from './screens/learn.js';
import cardsScreen from './screens/cards.js';
import editor from './screens/editor.js';
import ai from './screens/ai.js';
import more from './screens/more.js';
import device from './screens/device.js';
import onboarding, { openConflictSheet, openEmptyCloudSheet, openMovedSheet, openSwitchSheet } from './screens/onboarding.js';

export const APP_VERSION = '2.1.0';

const TABS = [
  { key: 'start', label: 'Start', icon: 'home', hash: '#/start' },
  { key: 'lernen', label: 'Lernen', icon: 'learn', hash: '#/lernen' },
  { key: 'karten', label: 'Karten', icon: 'cards', hash: '#/karten' },
  { key: 'ki', label: 'KI', icon: 'sparkles', hash: '#/ki' },
  { key: 'mehr', label: 'Mehr', icon: 'more', hash: '#/mehr' },
];

const ROUTES = [
  [/^\/start$/, home.start],
  [/^\/lernen$/, learn.setup],
  [/^\/lernen\/session$/, learn.session],
  [/^\/karten$/, cardsScreen.list],
  [/^\/karten\/neu$/, editor.create],
  [/^\/karten\/([^/]+)\/bearbeiten$/, editor.edit],
  [/^\/karten\/([^/]+)$/, cardsScreen.detail],
  [/^\/ki$/, ai.hub],
  [/^\/ki\/job\/([^/]+)$/, ai.job],
  [/^\/ki\/test$/, ai.test],
  [/^\/mehr$/, more.menu],
  [/^\/mehr\/statistik$/, more.statistics],
  [/^\/mehr\/einstellungen$/, more.settings],
  [/^\/mehr\/daten$/, more.data],
  [/^\/mehr\/sync$/, device.page],
];

const shell = {
  root: null,
  topbar: null,
  titleEl: null,
  eyebrowEl: null,
  backEl: null,
  actionsEl: null,
  syncChip: null,
  readOnly: null,
  view: null,
  tabs: new Map(),
  current: null,
  cleanup: null,
};

// -- install prompt (Android/Chromium) ----------------------------------------
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event;
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  toast('FlashCard App installiert', { tone: 'success' });
});

export function installPrompt() {
  if (!deferredInstall) return null;
  return {
    prompt: async () => {
      const event = deferredInstall;
      deferredInstall = null;
      event.prompt();
      try { await event.userChoice; } catch { /* dismissed */ }
    },
  };
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// -- service worker ----------------------------------------------------------------
const UPDATE_CHECK_MS = 30 * 60 * 1000;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!shell.updateAccepted || reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then((registration) => {
    const offer = (worker) => {
      if (worker && navigator.serviceWorker.controller) offerUpdate(worker);
    };
    if (registration.waiting) offer(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') offer(worker);
      });
    });
    const check = () => registration.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    window.addEventListener('online', check);
    setInterval(check, UPDATE_CHECK_MS);
  }).catch((error) => {
    console.warn('Service Worker nicht registriert', error);
  });
}

function offerUpdate(worker) {
  if (shell.updateOffered) return;
  shell.updateOffered = true;
  emit('update-available', {});
  toast('Update verfügbar', {
    action: {
      label: 'Neu laden',
      onClick: () => {
        shell.updateAccepted = true;
        worker.postMessage({ type: 'SKIP_WAITING' });
      },
    },
    duration: 24 * 60 * 60 * 1000,
  });
}

// -- shell ---------------------------------------------------------------------------
function buildShell() {
  const app = document.getElementById('app');
  clear(app);
  shell.root = app;
  shell.tabs = new Map();
  shell.backEl = h('a', { class: 'btn btn-icon topbar-back', href: '#/start', 'aria-label': 'Zurück', hidden: true }, icon('chevron-left'));
  shell.eyebrowEl = h('p', { class: 'topbar-eyebrow' });
  shell.titleEl = h('h1', { class: 'topbar-title', id: 'page-title' });
  shell.syncChip = h('button', { class: 'sync-chip', type: 'button', id: 'sync-chip', on: { click: openSyncSheet } });
  shell.actionsEl = h('div', { class: 'topbar-actions' });
  shell.topbar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-inner' },
      shell.backEl,
      h('div', { class: 'topbar-titles' }, shell.eyebrowEl, shell.titleEl),
      shell.actionsEl,
      shell.syncChip));
  shell.readOnly = h('div', { class: 'readonly-bar', id: 'readonly-bar', hidden: true, role: 'status' });
  shell.view = h('main', { class: 'view', id: 'view', tabindex: '-1', 'aria-labelledby': 'page-title' });
  const tabInner = h('div', { class: 'tabbar-inner' });
  for (const tab of TABS) {
    const link = h('a', { class: 'tab', href: tab.hash, dataset: { tab: tab.key }, id: `tab-${tab.key}` },
      h('span', { class: 'tab-pill' }, icon(tab.icon)),
      h('span', { class: 'tab-label', text: tab.label }));
    shell.tabs.set(tab.key, link);
    tabInner.append(link);
  }
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Hauptnavigation' }, tabInner);
  app.append(shell.topbar, shell.readOnly, shell.view, tabbar);
  window.addEventListener('scroll', () => {
    shell.topbar.classList.toggle('is-scrolled', window.scrollY > 4);
  }, { passive: true });
  renderSyncChip(sync.status);
}

const CHIP_TEXT = {
  active: ['Synchron', 'is-ok'],
  inactive: ['Nur lesen', 'is-readonly'],
  switching: ['Wechsel …', 'is-syncing'],
  conflict: ['Entscheiden', 'is-alert'],
  offline: ['Offline', 'is-offline'],
  auth: ['Anmelden', 'is-alert'],
  moved: ['Umgezogen', 'is-readonly'],
  not_initialized: ['Noch leer', 'is-readonly'],
  not_connected: ['Nicht verbunden', 'is-offline'],
  error: ['Sync-Fehler', 'is-alert'],
  unknown: ['Verbinde …', 'is-syncing'],
};

function renderSyncChip(status) {
  const chip = shell.syncChip;
  if (!chip) return;
  clear(chip);
  chip.className = 'sync-chip';
  let text;
  let tone;
  if (isCloud()) {
    [text, tone] = CHIP_TEXT[status.state] || CHIP_TEXT.unknown;
    if (status.state === 'active' && status.syncing) [text, tone] = ['Speichert …', 'is-syncing'];
    else if (status.state === 'active' && status.pending) [text, tone] = ['Speichert …', 'is-syncing'];
    if (status.state === 'offline' && cloud.isActive()) text = 'Offline · lokal';
  } else {
    const waiting = status.pending === 1 ? '1 Änderung wartet' : `${status.pending} Änderungen warten`;
    if (status.pending > 0) [text, tone] = [status.online ? waiting : `Offline – ${waiting}`, 'is-pending'];
    else if (!status.online) [text, tone] = ['Offline', 'is-offline'];
    else if (status.syncing) [text, tone] = ['Synchronisiere …', 'is-syncing'];
    else [text, tone] = ['Synchronisiert', 'is-ok'];
  }
  chip.classList.add(tone);
  chip.append(
    tone === 'is-ok' ? icon('check', 'chip-check') : tone === 'is-readonly' ? icon('lock', 'chip-check') : h('span', { class: 'dot', 'aria-hidden': 'true' }),
    h('span', { class: 'chip-text', text }),
  );
  chip.title = text;
  chip.setAttribute('aria-label', `Synchronisation: ${text}. Details anzeigen`);
  renderReadOnlyBar(status);
}

function renderReadOnlyBar(status) {
  const bar = shell.readOnly;
  if (!bar) return;
  const show = isCloud() && ['inactive', 'conflict', 'auth', 'moved'].includes(status.state);
  bar.hidden = !show;
  shell.root.classList.toggle('has-readonly', show);
  if (!show) return;
  clear(bar);
  if (status.state === 'inactive') {
    bar.append(
      h('span', { class: 'readonly-icon' }, icon('lock', 'icon-sm')),
      h('span', { class: 'readonly-text' }, h('strong', { text: 'Nur lesen' }), ` · aktiv: ${cloud.describeDevice(status.activeDevice)}`),
      h('button', { class: 'btn btn-sm readonly-action', type: 'button', id: 'readonly-activate', on: { click: () => openSwitchSheet({ start: true }) } }, 'Hier aktivieren'));
  } else if (status.state === 'conflict') {
    bar.append(
      h('span', { class: 'readonly-icon' }, icon('info', 'icon-sm')),
      h('span', { class: 'readonly-text' }, h('strong', { text: 'Änderungen klären' }), ' · nichts geht verloren'),
      h('button', { class: 'btn btn-sm readonly-action', type: 'button', id: 'readonly-resolve', on: { click: openConflictSheet } }, 'Entscheiden'));
  } else if (status.state === 'moved') {
    bar.append(
      h('span', { class: 'readonly-icon' }, icon('swap', 'icon-sm')),
      h('span', { class: 'readonly-text' }, h('strong', { text: 'Umgezogen' }), ` · jetzt ${(status.movedTo && status.movedTo.label) || 'neuer Anbieter'}`),
      h('button', { class: 'btn btn-sm readonly-action', type: 'button', id: 'readonly-moved', on: { click: () => openMovedSheet() } }, 'Wechseln'));
  } else {
    bar.append(
      h('span', { class: 'readonly-icon' }, icon('lock', 'icon-sm')),
      h('span', { class: 'readonly-text' }, h('strong', { text: 'Anmeldung erneuern' }), ' · Daten bleiben hier'),
      h('button', { class: 'btn btn-sm readonly-action', type: 'button', id: 'readonly-signin', on: { click: () => cloud.provider().auth.signIn() } }, 'Anmelden'));
  }
}

function openSyncSheet() {
  if (isCloud()) {
    navigate('#/mehr/sync');
    return;
  }
  const status = sync.status;
  const rows = [
    ['Verbindung', status.online ? 'Online' : 'Offline'],
    ['Live-Aktualisierung', status.live ? 'Aktiv' : 'Nicht verbunden'],
    ['Wartende Bewertungen', String(status.pending)],
    ['Letzte Synchronisation', state.meta.lastSync ? formatDateTime(state.meta.lastSync) : 'Noch nie'],
    ['Karten auf diesem Gerät', String(state.cards.size)],
  ];
  const list = h('dl', { class: 'kv' }, rows.map(([key, value]) => h('div', { class: 'kv-row' }, h('dt', { text: key }), h('dd', { text: value }))));
  const notes = [];
  if (status.pending) notes.push(h('p', { class: 'banner', text: `${plural(status.pending, 'Bewertung wartet', 'Bewertungen warten')} auf Übertragung. Sie werden automatisch genau einmal übertragen, sobald der Server erreichbar ist.` }));
  if (!status.online) notes.push(h('p', { class: 'banner is-info', text: 'Ohne Verbindung kannst du Karten lesen und lernen. Bearbeiten, Anlegen und Löschen brauchen eine Verbindung.' }));
  openSheet({
    title: 'Synchronisation',
    body: [...notes, list],
    actions: [{
      label: 'Jetzt synchronisieren',
      icon: 'refresh',
      variant: 'btn-primary',
      onClick: async (sheet) => {
        sheet.setBusy(true);
        await sync.syncNow();
        sheet.close();
        toast(sync.status.online ? 'Synchronisiert' : 'Server nicht erreichbar', { tone: sync.status.online ? 'success' : 'error' });
      },
    }],
  });
}

function setTopbar({ title = '', eyebrow = '', back = null, actions = [] } = {}) {
  shell.titleEl.textContent = title;
  shell.eyebrowEl.textContent = eyebrow;
  shell.eyebrowEl.hidden = !eyebrow;
  if (back) {
    shell.backEl.hidden = false;
    shell.backEl.setAttribute('href', back);
  } else {
    shell.backEl.hidden = true;
  }
  clear(shell.actionsEl);
  for (const action of actions) shell.actionsEl.append(action);
  document.title = title ? `${title} · FlashCard App` : 'FlashCard App';
}

// -- router -------------------------------------------------------------------------------
function currentPath() {
  const hash = location.hash || '#/start';
  return hash.replace(/^#/, '') || '/start';
}

export function navigate(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', hash);
    route();
  } else if (location.hash === hash) {
    route();
  } else {
    location.hash = hash;
  }
}

function match(path) {
  for (const [pattern, screen] of ROUTES) {
    const result = pattern.exec(path);
    if (result) return { screen, params: result.slice(1).map(decodeURIComponent) };
  }
  return null;
}

function route({ keepScroll = false } = {}) {
  if (!shell.view) return;
  const path = currentPath();
  const found = match(path);
  if (!found) {
    navigate('#/start', { replace: true });
    return;
  }
  const { screen, params } = found;
  const sameScreen = shell.current && shell.current.screen === screen && shell.current.path === path;
  if (!sameScreen) document.querySelectorAll('.points-pop').forEach((item) => item.remove());
  const scrollY = keepScroll && sameScreen ? window.scrollY : 0;
  if (shell.cleanup) {
    try { shell.cleanup(); } catch (error) { console.warn(error); }
    shell.cleanup = null;
  }
  shell.current = { screen, path, params };
  shell.root.dataset.area = screen.area || 'home';
  shell.root.classList.toggle('is-immersive', Boolean(screen.immersive));
  shell.root.classList.toggle('is-editing', Boolean(screen.editing));
  for (const [key, link] of shell.tabs) {
    if (key === screen.tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  setTopbar(screen.title ? screen.title(...params) : {});
  clear(shell.view);
  shell.view.classList.remove('view-enter');
  void shell.view.offsetWidth;
  if (!sameScreen) shell.view.classList.add('view-enter');
  const ctx = { navigate, setTopbar, params, rerender: () => route({ keepScroll: true }) };
  let result;
  try {
    result = screen.render(shell.view, ctx, ...params);
  } catch (error) {
    console.error(error);
    shell.view.append(h('p', { class: 'form-error', text: `Ansicht konnte nicht geladen werden: ${error.message}` }));
  }
  shell.cleanup = (result && result.cleanup) || null;
  shell.current.onData = (result && result.onData) || null;
  if (keepScroll) window.scrollTo(0, scrollY);
  else {
    window.scrollTo(0, 0);
    if (!keepScroll && document.activeElement === document.body) shell.view.focus({ preventScroll: true });
  }
}

let dataTimer = null;
function onDataChanged() {
  clearTimeout(dataTimer);
  dataTimer = setTimeout(() => {
    const current = shell.current;
    if (!current) return;
    if (current.onData) current.onData();
    else if (current.screen.live) route({ keepScroll: true });
  }, 120);
}

// -- server mode: password login ------------------------------------------------------------
function showLogin(message = '') {
  sync.stopSyncLoop();
  shell.view = null;
  shell.current = null;
  const app = document.getElementById('app');
  clear(app);
  app.dataset.area = 'home';
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true, id: 'login-password', autofocus: true });
  const deviceInput = h('input', { class: 'input', type: 'text', autocomplete: 'off', value: state.meta.device || deviceGuess(), id: 'login-device', maxlength: '80' });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: !message, text: message });
  const submit = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', id: 'login-submit' }, icon('lock'), 'Anmelden');
  const form = h('form', { class: 'card stack', novalidate: true },
    error,
    field('Passwort', password),
    field('Gerätename', deviceInput, 'Erscheint in der Geräteliste des Servers.'),
    submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (!password.value) {
      error.textContent = 'Bitte das Passwort eingeben.';
      error.hidden = false;
      password.focus();
      return;
    }
    submit.disabled = true;
    try {
      const result = await api.post('/api/auth/login', { password: password.value, device_name: deviceInput.value.trim(), client: 'pwa' });
      await setMeta('device', result.device_name || deviceInput.value.trim());
      await startApp();
    } catch (failure) {
      let text = errorMessage(failure);
      if (failure instanceof ApiError && failure.status === 401) text = 'Das Passwort ist falsch.';
      if (failure instanceof ApiError && failure.status === 503) text = 'Der Server ist noch nicht eingerichtet (Passwort fehlt).';
      error.textContent = text;
      error.hidden = false;
      submit.disabled = false;
      password.select();
    }
  });
  app.append(h('div', { class: 'login' },
    h('div', { class: 'login-inner' },
      h('div', { class: 'login-brand' },
        h('img', { class: 'login-logo', src: 'icons/icon-192.png', alt: '', width: '84', height: '84' }),
        h('h1', { class: 'login-title', text: 'FlashCard App' }),
        h('p', { class: 'muted', text: 'Melde dich mit dem Passwort deines FlashCard-Servers an. Desktop und Handy teilen denselben Lernstand.' })),
      form)));
  document.title = 'Anmelden · FlashCard App';
  requestAnimationFrame(() => password.focus());
}

export async function logout() {
  if (isCloud()) {
    const label = cloud.status.label || 'Cloud';
    const ok = await confirmDialog({
      title: `${label} trennen?`,
      text: `Die lokale Kopie wird von diesem Gerät gelöscht. Deine Daten bleiben in ${label} und auf dem Desktop erhalten.`,
      confirm: 'Trennen',
      danger: true,
      icon: 'logout',
    });
    if (!ok) return;
    if (!(await leaveCloud(label))) return;
    window.location.reload();
    return;
  }
  const pending = sync.status.pending;
  const ok = await confirmDialog({
    title: 'Abmelden?',
    text: pending
      ? `${plural(pending, 'Bewertung wurde', 'Bewertungen wurden')} noch nicht übertragen und gehen beim Abmelden verloren. Die lokalen Daten werden von diesem Gerät gelöscht.`
      : 'Die lokale Kopie der Karten wird von diesem Gerät gelöscht. Deine Daten bleiben auf dem Server.',
    confirm: 'Abmelden',
    danger: true,
    icon: 'logout',
  });
  if (!ok) return;
  try {
    await api.post('/api/auth/logout', {});
  } catch {
    // Logging out locally still protects this device.
  }
  sync.stopSyncLoop();
  await db.clearEverything();
  resetMemory();
  if ('caches' in window) {
    for (const key of await caches.keys()) if (key.startsWith('fc-media')) await caches.delete(key);
  }
  showLogin();
}

/** Hand the lease back, sign out and forget the local copy (data stays in the cloud). */
async function leaveCloud(label) {
  if (!(await cloud.release())) {
    const anyway = await confirmDialog({
      title: 'Änderungen noch nicht übertragen',
      text: `Einige Änderungen haben ${label} noch nicht erreicht (keine Verbindung?). Beim Abmelden gehen sie verloren. Besser: mit Internet erneut versuchen.`,
      confirm: 'Trotzdem abmelden',
      danger: true,
      icon: 'logout',
    });
    if (!anyway) return false;
  }
  await cloud.provider().auth.signOut();
  await db.clearEverything();
  resetMemory();
  return true;
}

/** "Konto wechseln": leave this account, then sign in with another one. */
export async function switchAccount() {
  const chosen = cloud.provider();
  const ok = await confirmDialog({
    title: 'Konto wechseln?',
    text: `Dieses Gerät meldet sich von ${chosen.accountLabel === 'Google-Konto' ? 'diesem Google-Konto' : 'diesem Konto'} ab (die Daten dort bleiben erhalten) und lädt danach den Stand des anderen Kontos.`,
    confirm: 'Konto wechseln',
    icon: 'swap',
  });
  if (!ok) return;
  if (!(await leaveCloud(chosen.label))) return;
  await chosen.auth.signIn({ returnHash: '#/start', selectAccount: true });
}

// -- start ------------------------------------------------------------------------------------
let started = false;

async function startApp() {
  buildShell();
  if (!started) {
    started = true;
    startCalendarWatch();
    window.addEventListener('hashchange', () => route());
    on('data-changed', onDataChanged);
    on('summary', onDataChanged);
    on('status', renderSyncChip);
    on('auth-required', () => {
      if (!isCloud() && shell.view) showLogin('Deine Anmeldung ist abgelaufen. Bitte erneut anmelden.');
    });
    on('sync-notice', onSyncNotice);
    on('sync-resume', onResume);
  }
  if (!location.hash) history.replaceState(null, '', '#/start');
  route();
  sync.startSyncLoop();
  await sync.loadMeta();
  sync.refreshSummary();
  if (!isCloud()) {
    await sync.syncNow();
    emit('data-changed', { source: 'start' });
  }
}

// Screens where a quick sign-in redirect loses nothing (no form, no session).
const SAFE_TO_LEAVE = /^#\/(start|lernen|karten|ki|mehr)(\/(sync|statistik|daten|einstellungen))?$/;

/** Back in the foreground after a while: renew an expired web sign-in, then switch. */
async function onResume() {
  const chosen = cloud.provider();
  if (!chosen) return;
  if (await chosen.auth.renewalNeeded()) {
    if (navigator.onLine && SAFE_TO_LEAVE.test(location.hash) && !document.querySelector('.backdrop')) {
      if (await chosen.auth.trySilentRenewal({ returnHash: location.hash })) return;
    }
    cloud.needsSignIn();
    return;
  }
  const result = await cloud.startup({ resumed: true });
  if (result === 'moved') openMovedSheet();
}

function onSyncNotice(notice) {
  if (notice.kind === 'activated') {
    toast(notice.previous ? 'Gerätewechsel erkannt – dieses Gerät ist jetzt aktiv.' : 'Dieses Gerät ist jetzt aktiv.', { tone: 'success', key: 'device' });
  } else if (notice.kind === 'deactivated') {
    toast(`Gerätewechsel: ${cloud.describeDevice(notice.other)} ist jetzt aktiv. Hier nur noch lesen.`, { key: 'device' });
  } else if (notice.kind === 'conflict') {
    openConflictSheet();
  } else if (notice.kind === 'resolved') {
    toast(notice.choice === 'merge' ? 'Änderungen übernommen – alles synchron.' : `${cloud.status.label}-Stand geladen.`, { tone: 'success', key: 'device' });
  } else if (notice.kind === 'moved') {
    openMovedSheet();
  } else if (notice.kind === 'signed_out_other') {
    toast(`${cloud.describeDevice(notice.other)} ist abgemeldet und nur noch lesend.`, { key: 'device' });
  }
  if (['pulled', 'activated', 'resolved'].includes(notice.kind)) emit('data-changed', { source: 'sync' });
}

async function bootCloud() {
  useLocalBackend(localBackend);
  const chosen = providers.provider();
  let notice = '';
  let silentFailed = false;
  let completed = false;
  if (chosen.configured()) {
    try {
      const result = await chosen.auth.completeRedirect();
      if (result.error) notice = result.error;
      if (result.silent) silentFailed = true;
      completed = Boolean(result.completed);
    } catch (error) {
      notice = error.message || 'Anmeldung fehlgeschlagen.';
    }
  }
  if (!chosen.configured()) {
    onboarding.showSetup(document.getElementById('app'), chosen);
    return;
  }
  await cloud.init(chosen);
  const signedIn = await chosen.auth.isSignedIn();
  if (!signedIn && dataset.isEmpty() && !cloud.hasBase()) {
    onboarding.showWelcome(document.getElementById('app'), { message: notice, provider: chosen });
    return;
  }
  await startApp();
  if (notice) toast(notice, { tone: 'error' });
  if (!(await chosen.auth.ready())) {
    // Google web sign-ins last an hour, Microsoft's 24 h: a quick redirect
    // renews them silently while the account's session is alive.  Otherwise
    // the status asks for one tap on "Anmelden"; learning goes on locally.
    if (!silentFailed && navigator.onLine && (signedIn || cloud.hasBase()) && (await chosen.auth.trySilentRenewal({ returnHash: location.hash }))) return;
    cloud.needsSignIn();
    return;
  }
  if (completed) await cloud.refreshAccount();
  const result = await cloud.startup();
  if (result === 'not_initialized') openEmptyCloudSheet();
  else if (result === 'moved') openMovedSheet();
  else if (result === 'inactive' && !cloud.status.autoSwitch) openSwitchSheet();
  emit('data-changed', { source: 'start' });
}

async function bootServer() {
  try {
    const session = await api.get('/api/auth/session', { timeout: 8000 });
    await setMeta('device', session.device_name || state.meta.device);
    await startApp();
  } catch (error) {
    if (error instanceof NetworkError && state.meta.epoch) {
      await startApp();
      toast('Offline – du siehst den zuletzt synchronisierten Stand.');
    } else if (error instanceof ApiError && error.status === 503) {
      showLogin('Der Server ist noch nicht eingerichtet (Passwort fehlt).');
    } else if (error instanceof NetworkError) {
      showLogin('Der Server ist nicht erreichbar. Bitte Verbindung prüfen.');
    } else {
      showLogin();
    }
  }
}

export async function enterApp() {
  await startApp();
  const result = await cloud.startup();
  if (result === 'not_initialized') openEmptyCloudSheet();
  emit('data-changed', { source: 'start' });
}

async function boot() {
  registerServiceWorker();
  document.documentElement.classList.toggle('is-standalone', isStandalone());
  await loadConfig();
  try {
    await load();
  } catch (error) {
    console.warn('Lokale Daten nicht lesbar', error);
  }
  if (isCloud()) await bootCloud();
  else await bootServer();
}

boot();
