// Provider-neutral synchronisation of the PWA – the browser twin of
// app/cloudsync/engine.py.  Same logical layout, same documents, same
// single-active-device protocol for Google Drive (default) and OneDrive:
//
//   head             revision pointer + lease of the one device that may write
//   state/…          immutable snapshots (core + review months)
//   media/…          images, ai/blobs/… AI package files, devices/… status
//
// The provider (cloud/providers.js) supplies sign-in and a small file store
// with a compare-and-swap head; nothing here knows Google or Microsoft.
//
// * activate(): load the newest revision, then take the lease (compare-and-
//   swap, verified by reading the head back).  The other device locks itself
//   at its next check.
// * commit(): only the lease holder uploads new files and swaps the head.
// * Offline the active device keeps working; changes are committed later.
// * Unsent changes that meet a newer state are never overwritten: the user
//   applies them (three-way merge, core/merge.js) or discards them.
// * A data set that moved to another provider (head.moved_to) turns this
//   device read-only and offers the switch.

import { ApiError, NetworkError } from '../api.js';
import { emit, on } from '../bus.js';
import { chooseProvider } from '../config.js';
import * as db from '../db.js';
import { state } from '../store.js';
import { decodeDocument, digestOf, encodeDocument, sha256Hex } from '../core/canonical.js';
import * as dataset from '../core/dataset.js';
import { mergeDatasets } from '../core/merge.js';
import { utcIso } from '../core/time.js';
import { deviceGuess } from '../util.js';
import { AuthRequiredError, HeadConflict, NotFoundError, StorageConflict, StorageError, ThrottledError } from './errors.js';
import { provider as providerFor } from './providers.js';

const GraphError = StorageError;
const PreconditionFailed = HeadConflict;
const ConflictError = StorageConflict;

export const FORMAT = 'flashcard-app-onedrive';
const CORE_FORMAT = 'flashcard-onedrive-core';
const REVIEWS_FORMAT = 'flashcard-onedrive-reviews';
const HISTORY = 5;
const DEVICE_KEY = 'od_device'; // shared by all providers: the device keeps its ID
const AUTO_BACKUPS_KEEP = 14;
const DEVICE_HEARTBEAT = 5 * 60 * 1000;
const COMMIT_DELAY = 1500;
const CHECK_INTERVAL = 30000;
const RESUME_SWITCH_AFTER = 20000;
const GC_INTERVAL = 24 * 60 * 60 * 1000;

export const status = {
  mode: 'gdrive',
  provider: 'gdrive',
  label: 'Google Drive',
  vendor: 'Google',
  accountLabel: 'Google-Konto',
  movedTo: null,
  state: 'not_connected',
  online: navigator.onLine,
  syncing: false,
  pending: 0,
  activeDevice: null,
  thisDevice: null,
  revision: 0,
  lastSync: null,
  account: {},
  autoSwitch: true,
  conflict: null,
  message: '',
};

let sync = emptyState();
let device = null;
let store = null;
let current = null; // the provider (cloud/providers.js)
let stateKey = 'gd_state';
let lastDeviceWrite = 0;
let phase = 'idle';
let remote = 'unknown';
let lock = Promise.resolve();
let commitTimer = null;
let checkTimer = null;
let hiddenSince = null;
let started = false;
let dirtyCache = null;

function emptyState() {
  return {
    dataset_id: null,
    base_revision: 0,
    base_fingerprint: '',
    base_review_digests: {},
    lease_id: null,
    head_etag: null,
    known_lease: null,
    last_sync_at: null,
    conflict: null,
    pending_commit: null,
    last_backup_day: null,
    last_gc_at: 0,
    moved_to: null,
  };
}

function withLock(work) {
  const run = lock.then(work, work);
  lock = run.catch(() => {});
  return run;
}

const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const shortId = () => randomHex(4);
const pad6 = (value) => String(value).padStart(6, '0');

export function describeDevice(lease) {
  if (!lease) return 'kein Gerät';
  if (lease.device_name) return lease.device_name;
  return lease.platform === 'mobile' ? 'das Handy' : 'der Desktop';
}

function thisDevice() {
  return { device_id: device.device_id, device_name: device.device_name, platform: 'mobile' };
}

// -- persistence ---------------------------------------------------------------
async function saveState() {
  await db.setMeta(stateKey, sync);
}

async function saveBase(base) {
  await db.put('snapshots', { key: 'base', ...base });
}

async function loadBase() {
  const row = await db.get('snapshots', 'base');
  return row ? { core: row.core, events: row.events } : null;
}

export async function loadDevice() {
  device = (await db.getMeta(DEVICE_KEY)) || null;
  if (!device) {
    device = { device_id: randomHex(16), device_name: deviceGuess(), auto_switch: true };
    await db.setMeta(DEVICE_KEY, device);
  }
  return device;
}

