// Minimal Google Drive API v3 client for the hidden appDataFolder – the
// browser twin of app/gdrive/drive.py.
//
// * Only appDataFolder: every listing passes spaces=appDataFolder (app data
//   never shows up in a normal files.list), every new file gets
//   parents=["appDataFolder"].  The token's scope is drive.appdata only.
// * 401 → the token is requested again once (a renewed sign-in may exist);
//   otherwise AuthRequiredError (the user taps "Anmelden").
// * 429, 5xx and 403 rate limits → exponential back-off with jitter, at most
//   MAX_RETRIES times; Retry-After wins.  No endless loop.
// * Small files: one multipart request; larger than 5 MB: resumable upload.

import { http } from '../api.js';
import { AuthRequiredError, NotFoundError, StorageConflict, StorageError, ThrottledError } from '../cloud/errors.js';

export const APP_DATA = 'appDataFolder';
const FILE_FIELDS = 'id,name,size,createdTime,modifiedTime,md5Checksum,version,appProperties';
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;
export const MULTIPART_LIMIT = 5 * 1024 * 1024;
const MAX_RETRIES = 5;
const MAX_BACKOFF = 32;
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError']);
const AUTH_REASONS = new Set(['authError', 'insufficientPermissions', 'insufficientScopes', 'invalidCredentials']);

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function quoteQuery(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function backoffDelay(attempt, retryAfter = null, random = Math.random) {
  const given = Number(retryAfter);
  if (retryAfter !== null && retryAfter !== '' && Number.isFinite(given) && given >= 0) return Math.min(MAX_BACKOFF, given);
  const base = Math.min(MAX_BACKOFF, 0.5 * 2 ** Math.max(0, attempt - 1));
  return base * (0.5 + 0.5 * random());
}

function fileOf(raw) {
  return {
    id: String(raw.id || ''),
    name: String(raw.name || ''),
    size: Number(raw.size) || 0,
    created: String(raw.createdTime || ''),
    modified: String(raw.modifiedTime || ''),
    version: Number(raw.version) || 0,
    appProperties: raw.appProperties || {},
  };
}

export class DriveClient {
  constructor({ base, token, sleep = realSleep }) {
    this.base = String(base || 'https://www.googleapis.com').replace(/\/$/, '');
    this.token = token;
    this.sleep = sleep;
    this.requests = 0;
  }

  async send(method, url, { body, headers = {}, auth = true, timeout = 60000 } = {}) {
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const request = { ...headers };
      if (auth) request.Authorization = `Bearer ${await this.token(refreshed)}`;
      this.requests += 1;
      let response;
      if (method === 'GET') response = await http.get(url, { headers: request, timeout });
      else if (method === 'POST') response = await http.post(url, body, { headers: request, timeout });
      else if (method === 'PATCH') response = await http.patch(url, body, { headers: request, timeout });
      else if (method === 'PUT') response = await http.put(url, body, { headers: request, timeout });
      else response = await http.del(url, { headers: request, timeout });
      if (response.ok) return response;
      let reason = '';
      let message = '';
      try {
        const payload = await response.json();
        const error = payload && payload.error;
        if (error) {
          message = error.message || '';
          reason = (error.errors && error.errors[0] && error.errors[0].reason) || error.status || '';
        }
      } catch { /* not JSON */ }
      const status = response.status;
      if (status === 401 && auth && !refreshed) {
        refreshed = true;
        continue;
      }
      const retryable = [429, 500, 502, 503, 504].includes(status) || (status === 403 && RATE_REASONS.has(reason));
      if (retryable && attempt < MAX_RETRIES) {
        await this.sleep(backoffDelay(attempt + 1, response.headers.get('Retry-After')) * 1000);
        continue;
      }
      if (retryable) throw new ThrottledError('Google Drive ist gerade überlastet – die Synchronisation wird später erneut versucht.', { status, code: reason });
      if (status === 401 || (status === 403 && AUTH_REASONS.has(reason))) throw new AuthRequiredError('Die Google-Anmeldung muss erneuert werden.');
      if (status === 403 && reason === 'accessNotConfigured') throw new StorageError('Die Google Drive API ist im Google-Cloud-Projekt nicht aktiviert (Anleitung, Schritt 3).', { status, code: reason });
      if (status === 404) throw new NotFoundError(`Nicht gefunden: ${url}`, { status, code: reason });
      if (status === 409) throw new StorageConflict(message || 'Konflikt beim Speichern.', { status, code: reason });
      throw new StorageError(message || `Google-Drive-Anfrage fehlgeschlagen (${status}).`, { status, code: reason });
    }
  }

  async json(method, url, payload) {
    const options = payload === undefined
      ? { headers: { Accept: 'application/json' } }
      : { body: JSON.stringify(payload), headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8' } };
    const response = await this.send(method, url, options);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  filesUrl(suffix = '', params = {}) {
    const query = new URLSearchParams(params).toString();
    return `${this.base}/drive/v3/files${suffix}${query ? `?${query}` : ''}`;
  }

  uploadUrl(suffix, params) {
    return `${this.base}/upload/drive/v3/files${suffix}?${new URLSearchParams(params)}`;
  }

  /** Files of the app-data folder matching all conditions (Drive query clauses). */
  async list(conditions = [], { orderBy = '', pageSize = 1000, limit = null } = {}) {
    const clauses = [`${quoteQuery(APP_DATA)} in parents`, 'trashed = false', ...conditions];
    const params = { spaces: APP_DATA, q: clauses.join(' and '), fields: LIST_FIELDS, pageSize: String(Math.max(1, Math.min(1000, pageSize))) };
    if (orderBy) params.orderBy = orderBy;
    const files = [];
    let token = '';
    for (;;) {
      if (token) params.pageToken = token;
      const page = (await this.json('GET', this.filesUrl('', params))) || {};
      files.push(...(page.files || []).map(fileOf));
      token = page.nextPageToken || '';
      if (!token || (limit !== null && files.length >= limit)) break;
    }
    return limit !== null ? files.slice(0, limit) : files;
  }

  find(name) {
    return this.list([`name = ${quoteQuery(name)}`], { orderBy: 'createdTime' });
  }

  withProperty(key, value, options = {}) {
    return this.list([`appProperties has { key=${quoteQuery(key)} and value=${quoteQuery(value)} }`], options);
  }

  async download(id) {
    const response = await this.send('GET', this.filesUrl(`/${encodeURIComponent(id)}`, { alt: 'media' }), { timeout: 120000 });
    return new Uint8Array(await response.arrayBuffer());
  }

  async about() {
    const data = await this.json('GET', `${this.base}/drive/v3/about?${new URLSearchParams({ fields: 'user(displayName,emailAddress)' })}`);
    return (data && data.user) || {};
  }

  async create(name, bytes, { mimeType = 'application/octet-stream', appProperties = null } = {}) {
    const metadata = { name, parents: [APP_DATA], mimeType };
    if (appProperties) metadata.appProperties = appProperties;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.length > MULTIPART_LIMIT) return this.resumable('POST', this.uploadUrl('', { uploadType: 'resumable', fields: FILE_FIELDS }), metadata, data, mimeType);
    const boundary = `flashcard${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      data,
      `\r\n--${boundary}--`,
    ]);
    const response = await this.send('POST', this.uploadUrl('', { uploadType: 'multipart', fields: FILE_FIELDS }), {
      body,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      timeout: 180000,
    });
    return fileOf(await response.json());
  }

  async update(id, bytes, { mimeType = 'application/octet-stream' } = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.length > MULTIPART_LIMIT) return this.resumable('PATCH', this.uploadUrl(`/${encodeURIComponent(id)}`, { uploadType: 'resumable', fields: FILE_FIELDS }), {}, data, mimeType);
    const response = await this.send('PATCH', this.uploadUrl(`/${encodeURIComponent(id)}`, { uploadType: 'media', fields: FILE_FIELDS }), {
      body: data,
      headers: { 'Content-Type': mimeType },
      timeout: 180000,
    });
    return fileOf(await response.json());
  }

  async resumable(method, url, metadata, data, mimeType) {
    const start = await this.send(method, url, {
      body: JSON.stringify(metadata),
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType },
    });
    const location = start.headers.get('Location');
    if (!location) throw new StorageError('Google Drive hat keine Upload-Adresse geliefert.');
    const sameHost = new URL(location).host === new URL(this.base).host;
    const response = await this.send('PUT', location, { body: data, headers: { 'Content-Type': mimeType }, auth: sameHost, timeout: 300000 });
    return fileOf(await response.json());
  }

  async remove(id) {
    try {
      await this.send('DELETE', this.filesUrl(`/${encodeURIComponent(id)}`));
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }
}
