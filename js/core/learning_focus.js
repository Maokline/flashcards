// App preference in the existing auxiliary-file index; never an AI package.
import { ApiError } from '../api.js';
import * as dataset from './dataset.js';
import { state } from '../store.js';

export const FOCUS_FILE = 'ai_inbox/app-settings/learning_focus.json';
let cachedHash;
let cachedValue;

export function normalizeFocus(value) {
  const ids = value?.deck_ids ?? null;
  if (ids !== null && (!Array.isArray(ids) || ids.length > 2000 || ids.some((id) => typeof id !== 'string' || !id))) {
    throw new ApiError(422, { error: 'validation', message: 'Ungültiger Lernfokus.' });
  }
  return { deck_ids: ids === null ? null : [...new Set(ids)], updated_at: value?.updated_at ?? null };
}

export async function getFocus() {
  const entry = state.files.get(FOCUS_FILE);
  if (!entry) return { deck_ids: null, updated_at: null };
  if (entry.sha256 === cachedHash) return structuredClone(cachedValue);
  const value = normalizeFocus(JSON.parse(await dataset.readFileText(FOCUS_FILE)));
  cachedHash = entry.sha256;
  cachedValue = value;
  return structuredClone(value);
}

export async function setFocus(deckIds) {
  const value = normalizeFocus({ deck_ids: deckIds, updated_at: new Date().toISOString() });
  if (value.deck_ids?.some((id) => !state.decks.has(id))) {
    throw new ApiError(422, { error: 'validation', message: 'Mindestens ein gewähltes Deck existiert nicht mehr.' });
  }
  await dataset.writeFileText(FOCUS_FILE, JSON.stringify(value)); // active-device guard
  return value;
}
