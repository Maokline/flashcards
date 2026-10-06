// The single network gateway of the app.  Nothing else calls fetch():
//
// * `api.*`   – requests to the app's own backend.  In server mode they go to
//               the sync server (session cookie, CSRF header on every
//               changing request).  In OneDrive mode the same paths are
//               answered by the local backend in this browser
//               (js/local/backend.js) – screens do not need to know.
// * `http.*`  – requests to Microsoft (sign-in, Graph).  No cookies are sent;
//               callers add the bearer token themselves.
//
// HTTP errors become ApiError, network failures NetworkError.

import { emit } from './bus.js';

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || `Serverfehler (${status})`);
    this.status = status;
    this.body = body || {};
    this.code = this.body.error || 'error';
  }
}

export class NetworkError extends Error {
  constructor(cause) {
    super('Keine Verbindung zum Server.');
    this.cause = cause;
    this.offline = true;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

// OneDrive mode: the local backend answers /api/* (set by app.js).
let localBackend = null;
export function useLocalBackend(backend) {
  localBackend = backend;
}
export function isLocal() {
  return Boolean(localBackend);
}

async function request(path, { method = 'GET', json, form, signal, timeout = 20000, raw = false } = {}) {
  if (localBackend && path.startsWith('/api/')) {
    return localBackend.handle(method, path, { json, form, raw });
  }
  const headers = { Accept: 'application/json' };
  if (!SAFE_METHODS.has(method)) headers['X-FlashCard-Client'] = 'pwa';
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    body = form;
  }
  const controller = new AbortController();
  const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    emit('network', { ok: false });
    throw new NetworkError(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
  emit('network', { ok: true });
  if (raw && response.ok) return response;
  if (response.status === 204) return null;
  let payload = null;
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/login')) emit('auth-required', {});
    throw new ApiError(response.status, payload);
  }
  return payload;
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, json, options) => request(path, { ...options, method: 'POST', json }),
  patch: (path, json, options) => request(path, { ...options, method: 'PATCH', json }),
  del: (path, options) => request(path, { ...options, method: 'DELETE' }),
  upload: (path, file, filename, options) => {
    const form = new FormData();
    form.append('file', file, filename || file.name || 'bild.jpg');
    return request(path, { ...options, method: 'POST', form, timeout: 120000 });
  },
  blob: async (path, options) => {
    const response = await request(path, { ...options, method: 'GET', raw: true });
    return response instanceof Blob ? response : response.blob();
  },
  /**
   * Load media in the background so it stays available offline (service
   * worker cache in server mode, IndexedDB in OneDrive mode).
   */
  warm: async (paths, { concurrency = 4 } = {}) => {
    if (localBackend) return localBackend.warm(paths);
    const queue = [...new Set(paths)];
    const worker = async () => {
      while (queue.length) {
        const path = queue.shift();
        try {
          const response = await request(path, { method: 'GET', raw: true, timeout: 30000 });
          await response.arrayBuffer();
        } catch { /* best effort: the image loads again when shown */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return undefined;
  },
};

// -- requests to the cloud providers (Google, Microsoft) -----------------------
async function send(url, { method = 'GET', headers = {}, body, timeout = 30000, signal } = {}) {
  const controller = new AbortController();
  const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    emit('network', { ok: true });
    return response;
  } catch (error) {
    emit('network', { ok: false });
    throw new NetworkError(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const http = {
  get: (url, options = {}) => send(url, { ...options, method: 'GET' }),
  put: (url, body, options = {}) => send(url, { ...options, method: 'PUT', body }),
  post: (url, body, options = {}) => send(url, { ...options, method: 'POST', body }),
  del: (url, options = {}) => send(url, { ...options, method: 'DELETE' }),
  patch: (url, body, options = {}) => send(url, { ...options, method: 'PATCH', body }),
  /** Same-origin static file (config.json). */
  asset: (url, options = {}) => send(url, { ...options, method: 'GET' }),
};

export function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function errorMessage(error) {
  if (error instanceof NetworkError) {
    return localBackend ? 'Keine Verbindung zu OneDrive. Bitte später erneut versuchen.' : 'Keine Verbindung zum Server. Bitte später erneut versuchen.';
  }
  if (error instanceof ApiError) {
    if (error.status === 413) return error.message || 'Die Datei ist zu groß.';
    return error.message || `Serverfehler (${error.status}).`;
  }
  return (error && error.message) || 'Unbekannter Fehler.';
}
