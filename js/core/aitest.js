// AI test export – byte-for-byte port of
// app/services/ai_test_export_service.py (the same self-contained HTML the
// desktop creates).  tests/test_engine_parity.py compares both outputs.

import { base64, pythonJson } from './canonical.js';
import { localIso } from './time.js';

export const START_TEXT = 'Bitte verwende die Tutor-Anweisungen und den Lernstand aus der angehängten '
  + 'HTML-Datei. Stelle mir die Fragen interaktiv, jeweils eine nach der anderen, '
  + 'und passe die Aufgabenform an den Lernstand der jeweiligen Karte an. Starte '
  + 'jetzt den Test.';

export const WRITEBACK_POLICY = 'Dieser Export ist read-only: Der Tutor darf keine Karten, Punkte, Levels, '
  + 'Streaks, Fehlerzähler, Termine oder sonstigen Lernstand automatisch '
  + 'zurückschreiben oder verändern.';

export const TUTOR_RULES = [
  'Stelle immer genau eine Aufgabe auf einmal.',
  'Verrate die Antwort nicht, bevor die lernende Person geantwortet hat.',
  'Warte nach jeder Aufgabe auf die Antwort der lernenden Person.',
  'Bewerte ausschließlich mit KORREKT, TEILWEISE KORREKT oder FALSCH und erkläre knapp, was fehlt oder falsch ist.',
  'Reagiere auf schwache Antworten unterstützend und gib abgestufte Hilfen.',
  'Fordere bei starken Antworten einen kurzen Transfer oder eine Anwendung.',
  'Halte Aufgaben, Rückmeldungen und Erklärungen kurz und fokussiert.',
  'Verwende bei Multiple Choice nur plausible Distraktoren.',
  'Verwende keine Fangfragen oder absichtlich irreführenden Formulierungen.',
  'Gib bei Listenaufgaben auf niedrigen Levels Strukturhinweise.',
  'Behandle die Karte als primäre Wissensquelle.',
  'Erfinde keine Aussagen, die dem Karteninhalt widersprechen.',
  'Vereinfache die Aufgabe, wenn der Karteninhalt für das Zielniveau nicht ausreicht.',
  'Beziehe vorhandene Frage- und Antwortbilder in die Aufgabe ein.',
  'Erkläre die Lösung ausführlicher, wenn die lernende Person darum bittet.',
  'Führe den Test interaktiv durch und präsentiere nicht alle Aufgaben auf einmal.',
];

export const ADAPTIVE_LEVELS = [
  { levels: '1-2', mode: 'Unterstützend: Lückentext, Multiple Choice, Zuordnung und Hinweise.' },
  { levels: '3-4', mode: 'Geführter Abruf mit knappen Leitfragen und begrenzten Hinweisen.' },
  { levels: '5-7', mode: 'Aktiver freier Abruf und Anwendung des Kartenwissens.' },
  { levels: '8-10', mode: 'Sicheres Wiedererkennen und ein kurzer Mini-Transfer auf einen nahen Fall.' },
  { levels: 'mastered', mode: 'Nur ausdrücklich ausgewählte gemeisterte Karten; kurzer fortgeschrittener Transfer.' },
];

