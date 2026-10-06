// The local data set of the PWA in OneDrive mode – the browser counterpart of
// the desktop's SQLite database plus its CardService/MediaService rules.
//
// Every change goes through `apply()`: memory (store.js) and IndexedDB are
// updated in one transaction, then `local-change` tells the OneDrive sync to
// commit.  Writes are only allowed on the active device: the sync installs a
// guard that throws while another device holds the lease.

import { ApiError } from '../api.js';
import { emit } from '../bus.js';
import * as db from '../db.js';
import { state } from '../store.js';
import { sha256Hex } from './canonical.js';
import { MASTERED_POINTS, effectiveTime, learningStateJson, normalizeCard, processCorrect, processIncorrect } from './engine.js';
import { utcIso } from './time.js';

export const CARD_FIELDS = [
  'id', 'deck_id', 'question', 'answer', 'category', 'category_id', 'subcategory', 'subcategory_id',
  'question_images', 'answer_images', 'created_at', 'updated_at', 'points', 'level', 'mastered',
  'positive_streak', 'negative_streak', 'success_history', 'total_incorrect_count',
  'consecutive_incorrect_attempts', 'last_reviewed', 'next_review', 'recovery_mode', 'recovery_interval',
];
const DECK_FIELDS = ['id', 'name', 'description', 'color', 'created_at', 'updated_at'];
const CATEGORY_FIELDS = ['id', 'deck_id', 'name', 'created_at', 'updated_at'];
const SUBCATEGORY_FIELDS = ['id', 'category_id', 'name', 'created_at', 'updated_at'];
const MEDIA_FIELDS = ['id', 'relative_path', 'original_name', 'mime_type', 'size_bytes', 'sha256', 'created_at'];
const MIME_EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/svg+xml': '.svg' };

let guard = () => {};
let blobFetcher = null;
let mediaFetcher = null;

/** Installed by the OneDrive sync: throws while this device is read-only. */
export function setGuard(fn) {
  guard = fn || (() => {});
}

/** Download hooks for files that are not on this device yet. */
export function setFetchers({ blob, media }) {
  blobFetcher = blob;
  mediaFetcher = media;
}

const invalid = (message) => new ApiError(422, { error: 'validation', message });
const notFound = (message) => new ApiError(404, { error: 'not_found', message });
const pick = (row, fields) => Object.fromEntries(fields.map((key) => [key, row[key] ?? null]));
const fold = (text) => String(text || '').trim().toLowerCase();
const uuid = () => crypto.randomUUID();

export function snapshotCard(card) {
  const row = pick(card, CARD_FIELDS);
  row.question_images = [...(card.question_images || [])];
  row.answer_images = [...(card.answer_images || [])];
  row.category = row.category || '';
  row.subcategory = row.subcategory || '';
  row.success_history = (card.success_history || []).map(Boolean).slice(-10);
  return row;
}

function viewCard(row) {
  const deck = state.decks.get(row.deck_id);
  return { ...snapshotCard(row), deck_name: deck ? deck.name : '', version: 1, content_hash: '' };
}

/** Atomically change memory + IndexedDB, then announce the change. */
export async function apply({ put = {}, del = {}, silent = false } = {}) {
  const puts = {};
  const deletes = {};
  for (const [store, rows] of Object.entries(put)) {
    if (!rows.length) continue;
    puts[store] = rows;
    for (const row of rows) {
      if (store === 'files') state.files.set(row.path, { sha256: row.sha256, size: row.size });
      else if (store === 'cards') state.cards.set(row.id, row);
      else if (state[store] instanceof Map && row.id !== undefined) state[store].set(row.id, row);
    }
  }
  for (const [store, keys] of Object.entries(del)) {
    if (!keys.length) continue;
    deletes[store] = keys;
    for (const key of keys) {
      if (state[store] instanceof Map) state[store].delete(key);
    }
  }
  await db.write({ puts, deletes });
  if (!silent) {
    emit('local-change', {});
    emit('data-changed', { source: 'local' });
  }
}

function now() {
  return utcIso(Date.now());
}

