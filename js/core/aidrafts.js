// AI draft workflow – port of app/services/ai_draft_service.py for the PWA in
// OneDrive mode.  Jobs live in the synchronised file index exactly like in
// the desktop's inbox folder:
//
//   ai_inbox/<job_id>/manifest.json      the producer's immutable manifest
//   ai_inbox/<job_id>/media/...          its images
//   ai_inbox/<job_id>/review_state.json  every decision (same schema as desktop)
//
// The same strict validation applies; only an explicit accept creates a card.

import { utcIso } from './time.js';

export const MANIFEST = 'manifest.json';
export const REVIEW_STATE = 'review_state.json';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MANIFEST_KEYS = ['job_id', 'title', 'source_document', 'cards'];
const CARD_KEYS = ['draft_id', 'question', 'answer', 'suggested_deck', 'suggested_category', 'suggested_subcategory', 'question_images', 'answer_images', 'source_page', 'source_note', 'media_origins'];
const EDIT_ALIASES = { deck_name: 'suggested_deck', category_name: 'suggested_category', subcategory_name: 'suggested_subcategory' };
const STATE_KEYS = ['schema_version', 'job_id', 'cards'];
const REVIEW_KEYS = ['status', 'edited_card', 'accepted_card_id', 'rejection_reason', 'updated_at'];
const ORIGINS = ['source_extract', 'generated_chart', 'generated_diagram', 'user_added'];
const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/vnd.microsoft.icon',
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
};
const MUTABLE = new Set(['pending', 'edited']);
const ACCEPTABLE = new Set(['pending', 'edited', 'rejected']);

export class DraftError extends Error {
  constructor(message, { status = 422, code = 'invalid_draft' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function imageType(path) {
  const extension = String(path).split('.').pop().toLowerCase();
  return IMAGE_TYPES[extension] || null;
}

function requireMapping(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DraftError(`${location}: must be a JSON object`);
  return value;
}

function requireExactKeys(payload, expected, location) {
  const actual = Object.keys(payload);
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`missing fields: ${missing.sort().join(', ')}`);
    if (extra.includes('tags')) parts.push('tags are not supported');
    const unknown = extra.filter((key) => key !== 'tags');
    if (unknown.length) parts.push(`unknown fields: ${unknown.sort().join(', ')}`);
    throw new DraftError(`${location}: ${parts.join('; ')}`);
  }
}

function requireSafeId(value, location) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new DraftError(`${location}: must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}`);
  return value;
}

function requireString(value, location, allowEmpty = false) {
  if (typeof value !== 'string') throw new DraftError(`${location}: must be a string`);
  if (!allowEmpty && !value.trim()) throw new DraftError(`${location}: must not be empty`);
  if (allowEmpty && value && !value.trim()) throw new DraftError(`${location}: must be empty or contain non-whitespace text`);
  return value;
}

/** Strict JSON: duplicate keys are rejected like the desktop does. */
export function parseStrictJson(text, location) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DraftError(`${location}: invalid JSON: ${error.message}`);
  }
  const duplicate = findDuplicateKey(text);
  if (duplicate !== null) throw new DraftError(`${location}: invalid JSON: duplicate JSON key '${duplicate}'`);
  return value;
}

function findDuplicateKey(text) {
  const stack = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.object && top.expectKey) {
        const key = JSON.parse(text.slice(index, end + 1));
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      index = end + 1;
      continue;
    }
    if (char === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
    else if (char === '[') stack.push({ object: false });
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',') {
      const top = stack[stack.length - 1];
      if (top && top.object) top.expectKey = true;
    }
    index += 1;
  }
  return null;
}

