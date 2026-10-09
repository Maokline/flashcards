import { api, NetworkError } from './api.js';
import { emit } from './bus.js';
import * as db from './db.js';

export function resolveFocus(config, decks) {
  const rows = decks instanceof Map ? [...decks.values()] : [...decks];
  const chosen = config?.deck_ids === null || config?.deck_ids === undefined ? null : new Set(config.deck_ids);
  return rows.filter((deck) => chosen === null || chosen.has(deck.id)).map((deck) => deck.id);
}

export async function readFocus() {
  try {
    const focus = await api.get('/api/learning-focus');
    await db.setMeta('learning_focus', focus);
    return focus;
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    return (await db.getMeta('learning_focus')) || { deck_ids: null, updated_at: null };
  }
}

export async function saveFocus(deckIds) {
  const focus = await api.post('/api/learning-focus', { deck_ids: deckIds });
  await db.setMeta('learning_focus', focus);
  emit('data-changed', { preference: 'learning_focus' });
  return focus;
}