// -- decks and categories ----------------------------------------------------
function requireName(value, label) {
  const clean = String(value || '').trim();
  if (!clean) throw invalid(`${label} darf nicht leer sein.`);
  return clean;
}

function cleanColor(value) {
  const clean = String(value || '#4A90E2').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(clean)) throw invalid('Die Deckfarbe muss ein #RRGGBB-Wert sein.');
  return clean.toUpperCase();
}

const findDeck = (name) => [...state.decks.values()].find((deck) => fold(deck.name) === fold(name)) || null;
const findCategory = (deckId, name) => [...state.categories.values()].find((item) => item.deck_id === deckId && fold(item.name) === fold(name)) || null;
const findSubcategory = (categoryId, name) => [...state.subcategories.values()].find((item) => item.category_id === categoryId && fold(item.name) === fold(name)) || null;

/** Like CardService.resolve_destination: create what is missing (pending rows are collected). */
function resolveDestination(deckName, categoryName = '', subcategoryName = '', pending) {
  const cleanDeck = requireName(deckName, 'Der Deckname');
  const cleanCategory = String(categoryName || '').trim();
  const cleanSub = String(subcategoryName || '').trim();
  if (cleanSub && !cleanCategory) throw invalid('Eine Unterkategorie braucht eine Kategorie.');
  const stamp = now();
  let deck = findDeck(cleanDeck) || pending.decks.find((item) => fold(item.name) === fold(cleanDeck));
  if (!deck) {
    deck = { id: uuid(), name: cleanDeck, description: '', color: '#4A90E2', created_at: stamp, updated_at: stamp };
    pending.decks.push(deck);
  }
  let categoryId = null;
  let subcategoryId = null;
  if (cleanCategory) {
    let category = findCategory(deck.id, cleanCategory) || pending.categories.find((item) => item.deck_id === deck.id && fold(item.name) === fold(cleanCategory));
    if (!category) {
      category = { id: uuid(), deck_id: deck.id, name: cleanCategory, created_at: stamp, updated_at: stamp };
      pending.categories.push(category);
    }
    categoryId = category.id;
    if (cleanSub) {
      let sub = findSubcategory(category.id, cleanSub) || pending.subcategories.find((item) => item.category_id === category.id && fold(item.name) === fold(cleanSub));
      if (!sub) {
        sub = { id: uuid(), category_id: category.id, name: cleanSub, created_at: stamp, updated_at: stamp };
        pending.subcategories.push(sub);
      }
      subcategoryId = sub.id;
    }
  }
  return [deck.id, categoryId, subcategoryId];
}

function lookup(map, pendingList, id) {
  return map.get(id) || pendingList.find((item) => item.id === id) || null;
}

/** CardService._resolve_hierarchy with the same consistency rules. */
function resolveHierarchy(deckId, categoryId, subcategoryId, pending) {
  if (!lookup(state.decks, pending.decks, deckId)) throw notFound('Deck nicht gefunden.');
  let category = categoryId ? lookup(state.categories, pending.categories, categoryId) : null;
  const sub = subcategoryId ? lookup(state.subcategories, pending.subcategories, subcategoryId) : null;
  if (subcategoryId && !sub) throw notFound('Unterkategorie nicht gefunden.');
  if (sub && !category) category = lookup(state.categories, pending.categories, sub.category_id);
  if (categoryId && !category) throw notFound('Kategorie nicht gefunden.');
  if (!category) return { categoryId: null, subcategoryId: null, category: '', subcategory: '' };
  if (category.deck_id !== deckId) throw invalid('Die Kategorie gehört nicht zum gewählten Deck.');
  if (sub && sub.category_id !== category.id) throw invalid('Die Unterkategorie gehört nicht zur gewählten Kategorie.');
  return { categoryId: category.id, subcategoryId: sub ? sub.id : null, category: category.name, subcategory: sub ? sub.name : '' };
}

function emptyPending() {
  return { decks: [], categories: [], subcategories: [] };
}

