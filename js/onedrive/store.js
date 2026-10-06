// OneDrive as a file store for the provider-neutral sync (cloud/sync.js) –
// the browser twin of app/onedrive/provider.py.  The logical layout is a real
// folder tree in "Apps/FlashCard App"; the head is sync/head.json, changed only
// with If-Match (ETag) and verified by reading it back.

import { GraphClient, PreconditionFailed } from './graph.js';
import { NotFoundError } from '../cloud/errors.js';

const HEAD = 'sync/head.json';
const FOLDERS = ['metadata', 'sync', 'state', 'media', 'ai', 'ai/blobs', 'devices', 'backups'];

export class OneDriveStore {
  constructor({ base, token }) {
    this.graph = new GraphClient({ base, token });
  }

  open() {
    return this.graph.approot();
  }

  async ensureLayout() {
    await this.graph.approot();
    for (const folder of FOLDERS) {
      const parts = folder.split('/');
      const name = parts.pop();
      const parent = parts.join('/');
      if (await this.graph.stat(folder)) continue;
      const url = parent ? `${this.graph.itemUrl(parent)}/children` : `${this.graph.itemUrl('')}/children`;
      try {
        await this.graph.json('POST', url, { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
      } catch { /* exists already */ }
    }
  }

  async list(folder) {
    const items = await this.graph.children(folder);
    return items.filter((item) => !item.folder).map((item) => ({
      name: item.name,
      path: `${folder}/${item.name}`,
      size: Number(item.size) || 0,
      created: item.createdDateTime || null,
    }));
  }

  async download(path) {
    const { bytes } = await this.graph.download(path);
    return bytes;
  }

  async readJson(path) {
    const result = await this.graph.readJson(path);
    return result ? result.doc : null;
  }

  upload(path, bytes, { contentType = 'application/octet-stream' } = {}) {
    return this.graph.upload(path, bytes, { contentType });
  }

  uploadJson(path, doc) {
    return this.graph.uploadJson(path, doc);
  }

  remove(path) {
    return this.graph.remove(path);
  }

  async readHead() {
    const result = await this.graph.readJson(HEAD);
    if (!result) return { head: null, token: null };
    return { head: result.doc, token: result.item.eTag };
  }

  async writeHead(head, token, { create = false } = {}) {
    if (create) await this.graph.uploadJson(HEAD, head, { conflict: 'fail' });
    else await this.graph.uploadJson(HEAD, head, { ifMatch: token });
    const current = await this.readHead();
    if (!current.head || current.head.commit_id !== head.commit_id) {
      throw new PreconditionFailed('Die Head-Datei wurde gleichzeitig von einem anderen Gerät geändert.');
    }
    return current.token;
  }

  async discardHead() {
    try { await this.graph.remove(HEAD); } catch (error) { if (!(error instanceof NotFoundError)) throw error; }
  }
}
