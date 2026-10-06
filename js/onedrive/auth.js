// Microsoft sign-in for the PWA: OAuth 2.0 authorization code flow with PKCE
// (single-page application, no client secret).
//
// 1. signIn() stores verifier + state and redirects to login.microsoftonline.com.
// 2. Microsoft redirects back to the app with ?code=…&state=….
// 3. completeRedirect() exchanges the code (with the verifier) for tokens.
//
// Requested scopes: Files.ReadWrite.AppFolder (only "Apps/FlashCard App"),
// offline_access, openid, profile.  Tokens stay in this browser (IndexedDB).
// Microsoft limits refresh tokens of single-page apps to 24 hours; after that a
// quick redirect renews the sign-in (usually without any input).

import { http, NetworkError } from '../api.js';
import { AuthRequiredError } from '../cloud/errors.js';
import { config } from '../config.js';
import * as db from '../db.js';

export { AuthRequiredError };

const PENDING_KEY = 'fc-auth-pending';
const SILENT_KEY = 'fc-auth-silent-tried';
const TOKENS = 'od_tokens';
const MARGIN_MS = 2 * 60 * 1000;

function b64url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(length = 48) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

async function challengeOf(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

function endpoint(kind) {
  return `${config.authority.replace(/\/$/, '')}/${config.tenant}/oauth2/v2.0/${kind}`;
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

export async function buildAuthorizeUrl({ prompt = '', loginHint = '', returnHash = '' } = {}) {
  const verifier = randomString(48);
  const state = randomString(24);
  storePending({ verifier, state, returnHash, prompt });
  const params = new URLSearchParams({
    client_id: config.client_id,
    response_type: 'code',
    redirect_uri: config.redirect_uri,
    response_mode: 'query',
    scope: config.scopes.join(' '),
    state,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: 'S256',
  });
  if (prompt) params.set('prompt', prompt);
  if (loginHint) params.set('login_hint', loginHint);
  return `${endpoint('authorize')}?${params}`;
}

/** Leave the app for Microsoft's sign-in page. */
export async function signIn(options = {}) {
  const url = await buildAuthorizeUrl({ returnHash: location.hash, ...options });
  window.location.assign(url);
}

function accountFromIdToken(idToken) {
  if (!idToken || idToken.split('.').length < 2) return {};
  try {
    const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const text = decodeURIComponent(escape(atob(payload + '='.repeat((4 - (payload.length % 4)) % 4))));
    const claims = JSON.parse(text);
    return {
      name: String(claims.name || ''),
      username: String(claims.preferred_username || claims.email || ''),
      id: String(claims.oid || claims.sub || ''),
    };
  } catch {
    return {};
  }
}

async function tokenRequest(form) {
  const response = await http.post(endpoint('token'), new URLSearchParams(form).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  });
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    if (response.status >= 500) throw new NetworkError(new Error(`token endpoint ${response.status}`));
    throw new AuthRequiredError(body.error === 'invalid_grant'
      ? 'Die Microsoft-Anmeldung ist abgelaufen – bitte erneut anmelden.'
      : `Anmeldung fehlgeschlagen (${body.error || response.status}).`);
  }
  return body;
}

async function saveTokens(body, previous = {}) {
  const account = accountFromIdToken(body.id_token);
  const record = {
    client_id: config.client_id,
    access_token: body.access_token,
    refresh_token: body.refresh_token || previous.refresh_token || '',
    expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    // Single-page apps: the refresh token expires 24 h after the sign-in.
    signed_in_at: previous.signed_in_at && !body.id_token ? previous.signed_in_at : Date.now(),
    account: account.username || account.name ? account : (previous.account || {}),
  };
  await db.setMeta(TOKENS, record);
  return record;
}

/**
 * Called on every start: finishes a sign-in when Microsoft redirected back.
 * Returns {completed, error, returnHash}.
 */
export async function completeRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return { completed: false };
  const state = url.searchParams.get('state');
  const pending = takePending();
  const clean = `${url.pathname}${pending && pending.returnHash ? pending.returnHash : '#/start'}`;
  history.replaceState(null, '', clean);
  if (!pending || pending.state !== state) return { completed: false, error: 'Die Anmeldung konnte nicht zugeordnet werden – bitte erneut versuchen.' };
  if (error) {
    const silent = pending.prompt === 'none';
    return { completed: false, silent, error: silent ? '' : (url.searchParams.get('error_description') || error) };
  }
  const body = await tokenRequest({
    client_id: config.client_id,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirect_uri,
    code_verifier: pending.verifier,
    scope: config.scopes.join(' '),
  });
  await saveTokens(body);
  try { sessionStorage.removeItem(SILENT_KEY); } catch { /* ignore */ }
  return { completed: true, returnHash: pending.returnHash };
}

export async function tokens() {
  const record = await db.getMeta(TOKENS);
  if (!record || record.client_id !== config.client_id || !record.refresh_token) return null;
  return record;
}

export async function isSignedIn() {
  return Boolean(await tokens());
}

export async function account() {
  const record = await tokens();
  return (record && record.account) || {};
}

let refreshing = null;

/** A valid access token; refreshes when needed. */
export async function accessToken(forceRefresh = false) {
  const record = await tokens();
  if (!record) throw new AuthRequiredError('Bitte bei Microsoft anmelden.');
  if (!forceRefresh && record.access_token && record.expires_at - MARGIN_MS > Date.now()) return record.access_token;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const body = await tokenRequest({
          client_id: config.client_id,
          grant_type: 'refresh_token',
          refresh_token: record.refresh_token,
          scope: config.scopes.join(' '),
        });
        return (await saveTokens(body, record)).access_token;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/**
 * The 24-hour limit of single-page apps: renew the sign-in with a quick
 * redirect (no input while the Microsoft session is alive).  Only tried once
 * per app session to avoid loops.
 */
export async function trySilentRenewal() {
  let tried = false;
  try { tried = sessionStorage.getItem(SILENT_KEY) === '1'; } catch { tried = true; }
  if (tried) return false;
  try { sessionStorage.setItem(SILENT_KEY, '1'); } catch { return false; }
  const record = await db.getMeta(TOKENS);
  await signIn({ prompt: 'none', loginHint: record && record.account ? record.account.username : '' });
  return true;
}

export async function signOut() {
  await db.setMeta(TOKENS, null);
}

/** Ready to synchronise (a refresh token renews the access token itself). */
export async function ready() {
  return isSignedIn();
}

export const renewalNeeded = async () => false;