function hierarchyFrom(payload, current, pending) {
  const names = [payload.deck_name, payload.category_name, payload.subcategory_name].some((value) => String(value || '').trim());
  if (!names) {
    const deckId = payload.deck_id || (current && current.deck_id);
    if (!deckId) throw invalid('Eine Karte braucht ein Deck.');
    return [deckId, payload.category_id || null, payload.subcategory_id || null];
  }
  const deckName = String(payload.deck_name || '').trim() || (payload.deck_id ? (state.decks.get(payload.deck_id) || {}).name : '');
  if (!deckName) throw invalid('Eine Karte braucht ein Deck.');
  const categoryName = String(payload.category_name || '').trim() || (payload.category_id ? (state.categories.get(payload.category_id) || {}).name || '' : '');
  const subName = String(payload.subcategory_name || '').trim() || (payload.subcategory_id ? (state.subcategories.get(payload.subcategory_id) || {}).name || '' : '');
  return resolveDestination(deckName, categoryName, subName, pending);
}

function validateContent(question, answer, answerImages) {
  if (!String(question || '').trim()) throw invalid('Bitte eine Frage eingeben.');
  if (!String(answer || '').trim() && !(answerImages || []).length) throw invalid('Bitte eine Antwort eingeben oder ein Antwortbild hinzufügen.');
}

function normalizeIds(values) {
  return [...new Set((values || []).map(String))];
}

function requireMedia(ids) {
  for (const id of ids) if (!state.media.has(id)) throw notFound('Ein Bild wurde nicht gefunden.');
}

// -- cards -----------------------------------------------------------------------
export async function createCard(payload) {
  guard();
  if (payload.id && state.cards.has(payload.id)) return state.cards.get(payload.id); // idempotent retry
  const pending = emptyPending();
  const [deckId, categoryId, subcategoryId] = hierarchyFrom(payload, null, pending);
  const hierarchy = resolveHierarchy(deckId, categoryId, subcategoryId, pending);
  const questionImages = normalizeIds(payload.question_images);
  const answerImages = normalizeIds(payload.answer_images);
  validateContent(payload.question, payload.answer, answerImages);
  requireMedia([...questionImages, ...answerImages]);
  const stamp = now();
  const card = viewCard(normalizeCard({
    id: payload.id || uuid(),
    deck_id: deckId,
    question: String(payload.question),
    answer: String(payload.answer || ''),
    category: hierarchy.category,
    category_id: hierarchy.categoryId,
    subcategory: hierarchy.subcategory,
    subcategory_id: hierarchy.subcategoryId,
    question_images: questionImages,
    answer_images: answerImages,
    created_at: stamp,
    updated_at: stamp,
    points: 0,
    level: 1,
    mastered: false,
    positive_streak: 0,
    negative_streak: 0,
    success_history: [],
    total_incorrect_count: 0,
    consecutive_incorrect_attempts: 0,
    last_reviewed: null,
    next_review: stamp,
    recovery_mode: false,
    recovery_interval: 1,
  }));
  await apply({ put: { ...pending, cards: [card] } });
  return state.cards.get(card.id);
}

