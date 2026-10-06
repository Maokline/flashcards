// Google Drive as a file store for the provider-neutral sync (cloud/sync.js) –
// the browser twin of app/gdrive/provider.py.
//
// appDataFolder is flat: logical paths become names with "__"
// ("state/core-r000042-ab.json.gz" → "state__core-r000042-ab.json.gz"); every
// file carries appProperties fc_path / fc_folder / fc_kind and listings select
// by those exact properties.
//
// The head is an append-only chain "sync__head__g<generation>__<commit>.json":
// a writer that read generation n proposes n+1 and resolves again – highest
// generation wins, among several proposals the oldest (createdTime, then id).
// A losing writer removes its proposal and gets HeadConflict.

import { HeadConflict, NotFoundError, StorageConflict } from '../cloud/errors.js';
import { DriveClient } from './drive.js';

const HEAD_PREFIX = 'sync__head__g';
const SEP = '__';
const HEAD_KEEP = 20;
const UNIQUE_FOLDERS = new Set(['state', 'backups']);

export function driveName(path) {
  const parts = String(path).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part.includes(SEP))) throw new Error(`Pfad nicht für Google Drive geeignet: ${path}`);
  return parts.join(SEP);
}

export function headName(generation, commitId) {
  return `${HEAD_PREFIX}${String(generation).padStart(9, '0')}${SEP}${commitId}.json`;
}

export function parseHeadName(name) {
  if (!name.startsWith(HEAD_PREFIX) || !name.endsWith('.json')) return null;
  const rest = name.slice(HEAD_PREFIX.length, -'.json'.length);
  const cut = rest.indexOf(SEP);
  if (cut < 0) return null;
  const generation = rest.slice(0, cut);
  if (!/^\d+$/.test(generation)) return null;
  return { generation: Number(generation), commit: rest.slice(cut + SEP.length) };
}

const folderOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const olderFirst = (a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class GoogleDriveStore {
  constructor({ base, token, client = null }) {
    this.client = client || new DriveClient({ base, token });
    this.ids = new Map();
    this.listed = new Set();
  }

  async open() {
    await this.client.list([], { pageSize: 1, limit: 1 });
  }

  async ensureLayout() { /* flat app data: nothing to create */ }

  async list(folder) {
    const clean = String(folder).replace(/^\/+|\/+$/g, '');
    const items = (await this.client.withProperty('fc_folder', clean)).sort(olderFirst);
    const seen = new Set();
    const files = [];
    for (const item of items) {
      const path = (item.appProperties && item.appProperties.fc_path) || item.name.split(SEP).join('/');
      if (seen.has(path)) continue;
      seen.add(path);
      if (!this.ids.has(path)) this.ids.set(path, item.id);
      files.push({ name: path.split('/').pop(), path, size: item.size, created: item.created || null });
    }
    this.listed.add(clean);
    return files;
  }

  async lookup(path) {
    if (this.ids.has(path)) return this.ids.get(path);
    const folder = folderOf(path);
    if (folder && !this.listed.has(folder)) {
      await this.list(folder);
      if (this.ids.has(path)) return this.ids.get(path);
    }
    const matches = await this.client.find(driveName(path));
    if (!matches.length) return null;
    const newest = matches.reduce((best, item) => (item.modified > best.modified ? item : best));
    this.ids.set(path, newest.id);
    return newest.id;
  }

  async download(path) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = await this.lookup(path);
      if (!id) throw new NotFoundError(`Nicht gefunden: ${path}`);
      try {
        return await this.client.download(id);
      } catch (error) {
        if (!(error instanceof NotFoundError) || attempt) throw error;
        this.ids.delete(path);
        this.listed.delete(folderOf(path));
      }
    }
    throw new NotFoundError(`Nicht gefunden: ${path}`);
  }

  async readJson(path) {
    try {
      return JSON.parse(decoder.decode(await this.download(path)));
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async upload(path, bytes, { contentType = 'application/octet-stream' } = {}) {
    const folder = folderOf(path);
    let id = this.ids.get(path) || null;
    if (!id && !UNIQUE_FOLDERS.has(folder.split('/')[0])) id = await this.lookup(path);
    if (id) {
      try {
        const item = await this.client.update(id, bytes, { mimeType: contentType });
        this.ids.set(path, item.id);
        return;
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        this.ids.delete(path);
      }
    }
    const item = await this.client.create(driveName(path), bytes, {
      mimeType: contentType,
      appProperties: { fc_path: path, fc_folder: folder, fc_kind: 'file' },
    });
    this.ids.set(path, item.id);
  }

  uploadJson(path, doc) {
    return this.upload(path, encoder.encode(JSON.stringify(doc, null, 2)), { contentType: 'application/json' });
  }

  async remove(path) {
    const id = await this.lookup(path);
    if (!id) return false;
    this.ids.delete(path);
    return this.client.remove(id);
  }

  async headFiles() {
    const files = await this.client.withProperty('fc_kind', 'head', { orderBy: 'name desc', pageSize: 50, limit: 50 });
    return files.map((item) => ({ item, parsed: parseHeadName(item.name) })).filter((entry) => entry.parsed);
  }

  async resolve(attempt = 0) {
    const heads = await this.headFiles();
    if (!heads.length) return { head: null, token: null, heads };
    const generation = Math.max(...heads.map((entry) => entry.parsed.generation));
    const winner = heads.filter((entry) => entry.parsed.generation === generation).map((entry) => entry.item).sort(olderFirst)[0];
    let head;
    try {
      head = JSON.parse(decoder.decode(await this.client.download(winner.id)));
    } catch (error) {
      if (error instanceof NotFoundError && attempt < 3) return this.resolve(attempt + 1);
      throw error;
    }
    return { head, token: { generation, commit_id: head.commit_id, file_id: winner.id }, heads };
  }

  async readHead() {
    const { head, token } = await this.resolve();
    return { head, token };
  }

  async writeHead(head, token, { create = false } = {}) {
    let generation;
    if (create) {
      const current = await this.resolve();
      if (current.head) throw new StorageConflict('In Google Drive liegt bereits ein Datenbestand.');
      generation = 1;
    } else {
      generation = Number((token && token.generation) || 0) + 1;
    }
    head.generation = generation;
    const proposal = await this.client.create(headName(generation, head.commit_id), encoder.encode(JSON.stringify(head)), {
      mimeType: 'application/json',
      appProperties: { fc_kind: 'head', fc_folder: 'sync', fc_generation: String(generation) },
    });
    const current = await this.resolve();
    if (!current.head || current.head.commit_id !== head.commit_id) {
      try { await this.client.remove(proposal.id); } catch { /* cleaned up later */ }
      throw new HeadConflict('Gleichzeitig hat ein anderes Gerät den Stand in Google Drive geändert.');
    }
    for (const entry of current.heads) {
      if (entry.parsed.generation < generation - HEAD_KEEP) {
        try { await this.client.remove(entry.item.id); } catch { /* next time */ }
      }
    }
    return current.token;
  }

  async discardHead() {
    for (const entry of await this.headFiles()) {
      try { await this.client.remove(entry.item.id); } catch { /* best effort */ }
    }
  }

  async account() {
    const user = await this.client.about();
    return { name: String(user.displayName || ''), email: String(user.emailAddress || ''), username: String(user.emailAddress || '') };
  }
}