export function parseCard(raw, { hasMedia, location }) {
  const payload = requireMapping(raw, location);
  requireExactKeys(payload, CARD_KEYS, location);
  const draftId = requireSafeId(payload.draft_id, `${location}.draft_id`);
  const question = requireString(payload.question, `${location}.question`);
  const answer = requireString(payload.answer, `${location}.answer`, true);
  const deck = requireString(payload.suggested_deck, `${location}.suggested_deck`);
  const category = requireString(payload.suggested_category, `${location}.suggested_category`, true);
  const subcategory = requireString(payload.suggested_subcategory, `${location}.suggested_subcategory`, true);
  if (subcategory && !category) throw new DraftError(`${location}.suggested_subcategory: a suggested_subcategory requires suggested_category`);
  const questionImages = parseImages(payload.question_images, hasMedia, `${location}.question_images`);
  const answerImages = parseImages(payload.answer_images, hasMedia, `${location}.answer_images`);
  if (!answer.trim() && !answerImages.length) throw new DraftError(`${location}.answer: answer must contain text or at least one answer image`);
  const all = [...questionImages, ...answerImages];
  if (new Set(all).size !== all.length) throw new DraftError(`${location}.question_images/answer_images: an image path may appear only once per draft card`);
  const page = payload.source_page;
  if (page !== null && (typeof page !== 'number' || !Number.isInteger(page) || page < 1)) throw new DraftError(`${location}.source_page: source_page must be null or an integer >= 1`);
  const note = requireString(payload.source_note, `${location}.source_note`, true);
  if (!Array.isArray(payload.media_origins)) throw new DraftError(`${location}.media_origins: media_origins must be an array`);
  if (payload.media_origins.length !== all.length) throw new DraftError(`${location}.media_origins: media_origins must contain one value per question image and then answer image`);
  payload.media_origins.forEach((origin, index) => {
    if (typeof origin !== 'string') throw new DraftError(`${location}.media_origins[${index}]: media origin must be a string`);
    if (!ORIGINS.includes(origin)) throw new DraftError(`${location}.media_origins[${index}]: unsupported media origin '${origin}'; allowed: ${ORIGINS.join(', ')}`);
  });
  return {
    draft_id: draftId,
    question,
    answer,
    suggested_deck: deck,
    suggested_category: category,
    suggested_subcategory: subcategory,
    question_images: questionImages,
    answer_images: answerImages,
    source_page: page,
    source_note: note,
    media_origins: [...payload.media_origins],
  };
}

function parseImages(raw, hasMedia, location) {
  if (!Array.isArray(raw)) throw new DraftError(`${location}: must be an array`);
  return raw.map((value, index) => {
    const at = `${location}[${index}]`;
    if (typeof value !== 'string' || !value) throw new DraftError(`${at}: image path must be a non-empty string`);
    if (value.includes('\\') || value.includes('\0') || value.includes(':')) throw new DraftError(`${at}: image path must be a portable relative POSIX path`);
    const segments = value.split('/');
    if (value.startsWith('/') || segments.some((segment) => ['', '.', '..'].includes(segment))) throw new DraftError(`${at}: image path must stay below the job media directory`);
    if (!hasMedia(value)) throw new DraftError(`${at}: referenced image does not exist inside media: '${value}'`);
    if (!imageType(value)) throw new DraftError(`${at}: referenced media is not a recognized image: '${value}'`);
    return segments.join('/');
  });
}

/** to_manifest_dict(): the public manifest field order. */
export function manifestDict(card) {
  return {
    draft_id: card.draft_id,
    question: card.question,
    answer: card.answer,
    suggested_deck: card.suggested_deck,
    suggested_category: card.suggested_category,
    suggested_subcategory: card.suggested_subcategory,
    question_images: [...card.question_images],
    answer_images: [...card.answer_images],
    source_page: card.source_page,
    source_note: card.source_note,
    media_origins: [...card.media_origins],
  };
}

/**
 * The workflow over a file API:
 *   files.list() → paths ("ai_inbox/<job>/...")
 *   files.readText(path) → Promise<string>
 *   files.writeText(path, text) → Promise<void>
 */
export class DraftInbox {
  constructor(files, { clock = () => Date.now() } = {}) {
    this.files = files;
    this.clock = clock;
  }