export async function updateCard(cardId, payload) {
  guard();
  const current = state.cards.get(cardId);
  if (!current) throw notFound('Karte nicht gefunden.');
  const fields = new Set(Object.keys(payload));
  const pending = emptyPending();
  const next = { ...current };
  for (const name of ['question', 'answer']) if (fields.has(name) && payload[name] !== null && payload[name] !== undefined) next[name] = String(payload[name]);
  for (const name of ['question_images', 'answer_images']) if (fields.has(name) && payload[name]) next[name] = normalizeIds(payload[name]);
  const hierarchyKeys = ['deck_id', 'deck_name', 'category_id', 'category_name', 'subcategory_id', 'subcategory_name'].filter((key) => fields.has(key));
  if (hierarchyKeys.length) {
    const deckChanged = (fields.has('deck_id') && payload.deck_id && payload.deck_id !== current.deck_id) || (fields.has('deck_name') && String(payload.deck_name || '').trim());
    const pickId = (name, fallback) => (fields.has(name) ? payload[name] : (deckChanged ? null : fallback));
    const ids = hierarchyFrom({
      deck_id: fields.has('deck_id') && payload.deck_id ? payload.deck_id : current.deck_id,
      deck_name: payload.deck_name,
      category_id: pickId('category_id', current.category_id),
      category_name: payload.category_name,
      subcategory_id: pickId('subcategory_id', current.subcategory_id),
      subcategory_name: payload.subcategory_name,
    }, current, pending);
    const hierarchy = resolveHierarchy(ids[0], ids[1], ids[2], pending);
    Object.assign(next, { deck_id: ids[0], category_id: hierarchy.categoryId, subcategory_id: hierarchy.subcategoryId, category: hierarchy.category, subcategory: hierarchy.subcategory });
  } else {
    const hierarchy = resolveHierarchy(next.deck_id, next.category_id, next.subcategory_id, pending);
    Object.assign(next, { category: hierarchy.category, subcategory: hierarchy.subcategory, category_id: hierarchy.categoryId, subcategory_id: hierarchy.subcategoryId });
  }
  if (!hierarchyKeys.length && !['question', 'answer', 'question_images', 'answer_images'].some((key) => fields.has(key))) throw invalid('Keine Änderung angegeben.');
  validateContent(next.question, next.answer, next.answer_images);
  requireMedia([...next.question_images, ...next.answer_images]);
  next.updated_at = now();
  await apply({ put: { ...pending, cards: [viewCard(next)] } });
  return state.cards.get(cardId);
}

function eventsOf(cardIds) {
  const ids = new Set(cardIds);
  return [...state.events.values()].filter((event) => ids.has(event.card_id)).map((event) => event.id);
}

export async function deleteCard(cardId) {
  guard();
  if (!state.cards.has(cardId)) throw notFound('Karte nicht gefunden.');
  // ON DELETE CASCADE: the card's review events go with it.
  await apply({ del: { cards: [cardId], events: eventsOf([cardId]) } });
  return { deleted: true, id: cardId };
}

export async function bulk({ action, card_ids: ids = [], deck_id: deckId, category_id: categoryId = null, subcategory_id: subcategoryId = null }) {
  guard();
  const unique = normalizeIds(ids);
  if (!unique.length) return { action, affected: 0 };
  if (unique.some((id) => !state.cards.has(id))) throw notFound('Mindestens eine Karte wurde nicht gefunden.');
  const stamp = now();
  const cards = unique.map((id) => ({ ...state.cards.get(id) }));
  if (action === 'delete') {
    await apply({ del: { cards: unique, events: eventsOf(unique) } });
    return { action, affected: unique.length };
  }
  if (action === 'move') {
    if (!deckId) throw invalid('Zum Verschieben wird ein Deck benötigt.');
    const hierarchy = resolveHierarchy(deckId, categoryId || null, subcategoryId || null, emptyPending());
    for (const card of cards) Object.assign(card, { deck_id: deckId, category_id: hierarchy.categoryId, subcategory_id: hierarchy.subcategoryId, category: hierarchy.category, subcategory: hierarchy.subcategory, updated_at: stamp });
  } else if (action === 'mastered') {
    for (const card of cards) Object.assign(card, { points: MASTERED_POINTS, level: 10, mastered: true, next_review: null, recovery_mode: false, updated_at: stamp });
  } else if (action === 'unmastered') {
    for (const card of cards) Object.assign(card, { points: Math.min(card.points, MASTERED_POINTS - 1), mastered: false, next_review: card.next_review || stamp, updated_at: stamp });
  } else if (action === 'reset') {
    for (const card of cards) {
      Object.assign(card, { points: 0, level: 1, mastered: false, positive_streak: 0, negative_streak: 0, success_history: [], total_incorrect_count: 0, consecutive_incorrect_attempts: 0, last_reviewed: null, next_review: stamp, recovery_mode: false, recovery_interval: 1, updated_at: stamp });
    }
  } else {
    throw invalid(`Unbekannte Aktion: ${action}`);
  }
  // Direct row updates in SQLite bypass Card.__post_init__; only "unmastered"
  // keeps its level as stored, exactly like the desktop.
  await apply({ put: { cards: cards.map((card) => viewCard(card)) } });
  return { action, affected: unique.length };
}

