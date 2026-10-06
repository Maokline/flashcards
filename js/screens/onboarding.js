// First start, sign-in (Google Drive by default, OneDrive optional), device
// switch, conflict decisions and the move to another provider.

import { errorMessage } from '../api.js';
import * as cloud from '../cloud/sync.js';
import * as providers from '../cloud/providers.js';
import { chooseProvider, config, saveOverride } from '../config.js';
import { openSheet, toast } from '../ui.js';
import { clear, h, icon } from '../util.js';

function brand() {
  return h('div', { class: 'welcome-brand' },
    h('img', { class: 'welcome-logo', src: 'icons/icon-192.png', alt: '', width: '96', height: '96' }),
    h('h1', { class: 'welcome-title', text: 'FlashCard App' }),
    h('p', { class: 'welcome-sub', text: 'Lernen auf Desktop und Handy – mit einem gemeinsamen Stand.' }));
}

function feature(iconName, title, text, tone) {
  return h('li', { class: 'welcome-feature' },
    h('span', { class: `feature-icon ${tone}` }, icon(iconName)),
    h('span', { class: 'feature-text' }, h('strong', { text: title }), h('span', { text })));
}

function otherProvider(current) {
  return providers.available().find((item) => item.key !== current.key) || null;
}

/** First start: connect the chosen provider (Google Drive by default). */
function showWelcome(app, { message = '', provider = providers.provider() } = {}) {
  clear(app);
  app.dataset.area = 'home';
  const button = h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'button', id: 'welcome-signin' }, icon('cloud'), `Mit ${provider.label} verbinden`);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await provider.auth.signIn({ returnHash: '#/start' });
    } catch (error) {
      button.disabled = false;
      toast(errorMessage(error), { tone: 'error' });
    }
  });
  const other = otherProvider(provider);
  const alternative = other
    ? h('button', { class: 'btn btn-ghost btn-block', type: 'button', id: 'welcome-other', on: { click: () => { chooseProvider(other.key); window.location.reload(); } } }, `Stattdessen ${other.label} verwenden`)
    : null;
  app.append(h('div', { class: 'welcome' },
    h('div', { class: 'welcome-inner' },
      brand(),
      h('ul', { class: 'welcome-features' },
        feature('swap', 'Ein Stand, zwei Geräte', 'Öffnest du die App auf dem Handy, übernimmt es automatisch – mit dem neuesten Stand vom Desktop.', 'tone-learn'),
        feature('cloud', `Deine Daten in deinem ${provider.label}`, `Kein Server, keine laufenden Kosten. ${provider.privacy}`, 'tone-blue'),
        feature('offline', 'Lernt auch offline', 'Bewertungen werden gespeichert und später übertragen.', 'tone-mint')),
      message ? h('p', { class: 'form-error', role: 'alert', text: message }) : null,
      h('div', { class: 'welcome-actions' },
        button,
        alternative,
        h('p', { class: 'tiny muted center', text: `Du meldest dich direkt bei ${provider.vendor} an – die App sieht dein Passwort nie.` })))));
  document.title = 'Willkommen · FlashCard App';
}

/** The client ID of the chosen provider is missing: ask for it once. */
function showSetup(app, provider = providers.provider()) {
  clear(app);
  app.dataset.area = 'home';
  const input = h('input', { class: 'input', id: 'setup-client-id', placeholder: provider.clientIdExample, autocomplete: 'off', spellcheck: 'false', inputmode: 'text' });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', id: 'setup-save' }, icon('check'), 'Speichern');
  save.addEventListener('click', () => {
    const value = input.value.trim();
    if (!provider.clientIdPattern.test(value)) {
      error.textContent = `Bitte die ${provider.clientIdLabel} im Format ${provider.clientIdExample} eintragen.`;
      error.hidden = false;
      return;
    }
    saveOverride({ [provider.configKey]: value });
    window.location.reload();
  });
  const doc = provider.key === 'gdrive' ? 'docs/GOOGLE_DRIVE_SETUP.md' : 'docs/ONEDRIVE_SETUP.md';
  app.append(h('div', { class: 'welcome' },
    h('div', { class: 'welcome-inner' },
      brand(),
      h('section', { class: 'card stack' },
        h('p', { class: 'strong', text: 'Einmalige Einrichtung' }),
        h('p', { class: 'small muted', text: `Trage die ${provider.clientIdLabel} deines ${provider.key === 'gdrive' ? 'Google-Cloud-Projekts' : 'Microsoft-App-Registrierung'} ein. Die Anleitung steht in ${doc}.` }),
        error,
        h('label', { class: 'field-label', for: 'setup-client-id', text: provider.clientIdLabel }),
        input,
        save))));
  document.title = 'Einrichten · FlashCard App';
}

