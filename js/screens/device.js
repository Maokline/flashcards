// Mehr → Sync & Geräte: provider (Google Drive / OneDrive), account, status,
// active device, device switch, automatic switching, offline images and the
// other devices.

import { errorMessage } from '../api.js';
import { on } from '../bus.js';
import * as cloud from '../cloud/sync.js';
import * as providers from '../cloud/providers.js';
import { state } from '../store.js';
import { confirmDialog, field, sectionTitle, toast, toggle } from '../ui.js';
import { clear, formatDateTime, h, icon, plural } from '../util.js';
import { logout, switchAccount } from '../app.js';
import { openConflictSheet, openMovedSheet, openSwitchSheet } from './onboarding.js';

function stateLabel(status) {
  const label = status.label || 'Cloud';
  const vendor = status.vendor || label;
  const target = (status.movedTo && status.movedTo.label) || 'einen anderen Anbieter';
  return {
    active: ['Dieses Gerät ist aktiv', `Synchronisiert – Änderungen werden automatisch in ${label} gespeichert.`, 'is-ok'],
    inactive: ['Nur lesen', 'Ein anderes Gerät ist gerade aktiv.', 'is-readonly'],
    switching: ['Gerätewechsel …', 'Der neueste Stand wird geladen.', 'is-busy'],
    conflict: ['Entscheidung nötig', 'Nicht übertragene Änderungen treffen auf einen neueren Stand.', 'is-alert'],
    offline: ['Offline', 'Lernen geht weiter – die Synchronisation wird später erneut versucht.', 'is-offline'],
    auth: ['Anmeldung erneuern', `Die ${vendor}-Anmeldung muss kurz erneuert werden. Änderungen bleiben auf diesem Gerät.`, 'is-alert'],
    not_initialized: [`${label} ist leer`, 'Verbinde zuerst die Desktop-App.', 'is-readonly'],
    not_connected: ['Nicht verbunden', `Melde dich bei ${vendor} an.`, 'is-offline'],
    moved: ['Umgezogen', `Der gemeinsame Stand liegt jetzt in ${target}.`, 'is-readonly'],
    error: ['Sync-Fehler', '', 'is-alert'],
  }[status.state] || [status.state, '', 'is-busy'];
}

function deviceIcon(item) {
  return icon(item && item.platform === 'mobile' ? 'phone' : 'monitor');
}