// -- reviews ----------------------------------------------------------------------
function nextEventId() {
  let max = 0;
  for (const id of state.events.keys()) if (Number(id) > max) max = Number(id);
  return max + 1;
}

/** Apply one rating with the learning engine (ReviewEventService rules). */
export async function review({ event_id: eventId, card_id: cardId, correct, immediate_retry: immediateRetry = false, duration_seconds: duration = 0, reviewed_at: reviewedAt = null }) {
  guard();
  const previous = state.cards.get(cardId);
  if (!previous) return { event_id: eventId, card_id: cardId, status: 'rejected', duplicate: false, reason: 'card_not_found' };
  const retry = Boolean(correct && immediateRetry);
  const moment = effectiveTime(reviewedAt, previous, Date.now());
  const result = correct ? processCorrect(previous, moment, { immediateRetry: retry }) : processIncorrect(previous, moment);
  const card = viewCard(result.card);
  const event = {
    id: nextEventId(),
    card_id: cardId,
    reviewed_at: card.last_reviewed || card.updated_at,
    correct: Boolean(correct),
    immediate_retry: retry,
    points_before: previous.points,
    points_after: card.points,
    level_before: previous.level,
    level_after: card.level,
    duration_seconds: Math.min(3600, Math.max(0, Number(duration) || 0)),
    before_state_json: learningStateJson(previous),
    after_state_json: learningStateJson(card),
  };
  await apply({ put: { cards: [card], events: [event] } });
  return {
    event_id: eventId,
    card_id: cardId,
    status: 'applied',
    duplicate: false,
    points_change: result.points_change,
    points_before: previous.points,
    points_after: card.points,
    level_before: previous.level,
    level_after: card.level,
    retry_after_cards: result.retry_after_cards,
    reviewed_at: event.reviewed_at,
    card,
  };
}

// -- media --------------------------------------------------------------------------
function extensionFor(name, type) {
  const match = /\.([a-z0-9]{1,15})$/i.exec(String(name || ''));
  if (match) return `.${match[1].toLowerCase()}`;
  return MIME_EXTENSIONS[type] || '';
}

export async function addMedia(blob, originalName = 'bild.jpg', { guarded = true } = {}) {
  if (guarded) guard();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytes.length) throw invalid('Die Datei ist leer.');
  if (bytes.length > 25 * 1024 * 1024) throw new ApiError(413, { error: 'too_large', message: 'Das Bild ist größer als 25 MB.' });
  const id = uuid();
  const type = blob.type || 'application/octet-stream';
  const row = {
    id,
    relative_path: `${id.slice(0, 2)}/${id}${extensionFor(originalName, type)}`,
    original_name: String(originalName || 'bild'),
    mime_type: type,
    size_bytes: bytes.length,
    sha256: await sha256Hex(bytes),
    created_at: now(),
  };
  await db.put('media_blobs', { id, blob: new Blob([bytes], { type }), uploaded: false });
  await apply({ put: { media: [row] } });
  return { ...row, url: null, version: 1 };
}

export async function deleteMedia(mediaId) {
  guard();
  const attached = [...state.cards.values()].some((card) => (card.question_images || []).includes(mediaId) || (card.answer_images || []).includes(mediaId));
  if (attached) throw new ApiError(409, { error: 'media_in_use', message: 'Das Bild gehört noch zu einer Karte.' });
  await db.remove('media_blobs', mediaId);
  await apply({ del: { media: [mediaId] } });
  return { deleted: true };
}

/** The image as Blob – from this device or (once) downloaded from OneDrive. */
export async function mediaBlob(mediaId) {
  const stored = await db.get('media_blobs', mediaId);
  if (stored && stored.blob) return stored.blob;
  const row = state.media.get(mediaId);
  if (!row || !mediaFetcher) return null;
  const bytes = await mediaFetcher(row);
  if (!bytes) return null;
  const blob = new Blob([bytes], { type: row.mime_type || 'application/octet-stream' });
  await db.put('media_blobs', { id: mediaId, blob, uploaded: true });
  return blob;
}

// -- files of AI draft packages ----------------------------------------------------------
export function fileList() {
  return [...state.files.keys()];
}

