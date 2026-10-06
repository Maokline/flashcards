// The cloud providers of the PWA (twin of app/cloudsync/providers.py).
//
// Each provider bundles its sign-in (auth module), its file store and the
// words the screens use.  The sync engine (cloud/sync.js) only talks to
//   store.readHead / writeHead / list / download / upload / uploadJson /
//   readJson / remove / open / ensureLayout / discardHead
// and never to Google or Microsoft directly.

import { chosenProvider, config } from '../config.js';
import * as gdriveAuth from '../gdrive/auth.js';
import { GoogleDriveStore } from '../gdrive/store.js';
import * as onedriveAuth from '../onedrive/auth.js';
import { OneDriveStore } from '../onedrive/store.js';

const PROVIDERS = {
  gdrive: {
    key: 'gdrive',
    label: 'Google Drive',
    vendor: 'Google',
    accountLabel: 'Google-Konto',
    privacy: 'FlashCard App kann nur ihre eigenen versteckten App-Daten in deinem Google Drive lesen und schreiben.',
    clientIdLabel: 'Web-Client-ID (Google Cloud, Typ „Webanwendung“)',
    clientIdPattern: /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i,
    clientIdExample: '123456789012-abc123def456.apps.googleusercontent.com',
    configKey: 'google_client_id',
    stateKey: 'gd_state',
    auth: gdriveAuth,
    configured: () => Boolean(config.google_client_id),
    createStore: (token) => new GoogleDriveStore({ base: config.google_api_base, token }),
  },
  onedrive: {
    key: 'onedrive',
    label: 'OneDrive',
    vendor: 'Microsoft',
    accountLabel: 'Microsoft-Konto',
    privacy: 'FlashCard App sieht nur ihren eigenen Ordner „Apps/FlashCard App“ in deinem OneDrive.',
    clientIdLabel: 'Anwendungs-ID (Client-ID)',
    clientIdPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    clientIdExample: '00000000-0000-0000-0000-000000000000',
    configKey: 'client_id',
    stateKey: 'od_state',
    auth: onedriveAuth,
    configured: () => Boolean(config.client_id),
    createStore: (token) => new OneDriveStore({ base: config.graph_base, token }),
  },
};

export function provider(key = chosenProvider()) {
  return PROVIDERS[key] || PROVIDERS.gdrive;
}

export function all() {
  return Object.values(PROVIDERS);
}

/** Providers this build can use (a client ID is configured). */
export function available() {
  return all().filter((item) => item.configured());
}
