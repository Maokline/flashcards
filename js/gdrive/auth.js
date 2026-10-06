// Google sign-in for the PWA – Google's OAuth 2.0 flow for client-side web
// applications (OAuth client of type "Web application", its own client ID,
// separate from the desktop's "Desktop app" client; no secret in the app).
//
// 1. signIn() remembers a random state and leaves the app for
//    accounts.google.com (response_type=token, scope drive.appdata only).
// 2. Google redirects back to the app address with the access token in the
//    URL fragment; completeRedirect() checks the state, keeps the token in
//    IndexedDB and removes it from the address bar immediately.
// 3. Web tokens last about one hour and come without a refresh token.  When
//    the app starts or returns to the foreground with an expired token, a
//    quick redirect with prompt=none renews it while the Google session is
//    alive; otherwise the app asks for one tap on "Anmelden".  Local work is
//    never blocked by this – changes wait locally and are committed after.
//
// A full-page redirect (instead of a pop-up) works in installed home-screen
// apps on iPhone and Android and needs no external script (strict CSP).

import { http } from '../api.js';
import { AuthRequiredError } from '../cloud/errors.js';
import { config } from '../config.js';
import * as db from '../db.js';

export { AuthRequiredError };

const PENDING_KEY = 'fc-gauth-pending';
const SILENT_AT_KEY = 'fc-gauth-silent-at';
const SILENT_FAILED_KEY = 'fc-gauth-silent-failed';
const TOKENS = 'gd_tokens';
const MARGIN_MS = 2 * 60 * 1000;
const SILENT_PAUSE_MS = 5 * 60 * 1000;

function randomString(bytes = 24) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function storePending(value) {
  const text = JSON.stringify({ ...value, created: Date.now() });
  try { sessionStorage.setItem(PENDING_KEY, text); } catch { /* ignore */ }
  try { localStorage.setItem(PENDING_KEY, text); } catch { /* ignore */ }
}

function takePending() {
  let text = null;
  try { text = sessionStorage.getItem(PENDING_KEY) || localStorage.getItem(PENDING_KEY); } catch { text = null; }
  try { sessionStorage.removeItem(PENDING_KEY); localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return Date.now() - value.created < 30 * 60 * 1000 ? value : null;
  } catch {
    return null;
  }
}

function session(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, String(value));
  } catch { /* private mode */ }
  return null;
}

export function buildAuthorizeUrl({ prompt = '', loginHint = '', returnHash = '', selectAccount = false } = {}) {
  const state = randomString(24);
  storePending({ state, returnHash, prompt });
  const params = new URLSearchParams({
    client_id: config.google_client_id,
    redirect_uri: config.redirect_uri,
    response_type: 'token',
    scope: config.google_scope,
    include_granted_scopes: 'true',
    state,
  });
  if (prompt) params.set('prompt', prompt);
  else if (selectAccount) params.set('prompt', 'select_account');
  if (loginHint) params.set('login_hint', loginHint);
  return `${config.google_auth_endpoint}?${params}`;
}

/** Leave the app for Google's sign-in page. */
export async function signIn(options = {}) {
  window.location.assign(buildAuthorizeUrl({ returnHash: location.hash, ...options }));
}

function describe(error) {
  return {
    access_denied: 'Die Anmeldung wurde abgebrochen.',
    interaction_required: 'Bitte bei Google anmelden.',
    login_required: 'Bitte bei Google anmelden.',
  }[error] || `Google hat die Anmeldung abgelehnt (${error}).`;
}

/**
 * Called on every start: finishes a sign-in when Google redirected back.
 * Returns {completed, error, silent, returnHash}.
 */
export async function completeRedirect() {
  const fragment = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (!/(^|&)(access_token|error)=/.test(fragment)) return { completed: false };
  const params = new URLSearchParams(fragment);
  const pending = takePending();
  const target = pending && pending.returnHash && !/access_token|error=/.test(pending.returnHash) ? pending.returnHash : '#/start';
  history.replaceState(null, '', `${location.pathname}${location.search}${target}`);
  if (!pending || pending.state !== params.get('state')) {
    return { completed: false, error: 'Die Anmeldung konnte nicht zugeordnet werden – bitte erneut versuchen.' };
  }
  if (params.get('error')) {
    const silent = pending.prompt === 'none';
    if (silent) session(SILENT_FAILED_KEY, '1');
    return { completed: false, silent, error: silent ? '' : describe(params.get('error')) };
  }
  const scopes = String(params.get('scope') || '').split(' ');
  if (!scopes.includes(config.google_scope)) {
    return { completed: false, error: 'Der Zugriff auf die App-Daten wurde nicht erlaubt – bitte bei der Anmeldung zustimmen.' };
  }
  const previous = (await db.getMeta(TOKENS)) || {};
  await db.setMeta(TOKENS, {
    client_id: config.google_client_id,
    access_token: params.get('access_token'),
    expires_at: Date.now() + (Number(params.get('expires_in')) || 3600) * 1000,
    scope: params.get('scope') || config.google_scope,
    account: previous.client_id === config.google_client_id ? previous.account || {} : {},
    signed_in_at: Date.now(),
  });
  session(SILENT_FAILED_KEY, null);
  return { completed: true, returnHash: target };
}

export async function tokens() {
  const record = await db.getMeta(TOKENS);
  if (!record || record.client_id !== config.google_client_id || !record.access_token) return null;
  return record;
}

/** An account is known on this device (the token may need a renewal). */
export async function isSignedIn() {
  return Boolean(await tokens());
}

/** A valid access token is at hand: synchronisation can run right now. */
export async function ready() {
  const record = await tokens();
  return Boolean(record && record.expires_at - MARGIN_MS > Date.now());
}

export async function renewalNeeded() {
  const record = await tokens();
  return Boolean(record && record.expires_at - MARGIN_MS <= Date.now());
}

export async function account() {
  const record = await tokens();
  return (record && record.account) || {};
}

export async function saveAccount(value) {
  const record = await tokens();
  if (!record) return;
  await db.setMeta(TOKENS, { ...record, account: value || {} });
}

export async function accessToken() {
  const record = await tokens();
  if (!record) throw new AuthRequiredError('Bitte bei Google anmelden.');
  if (record.expires_at - MARGIN_MS > Date.now()) return record.access_token;
  throw new AuthRequiredError('Die Google-Anmeldung muss kurz erneuert werden.');
}

/**
 * Renew an expired token with a quick redirect (prompt=none).  At most every
 * few minutes and never again in this session after Google said no – then the
 * user taps "Anmelden".
 */
export async function trySilentRenewal({ returnHash } = {}) {
  if (session(SILENT_FAILED_KEY) === '1') return false;
  const last = Number(session(SILENT_AT_KEY) || 0);
  if (Date.now() - last < SILENT_PAUSE_MS) return false;
  session(SILENT_AT_KEY, Date.now());
  const known = await account();
  await signIn({ prompt: 'none', loginHint: known.email || known.username || '', returnHash: returnHash ?? location.hash });
  return true;
}

export async function signOut() {
  const record = await tokens();
  if (record && record.access_token) {
    try {
      await http.post(config.google_revoke_endpoint, new URLSearchParams({ token: record.access_token }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
      });
    } catch { /* offline: the token expires within the hour anyway */ }
  }
  await db.setMeta(TOKENS, null);
}