export async function fileBlob(path) {
  const entry = state.files.get(path);
  if (!entry) return null;
  const stored = await db.get('blobs', entry.sha256);
  if (stored && stored.blob) return stored.blob;
  if (!blobFetcher) return null;
  const bytes = await blobFetcher(entry.sha256);
  const blob = new Blob([bytes]);
  await db.put('blobs', { sha256: entry.sha256, blob, uploaded: true });
  return blob;
}

export async function readFileText(path) {
  const blob = await fileBlob(path);
  if (!blob) throw notFound(`Datei fehlt: ${path}`);
  return blob.text();
}

export async function writeFileText(path, text) {
  guard();
  const bytes = new TextEncoder().encode(text);
  const sha256 = await sha256Hex(bytes);
  await db.put('blobs', { sha256, blob: new Blob([bytes], { type: 'application/json' }), uploaded: false });
  await apply({ put: { files: [{ path, sha256, size: bytes.length }] } });
}

/** Copy a file of an AI package into the card media (MediaService.import_media). */
export async function importFileAsMedia(path, type) {
  const blob = await fileBlob(path);
  if (!blob) throw notFound(`Bild fehlt: ${path}`);
  const name = path.split('/').pop();
  const media = await addMedia(new Blob([await blob.arrayBuffer()], { type: type || 'application/octet-stream' }), name);
  return media.id;
}

export function resolveDestinationNow(deckName, categoryName, subcategoryName) {
  const pending = emptyPending();
  const ids = resolveDestination(deckName, categoryName, subcategoryName, pending);
  return { ids, pending };
}

export async function savePending(pending) {
  await apply({ put: pending });
}

// -- snapshot ------------------------------------------------------------------------------
export function exportDataset() {
  const byId = (rows, fields) => rows.map((row) => pick(row, fields)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const decks = byId([...state.decks.values()], DECK_FIELDS).map((deck) => ({ ...deck, description: deck.description || '' }));
  const media = byId([...state.media.values()], MEDIA_FIELDS).map((item) => ({ ...item, size_bytes: Number(item.size_bytes) || 0 }));
  const cards = [...state.cards.values()].map(snapshotCard).sort((a, b) => (a.id < b.id ? -1 : 1));
  const files = Object.fromEntries([...state.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, entry]) => [path, { sha256: entry.sha256, size: Number(entry.size) || 0 }]));
  const events = [...state.events.values()].map((event) => ({ ...event })).sort((a, b) => a.id - b.id);
  return {
    core: {
      decks,
      categories: byId([...state.categories.values()], CATEGORY_FIELDS),
      subcategories: byId([...state.subcategories.values()], SUBCATEGORY_FIELDS),
      cards,
      media,
      ai_files: files,
    },
    events,
  };
}

/** Replace the whole local data set (pull from OneDrive). */
export async function replaceAll({ core, events }) {
  state.decks = new Map(core.decks.map((row) => [row.id, { ...row }]));
  state.categories = new Map(core.categories.map((row) => [row.id, { ...row }]));
  state.subcategories = new Map(core.subcategories.map((row) => [row.id, { ...row }]));
  state.media = new Map(core.media.map((row) => [row.id, { ...row }]));
  state.cards = new Map(core.cards.map((row) => [row.id, viewCard(row)]));
  state.events = new Map(events.map((row) => [Number(row.id), { ...row, id: Number(row.id) }]));
  state.files = new Map(Object.entries(core.ai_files || {}).map(([path, entry]) => [path, { sha256: entry.sha256, size: entry.size }]));
  await db.write({
    clear: ['decks', 'categories', 'subcategories', 'cards', 'media', 'events', 'files'],
    puts: {
      decks: [...state.decks.values()],
      categories: [...state.categories.values()],
      subcategories: [...state.subcategories.values()],
      media: [...state.media.values()],
      cards: [...state.cards.values()],
      events: [...state.events.values()],
      files: [...state.files.entries()].map(([path, entry]) => ({ path, ...entry })),
    },
  });
  emit('data-changed', { source: 'pull' });
}

export function isEmpty() {
  return !state.decks.size && !state.cards.size && !state.media.size && !state.events.size && !state.files.size;
}