export async function updateDevice(values) {
  Object.assign(device, values);
  await db.setMeta(DEVICE_KEY, device);
  publishStatus();
}

// -- status ------------------------------------------------------------------------
function derivedState() {
  if (!current || !current.configured()) return 'not_connected';
  if (sync.moved_to) return 'moved';
  if (sync.conflict) return 'conflict';
  if (phase === 'switching') return 'switching';
  if (['auth', 'offline', 'not_initialized', 'error', 'not_connected'].includes(remote)) return remote;
  return sync.lease_id ? 'active' : 'inactive';
}

function message(current) {
  const other = describeDevice(sync.known_lease);
  const label = current ? current.label : 'Cloud';
  return {
    not_connected: `Nicht mit ${label} verbunden`,
    moved: `Umgezogen zu ${(sync.moved_to && sync.moved_to.label) || 'einem anderen Anbieter'}`,
    conflict: 'Entscheidung nötig',
    switching: 'Gerätewechsel …',
    auth: 'Anmeldung erneuern',
    offline: sync.lease_id ? 'Offline – lokal gespeichert, Synchronisation wird später erneut versucht' : 'Offline',
    not_initialized: `${label} ist noch leer`,
    error: status.message || 'Synchronisation gestört',
    active: 'Synchronisiert',
    inactive: `Nur lesen – aktiv: ${other}`,
  }[current] || current;
}

export function publishStatus(patch = {}) {
  const current = derivedState();
  Object.assign(status, {
    state: current,
    revision: sync.base_revision,
    lastSync: sync.last_sync_at,
    activeDevice: sync.lease_id && device ? thisDevice() : sync.known_lease,
    thisDevice: device ? thisDevice() : null,
    autoSwitch: device ? device.auto_switch !== false : true,
    conflict: sync.conflict,
    movedTo: sync.moved_to || null,
    pending: dirtyCache && dirtyCache.dirty ? 1 : 0,
    ...patch,
  });
  status.message = patch.message || message(current);
  emit('status', { ...status });
}

function markRemote(value, text = '') {
  remote = value;
  publishStatus(text ? { message: text } : {});
}

async function call(work) {
  try {
    const result = await work();
    if (remote !== 'not_initialized') remote = 'online';
    status.online = true;
    return result;
  } catch (error) {
    if (error instanceof AuthRequiredError) markRemote('auth');
    else if (error instanceof NetworkError || error instanceof ThrottledError) {
      status.online = !(error instanceof NetworkError);
      markRemote('offline');
    }
    throw error;
  }
}

// -- write guard --------------------------------------------------------------------
export function assertWritable() {
  if (!current || !current.configured() || !started) return;
  if (sync.moved_to) {
    throw new ApiError(423, { error: 'moved', message: `Die Synchronisation ist zu ${sync.moved_to.label || 'einem anderen Anbieter'} umgezogen – bitte unter Mehr → Sync & Geräte wechseln.` });
  }
  if (sync.conflict) {
    throw new ApiError(423, { error: 'conflict', message: 'Auf diesem Gerät liegen noch nicht übertragene Änderungen. Bitte zuerst entscheiden (Mehr → Sync & Geräte).' });
  }
  if (phase === 'switching') throw new ApiError(423, { error: 'switching', message: 'Gerätewechsel läuft – einen Moment bitte.' });
  if (!sync.lease_id) {
    throw new ApiError(423, { error: 'read_only', message: `Gerade ist ${describeDevice(sync.known_lease)} aktiv – dieses Gerät ist schreibgeschützt. Tippe auf „Dieses Gerät aktivieren“.` });
  }
}

export function isActive() {
  return Boolean(sync.lease_id) && !sync.conflict;
}

// -- local data --------------------------------------------------------------------------
function normalizeEvent(event) {
  return {
    id: Number(event.id),
    card_id: String(event.card_id),
    reviewed_at: String(event.reviewed_at),
    correct: Boolean(event.correct),
    immediate_retry: Boolean(event.immediate_retry),
    points_before: Number(event.points_before),
    points_after: Number(event.points_after),
    level_before: Number(event.level_before),
    level_after: Number(event.level_after),
    duration_seconds: Number(event.duration_seconds) || 0,
    before_state_json: String(event.before_state_json),
    after_state_json: String(event.after_state_json),
  };
}

function normalizeCore(core) {
  const byId = (rows) => [...(rows || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    decks: byId(core.decks).map((deck) => ({ ...deck, description: deck.description || '' })),
    categories: byId(core.categories),
    subcategories: byId(core.subcategories),
    cards: byId(core.cards).map(dataset.snapshotCard),
    media: byId(core.media).map((item) => ({ ...item, size_bytes: Number(item.size_bytes) || 0 })),
    ai_files: Object.fromEntries(Object.entries(core.ai_files || {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, entry]) => [path, { sha256: String(entry.sha256), size: Number(entry.size) || 0 }])),
  };
}

