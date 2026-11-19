// Stored deck shares of weighted sessions, as the screens use them.
//
// Cloud mode: answered on this device (js/core/deck_weight_file.js).  Server
// mode: the same paths at the sync server; the last answer is kept for
// offline use and only written when it changed.
import { api, NetworkError } from './api.js';
import { isCloud } from './config.js';
import * as db from './db.js';
import { normalizeDocument } from './core/deck_weights.js';

let rememberedText = null;

async function remember(document) {
  if (isCloud()) return;
  const text = JSON.stringify(document);
  if (text === rememberedText) return;
  rememberedText = text;
  try { await db.setMeta('deck_weights', document); } catch { /* the cache is optional */ }
}

/** Every stored deck combination ({version, combinations}). */
export async function readWeights() {
  try {
    const document = normalizeDocument(await api.get('/api/deck-weights'));
    await remember(document);
    return document;
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    return normalizeDocument(await db.getMeta('deck_weights'));
  }
}

/** Store the shares of one deck combination; resolves with the new document. */
export async function saveWeights(weights) {
  const document = normalizeDocument(await api.post('/api/deck-weights', { weights }));
  await remember(document);
  return document;
}
