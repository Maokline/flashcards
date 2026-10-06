// The app's API answered inside the browser (cloud mode: Google Drive or OneDrive).
//
// Screens call the same paths as with the optional sync server
// (`api.post('/api/cards', …)`); here they are executed on this device's data
// set with the ported core rules.  Responses have the server's shape, errors
// become ApiError with the same status codes.

import { ApiError } from '../api.js';
import * as db from '../db.js';
import { state } from '../store.js';
import { DraftError, DraftInbox, imageType } from '../core/aidrafts.js';
import { exportTest, START_TEXT } from '../core/aitest.js';
import * as dataset from '../core/dataset.js';
import { levelRanges, MASTERED_POINTS } from '../core/engine.js';
import { selectSessionCards } from '../core/selection.js';
import * as statistics from '../core/statistics.js';
import { utcIso } from '../core/time.js';
import * as cloud from '../cloud/sync.js';

const inbox = new DraftInbox({
  list: () => dataset.fileList(),
  readText: (path) => dataset.readFileText(path),
  writeText: (path, text) => dataset.writeFileText(path, text),
});

const integration = {
  importMedia: (path) => dataset.importFileAsMedia(path, imageType(path)),
  createCard: (payload) => dataset.createCard(payload),
};

function parse(path) {
  const url = new URL(path, 'https://local.invalid');
  return { parts: url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent), query: url.searchParams };
}

const notFound = () => new ApiError(404, { error: 'not_found', message: 'Nicht gefunden.' });

function allCards() {
  return [...state.cards.values()];
}

function selection(json) {
  return selectSessionCards(allCards(), {
    deckIds: json.deck_ids || [],
    categoryIds: json.category_ids || [],
    subcategoryIds: json.subcategory_ids || [],
    dueOnly: json.due_only !== false,
    includeMastered: Boolean(json.include_mastered),
    limit: null,
  });
}

async function mediaLookup(ids) {
  const files = new Map();
  for (const id of ids) {
    const row = state.media.get(id);
    if (!row) continue;
    try {
      const blob = await dataset.mediaBlob(id);
      if (blob) files.set(id, { original_name: row.original_name, mime_type: row.mime_type, bytes: new Uint8Array(await blob.arrayBuffer()) });
    } catch {
      files.set(id, { original_name: row.original_name, mime_type: row.mime_type, bytes: null });
    }
  }
  return (id) => files.get(id) || null;
}

async function createAiTest(json) {
  let cards;
  let chosen;
  if (json.card_ids && json.card_ids.length) {
    cards = [...new Set(json.card_ids)].map((id) => state.cards.get(id)).filter(Boolean);
    if (json.limit) cards = cards.slice(0, json.limit);
    chosen = { source: 'mobile', card_ids: cards.map((card) => card.id) };
  } else {
    cards = selection(json);
    if (json.limit) cards = cards.slice(0, json.limit);
    chosen = {
      source: 'mobile',
      deck_ids: json.deck_ids || [],
      category_ids: json.category_ids || [],
      subcategory_ids: json.subcategory_ids || [],
      due_only: Boolean(json.due_only),
      include_mastered: Boolean(json.include_mastered),
      limit: json.limit ?? null,
    };
  }
  if (!cards.length) throw new ApiError(422, { error: 'validation', message: 'Für diese Auswahl gibt es keine Karten.' });
  const ids = cards.flatMap((card) => [...(card.question_images || []), ...(card.answer_images || [])]);
  const media = await mediaLookup([...new Set(ids)]);
  const result = exportTest(cards, { media, selection: chosen, deckName: (deckId) => (state.decks.get(deckId) || {}).name || '' });
  const blob = new Blob([result.html], { type: 'text/html' });
  const entry = { file_name: result.fileName, blob, size_bytes: blob.size, created_at: utcIso() };
  await db.put('ai_tests', entry);
  return {
    file_name: entry.file_name,
    url: `/api/ai-tests/${encodeURIComponent(entry.file_name)}`,
    size_bytes: entry.size_bytes,
    created_at: entry.created_at,
    card_count: result.cardCount,
    start_text: START_TEXT,
  };
}