function monthOf(reviewedAt) {
  const text = String(reviewedAt || '');
  return text.length >= 7 && text[4] === '-' ? text.slice(0, 7) : '0000-00';
}

function splitEvents(events) {
  const months = {};
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const month = monthOf(event.reviewed_at);
    (months[month] = months[month] || []).push(event);
  }
  return months;
}

async function fingerprintOf(core, events) {
  const content = normalizeCore(core);
  const months = splitEvents(events.map(normalizeEvent));
  const coreDigest = await digestOf(content);
  const reviewDigests = {};
  for (const [month, items] of Object.entries(months)) reviewDigests[month] = await digestOf(items);
  const sorted = Object.fromEntries(Object.entries(reviewDigests).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { content, months, coreDigest, reviewDigests, fingerprint: await digestOf({ core: coreDigest, reviews: sorted }) };
}

async function exportLocal() {
  const { core, events } = dataset.exportDataset();
  const info = await fingerprintOf(core, events);
  return { core: info.content, events: events.map(normalizeEvent), ...info };
}

async function hasLocalChanges(current) {
  const local = current || await exportLocal();
  const dirty = sync.base_fingerprint ? local.fingerprint !== sync.base_fingerprint : !dataset.isEmpty();
  dirtyCache = { fingerprint: local.fingerprint, dirty };
  return dirty;
}

async function setBase(local) {
  sync.base_fingerprint = local.fingerprint;
  sync.base_review_digests = { ...local.reviewDigests };
  await saveBase({ core: local.core, events: local.events });
  dirtyCache = { fingerprint: local.fingerprint, dirty: false };
}

// -- remote documents ---------------------------------------------------------------
async function readHead() {
  const { head, token } = await store.readHead();
  if (!head) return { head: null, etag: null };
  if (head.format !== FORMAT) throw new GraphError(`Der Sync-Kopf in ${current.label} ist beschädigt.`);
  if (Number(head.format_version || 0) > 1) throw new GraphError(`Die Daten in ${current.label} stammen von einer neueren App-Version – bitte die App aktualisieren.`);
  if (head.moved_to && JSON.stringify(head.moved_to) !== JSON.stringify(sync.moved_to)) {
    sync.moved_to = head.moved_to;
    sync.lease_id = null;
    sync.known_lease = null;
    await saveState();
    publishStatus();
    emit('sync-notice', { kind: 'moved', to: head.moved_to });
  }
  return { head, etag: token };
}

function holds(head) {
  const lease = head.lease || {};
  return Boolean(sync.lease_id && lease.device_id === device.device_id && lease.lease_id === sync.lease_id);
}

function lease(leaseId, previous) {
  return {
    ...thisDevice(),
    lease_id: leaseId,
    acquired_at: utcIso(),
    previous_device_id: previous ? previous.device_id || null : null,
    previous_device_name: previous ? previous.device_name || null : null,
  };
}

function summary(head) {
  return { revision: head.revision, core: head.core, reviews: head.reviews, updated_at: head.updated_at, updated_by: head.updated_by };
}

async function writeHead(head, etag, { create = false, parent = null } = {}) {
  head.commit_id = head.commit_id || shortId();
  head.parent_commit_id = create ? null : parent;
  // The store compares and swaps, and verifies by reading the head back.
  return store.writeHead(head, etag, { create });
}

async function downloadDocument(entry) {
  const bytes = await store.download(entry.path);
  if (entry.sha256 && await sha256Hex(bytes) !== entry.sha256) throw new GraphError(`Prüfsumme stimmt nicht: ${entry.path}`);
  return decodeDocument(bytes);
}

async function downloadDataset(head) {
  const core = await downloadDocument(head.core);
  if (core.format !== CORE_FORMAT) throw new GraphError('Unbekanntes Snapshot-Format.');
  const events = [];
  for (const segment of head.reviews || []) {
    const doc = await downloadDocument(segment);
    if (doc.format !== REVIEWS_FORMAT) throw new GraphError('Unbekanntes Review-Format.');
    events.push(...doc.events);
  }
  return { core: normalizeCore(core), events: events.map(normalizeEvent) };
}

export function mediaPath(id, relativePath) {
  const name = String(relativePath || '').split('/').pop();
  let suffix = '';
  const dot = name.lastIndexOf('.');
  if (dot >= 0) {
    const candidate = name.slice(dot).toLowerCase();
    if (candidate.length <= 16 && /^\.[a-z0-9]*$/.test(candidate)) suffix = candidate;
  }
  return `media/${id}${suffix}`;
}

async function fetchMedia(row) {
  const bytes = await store.download(mediaPath(row.id, row.relative_path));
  if (row.sha256 && await sha256Hex(bytes) !== row.sha256) throw new GraphError('Bild ist beschädigt angekommen.');
  return bytes;
}

async function fetchBlob(sha) {
  const bytes = await store.download(`ai/blobs/${sha}`);
  if (await sha256Hex(bytes) !== sha) throw new GraphError('Datei ist beschädigt angekommen.');
  return bytes;
}

async function pull(head) {
  const data = await downloadDataset(head);
  await dataset.replaceAll(data);
  const local = await exportLocal();
  await setBase(local);
  Object.assign(sync, {
    dataset_id: head.dataset_id,
    base_revision: Number(head.revision),
    last_sync_at: utcIso(),
  });
  await saveState();
  emit('sync-notice', { kind: 'pulled', revision: head.revision });
  prefetchMedia();
}

async function publish({ core, events, head, etag, leaseValue, knownDigests, remoteCore, merge = false, create = false }) {
  const revision = Number(head.revision || 0) + 1;
  const token = shortId();
  const datasetId = String(head.dataset_id);
  const remoteMedia = new Set(((remoteCore && remoteCore.media) || []).map((item) => item.id));
  const remoteShas = new Set(Object.values((remoteCore && remoteCore.ai_files) || {}).map((entry) => entry.sha256));
  for (const item of core.media) {
    if (remoteMedia.has(item.id)) continue;
    const stored = await db.get('media_blobs', item.id);
    if (!stored || !stored.blob) throw new GraphError(`Bild fehlt auf diesem Gerät: ${item.original_name}`);
    await store.upload(mediaPath(item.id, item.relative_path), new Uint8Array(await stored.blob.arrayBuffer()), { contentType: item.mime_type || 'application/octet-stream' });
  }
  const uploaded = new Set();
  for (const entry of Object.values(core.ai_files)) {
    if (remoteShas.has(entry.sha256) || uploaded.has(entry.sha256)) continue;
    const stored = await db.get('blobs', entry.sha256);
    if (!stored || !stored.blob) throw new GraphError('Eine Datei eines KI-Pakets fehlt auf diesem Gerät.');
    await store.upload(`ai/blobs/${entry.sha256}`, new Uint8Array(await stored.blob.arrayBuffer()));
    uploaded.add(entry.sha256);
  }
  const months = splitEvents(events);
  const existing = Object.fromEntries((head.reviews || []).map((entry) => [entry.month, entry]));
  const segments = [];
  for (const month of Object.keys(months).sort()) {
    const items = months[month];
    const monthDigest = await digestOf(items);
    if (existing[month] && knownDigests[month] === monthDigest) {
      segments.push(existing[month]);
      continue;
    }
    const data = await encodeDocument({ format: REVIEWS_FORMAT, format_version: 1, dataset_id: datasetId, month, events: items });
    const path = `state/reviews-${month}-r${pad6(revision)}-${token}.json.gz`;
    await store.upload(path, data);
    segments.push({ month, path, sha256: await sha256Hex(data), size: data.length, count: items.length });
  }
  const counts = {
    decks: core.decks.length,
    categories: core.categories.length,
    subcategories: core.subcategories.length,
    cards: core.cards.length,
    media: core.media.length,
    ai_files: Object.keys(core.ai_files).length,
  };
  const document = {
    ...core,
    format: CORE_FORMAT,
    format_version: 1,
    dataset_id: datasetId,
    revision,
    exported_at: utcIso(),
    exported_by: thisDevice(),
    counts,
  };
  const data = await encodeDocument(document);
  const corePath = `state/core-r${pad6(revision)}-${token}.json.gz`;
  await store.upload(corePath, data);
  const newHead = {
    format: FORMAT,
    format_version: 1,
    sync_version: 1,
    dataset_id: datasetId,
    revision,
    commit_id: token,
    updated_at: utcIso(),
    updated_by: thisDevice(),
    core: { path: corePath, sha256: await sha256Hex(data), size: data.length },
    reviews: segments,
    counts: { ...counts, review_events: events.length },
    lease: leaseValue,
    lease_seq: Number(head.lease_seq || 0) + (leaseValue === head.lease ? 0 : 1),
    history: [summary(head), ...(head.history || [])].slice(0, HISTORY),
    created_at: head.created_at || utcIso(),
    app_version: 'pwa',
  };
  sync.pending_commit = { commit_id: token, revision, lease_id: leaseValue.lease_id, merge };
  await saveState();
  try {
    const newEtag = await writeHead(newHead, etag, { create, parent: head.commit_id || null });
    return { head: newHead, etag: newEtag };
  } catch (error) {
    sync.pending_commit = null;
    await saveState();
    throw error;
  }
}

async function afterPublish(head, etag) {
  Object.assign(sync, {
    pending_commit: null,
    head_etag: etag,
    base_revision: Number(head.revision),
    known_lease: head.lease,
    last_sync_at: utcIso(),
  });
  await saveState();
  housekeeping(head).catch(() => {});
}

async function recover(head) {
  const pending = sync.pending_commit;
  if (!pending || !head) return;
  if (head.commit_id === pending.commit_id) {
    sync.lease_id = pending.lease_id || sync.lease_id;
    sync.base_revision = Number(head.revision);
    sync.pending_commit = null;
    if (pending.merge) {
      sync.conflict = null;
      await pull(head);
    } else {
      await setBase(await exportLocal());
    }
  }
  sync.pending_commit = null;
  await saveState();
}

// -- protocol -----------------------------------------------------------------------------
async function lostLease(head) {
  const other = head.lease || null;
  const dirty = await hasLocalChanges();
  sync.known_lease = other;
  sync.lease_id = null;
  if (dirty) {
    sync.conflict = { detected_at: utcIso(), other_device: other, remote_revision: Number(head.revision || 0), base_revision: sync.base_revision };
    emit('sync-notice', { kind: 'conflict', other });
  } else {
    emit('sync-notice', { kind: 'deactivated', other });
    if (Number(head.revision || 0) !== sync.base_revision) await pull(head);
  }
  await saveState();
  publishStatus();
}

export function check() {
  return withLock(async () => {
    const { head, etag } = await call(readHead);
    if (!head) {
      markRemote('not_initialized');
      return null;
    }
    await recover(head);
    if (sync.lease_id && !holds(head)) await lostLease(head);
    else if (!sync.lease_id && !sync.conflict) {
      sync.known_lease = head.lease || null;
      if (Number(head.revision) !== sync.base_revision && !(await hasLocalChanges())) await pull(head);
    } else {
      sync.known_lease = head.lease || null;
    }
    sync.head_etag = etag;
    await saveState();
    publishStatus();
    if (!sync.moved_to && Date.now() - lastDeviceWrite > DEVICE_HEARTBEAT) writeDevice(Boolean(sync.lease_id)).catch(() => {});
    return head;
  });
}

export function commit() {
  return withLock(async () => {
    if (!sync.lease_id || sync.conflict) return false;
    const local = await exportLocal();
    if (!(await hasLocalChanges(local))) {
      publishStatus();
      return false;
    }
    publishStatus({ syncing: true });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { head, etag } = await call(readHead);
        if (!head) throw new GraphError(`In ${current.label} liegen keine FlashCard-Daten.`);
        await recover(head);
        if (sync.moved_to) return false;
        if (!holds(head) || Number(head.revision) !== sync.base_revision) {
          await lostLease(head);
          return false;
        }
        const base = await loadBase();
        let published;
        try {
          published = await call(() => publish({
            core: local.core,
            events: local.events,
            head,
            etag,
            leaseValue: head.lease,
            knownDigests: sync.base_review_digests,
            remoteCore: base ? base.core : null,
          }));
        } catch (error) {
          if (error instanceof PreconditionFailed) continue;
          throw error;
        }
        await setBase(local);
        await afterPublish(published.head, published.etag);
        emit('sync-notice', { kind: 'committed', revision: published.head.revision });
        return true;
      }
      throw new GraphError(`${current.label} hat das Speichern mehrfach abgelehnt – Synchronisation wird später erneut versucht.`);
    } finally {
      publishStatus({ syncing: false });
    }
  });
}

