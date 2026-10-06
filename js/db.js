// IndexedDB persistence.
//
// Server mode: offline copy of the change feed + queue of reviews to send.
// OneDrive mode: this device's complete local copy of the data set – the same
// tables the desktop keeps in SQLite – plus image blobs, the files of AI
// draft packages and the base snapshot of the last synchronisation.

const DB_NAME = 'flashcard-pwa';
const DB_VERSION = 2;
export const ENTITY_STORES = ['decks', 'categories', 'subcategories', 'cards', 'media'];
export const LOCAL_STORES = ['events', 'files'];
const ALL_STORES = ['meta', ...ENTITY_STORES, 'pending_reviews', ...LOCAL_STORES, 'blobs', 'media_blobs', 'snapshots', 'ai_tests'];

let databasePromise = null;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function open() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      for (const name of ENTITY_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pending_reviews')) db.createObjectStore('pending_reviews', { keyPath: 'event_id' });
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'sha256' });
      if (!db.objectStoreNames.contains('media_blobs')) db.createObjectStore('media_blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('ai_tests')) db.createObjectStore('ai_tests', { keyPath: 'file_name' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB ist blockiert.'));
  });
  return databasePromise;
}

async function transaction(stores, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaktion abgebrochen'));
    Promise.resolve(work(tx)).then((value) => { result = value; }, reject);
  });
}

export async function getAll(store) {
  return transaction([store], 'readonly', (tx) => promisify(tx.objectStore(store).getAll()));
}

export async function get(store, key) {
  return transaction([store], 'readonly', (tx) => promisify(tx.objectStore(store).get(key)));
}

export async function put(store, value) {
  return transaction([store], 'readwrite', (tx) => {
    tx.objectStore(store).put(value);
  });
}

export async function remove(store, key) {
  return transaction([store], 'readwrite', (tx) => {
    tx.objectStore(store).delete(key);
  });
}

export async function getMeta(key) {
  const row = await transaction(['meta'], 'readonly', (tx) => promisify(tx.objectStore('meta').get(key)));
  return row ? row.value : undefined;
}

export async function setMeta(key, value) {
  return transaction(['meta'], 'readwrite', (tx) => {
    tx.objectStore('meta').put({ key, value });
  });
}

// Apply one page of the change feed atomically (server mode).
export async function applyChanges({ reset, upserts, deleted, meta }) {
  return transaction([...ENTITY_STORES, 'meta'], 'readwrite', (tx) => {
    if (reset) for (const name of ENTITY_STORES) tx.objectStore(name).clear();
    for (const [name, items] of Object.entries(upserts)) {
      const store = tx.objectStore(name);
      for (const item of items) store.put(item);
    }
    for (const [name, ids] of Object.entries(deleted)) {
      const store = tx.objectStore(name);
      for (const id of ids) store.delete(id);
    }
    for (const [key, value] of Object.entries(meta)) tx.objectStore('meta').put({ key, value });
  });
}

/**
 * OneDrive mode: write a set of changes atomically.
 *   {puts: {store: [rows]}, deletes: {store: [keys]}, meta: {key: value}, clear: [stores]}
 */
export async function write({ puts = {}, deletes = {}, meta = {}, clear = [] }) {
  const stores = new Set([...Object.keys(puts), ...Object.keys(deletes), ...clear]);
  if (Object.keys(meta).length) stores.add('meta');
  if (!stores.size) return undefined;
  return transaction([...stores], 'readwrite', (tx) => {
    for (const name of clear) tx.objectStore(name).clear();
    for (const [name, keys] of Object.entries(deletes)) {
      const store = tx.objectStore(name);
      for (const key of keys) store.delete(key);
    }
    for (const [name, rows] of Object.entries(puts)) {
      const store = tx.objectStore(name);
      for (const row of rows) store.put(row);
    }
    for (const [key, value] of Object.entries(meta)) tx.objectStore('meta').put({ key, value });
  });
}

export async function putEntity(store, item) {
  return put(store, item);
}

export async function deleteEntities(store, ids) {
  return transaction([store], 'readwrite', (tx) => {
    for (const id of ids) tx.objectStore(store).delete(id);
  });
}

export async function addPending(event) {
  return put('pending_reviews', event);
}

export async function listPending() {
  const items = await getAll('pending_reviews');
  return items.sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function removePending(eventIds) {
  return transaction(['pending_reviews'], 'readwrite', (tx) => {
    for (const id of eventIds) tx.objectStore('pending_reviews').delete(id);
  });
}

export async function clearEverything() {
  return transaction(ALL_STORES, 'readwrite', (tx) => {
    for (const name of ALL_STORES) tx.objectStore(name).clear();
  });
}

export async function clearEntities() {
  return transaction([...ENTITY_STORES, 'meta'], 'readwrite', (tx) => {
    for (const name of ENTITY_STORES) tx.objectStore(name).clear();
    tx.objectStore('meta').delete('cursor');
    tx.objectStore('meta').delete('epoch');
  });
}