/** Python's html.escape(text, quote=True). */
export function htmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Python's str() for the values shown in the learning-state table. */
function pythonStr(value) {
  if (value === null || value === undefined) return '';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

const text = (value) => (value === null || value === undefined ? '' : String(value));
const integer = (value) => {
  if (value === true) return 1;
  if (value === false) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

function pad(value) {
  return String(value).padStart(2, '0');
}

export function exportFileName(now) {
  const date = new Date(now);
  return `FlashCard_AI_Test_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.html`;
}

/**
 * `media(id)` returns `{original_name, mime_type, bytes}` or null.
 */
export function cardRecord(card, media, deckName = '') {
  const mediaRecords = (ids, side) => (ids || []).map((value) => {
    const id = text(value && typeof value === 'object' ? value.id : value);
    const asset = media(id);
    const filename = asset ? text(asset.original_name) : '';
    const type = (asset && asset.mime_type) || 'application/octet-stream';
    const bytes = asset && asset.bytes;
    const available = Boolean(bytes && bytes.length);
    return {
      id,
      filename,
      type,
      side,
      data_uri: available ? `data:${type};base64,${base64(bytes)}` : '',
      available,
    };
  });
  const questionMedia = mediaRecords(card.question_images, 'question');
  const answerMedia = mediaRecords(card.answer_images, 'answer');
  const name = text(card.deck_name || deckName);
  return {
    card_id: text(card.id),
    deck: name,
    category: text(card.category),
    subcategory: text(card.subcategory),
    question: text(card.question),
    answer: text(card.answer),
    identity: {
      id: text(card.id),
      deck_id: text(card.deck_id),
      deck_name: name,
      category_id: card.category_id === null || card.category_id === undefined ? null : text(card.category_id),
      category_name: text(card.category),
      subcategory_id: card.subcategory_id === null || card.subcategory_id === undefined ? null : text(card.subcategory_id),
      subcategory_name: text(card.subcategory),
    },
    text: { question: text(card.question), answer: text(card.answer) },
    question_images: questionMedia,
    answer_images: answerMedia,
    images: [...questionMedia, ...answerMedia],
    learning_state: {
      points: integer(card.points),
      level: integer(card.level),
      mastered: Boolean(card.mastered),
      positive_streak: integer(card.positive_streak),
      negative_streak: integer(card.negative_streak),
      success_history: (card.success_history || []).map(Boolean),
      total_incorrect_count: integer(card.total_incorrect_count),
      consecutive_incorrect_attempts: integer(card.consecutive_incorrect_attempts),
      last_reviewed: card.last_reviewed ?? null,
      next_review: card.next_review ?? null,
      recovery_mode: Boolean(card.recovery_mode),
      recovery_interval: integer(card.recovery_interval),
    },
    timestamps: {
      created_at: card.created_at ?? null,
      updated_at: card.updated_at ?? null,
    },
  };
}

function definitionList(rows) {
  return `<dl>${rows.map(([label, value]) => {
    const rendered = value !== null && typeof value === 'object' ? pythonJson(value) : pythonStr(value);
    return `<dt>${htmlEscape(label)}</dt><dd>${htmlEscape(rendered)}</dd>`;
  }).join('')}</dl>`;
}

function renderImage(image) {
  const filename = htmlEscape(image.filename || image.id);
  const side = htmlEscape(image.side);
  const type = htmlEscape(image.type);
  if (image.available && image.data_uri) {
    return `<figure><img src="${htmlEscape(image.data_uri)}" alt="${side}: ${filename}">`
      + `<figcaption>${side} · ${filename} · ${type}</figcaption></figure>`;
  }
  return `<p class="missing">Nicht eingebettet: ${side} · ${filename} · ${type}</p>`;
}

function renderCard(index, card) {
  const identity = card.identity;
  const identityRows = [
    ['Karten-ID', identity.id],
    ['Deck-ID', identity.deck_id],
    ['Deckname', identity.deck_name],
    ['Kategorie-ID', identity.category_id],
    ['Kategorie', identity.category_name],
    ['Unterkategorie-ID', identity.subcategory_id],
    ['Unterkategorie', identity.subcategory_name],
  ];
  const learningRows = [...Object.entries(card.learning_state), ...Object.entries(card.timestamps)];
  return `<section class="card" data-card-id="${htmlEscape(identity.id)}">`
    + `<h2>Karte ${index}</h2>`
    + definitionList(identityRows)
    + '<h3>Frage</h3><p>'
    + htmlEscape(card.text.question)
    + '</p><h3>Antwort</h3><p>'
    + htmlEscape(card.text.answer)
    + '</p><h3>Bilder</h3><div class="images">'
    + card.images.map(renderImage).join('')
    + '</div><h3>Vollständiger Lernstand</h3>'
    + definitionList(learningRows)
    + '</section>';
}

function safeJson(payload) {
  // json.dumps(payload, ensure_ascii=False, separators=(",", ":")) with the
  // same escapes Python applies before embedding it in a <script>.
  return JSON.stringify(payload)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function renderDocument(payload) {
  const ruleItems = TUTOR_RULES.map((rule) => `<li>${htmlEscape(rule)}</li>`).join('\n');
  const levelRows = ADAPTIVE_LEVELS.map((level) => `<tr><th scope="row">${htmlEscape(level.levels)}</th><td>${htmlEscape(level.mode)}</td></tr>`).join('\n');
  const cardSections = payload.cards.map((card, index) => renderCard(index + 1, card)).join('\n');
  const generatedAt = htmlEscape(String(payload.generated_at));
  const title = htmlEscape(String(payload.title));
  const startText = htmlEscape(String(payload.start_text));
  const writeback = htmlEscape(String(payload.writeback_policy));
  const selectionText = htmlEscape(JSON.stringify(payload.selection, null, 2) ?? 'null');
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 72rem; margin: 0 auto; padding: 2rem; line-height: 1.5; }
    header, section { border: 1px solid #8886; border-radius: .75rem; padding: 1rem 1.25rem; margin: 1rem 0; }
    h1, h2, h3 { line-height: 1.2; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #8886; padding: .5rem; text-align: left; vertical-align: top; }
    dl { display: grid; grid-template-columns: minmax(10rem, 1fr) 3fr; gap: .35rem 1rem; }
    dt { font-weight: 700; } dd { margin: 0; overflow-wrap: anywhere; }
    .images { display: flex; flex-wrap: wrap; gap: 1rem; }
    figure { margin: 0; max-width: 30rem; } img { display: block; max-width: 100%; max-height: 24rem; object-fit: contain; }
    .missing { border: 1px dashed #b66; padding: .5rem; }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <p>Erstellt: <time>${generatedAt}</time></p>
  <p>Selbstenthaltender UTF-8-Export ohne API- oder Netzwerkaufrufe.</p>
  <h2>Starttext</h2><p id="start-text">${startText}</p>
  <h2>Auswahl</h2><pre id="selection">${selectionText}</pre>
  <p id="writeback-policy"><strong>Keine automatische Rückschreibung:</strong> ${writeback}</p>
</header>
<section id="tutor-rules">
  <h2>16 verbindliche Tutorregeln</h2>
  <ol>${ruleItems}</ol>
</section>
<section id="adaptive-levels">
  <h2>Adaptive Levelbereiche</h2>
  <table><thead><tr><th>Level</th><th>Aufgabenmodus</th></tr></thead><tbody>${levelRows}</tbody></table>
</section>
<main id="cards">${cardSections}</main>
<script id="flashcard-ai-test-data" type="application/json">${safeJson(payload)}</script>
</body>
</html>
`;
}

/** Build the export: `{fileName, html, cardCount}`. */
export function exportTest(cards, { media, deckName = () => '', title = 'FlashCard AI Test', selection = null, now = Date.now() } = {}) {
  if (!cards.length) throw new Error('Mindestens eine Karte ist für einen KI-Test nötig.');
  const records = cards.map((card) => cardRecord(card, media, deckName(card.deck_id)));
  const payload = {
    format: 'flashcard-ai-test',
    version: 1,
    title,
    selection,
    generated_at: localIso(now),
    start_text: START_TEXT,
    writeback_policy: WRITEBACK_POLICY,
    tutor_rules: [...TUTOR_RULES],
    adaptive_levels: ADAPTIVE_LEVELS.map((item) => ({ ...item })),
    cards: records,
  };
  return { fileName: exportFileName(now), html: renderDocument(payload), cardCount: records.length };
}
