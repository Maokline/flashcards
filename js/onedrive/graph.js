// Minimal Microsoft Graph client for the OneDrive app folder – the browser
// twin of app/onedrive/graph.py.  Items are addressed by path below
// /me/drive/special/approot ("Apps/FlashCard App"); nothing else is reachable
// with the Files.ReadWrite.AppFolder permission.

import { http, NetworkError } from '../api.js';
import { AuthRequiredError, HeadConflict, NotFoundError as SharedNotFound, StorageConflict, StorageError } from '../cloud/errors.js';
import { utf8 } from '../core/canonical.js';

const SIMPLE_LIMIT = 4 * 1024 * 1024;
const CHUNK = 5 * 1024 * 1024 + 320 * 1024 * 2;

// The Graph errors are the shared storage errors (cloud/errors.js), so the
// provider-neutral sync engine can catch them without knowing OneDrive.
export const GraphError = StorageError;
export const PreconditionFailed = HeadConflict;
export const ConflictError = StorageConflict;
export const NotFoundError = SharedNotFound;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GraphClient {
  constructor({ base, token }) {
    this.base = String(base).replace(/\/$/, '');
    this.token = token;
  }

  itemUrl(path = '') {
    const clean = String(path).replace(/^\/+|\/+$/g, '');
    if (!clean) return `${this.base}/me/drive/special/approot`;
    return `${this.base}/me/drive/special/approot:/${clean.split('/').map(encodeURIComponent).join('/')}:`;
  }

  async send(method, url, { body, headers = {}, auth = true, timeout = 60000 } = {}) {
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const request = { ...headers };
      if (auth) request.Authorization = `Bearer ${await this.token(refreshed)}`;
      let response;
      if (method === 'GET') response = await http.get(url, { headers: request, timeout });
      else if (method === 'PUT') response = await http.put(url, body, { headers: request, timeout });
      else if (method === 'POST') response = await http.post(url, body, { headers: request, timeout });
      else response = await http.del(url, { headers: request, timeout });
      if (response.ok) return response;
      if (response.status === 401 && auth && !refreshed) {
        refreshed = true;
        continue;
      }
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
        const wait = Number(response.headers.get('Retry-After'));
        await sleep(Math.min(30, Number.isFinite(wait) && wait > 0 ? wait : 0.5 * 2 ** attempt) * 1000);
        continue;
      }
      let code = '';
      let message = '';
      try {
        const payload = await response.json();
        code = (payload && payload.error && payload.error.code) || '';
        message = (payload && payload.error && payload.error.message) || '';
      } catch { /* not JSON */ }
      if (response.status === 401) throw new AuthRequiredError('Die Microsoft-Anmeldung ist abgelaufen – bitte erneut anmelden.');
      if (response.status === 404) throw new NotFoundError(`Nicht gefunden: ${url}`, { status: 404, code });
      if (response.status === 409) throw new ConflictError(message || 'Datei existiert bereits.', { status: 409, code });
      if (response.status === 412) throw new PreconditionFailed('Die Datei wurde inzwischen geändert.', { status: 412, code });
      throw new GraphError(message || `OneDrive-Anfrage fehlgeschlagen (${response.status}).`, { status: response.status, code });
    }
  }

  async json(method, url, payload, headers = {}) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const response = await this.send(method, url, {
      body,
      headers: payload === undefined ? { Accept: 'application/json', ...headers } : { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    });
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  approot() {
    return this.json('GET', this.itemUrl(''));
  }

  async stat(path) {
    try {
      return await this.json('GET', this.itemUrl(path));
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /** {bytes, item} – the bearer token is never sent to the download host. */
  async download(path) {
    const item = await this.json('GET', this.itemUrl(path));
    const url = item && item['@microsoft.graph.downloadUrl'];
    const response = url
      ? await this.send('GET', url, { auth: false, timeout: 120000 })
      : await this.send('GET', `${this.itemUrl(path)}/content`, { timeout: 120000 });
    return { bytes: new Uint8Array(await response.arrayBuffer()), item };
  }

  async readJson(path) {
    try {
      const { bytes, item } = await this.download(path);
      return { doc: JSON.parse(new TextDecoder().decode(bytes)), item };
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async upload(path, bytes, { ifMatch = null, conflict = 'replace', contentType = 'application/octet-stream' } = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.length > SIMPLE_LIMIT) return this.uploadLarge(path, data, { ifMatch, conflict });
    const headers = { 'Content-Type': contentType, Accept: 'application/json' };
    if (ifMatch) headers['If-Match'] = ifMatch;
    const response = await this.send('PUT', `${this.itemUrl(path)}/content?@microsoft.graph.conflictBehavior=${conflict}`, { body: data, headers, timeout: 180000 });
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  uploadJson(path, doc, options = {}) {
    return this.upload(path, utf8(JSON.stringify(doc, null, 2)), { ...options, contentType: 'application/json' });
  }

  async uploadLarge(path, data, { ifMatch, conflict }) {
    const session = await this.json('POST', `${this.itemUrl(path)}/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': conflict } }, ifMatch ? { 'If-Match': ifMatch } : {});
    let result = {};
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
      const end = offset + chunk.length - 1;
      const response = await this.send('PUT', session.uploadUrl, {
        body: chunk,
        auth: false,
        timeout: 240000,
        headers: { 'Content-Range': `bytes ${offset}-${end}/${data.length}`, 'Content-Type': 'application/octet-stream' },
      });
      const text = await response.text();
      if (text) {
        try { result = JSON.parse(text); } catch { result = {}; }
      }
    }
    return result;
  }

  async remove(path) {
    try {
      await this.send('DELETE', this.itemUrl(path));
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }

  async children(path) {
    const clean = String(path).replace(/^\/+|\/+$/g, '');
    let url = clean ? `${this.itemUrl(clean)}/children?$top=200` : `${this.base}/me/drive/special/approot/children?$top=200`;
    const items = [];
    try {
      while (url) {
        const page = await this.json('GET', url);
        items.push(...(page.value || []));
        url = page['@odata.nextLink'] || null;
      }
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      throw error;
    }
    return items;
  }
}

export function isOffline(error) {
  return error instanceof NetworkError;
}