  jobIds() {
    const ids = new Set();
    for (const path of this.files.list()) {
      const parts = path.split('/');
      if (parts[0] === 'ai_inbox' && parts.length === 3 && parts[2] === MANIFEST && !parts[1].startsWith('.')) ids.add(parts[1]);
    }
    return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  hasFile(path) {
    return this.files.list().includes(path);
  }

  async loadJob(jobId) {
    const safe = requireSafeId(jobId, 'job_id');
    const base = `ai_inbox/${safe}`;
    if (!this.hasFile(`${base}/${MANIFEST}`)) throw new DraftError(`AI draft job '${safe}' was not found.`, { status: 404, code: 'not_found' });
    const location = `job[${safe}].manifest`;
    const manifest = requireMapping(parseStrictJson(await this.files.readText(`${base}/${MANIFEST}`), location), location);
    requireExactKeys(manifest, MANIFEST_KEYS, location);
    const manifestId = requireSafeId(manifest.job_id, `${location}.job_id`);
    if (manifestId !== safe) throw new DraftError(`${location}.job_id: job_id must exactly match its inbox folder name`);
    const title = requireString(manifest.title, `${location}.title`);
    const sourceDocument = requireString(manifest.source_document, `${location}.source_document`);
    if (!Array.isArray(manifest.cards) || !manifest.cards.length) throw new DraftError(`${location}.cards: cards must be a non-empty array`);
    const hasMedia = (relative) => this.hasFile(`${base}/media/${relative}`);
    const seen = new Set();
    const cards = manifest.cards.map((raw, index) => {
      const card = parseCard(raw, { hasMedia, location: `${location}.cards[${index}]` });
      if (seen.has(card.draft_id)) throw new DraftError(`${location}.cards[${index}].draft_id: duplicate draft_id '${card.draft_id}'`);
      seen.add(card.draft_id);
      return card;
    });
    const job = { job_id: safe, title, source_document: sourceDocument, cards, base, hasMedia };
    job.reviews = await this.loadReviews(job);
    return job;
  }

  async loadReviews(job) {
    const path = `${job.base}/${REVIEW_STATE}`;
    if (!this.hasFile(path)) return new Map();
    const location = `job[${job.job_id}].review_state`;
    const state = requireMapping(parseStrictJson(await this.files.readText(path), location), location);
    requireExactKeys(state, STATE_KEYS, location);
    if (state.schema_version !== 1) throw new DraftError(`${location}.schema_version: unsupported review state schema_version ${state.schema_version}`);
    if (state.job_id !== job.job_id) throw new DraftError(`${location}.job_id: job_id does not match the job folder`);
    const raw = requireMapping(state.cards, `${location}.cards`);
    const valid = new Set(job.cards.map((card) => card.draft_id));
    const reviews = new Map();
    for (const [draftId, value] of Object.entries(raw)) {
      const at = `${location}.cards[${draftId}]`;
      if (!valid.has(draftId)) throw new DraftError(`${at}: review state references an unknown draft_id`);
      const review = requireMapping(value, at);
      requireExactKeys(review, REVIEW_KEYS, at);
      const status = review.status;
      if (!['pending', 'accepted', 'rejected', 'edited', 'deleted'].includes(status)) throw new DraftError(`${at}.status: invalid draft status`);
      let edited = null;
      if (review.edited_card !== null) {
        edited = parseCard(review.edited_card, { hasMedia: job.hasMedia, location: `${at}.edited_card` });
        if (edited.draft_id !== draftId) throw new DraftError(`${at}.edited_card.draft_id: edited_card draft_id does not match its review key`);
      }
      if (status === 'edited' && !edited) throw new DraftError(`${at}: edited status requires edited_card`);
      if ((status === 'pending' || status === 'deleted') && edited) throw new DraftError(`${at}: ${status} status cannot contain edited_card`);
      const accepted = review.accepted_card_id;
      if (accepted !== null && (typeof accepted !== 'string' || !accepted)) throw new DraftError(`${at}.accepted_card_id: accepted_card_id must be null or a non-empty string`);
      if (status === 'accepted' && !accepted) throw new DraftError(`${at}: accepted status requires accepted_card_id`);
      if (status !== 'accepted' && accepted !== null) throw new DraftError(`${at}: accepted_card_id is only valid for accepted status`);
      if (typeof review.rejection_reason !== 'string') throw new DraftError(`${at}.rejection_reason: rejection_reason must be a string`);
      if (status !== 'rejected' && review.rejection_reason) throw new DraftError(`${at}.rejection_reason: rejection_reason is only valid for rejected status`);
      if (review.updated_at !== null && typeof review.updated_at !== 'string') throw new DraftError(`${at}.updated_at: updated_at must be null or an ISO timestamp string`);
      if (status !== 'pending' && review.updated_at === null) throw new DraftError(`${at}.updated_at: non-pending status requires updated_at`);
      reviews.set(draftId, {
        status,
        edited_card: edited,
        accepted_card_id: accepted,
        rejection_reason: review.rejection_reason,
        updated_at: review.updated_at,
      });
    }
    return reviews;
  }

  async writeReviews(job, reviews) {
    const cards = {};
    for (const card of job.cards) {
      const review = reviews.get(card.draft_id);
      if (!review) continue;
      cards[card.draft_id] = {
        status: review.status,
        edited_card: review.edited_card ? manifestDict(review.edited_card) : null,
        accepted_card_id: review.accepted_card_id ?? null,
        rejection_reason: review.rejection_reason ?? '',
        updated_at: review.updated_at ?? null,
      };
    }
    const payload = { schema_version: 1, job_id: job.job_id, cards };
    await this.files.writeText(`${job.base}/${REVIEW_STATE}`, `${JSON.stringify(payload, null, 2)}\n`);
  }

  review(job, draftId) {
    return job.reviews.get(draftId) || { status: 'pending', edited_card: null, accepted_card_id: null, rejection_reason: '', updated_at: null };
  }

  card(job, draftId) {
    const card = job.cards.find((item) => item.draft_id === draftId);
    if (!card) throw new DraftError(`Draft '${draftId}' was not found.`, { status: 404, code: 'not_found' });
    return card;
  }

  timestamp() {
    return utcIso(this.clock());
  }

  draftDict(job, card) {
    const review = this.review(job, card.draft_id);
    const effective = review.edited_card || card;
    const media = (paths) => paths.map((path) => ({ path, file: `${job.base}/media/${path}`, url: null }));
    return {
      job_id: job.job_id,
      draft_id: card.draft_id,
      status: review.status,
      question: effective.question,
      answer: effective.answer,
      suggested_deck: effective.suggested_deck,
      suggested_category: effective.suggested_category,
      suggested_subcategory: effective.suggested_subcategory,
      question_images: media(effective.question_images),
      answer_images: media(effective.answer_images),
      source_page: effective.source_page,
      source_note: effective.source_note,
      media_origins: [...effective.media_origins],
      accepted_card_id: review.accepted_card_id ?? null,
      rejection_reason: review.rejection_reason ?? '',
      updated_at: review.updated_at ?? null,
      edited: Boolean(review.edited_card),
    };
  }

  async summary(jobId) {
    let job;
    try {
      job = await this.loadJob(jobId);
    } catch (error) {
      return { job_id: jobId, title: jobId, error: error.message, counts: {}, total: 0, open: 0 };
    }
    const counts = { pending: 0, accepted: 0, rejected: 0, edited: 0 };
    let total = 0;
    for (const card of job.cards) {
      const status = this.review(job, card.draft_id).status;
      if (status === 'deleted') continue;
      counts[status] = (counts[status] || 0) + 1;
      total += 1;
    }
    return {
      job_id: job.job_id,
      title: job.title,
      source_document: job.source_document,
      counts,
      open: counts.pending + counts.edited,
      total,
      error: null,
    };
  }

  async listJobs() {
    const items = [];
    for (const id of this.jobIds()) items.push(await this.summary(id));
    return { items };
  }

  async getJob(jobId) {
    const job = await this.loadJob(jobId);
    const summary = await this.summary(jobId);
    const drafts = job.cards
      .filter((card) => this.review(job, card.draft_id).status !== 'deleted')
      .map((card) => this.draftDict(job, card));
    return { ...summary, drafts };
  }

  async editDraft(jobId, draftId, changes) {
    if (!changes || typeof changes !== 'object' || !Object.keys(changes).length) throw new DraftError(`job[${jobId}].draft[${draftId}].changes: changes must be a non-empty object`);
    const allowed = new Set([...CARD_KEYS.filter((key) => key !== 'draft_id'), ...Object.keys(EDIT_ALIASES)]);
    const forbidden = Object.keys(changes).filter((key) => !allowed.has(key));
    if (forbidden.length) throw new DraftError(`${forbidden.includes('tags') ? 'tags are not supported' : 'unknown fields'}: ${forbidden.sort().join(', ')}`);
    const job = await this.loadJob(jobId);
    const original = this.card(job, draftId);
    const current = this.review(job, draftId);
    if (!MUTABLE.has(current.status)) throw new DraftError(`Cannot edit draft '${draftId}' from status '${current.status}'.`, { status: 409, code: 'invalid_transition' });
    const payload = manifestDict(current.edited_card || original);
    for (const [key, value] of Object.entries(changes)) payload[EDIT_ALIASES[key] || key] = value;
    const editedOrigins = keepOrigins(current.edited_card || original, payload, changes);
    payload.media_origins = editedOrigins;
    const edited = parseCard(payload, { hasMedia: job.hasMedia, location: `job[${jobId}].draft[${draftId}].edited` });
    if (edited.draft_id !== draftId) throw new DraftError('draft_id is immutable');
    job.reviews.set(draftId, { status: 'edited', edited_card: edited, accepted_card_id: null, rejection_reason: '', updated_at: this.timestamp() });
    await this.writeReviews(job, job.reviews);
    return this.draftDict(job, original);
  }

  async rejectDraft(jobId, draftId, reason = '') {
    const job = await this.loadJob(jobId);
    this.card(job, draftId);
    const current = this.review(job, draftId);
    if (!MUTABLE.has(current.status)) throw new DraftError(`Cannot reject draft '${draftId}' from status '${current.status}'.`, { status: 409, code: 'invalid_transition' });
    job.reviews.set(draftId, { status: 'rejected', edited_card: current.edited_card, accepted_card_id: null, rejection_reason: String(reason || ''), updated_at: this.timestamp() });
    await this.writeReviews(job, job.reviews);
    return this.draftDict(job, this.card(job, draftId));
  }

  async restoreDraft(jobId, draftId) {
    const job = await this.loadJob(jobId);
    const original = this.card(job, draftId);
    const current = this.review(job, draftId);
    if (current.status !== 'rejected') throw new DraftError(`Cannot restore draft '${draftId}' from status '${current.status}'.`, { status: 409, code: 'invalid_transition' });
    job.reviews.set(draftId, { status: current.edited_card ? 'edited' : 'pending', edited_card: current.edited_card, accepted_card_id: null, rejection_reason: '', updated_at: this.timestamp() });
    await this.writeReviews(job, job.reviews);
    return this.draftDict(job, original);
  }

  async emptyTrash(jobId) {
    const job = await this.loadJob(jobId);
    const deleted = job.cards.filter((card) => this.review(job, card.draft_id).status === 'rejected').map((card) => card.draft_id);
    if (!deleted.length) return [];
    const timestamp = this.timestamp();
    for (const draftId of deleted) {
      job.reviews.set(draftId, { status: 'deleted', edited_card: null, accepted_card_id: null, rejection_reason: '', updated_at: timestamp });
    }
    await this.writeReviews(job, job.reviews);
    return deleted;
  }

  /**
   * `integration.importMedia(filePath)` → media id,
   * `integration.createCard({deck_name, category_name, …})` → card (the
   * hierarchy is resolved by name and created when missing).
   */
  async acceptDraft(jobId, draftId, integration, { deckName = null, categoryName = null, subcategoryName = null } = {}) {
    const job = await this.loadJob(jobId);
    const original = this.card(job, draftId);
    const current = this.review(job, draftId);
    if (!ACCEPTABLE.has(current.status)) throw new DraftError(`Cannot accept draft '${draftId}' from status '${current.status}'.`, { status: 409, code: 'invalid_transition' });
    const card = current.edited_card || original;
    const deck = destination(deckName, card.suggested_deck, true, 'deck');
    const category = destination(categoryName, card.suggested_category, false, 'category');
    const subcategory = destination(subcategoryName, card.suggested_subcategory, false, 'subcategory');
    if (subcategory && !category) throw new DraftError('a subcategory requires a category');
    const questionIds = [];
    for (const path of card.question_images) questionIds.push(await integration.importMedia(`${job.base}/media/${path}`));
    const answerIds = [];
    for (const path of card.answer_images) answerIds.push(await integration.importMedia(`${job.base}/media/${path}`));
    const created = await integration.createCard({
      deck_name: deck,
      category_name: category,
      subcategory_name: subcategory,
      question: card.question,
      answer: card.answer,
      question_images: questionIds,
      answer_images: answerIds,
    });
    job.reviews.set(draftId, { status: 'accepted', edited_card: current.edited_card, accepted_card_id: created.id, rejection_reason: '', updated_at: this.timestamp() });
    await this.writeReviews(job, job.reviews);
    return { card: created, draft: this.draftDict(job, original) };
  }
}

function destination(override, fallback, required, field) {
  const value = override === null || override === undefined ? fallback : override;
  if (typeof value !== 'string') throw new DraftError(`${field} name must be a string`);
  if (required && !value.trim()) throw new DraftError(`${field} name must not be empty`);
  if (!required && value && !value.trim()) throw new DraftError(`${field} name must be empty or non-whitespace text`);
  return value;
}

// Keep media origins aligned when only the image lists were edited
// (server/routes/ai_drafts.py `_with_origins`).
function keepOrigins(card, payload, changes) {
  if ('media_origins' in changes || !('question_images' in changes || 'answer_images' in changes)) return payload.media_origins;
  const known = new Map([...card.question_images, ...card.answer_images].map((path, index) => [path, card.media_origins[index]]));
  return [...payload.question_images, ...payload.answer_images].map((path) => known.get(path) || 'user_added');
}
