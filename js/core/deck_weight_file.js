// Stored deck shares of weighted sessions (cloud mode).  Like the learning
// focus this is an app preference in the existing auxiliary-file index –
// never an AI package – so the normal sync carries it to the desktop.
import { ApiError } from '../api.js';
import * as dataset from './dataset.js';
import { state } from '../store.js';
import { combinationIds, emptyDocument, findWeights, isValid, normalizeDocument, withCombination } from './deck_weights.js';
import { utcIso } from './time.js';

export const WEIGHTS_FILE = 'ai_inbox/app-settings/deck_weights.json';
let cachedHash;
let cachedValue;

const invalid = (message) => new ApiError(422, { error: 'validation', message });

async function read({ strict = false } = {}) {
  const entry = state.files.get(WEIGHTS_FILE);
  if (!entry) return emptyDocument();
  if (entry.sha256 === cachedHash) return structuredClone(cachedValue);
  let text;
  try {
    text = await dataset.readFileText(WEIGHTS_FILE);
  } catch (error) {
    // Not on this device yet and not loadable right now.  Reading shows
    // "nothing stored"; saving must not replace what it could not read.
    if (strict) throw error;
    return emptyDocument();
  }
  let value;
  try {
    value = normalizeDocument(JSON.parse(text));
  } catch {
    value = emptyDocument();
  }
  cachedHash = entry.sha256;
  cachedValue = value;
  return structuredClone(value);
}

/** Every stored combination; a missing or damaged file means none. */
export function getWeightsDocument() {
  return read();
}

/** Remember the shares for their deck combination (no write if unchanged). */
export async function saveWeightsDocument(weights) {
  const record = Boolean(weights) && typeof weights === 'object' && !Array.isArray(weights);
  const ids = record ? combinationIds(Object.keys(weights)) : [];
  if (ids.length < 2) throw invalid('Die Deck-Gewichtung braucht mindestens zwei Decks.');
  if (!isValid(weights, ids)) throw invalid('Die Deck-Anteile müssen ganze Prozentwerte von 0 bis 100 sein und zusammen 100 ergeben.');
  if (ids.some((id) => !state.decks.has(id))) throw invalid('Mindestens ein gewähltes Deck existiert nicht mehr.');
  const document = await read({ strict: true });
  const stored = findWeights(document, ids);
  if (stored && ids.every((id) => stored[id] === weights[id])) return document;
  const next = withCombination(document, weights, utcIso(), { existingDeckIds: [...state.decks.keys()] });
  await dataset.writeFileText(WEIGHTS_FILE, JSON.stringify(next)); // active-device guard
  return next;
}