export function activate() {
  return withLock(async () => {
    phase = 'switching';
    publishStatus();
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const { head, etag } = await call(readHead);
        if (!head) {
          markRemote('not_initialized');
          return 'not_initialized';
        }
        await recover(head);
        if (sync.moved_to) return 'moved';
        if (holds(head)) {
          if (Number(head.revision) !== sync.base_revision && !(await hasLocalChanges())) await pull(head);
          sync.known_lease = head.lease;
          sync.head_etag = etag;
          await saveState();
          return 'already';
        }
        if (sync.conflict) return 'conflict';
        const dirty = await hasLocalChanges();
        if (dirty && sync.lease_id) {
          await lostLease(head);
          return 'conflict';
        }
        if (dirty && !sync.base_fingerprint) {
          // Data created here before the first synchronisation: keep it safe.
          sync.conflict = { detected_at: utcIso(), other_device: head.lease || null, remote_revision: Number(head.revision), base_revision: 0, first_contact: true };
          await saveState();
          emit('sync-notice', { kind: 'conflict', other: head.lease || null });
          return 'conflict';
        }
        if (dirty) {
          sync.conflict = { detected_at: utcIso(), other_device: head.lease || null, remote_revision: Number(head.revision), base_revision: sync.base_revision };
          await saveState();
          emit('sync-notice', { kind: 'conflict', other: head.lease || null });
          return 'conflict';
        }
        if (Number(head.revision) !== sync.base_revision || sync.dataset_id !== head.dataset_id || !(await loadBase())) {
          publishStatus({ message: 'Lade neuesten Stand …' });
          await pull(head);
        }
        const previous = head.lease || null;
        const leaseId = randomHex(16);
        const newHead = { ...head, lease: lease(leaseId, previous), lease_seq: Number(head.lease_seq || 0) + 1, commit_id: shortId() };
        let newEtag;
        try {
          newEtag = await call(() => writeHead(newHead, etag, { parent: head.commit_id || null }));
        } catch (error) {
          if (error instanceof PreconditionFailed) continue;
          throw error;
        }
        Object.assign(sync, { lease_id: leaseId, known_lease: newHead.lease, head_etag: newEtag, last_sync_at: utcIso() });
        await saveState();
        writeDevice(true).catch(() => {});
        emit('sync-notice', { kind: 'activated', previous });
        return 'activated';
      }
      throw new GraphError('Der Gerätewechsel kollidierte mehrfach – bitte erneut versuchen.');
    } finally {
      phase = 'idle';
      publishStatus();
    }
  });
}

