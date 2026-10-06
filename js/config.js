// App configuration (config.json next to index.html).
//
//   {"backend": "gdrive",
//    "google_client_id": "….apps.googleusercontent.com",   // Web client
//    "client_id": "…", "tenant": "consumers"}               // OneDrive (optional)
//
// * The static build for the phone (tools/build_pwa.py) writes the Google web
//   client ID (google_drive_app.json → web_client_id) and, if present, the
//   OneDrive app registration into it.  No secrets.
// * The optional sync server answers /config.json with {"backend": "server"}.
// * Without a client ID the app asks for it once (stored on this device).
// * "backend" names the default provider; the user may pick the other cloud
//   provider on this device (stored as fc-provider).

import { http } from './api.js';

const OVERRIDE_KEY = 'fc-config-override';
const PROVIDER_KEY = 'fc-provider';
export const CLOUD_PROVIDERS = ['gdrive', 'onedrive'];

export const DEFAULTS = {
  backend: 'gdrive',
  // Google Drive (default provider): Web client, scope drive.appdata only.
  google_client_id: '',
  google_scope: 'https://www.googleapis.com/auth/drive.appdata',
  google_auth_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  google_revoke_endpoint: 'https://oauth2.googleapis.com/revoke',
  google_api_base: 'https://www.googleapis.com',
  // OneDrive (optional provider).
  client_id: '',
  tenant: 'consumers',
  authority: 'https://login.microsoftonline.com',
  graph_base: 'https://graph.microsoft.com/v1.0',
  scopes: ['Files.ReadWrite.AppFolder', 'offline_access', 'openid', 'profile'],
  redirect_uri: '',
};

export const config = { ...DEFAULTS };

function readOverride() {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function saveOverride(values) {
  try {
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ ...readOverride(), ...values }));
  } catch { /* private mode: the value lives for this session only */ }
  Object.assign(config, values);
}

export function appBaseUrl() {
  // The page itself is the redirect target: https://host/path/ (no file name).
  const url = new URL(window.location.href);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/[^/]*$/, '');
  return url.toString();
}

export const configState = { loaded: false };

async function readConfigFile() {
  // Two attempts: a slow first answer must not turn into the setup screen.
  for (const timeout of [6000, 12000]) {
    try {
      const response = await http.asset('./config.json', { timeout });
      if (response.ok) {
        configState.loaded = true;
        return (await response.json()) || {};
      }
      if (response.status === 404) return {};
    } catch { /* offline or slow: try once more, the service worker may answer */ }
  }
  return {};
}

export async function loadConfig() {
  const file = await readConfigFile();
  Object.assign(config, DEFAULTS, file || {});
  const override = readOverride();
  if (!config.client_id && override.client_id) config.client_id = override.client_id;
  if (!config.google_client_id && override.google_client_id) config.google_client_id = override.google_client_id;
  if (override.backend_hint && !file.backend) config.backend = override.backend_hint;
  if (!config.redirect_uri) config.redirect_uri = appBaseUrl();
  return config;
}

/** Local-first cloud mode (Google Drive or OneDrive) instead of the optional server. */
export function isCloud() {
  return config.backend !== 'server';
}

// Older name: the cloud mode used to be OneDrive only.
export const isOneDrive = isCloud;

/** The provider this device synchronises with. */
export function chosenProvider() {
  let stored = '';
  try { stored = localStorage.getItem(PROVIDER_KEY) || ''; } catch { stored = ''; }
  if (CLOUD_PROVIDERS.includes(stored)) return stored;
  return CLOUD_PROVIDERS.includes(config.backend) ? config.backend : 'gdrive';
}

export function chooseProvider(key) {
  try {
    if (CLOUD_PROVIDERS.includes(key)) localStorage.setItem(PROVIDER_KEY, key);
    else localStorage.removeItem(PROVIDER_KEY);
  } catch { /* private mode */ }
}