// At most one switch/conflict sheet at a time (several triggers may fire).
let switchSheet = null;
let conflictSheet = null;
let movedSheet = null;

/** "Der Desktop war zuletzt aktiv – wir übernehmen jetzt dieses Gerät." */
export function openSwitchSheet({ start = false } = {}) {
  if (switchSheet) return switchSheet;
  const other = cloud.describeDevice(cloud.status.activeDevice);
  const status = h('p', { class: 'form-info', hidden: true, role: 'status' });
  const sheet = openSheet({
    title: 'Hier weiterlernen?',
    className: 'sheet-switch',
    onClose: () => { switchSheet = null; },
    body: [
      h('div', { class: 'switch-visual', 'aria-hidden': 'true' },
        h('span', { class: 'switch-device' }, icon('monitor')),
        h('span', { class: 'switch-arrow' }, icon('swap')),
        h('span', { class: 'switch-device is-target' }, icon('phone'))),
      h('p', { class: 'switch-text' }, h('strong', { text: `Zuletzt war ${other} aktiv.` }), ' Wir laden den neuesten Stand und übernehmen dann mit diesem Gerät. Das andere Gerät zeigt danach nur noch an.'),
      status,
    ],
    actions: [
      { label: 'Nur lesen', variant: 'btn-secondary', onClick: (s) => s.close() },
      { label: 'Dieses Gerät aktivieren', icon: 'swap', variant: 'btn-primary', id: 'switch-activate', onClick: (s) => run(s) },
    ],
  });
  async function run(s) {
    s.setBusy(true);
    status.hidden = false;
    status.textContent = 'Lade den neuesten Stand …';
    try {
      const result = await cloud.activate();
      s.close();
      if (result === 'conflict') openConflictSheet();
    } catch (error) {
      s.setBusy(false);
      status.textContent = `Gerätewechsel nicht möglich: ${errorMessage(error)}`;
    }
  }
  switchSheet = sheet;
  if (start) run(sheet);
  return sheet;
}

export function openConflictSheet() {
  if (conflictSheet) return conflictSheet;
  const conflict = cloud.status.conflict || {};
  const other = cloud.describeDevice(conflict.other_device || cloud.status.activeDevice);
  const label = cloud.status.label || 'Cloud';
  const status = h('p', { class: 'form-info', hidden: true, role: 'status' });
  const sheet = openSheet({
    title: 'Änderungen zusammenführen?',
    onClose: () => { conflictSheet = null; },
    body: [
      h('p', { class: 'muted', text: `Auf diesem Gerät liegen Änderungen, die ${label} noch nicht erreicht haben – inzwischen war ${other} aktiv. Es wird nichts still überschrieben.` }),
      h('div', { class: 'choice-cards' },
        h('div', { class: 'choice-card is-recommended' },
          h('p', { class: 'strong', text: 'Übernehmen (empfohlen)' }),
          h('p', { class: 'small muted', text: 'Deine Bewertungen werden mit der Lern-Engine auf den neuesten Stand nachgetragen; Kartenänderungen beider Geräte bleiben erhalten.' })),
        h('div', { class: 'choice-card' },
          h('p', { class: 'strong', text: 'Verwerfen' }),
          h('p', { class: 'small muted', text: `Dieses Gerät lädt den ${label}-Stand; die Änderungen hier gehen verloren.` }))),
      status,
    ],
    stacked: true,
    actions: [
      { label: 'Übernehmen', icon: 'check', variant: 'btn-primary', id: 'conflict-merge', onClick: (s) => decide(s, 'merge') },
      { label: 'Verwerfen', icon: 'trash', variant: 'btn-danger-soft', id: 'conflict-discard', onClick: (s) => decide(s, 'discard') },
      { label: 'Später', variant: 'btn-ghost', id: 'conflict-later', onClick: (s) => s.close() },
    ],
  });
  async function decide(s, choice) {
    s.setBusy(true);
    status.hidden = false;
    status.textContent = choice === 'merge' ? 'Führe zusammen …' : `Lade ${label}-Stand …`;
    try {
      await cloud.resolveConflict(choice);
      s.close();
    } catch (error) {
      s.setBusy(false);
      status.textContent = errorMessage(error);
    }
  }
  conflictSheet = sheet;
  return sheet;
}