async function route(method, parts, query, json, form) {
  const [area, ...rest] = parts;
  if (area === 'meta' && method === 'GET') {
    return { app: 'FlashCard App V2', app_version: cloud.status.label || 'Cloud', levels: levelRanges(), mastered_points: MASTERED_POINTS, server_time: utcIso() };
  }
  if (area === 'statistics' && rest[0] === 'summary') {
    return statistics.summary({
      decks: [...state.decks.values()],
      cards: allCards(),
      events: [...state.events.values()],
      days: Number(query.get('days')) || 14,
    });
  }
  if (area === 'sessions' && rest[0] === 'select' && method === 'POST') {
    const selected = selection(json || {});
    const chosen = json && json.limit ? selected.slice(0, json.limit) : selected;
    return { card_ids: chosen.map((card) => card.id), available: selected.length };
  }
  if (area === 'reviews' && method === 'POST' && !rest.length) return dataset.review(json);
  if (area === 'cards') {
    if (!rest.length && method === 'POST') return dataset.createCard(json || {});
    if (rest[0] === 'bulk' && method === 'POST') return dataset.bulk(json || {});
    if (rest.length === 1) {
      if (method === 'GET') {
        const card = state.cards.get(rest[0]);
        if (!card) throw notFound();
        return card;
      }
      if (method === 'PATCH') {
        const { base_version: _v, base_content_hash: _h, force: _f, ...changes } = json || {};
        return dataset.updateCard(rest[0], changes);
      }
      if (method === 'DELETE') return dataset.deleteCard(rest[0]);
    }
  }
  if (area === 'media') {
    if (!rest.length && method === 'POST') {
      const file = form && form.get('file');
      if (!file) throw new ApiError(422, { error: 'validation', message: 'Keine Datei.' });
      return dataset.addMedia(file, file.name);
    }
    if (rest.length === 1 && method === 'DELETE') return dataset.deleteMedia(rest[0]);
    if (rest.length === 1 && method === 'GET') {
      const blob = await dataset.mediaBlob(rest[0]);
      if (!blob) throw notFound();
      return blob;
    }
  }
  if (area === 'ai-drafts' && rest[0] === 'jobs') {
    const [, jobId, kind, draftId, action] = rest;
    if (!jobId && method === 'GET') return inbox.listJobs();
    if (jobId && !kind && method === 'GET') return inbox.getJob(jobId);
    if (kind === 'empty-trash' && method === 'POST') return { deleted: await inbox.emptyTrash(jobId) };
    if (kind === 'media' && method === 'GET') {
      const blob = await dataset.fileBlob(`ai_inbox/${jobId}/media/${rest.slice(3).join('/')}`);
      if (!blob) throw notFound();
      return blob;
    }
    if (kind === 'drafts' && draftId) {
      if (!action && method === 'PATCH') return inbox.editDraft(jobId, draftId, (json && json.changes) || {});
      if (action === 'accept' && method === 'POST') {
        const result = await inbox.acceptDraft(jobId, draftId, integration, {
          deckName: json && json.deck_name !== undefined ? json.deck_name : null,
          categoryName: json && json.category_name !== undefined ? json.category_name : null,
          subcategoryName: json && json.subcategory_name !== undefined ? json.subcategory_name : null,
        });
        return { draft: result.draft, card_id: result.card.id, card: result.card };
      }
      if (action === 'reject' && method === 'POST') return inbox.rejectDraft(jobId, draftId, (json && json.reason) || '');
      if (action === 'restore' && method === 'POST') return inbox.restoreDraft(jobId, draftId);
    }
  }
  if (area === 'ai-tests') {
    if (!rest.length && method === 'POST') return createAiTest(json || {});
    if (!rest.length && method === 'GET') {
      const items = (await db.getAll('ai_tests')).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return { items: items.map((item) => ({ file_name: item.file_name, url: `/api/ai-tests/${encodeURIComponent(item.file_name)}`, size_bytes: item.size_bytes, created_at: item.created_at })) };
    }
    if (rest.length === 1 && method === 'GET') {
      const entry = await db.get('ai_tests', rest[0]);
      if (!entry) throw notFound();
      return entry.blob;
    }
  }
  if (area === 'backups') {
    if (method === 'GET') return { items: (await cloud.listRemoteBackups()).map((item) => ({ ...item, url: null })) };
    if (method === 'POST') return cloud.createRemoteBackup('manuell');
  }
  throw notFound();
}

export const localBackend = {
  async handle(method, path, { json, form } = {}) {
    const { parts, query } = parse(path);
    try {
      return await route(method, parts, query, json, form);
    } catch (error) {
      if (error instanceof DraftError) throw new ApiError(error.status, { error: error.code, message: error.message });
      throw error;
    }
  },
  async warm(paths) {
    const ids = paths.map((path) => {
      const match = /\/api\/media\/([^/?#]+)/.exec(path);
      return match ? decodeURIComponent(match[1]) : null;
    }).filter(Boolean);
    if (ids.length) await cloud.prefetchMedia(ids);
  },
};