function render(view) {
  const host = h('div', { class: 'stack-lg', id: 'sync-page' });
  view.append(host);
  let devices = null;

  const draw = () => {
    clear(host);
    const status = cloud.status;
    const provider = cloud.provider() || providers.provider();
    const [title, text, tone] = stateLabel(status);
    const thisDevice = status.thisDevice || {};
    const active = status.activeDevice;
    const otherActive = status.state !== 'active' && active && active.device_id !== thisDevice.device_id;
    const actions = [];
    if (status.state === 'inactive' || status.state === 'error') {
      actions.push(h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', id: 'sync-activate', on: { click: () => openSwitchSheet({ start: true }) } }, icon('swap'), 'Dieses Gerät aktivieren'));
    } else if (status.state === 'conflict') {
      actions.push(h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', id: 'sync-resolve', on: { click: openConflictSheet } }, icon('info'), 'Jetzt entscheiden'));
    } else if (status.state === 'auth' || status.state === 'not_connected') {
      actions.push(h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', id: 'sync-signin', on: { click: () => provider.auth.signIn() } }, icon('lock'), `Bei ${provider.vendor} anmelden`));
    } else if (status.state === 'moved') {
      actions.push(h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', id: 'sync-moved', on: { click: () => openMovedSheet() } }, icon('swap'), `Zu ${(status.movedTo && status.movedTo.label) || 'neuem Anbieter'} wechseln`));
    }
    const syncButton = h('button', { class: 'btn btn-secondary btn-lg btn-block', type: 'button', id: 'sync-now' }, icon('refresh'), 'Jetzt synchronisieren');
    syncButton.addEventListener('click', async () => {
      syncButton.disabled = true;
      try {
        const wasActive = cloud.isActive();
        const result = await cloud.syncNow();
        // A device switch found by this check already has its own notice.
        if (!(wasActive && result === 'inactive')) {
          toast(result === 'active' ? 'Alles synchron.' : result === 'inactive' ? 'Aktueller Stand geladen (nur lesen).' : cloud.status.message, { tone: result === 'active' || result === 'inactive' ? 'success' : '' });
        }
      } catch (error) {
        toast(errorMessage(error), { tone: 'error' });
      } finally {
        syncButton.disabled = false;
        draw();
      }
    });
    const signOutOther = otherActive
      ? h('button', { class: 'btn btn-ghost btn-block', type: 'button', id: 'sync-signout-other' }, icon('logout'), `${cloud.describeDevice(active)} abmelden`)
      : null;
    if (signOutOther) {
      signOutOther.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Zuvor aktives Gerät abmelden?',
          text: `${cloud.describeDevice(active)} wird bei der nächsten Prüfung auf „nur lesen“ gestellt. Nicht übertragene Änderungen dort werden nicht überschrieben. Dieses Gerät wird dadurch noch nicht aktiv.`,
          confirm: 'Abmelden',
          icon: 'logout',
        });
        if (!ok) return;
        try {
          if (await cloud.signOutOtherDevice()) toast(`${cloud.describeDevice(active)} ist abgemeldet.`, { tone: 'success' });
        } catch (error) {
          toast(errorMessage(error), { tone: 'error' });
        }
        draw();
      });
    }

    const auto = toggle('Gerätewechsel automatisch erkennen', status.autoSwitch, { id: 'sync-auto' });
    auto.input.addEventListener('change', async () => {
      await cloud.updateDevice({ auto_switch: auto.input.checked });
      toast(auto.input.checked ? 'Automatischer Gerätewechsel ist an.' : 'Automatischer Gerätewechsel ist aus.');
    });
    const images = toggle('Bilder offline speichern', state.meta.offline_images !== false, { id: 'sync-images' });
    images.input.addEventListener('change', async () => {
      state.meta.offline_images = images.input.checked;
      await cloud.updateDevice({ offline_images: images.input.checked });
      if (images.input.checked) cloud.prefetchMedia();
    });
    const name = h('input', { class: 'input', id: 'sync-device-name', value: thisDevice.device_name || '', maxlength: '60', autocomplete: 'off', enterkeyhint: 'done' });
    name.addEventListener('change', async () => {
      const value = name.value.trim();
      if (!value) return;
      await cloud.updateDevice({ device_name: value });
      toast('Gerätename gespeichert');
    });
    const account = status.account || {};

    host.append(
      h('section', { class: `sync-hero ${tone}` },
        h('div', { class: 'sync-hero-head' },
          h('span', { class: 'sync-hero-icon' }, icon(status.state === 'active' ? 'check' : status.state === 'inactive' ? 'lock' : 'cloud')),
          h('div', { class: 'spacer' },
            h('p', { class: 'sync-hero-title', id: 'sync-state', text: title }),
            text ? h('p', { class: 'sync-hero-text', text }) : null)),
        h('div', { class: 'device-pair' },
          h('div', { class: `device-tile${status.state === 'active' ? ' is-active' : ''}` },
            h('span', { class: 'device-tile-icon' }, deviceIcon(thisDevice)),
            h('span', { class: 'device-tile-label', text: 'Dieses Gerät' }),
            h('span', { class: 'device-tile-name', text: thisDevice.device_name || 'Handy' })),
          h('div', { class: `device-tile${status.state !== 'active' && active ? ' is-active' : ''}` },
            h('span', { class: 'device-tile-icon' }, deviceIcon(status.state === 'active' ? thisDevice : active)),
            h('span', { class: 'device-tile-label', text: 'Aktives Gerät' }),
            h('span', { class: 'device-tile-name', id: 'sync-active-device', text: status.state === 'active' ? (thisDevice.device_name || 'dieses Gerät') : cloud.describeDevice(active) }))),
        h('dl', { class: 'kv kv-compact' },
          h('div', { class: 'kv-row' }, h('dt', { text: 'Anbieter' }), h('dd', { id: 'sync-provider', text: provider.label })),
          h('div', { class: 'kv-row' }, h('dt', { text: provider.accountLabel }), h('dd', { id: 'sync-account', text: account.email || account.username || account.name || '–' })),
          h('div', { class: 'kv-row' }, h('dt', { text: 'Letzte Synchronisation' }), h('dd', { text: status.lastSync ? formatDateTime(status.lastSync) : 'noch nicht' })),
          h('div', { class: 'kv-row' }, h('dt', { text: 'Stand (Revision)' }), h('dd', { id: 'sync-revision', text: String(status.revision || '–') })))),
      h('div', { class: 'stack' }, ...actions, syncButton, signOutOther),
      sectionTitle('Gerätewechsel'),
      h('section', { class: 'card stack' },
        auto.element,
        h('p', { class: 'small muted', text: 'Öffnest du die App auf einem Gerät, übernimmt es automatisch – vorher wird immer der neueste Stand geladen. Das andere Gerät zeigt danach nur noch an.' }),
        images.element,
        field('Name dieses Geräts', name, 'So erscheint es am Desktop und in der Geräteliste.')),
      sectionTitle('Geräte'),
      h('section', { class: 'card', id: 'device-list' }, devices === null
        ? h('p', { class: 'small muted', text: 'Lade Geräteliste …' })
        : devices.length
          ? devices.map((item) => h('div', { class: 'device-row' },
            h('span', { class: 'stat-icon tone-blue' }, deviceIcon(item)),
            h('span', { class: 'deck-main' },
              h('span', { class: 'deck-name', text: `${item.device_name || 'Gerät'}${item.device_id === thisDevice.device_id ? ' (dieses Gerät)' : ''}` }),
              h('span', { class: 'deck-meta', text: `zuletzt ${formatDateTime(item.last_seen_at)}` })),
            ((status.state === 'active' && item.device_id === thisDevice.device_id) || (active && item.device_id === active.device_id))
              ? h('span', { class: 'chip chip-mastered', text: 'aktiv' }) : null))
          : h('p', { class: 'small muted', text: 'Noch keine Geräte gemeldet.' })),
      sectionTitle('Konto'),
      h('section', { class: 'card stack' },
        h('div', { class: 'row' },
          h('span', { class: 'stat-icon tone-slate' }, icon('cloud')),
          h('div', { class: 'spacer' },
            h('p', { class: 'strong', text: account.name || account.email || account.username || provider.accountLabel }),
            h('p', { class: 'tiny muted', text: account.email || account.username || provider.label }))),
        h('p', { class: 'small muted', text: provider.privacy }),
        h('button', { class: 'btn btn-secondary btn-block', type: 'button', id: 'sync-switch-account', on: { click: switchAccount } }, icon('swap'), 'Konto wechseln'),
        h('button', { class: 'btn btn-danger-soft btn-block', type: 'button', id: 'sync-logout', on: { click: logout } }, icon('logout'), `${provider.label} trennen`)),
      h('p', { class: 'tiny muted center', text: `Sync-Anbieter: ${provider.label}${provider.key === 'gdrive' ? ' (Standard)' : ''} · ${plural(state.media.size, 'Bild', 'Bilder')} im Datenbestand` }));
  };

  draw();
  let alive = true;
  cloud.listDevices().then((items) => { devices = items; if (alive) draw(); }).catch(() => { devices = []; if (alive) draw(); });
  const off = on('status', () => { if (alive) draw(); });
  return { cleanup: () => { alive = false; off(); }, onData: () => {} };
}

export default {
  page: {
    area: 'more',
    tab: 'mehr',
    title: () => ({ title: 'Sync & Geräte', eyebrow: cloud.status.label || 'Synchronisation', back: '#/mehr' }),
    render,
  },
};