/** First contact after start or resume. */
export async function startup({ resumed = false } = {}) {
  if (!current || !current.configured() || !(await current.auth.ready())) {
    markRemote(current && current.configured() ? 'auth' : 'not_connected');
    return status.state;
  }
  try {
    const head = await check();
    if (!head) return status.state;
    if (sync.moved_to) return 'moved';
    if (sync.conflict) return 'conflict';
    if (sync.lease_id) {
      await commit();
      return 'active';
    }
    if (device.auto_switch !== false) return await activate();
    return resumed ? 'inactive' : 'inactive';
  } catch (error) {
    if (!(error instanceof NetworkError) && !(error instanceof AuthRequiredError) && !(error instanceof ThrottledError)) {
      console.warn('Sync-Start fehlgeschlagen', error);
      markRemote('error', error.message);
    }
    return status.state;
  }
}

export function resolveConflict(choice) {
  return withLock(async () => {
    if (!sync.conflict) return null;
    if (choice === 'discard') {
      const { head } = await call(readHead);
      if (!head) throw new GraphError(`In ${current.label} liegen keine FlashCard-Daten.`);
      sync.conflict = null;
      sync.lease_id = null;
      await pull(head);
      emit('sync-notice', { kind: 'resolved', choice });
      return { choice };
    }
    const base = (await loadBase()) || { core: { decks: [], categories: [], subcategories: [], cards: [], media: [], ai_files: {} }, events: [] };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { head, etag } = await call(readHead);
      if (!head) throw new GraphError(`In ${current.label} liegen keine FlashCard-Daten.`);
      const remoteData = await downloadDataset(head);
      const local = await exportLocal();
      const { dataset: merged, report } = mergeDatasets(base, { core: local.core, events: local.events }, remoteData);
      const remoteInfo = await fingerprintOf(remoteData.core, remoteData.events);
      const leaseId = randomHex(16);
      let published;
      try {
        published = await call(() => publish({
          core: normalizeCore(merged.core),
          events: merged.events.map(normalizeEvent),
          head,
          etag,
          leaseValue: lease(leaseId, head.lease || null),
          knownDigests: remoteInfo.reviewDigests,
          remoteCore: remoteData.core,
          merge: true,
        }));
      } catch (error) {
        if (error instanceof PreconditionFailed) continue;
        throw error;
      }
      sync.lease_id = leaseId;
      await saveState();
      await dataset.replaceAll({ core: normalizeCore(merged.core), events: merged.events.map(normalizeEvent) });
      await setBase(await exportLocal());
      sync.conflict = null;
      sync.dataset_id = head.dataset_id;
      await afterPublish(published.head, published.etag);
      writeDevice(true).catch(() => {});
      emit('sync-notice', { kind: 'resolved', choice: 'merge', report });
      return { choice: 'merge', report };
    }
    throw new GraphError('Das Zusammenführen kollidierte mehrfach – bitte erneut versuchen.');
  }).finally(() => publishStatus());
}