export function openEmptyCloudSheet() {
  const label = cloud.status.label || 'Google Drive';
  const status = h('p', { class: 'form-info', hidden: true, role: 'status' });
  const where = cloud.status.provider === 'onedrive' ? 'Im Ordner „Apps/FlashCard App“' : `Im App-Speicher deines ${label}`;
  openSheet({
    title: `${label} ist noch leer`,
    body: [
      h('p', { class: 'muted', text: `${where} liegen noch keine Karten. Verbinde zuerst die Desktop-App (Einstellungen → Synchronisation → „Mit ${label} verbinden …“) – sie überträgt deinen Bestand. Danach erscheint er hier automatisch.` }),
      status,
    ],
    stacked: true,
    actions: [
      { label: 'Erneut prüfen', icon: 'refresh', variant: 'btn-primary', id: 'empty-recheck', onClick: async (s) => { s.setBusy(true); const result = await cloud.startup(); s.close(); if (result === 'not_initialized') toast(`Noch keine Daten in ${label}.`); } },
      {
        label: 'Hier neu beginnen',
        variant: 'btn-secondary',
        id: 'empty-start-here',
        onClick: async (s) => {
          s.setBusy(true);
          try {
            await cloud.initializeRemote();
            s.close();
            toast(`${label} eingerichtet – dieses Gerät ist aktiv.`, { tone: 'success' });
          } catch (error) {
            s.setBusy(false);
            status.hidden = false;
            status.textContent = errorMessage(error);
          }
        },
      },
    ],
  });
}

// Older name (OneDrive was the only provider before).
export const openEmptyOneDriveSheet = openEmptyCloudSheet;

/** The data set moved to another provider (head.moved_to): switch this phone too. */
export function openMovedSheet() {
  if (movedSheet) return movedSheet;
  const moved = cloud.status.movedTo || cloud.state_().moved_to || {};
  const target = providers.provider(moved.provider);
  const from = cloud.status.label || 'dem alten Anbieter';
  const status = h('p', { class: 'form-info', hidden: true, role: 'status' });
  const ready = target && target.key === moved.provider && target.configured();
  movedSheet = openSheet({
    title: `Synchronisation zu ${moved.label || target.label} umgezogen`,
    onClose: () => { movedSheet = null; },
    body: [
      h('p', { class: 'muted', text: `Der gemeinsame Stand liegt jetzt in ${moved.label || target.label}. ${from} bleibt unverändert als Archiv. Nach dem Wechsel meldest du dich einmal an; Änderungen, die hier noch nicht übertragen waren, werden zusammengeführt – nichts geht verloren.` }),
      ready ? null : h('p', { class: 'form-error', text: `Diese App-Version kennt ${moved.label || 'den neuen Anbieter'} noch nicht – bitte die Handy-App mit der neuen Client-ID neu veröffentlichen (Anleitung).` }),
      status,
    ],
    stacked: true,
    actions: [
      {
        label: `Zu ${moved.label || target.label} wechseln`,
        icon: 'swap',
        variant: 'btn-primary',
        id: 'moved-switch',
        onClick: async (s) => {
          if (!ready) return;
          s.setBusy(true);
          await cloud.switchTo(target.key);
          window.location.reload();
        },
      },
      { label: 'Später', variant: 'btn-ghost', onClick: (s) => s.close() },
    ],
  });
  return movedSheet;
}

export default { showWelcome, showSetup };

export { config };