/** Start a new data set in the cloud from this phone (nothing there yet). */
export function initializeRemote() {
  return withLock(async () => {
    const existing = await call(readHead);
    if (existing.head) throw new ConflictError(`In ${current.label} liegt bereits ein Datenbestand.`);
    await store.open();
    await store.ensureLayout();
    const datasetId = randomHex(16);
    await store.uploadJson('metadata/format.json', { format: FORMAT, format_version: 1, dataset_id: datasetId, provider: current.key, created_at: utcIso(), created_by: thisDevice(), app: 'FlashCard App V2' });
    const local = await exportLocal();
    const leaseId = randomHex(16);
    const empty = { revision: 0, dataset_id: datasetId, reviews: [], history: [], lease_seq: 0, created_at: utcIso() };
    const leaseValue = lease(leaseId, null);
    sync.lease_id = leaseId;
    const published = await publish({ core: local.core, events: local.events, head: { ...empty, lease: leaseValue }, etag: null, leaseValue, knownDigests: {}, remoteCore: null, create: true });
    sync.dataset_id = datasetId;
    await setBase(local);
    await afterPublish(published.head, published.etag);
    return 'initialized';
  });
}

// -- backups, devices, housekeeping ---------------------------------------------------------
function stamp() {
  const now = new Date();
  const two = (value) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}-${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`;
}

export async function createRemoteBackup(label = 'manuell', givenHead = null, { automatic = false } = {}) {
  const head = givenHead || (await call(readHead)).head;
  if (!head) throw new GraphError(`In ${current.label} liegen keine FlashCard-Daten.`);
  const name = `backup-${stamp()}-r${pad6(head.revision)}-${shortId()}${automatic ? '-auto' : ''}.json`;
  const doc = { format: 'flashcard-onedrive-backup', format_version: 1, label, automatic, created_at: utcIso(), created_by: thisDevice(), ...summary(head), dataset_id: head.dataset_id, counts: head.counts };
  await store.uploadJson(`backups/${name}`, doc);
  // Automatic backups: the newest 14 stay; manual backups are never pruned.
  const all = (await listRemoteBackups()).filter((entry) => entry.automatic);
  for (const entry of all.slice(AUTO_BACKUPS_KEEP)) await store.remove(`backups/${entry.name}`);
  return { name, created_at: doc.created_at, revision: head.revision, size_bytes: 0, automatic };
}

export async function listRemoteBackups() {
  const items = await store.list('backups');
  return items
    .filter((item) => /^backup-.*\.json$/.test(item.name || ''))
    .map((item) => {
      const match = /-r(\d{6})(?:-|\.json$)/.exec(item.name);
      return { name: item.name, revision: match ? Number(match[1]) : 0, automatic: /-auto\.json$/.test(item.name), size_bytes: Number(item.size) || 0, created_at: item.created || null };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

async function writeDevice(active) {
  if (!store || !device) return;
  lastDeviceWrite = Date.now();
  await store.uploadJson(`devices/${device.device_id}.json`, {
    format: 'flashcard-onedrive-device',
    ...thisDevice(),
    app_version: 'pwa',
    last_seen_at: utcIso(),
    active: Boolean(active),
    revision: sync.base_revision,
  });
}

export async function listDevices() {
  const items = await store.list('devices');
  const devices = [];
  for (const item of items) {
    if (!String(item.name || '').endsWith('.json')) continue;
    const doc = await store.readJson(`devices/${item.name}`);
    if (doc) devices.push(doc);
  }
  return devices.sort((a, b) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')));
}

function referenced(head) {
  const found = new Set();
  const collect = (entry) => {
    if (!entry) return;
    if (entry.core && entry.core.path) found.add(entry.core.path);
    for (const segment of entry.reviews || []) if (segment.path) found.add(segment.path);
  };
  collect(head);
  for (const item of head.history || []) collect(item);
  return found;
}

async function housekeeping(head) {
  const today = new Date().toISOString().slice(0, 10);
  if (sync.last_backup_day !== today) {
    await createRemoteBackup('automatisch', head, { automatic: true });
    sync.last_backup_day = today;
    await saveState();
  }
  if (Date.now() - Number(sync.last_gc_at || 0) > GC_INTERVAL) {
    const keep = referenced(head);
    for (const entry of await listRemoteBackups()) {
      const doc = await store.readJson(`backups/${entry.name}`);
      if (doc) for (const path of referenced(doc)) keep.add(path);
    }
    for (const item of await store.list('state')) {
      const path = `state/${item.name}`;
      const match = /-r(\d{6})-/.exec(item.name || '');
      if (keep.has(path) || !match || Number(match[1]) >= Number(head.revision)) continue;
      await store.remove(path);
    }
    sync.last_gc_at = Date.now();
    await saveState();
  }
  await writeDevice(true);
}

// -- media prefetch -------------------------------------------------------------------------
let prefetching = false;

export async function prefetchMedia(ids = null) {
  if (prefetching || !navigator.onLine || !store) return;
  if (device && device.offline_images === false && !ids) return;
  prefetching = true;
  try {
    const wanted = ids ? ids.filter((id) => state.media.has(id)) : [...state.media.keys()];
    const queue = [];
    for (const id of wanted) {
      const stored = await db.get('media_blobs', id);
      if (!stored) queue.push(id);
    }
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try { await dataset.mediaBlob(id); } catch { /* shown again on demand */ }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    emit('media-cached', {});
  } finally {
    prefetching = false;
  }
}

// -- scheduling ----------------------------------------------------------------------------
function scheduleCommit(delay = COMMIT_DELAY) {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commit().catch((error) => {
      if (!(error instanceof NetworkError) && !(error instanceof AuthRequiredError) && !(error instanceof ThrottledError)) console.warn(`Speichern in ${current.label} fehlgeschlagen`, error);
    });
  }, delay);
}

function scheduleCheck() {
  clearInterval(checkTimer);
  checkTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    (sync.lease_id ? commit().then(() => check()) : check()).catch(() => {});
  }, CHECK_INTERVAL);
}

export async function init(chosen = providerFor()) {
  current = chosen;
  stateKey = chosen.stateKey;
  await loadDevice();
  sync = { ...emptyState(), ...((await db.getMeta(stateKey)) || {}) };
  store = chosen.createStore((force) => chosen.auth.accessToken(force));
  Object.assign(status, { mode: chosen.key, provider: chosen.key, label: chosen.label, vendor: chosen.vendor, accountLabel: chosen.accountLabel });
  dataset.setGuard(assertWritable);
  dataset.setFetchers({ blob: fetchBlob, media: fetchMedia });
  status.account = await chosen.auth.account();
  started = true;
  if (!sync.base_fingerprint && !sync.lease_id && dataset.isEmpty()) remote = 'unknown';
  publishStatus();
  on('local-change', () => {
    publishStatus({ pending: 1 });
    if (sync.lease_id) scheduleCommit();
  });
  window.addEventListener('online', () => {
    status.online = true;
    if (sync.lease_id) scheduleCommit(300);
    else check().catch(() => {});
  });
  window.addEventListener('offline', () => {
    status.online = false;
    markRemote('offline');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenSince = Date.now();
      if (sync.lease_id) scheduleCommit(0);
      return;
    }
    const away = hiddenSince ? Date.now() - hiddenSince : 0;
    hiddenSince = null;
    if (away >= RESUME_SWITCH_AFTER) emit('sync-resume', { away });
    else check().catch(() => {});
  });
  window.addEventListener('pagehide', () => { if (sync.lease_id) scheduleCommit(0); });
  scheduleCheck();
}

export async function refreshAccount() {
  if (current && typeof store.account === 'function' && typeof current.auth.saveAccount === 'function') {
    try {
      await current.auth.saveAccount(await store.account());
    } catch { /* shown later */ }
  }
  status.account = current ? await current.auth.account() : {};
  publishStatus();
}

export function provider() {
  return current;
}

/** The sign-in must be renewed by the user (one tap); local work goes on. */
export function needsSignIn() {
  markRemote('auth');
}

export function syncNow() {
  return (async () => {
    await check();
    if (sync.lease_id) await commit();
    return status.state;
  })();
}

/**
 * Sign-out: transfer what is left, then hand the write permission back so no
 * device is shown as active any more. Resolves to false when changes could
 * not reach OneDrive (offline) – the caller must not delete them silently.
 */
export async function release() {
  try { await commit(); } catch { /* checked right below */ }
  if (sync.lease_id && await hasLocalChanges()) return false;
  await withLock(async () => {
    if (!sync.lease_id) return;
    try {
      const { head, etag } = await call(readHead);
      if (head && holds(head)) await writeHead({ ...head, lease: null, commit_id: shortId() }, etag, { parent: head.commit_id || null });
    } catch { /* the next device takes over in any case */ }
    sync.lease_id = null;
    await saveState();
    publishStatus();
  });
  return true;
}

/**
 * "Zuvor aktives Gerät abmelden": withdraw the other device's lease.  It turns
 * read-only at its next check; this device is not activated by it.
 */
export function signOutOtherDevice() {
  return withLock(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { head, etag } = await call(readHead);
      if (!head || sync.moved_to) return false;
      const other = head.lease;
      if (!other || holds(head)) return false;
      const next = {
        ...head,
        lease: null,
        lease_seq: Number(head.lease_seq || 0) + 1,
        commit_id: shortId(),
        signed_out_device: { ...other, signed_out_at: utcIso(), by: thisDevice() },
      };
      try {
        await call(() => writeHead(next, etag, { parent: head.commit_id || null }));
      } catch (error) {
        if (error instanceof PreconditionFailed) continue;
        throw error;
      }
      sync.known_lease = null;
      await saveState();
      emit('sync-notice', { kind: 'signed_out_other', other });
      publishStatus();
      return true;
    }
    throw new GraphError('Das Abmelden kollidierte mehrfach – bitte erneut versuchen.');
  });
}

/**
 * Use another provider on this phone (e.g. after the desktop moved the data
 * from OneDrive to Google Drive).  The common base snapshot stays, so local
 * changes that never reached the old provider are merged, not lost.
 */
export async function switchTo(key) {
  const next = providerFor(key);
  const carried = { base_fingerprint: sync.base_fingerprint, base_review_digests: sync.base_review_digests };
  const existing = (await db.getMeta(next.stateKey)) || null;
  if (!existing || !existing.base_fingerprint) {
    await db.setMeta(next.stateKey, { ...emptyState(), ...carried });
  }
  chooseProvider(key);
}

export function hasBase() {
  return Boolean(sync.base_fingerprint);
}

export function state_() {
  return sync;
}

export async function reset() {
  sync = emptyState();
  await saveState();
  publishStatus();
}

export { NotFoundError, AuthRequiredError };
