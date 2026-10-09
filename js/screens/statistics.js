// Advanced statistics. Aggregation happens once per filter/data change, never
// while scrolling. Problem/deck lists render in bounded pages.
import { api, errorMessage, NetworkError } from '../api.js';
import { advanced } from '../core/advanced_statistics.js';
import * as store from '../store.js';
import { readFocus, resolveFocus } from '../learning_focus.js';
import { emptyState, openSheet, sectionTitle, segmented, toast } from '../ui.js';
import { clear, formatDate, formatDuration, h, icon, percent, plural, softColor, tzOffset } from '../util.js';
import { openLearnSetup } from './learn.js';
import { openFocusDeckPicker, stageProgressCard } from './focus_ui.js';

const TABS = [
  { value: 'overview', label: 'Übersicht' }, { value: 'progress', label: 'Fortschritt' },
  { value: 'activity', label: 'Aktivität' }, { value: 'decks', label: 'Deckvergleich' },
];
const PERIODS = [{ value: '7', label: '7 Tage' }, { value: '30', label: '30 Tage' }, { value: '90', label: '90 Tage' }, { value: 'all', label: 'Gesamt' }];
const PAGE_SIZE = 20;
let pendingOpen = null;

/** Dashboard drilldowns enter the chosen tab without a second navigation route. */
export function openStatistics(navigate, options = {}) {
  pendingOpen = { ...options };
  navigate('#/mehr/statistik');
}

export async function fetchAdvanced({ deckIds, days = '30', categoryId = '' }) {
  const query = new URLSearchParams({ deck_ids: deckIds.join(','), days: String(days), tz_offset: String(tzOffset()) });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone) query.set('tz_name', zone);
  if (categoryId) query.set('category_id', categoryId);
  try { return await api.get(`/api/statistics/advanced?${query}`); }
  catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    return { ...advanced({ cards: store.cards(), decks: store.decks(), categories: store.categoriesOf(null), events: [...store.state.events.values()], deckIds, days: days === 'all' ? null : Number(days), categoryId: categoryId || null }), offline: true };
  }
}

function tile(label, value, hint, iconName, tone, id) {
  return h('section', { class: 'stat', id },
    h('span', { class: 'stat-head' }, h('span', { class: 'stat-label', text: label }), h('span', { class: `stat-icon ${tone}` }, icon(iconName, 'icon-sm'))),
    h('span', { class: 'stat-value', text: value }), h('span', { class: 'stat-hint', text: hint || '' }));
}

function learnGroup(ids, label, navigate) {
  if (!ids.length) { toast('Keine Karten in dieser Auswahl.'); return; }
  const decks = new Set(ids.map((id) => store.card(id)?.deck_id).filter(Boolean));
  openLearnSetup({ deckIds: store.decks().filter((deck) => decks.has(deck.id)).map((deck) => deck.id), cardIds: [...ids], dueOnly: false, limit: 'all', label }, navigate);
}

function groupRow(item, { label, maximum, cumulative = false, navigate }) {
  const share = cumulative ? Number(item.percent) || 0 : maximum ? (item.count / maximum) * 100 : 0;
  const tone = item.level === 'mastered' ? 'var(--mastered)' : `var(--lv-${item.level})`;
  return h('button', { class: 'distribution-row', type: 'button', dataset: { level: item.level }, disabled: !item.count,
    'aria-label': `${label}: ${item.count} Karten${cumulative ? `, ${Math.round(share)} Prozent` : ''}. Diese Karten lernen`,
    on: { click: () => learnGroup(item.card_ids || [], label, navigate) } },
  h('span', { class: 'distribution-top' }, h('span', { text: label }), h('span', { class: 'distribution-value', text: cumulative ? `${Math.round(share)} %` : String(item.count) })),
  h('span', { class: 'progress', 'aria-hidden': 'true' }, h('span', { class: 'progress-bar', vars: { '--value': `${Math.max(0, Math.min(100, share))}%`, '--bar-color': tone } })));
}

function openPeriodSheet(value, onPick) {
  let sheet;
  const rows = PERIODS.map((item) => h('button', { class: 'statistics-option', type: 'button', dataset: { period: item.value }, 'aria-pressed': String(item.value === value),
    on: { click: () => { sheet.close('pick'); onPick(item.value); } } }, h('span', { text: item.label }), item.value === value ? icon('check') : null));
  sheet = openSheet({ title: 'Zeitraum', className: 'sheet-picker', body: h('div', { class: 'stack', id: 'statistics-period-options' }, rows) });
}

function openCategorySheet(deckIds, value, onPick) {
  const selected = new Set(deckIds);
  const items = store.categoriesOf(null).filter((category) => selected.has(category.deck_id));
  let sheet;
  const pick = (id) => { sheet.close('pick'); onPick(id); };
  sheet = openSheet({ title: 'Kategorie', className: 'sheet-picker', body: h('div', { class: 'stack', id: 'statistics-category-options' },
    h('button', { class: 'statistics-option', type: 'button', dataset: { category: '' }, 'aria-pressed': String(!value), on: { click: () => pick('') } }, 'Alle Kategorien', !value ? icon('check') : null),
    items.map((category) => h('button', { class: 'statistics-option', type: 'button', dataset: { category: category.id }, 'aria-pressed': String(value === category.id), on: { click: () => pick(category.id) } },
      h('span', { class: 'statistics-option-text' }, h('span', { text: category.name }), h('span', { class: 'tiny muted', text: store.deck(category.deck_id)?.name || '' })),
      category.id === value ? icon('check') : null))) });
}

function activityBars(items, field, label, formatter) {
  // At most 30 columns. Longer periods are grouped into equal-sized ranges;
  // totals stay faithful to the selected period and chart DOM stays bounded.
  const chunk = Math.max(1, Math.ceil(items.length / 30));
  const groups = [];
  for (let index = 0; index < items.length; index += chunk) {
    const block = items.slice(index, index + chunk);
    groups.push({ first: block[0].day, last: block[block.length - 1].day, value: block.reduce((sum, item) => sum + (Number(item[field]) || 0), 0) });
  }
  const maximum = Math.max(1, ...groups.map((item) => item.value));
  return h('section', { class: 'card stack statistics-chart' },
    h('h3', { class: 'strong', text: label }),
    groups.length ? h('div', { class: 'statistics-bars', role: 'img', 'aria-label': `${label}: ${groups.map((item) => `${formatDate(item.first)} ${formatter(item.value)}`).join(', ')}` },
      groups.map((item) => h('span', { class: 'statistics-bar-col', title: `${formatDate(item.first)}${item.first !== item.last ? ` – ${formatDate(item.last)}` : ''}: ${formatter(item.value)}` },
        h('span', { class: 'statistics-bar', vars: { '--h': `${Math.max(item.value ? 3 : 0, (item.value / maximum) * 100)}%` } }))))
      : h('p', { class: 'small muted', text: 'Noch keine Bewertungen in diesem Zeitraum.' }),
    groups.length ? h('div', { class: 'distribution-top tiny muted' },
      h('span', { text: formatDate(groups[0].first) }), h('span', { text: formatDate(groups[groups.length - 1].last) })) : null,
    chunk > 1 ? h('p', { class: 'tiny muted', text: `Je Balken bis zu ${chunk} Tage zusammengefasst.` }) : null);
}

function renderProblems(items, navigate) {
  let visible = PAGE_SIZE;
  const list = h('div', { class: 'stack', id: 'statistics-problems' });
  const more = h('button', { class: 'btn btn-secondary btn-block', type: 'button', id: 'statistics-problems-more', on: { click: () => { visible += PAGE_SIZE; draw(); } } }, 'Weitere Karten anzeigen');
  const rows = h('div', { class: 'stack', id: 'statistics-problem-rows' });
  function draw() {
    clear(rows);
    rows.append(...items.slice(0, visible).map((card, index) => h('article', { class: 'card problem-card', dataset: { card: card.card_id } },
      h('div', { class: 'row' }, h('span', { class: 'problem-rank', text: String(index + 1) }),
        h('a', { class: 'problem-question', href: `#/karten/${encodeURIComponent(card.card_id)}`, text: card.question })),
      h('p', { class: 'tiny muted', text: [card.deck_name, card.category_name || 'Ohne Kategorie'].join(' · ') }),
      h('div', { class: 'problem-metrics' },
        h('span', { class: 'chip', text: `Level ${card.level}` }), h('span', { class: 'chip chip-due', text: `${card.total_incorrect_count} Fehler` }),
        h('span', { class: 'chip', text: `${card.accuracy === null || card.accuracy === undefined ? '–' : percent(card.accuracy)} Treffer` }), h('span', { class: card.recovery ? 'chip chip-due' : 'chip', text: `Recovery: ${card.recovery ? 'ja' : 'nein'}` })),
      h('p', { class: 'tiny muted', text: `Problem-Score ${Number(card.score || 0).toFixed(1).replace('.', ',')}` }))));
    more.hidden = visible >= items.length;
  }
  list.append(...[
    h('p', { class: 'small muted', text: 'Die Rangfolge kombiniert Fehlerzahl, jüngste Fehlerquote, Recovery und niedrige Level nach vielen Bewertungen. Der Score verändert keine Lernpunkte.' }),
    h('details', { class: 'statistics-score' }, h('summary', { text: 'Wie wird der Score berechnet?' }), h('p', { class: 'tiny muted', text: '2 × Fehlerzahl + 40 × Fehlerquote der letzten 10 Antworten + 15 bei Recovery + min(Bewertungen, 20) × (10 − Level) / 10. Ohne Antwortverlauf ist die Fehlerquote 0; die Trefferquote bleibt unbekannt. Als Bewertungszahl gilt das Maximum aus vorhandenen Bewertungen und Verlaufslänge. Bei Gleichstand entscheidet die Karten-ID. Gekonnte Karten und Karten ohne Fehler oder Recovery werden ausgelassen.' })),
    items.length ? h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', id: 'statistics-problems-learn', on: { click: () => learnGroup(items.map((card) => card.card_id), 'Problemkarten', navigate) } }, icon('play'), 'Diese Karten lernen') : null,
    items.length ? rows : emptyState('check', 'Keine Problemkarten', 'Für diese Auswahl gibt es keine auffälligen Karten.'), more,
  ].filter((node) => node !== null && node !== undefined));
  draw();
  return list;
}

export function renderStatistics(view, ctx) {
  const entry = pendingOpen || {};
  pendingOpen = null;
  const values = { deckIds: [], days: entry.days || '30', categoryId: '', tab: entry.tab || 'overview', todayOnly: Boolean(entry.todayOnly) };
  let alive = true;
  let ready = false;
  let generation = 0;
  let result = null;
  let focusIds = [];
  let deckOverride = false;
  const filters = h('div', { class: 'statistics-filters', id: 'statistics-filters', role: 'group', 'aria-label': 'Statistikfilter' });
  const body = h('div', { class: 'stack-lg', id: 'statistics-body', 'aria-live': 'polite' });
  const tabs = segmented(TABS, values.tab, (tab) => { values.tab = tab; values.todayOnly = false; draw(); }, 'Statistikansicht');
  tabs.classList.add('statistics-tabs');
  tabs.id = 'statistics-tabs';
  const focusReset = h('button', { class: 'btn btn-soft statistics-focus-reset', type: 'button', id: 'statistics-focus-reset', on: { click: () => {
    deckOverride = false; values.deckIds = [...focusIds]; values.categoryId = ''; values.todayOnly = false; load();
  } } }, icon('layers', 'icon-sm'), 'Aus Lernfokus übernehmen');
  view.append(h('div', { class: 'stack-lg', id: 'statistics' }, tabs, filters, focusReset, body));
  body.append(h('section', { class: 'card row', role: 'status' }, h('span', { class: 'spinner spinner-sm' }), 'Statistik wird geladen …'));

  function drawFilters() {
    clear(filters);
    const period = PERIODS.find((item) => item.value === values.days)?.label || '30 Tage';
    const category = store.state.categories.get(values.categoryId);
    filters.append(
      h('button', { class: 'statistics-filter', type: 'button', id: 'statistics-period', 'aria-haspopup': 'dialog', on: { click: () => openPeriodSheet(values.days, (days) => { values.days = days; values.todayOnly = false; load(); }) } }, icon('clock', 'icon-sm'), h('span', { text: period }), icon('chevron-down', 'icon-sm')),
      h('button', { class: 'statistics-filter', type: 'button', id: 'statistics-decks', 'aria-haspopup': 'dialog', on: { click: () => openFocusDeckPicker({ selected: values.deckIds, title: 'Statistik: Decks', idPrefix: 'statistics-deck', onApply: (ids) => {
        deckOverride = true; values.deckIds = ids;
        if (values.categoryId && !ids.includes(store.state.categories.get(values.categoryId)?.deck_id)) values.categoryId = '';
        return load();
      } }) } }, icon('layers', 'icon-sm'), h('span', { text: plural(values.deckIds.length, 'Deck', 'Decks') }), icon('chevron-down', 'icon-sm')),
      h('button', { class: 'statistics-filter', type: 'button', id: 'statistics-category', 'aria-haspopup': 'dialog', on: { click: () => openCategorySheet(values.deckIds, values.categoryId, (id) => { values.categoryId = id; load(); }) } },
        h('span', { text: category ? `${category.name} · ${store.deck(category.deck_id)?.name || ''}` : 'Alle Kategorien' }), icon('chevron-down', 'icon-sm')));
  }

  function draw() {
    if (!alive || !result) return;
    clear(body);
    const overview = result.overview || {};
    const stage = result.stage || {};
    const total = Number(overview.total_cards) || 0;
    if (result.offline) body.append(h('p', { class: 'banner', text: 'Offline: Karten und Fortschritt aus der lokalen Kopie. Die Aktivität kann ohne Serververbindung unvollständig sein.' }));
    if (!values.deckIds.length) body.append(h('p', { class: 'banner is-info', text: 'Keine Decks ausgewählt. Wähle Decks oder übernimm deinen Lernfokus.' }));
    if (values.tab === 'overview') {
      body.append(h('div', { class: 'stats-grid' },
        tile('Karten', String(total), plural(values.deckIds.length, 'Deck', 'Decks'), 'cards', 'tone-blue', 'st-total'),
        tile('Heute fällig', String(overview.due_cards || 0), 'in deiner Auswahl', 'clock', 'tone-apricot', 'st-due'),
        tile('Gekonnt', String(overview.mastered_cards || 0), `von ${total} Karten`, 'star', 'tone-gold', 'st-mastered'),
        tile('Heute gelernt', String(overview.cards_learned_today || 0), plural(overview.reviews_today || 0, 'Bewertung', 'Bewertungen'), 'check', 'tone-learn', 'st-learned'),
        tile('Erfolgsquote', percent(overview.accuracy_total), 'im gewählten Zeitraum', 'target', 'tone-blue', 'st-accuracy'),
        tile('Lernzeit', formatDuration(overview.learning_seconds_total), 'im gewählten Zeitraum', 'clock', 'tone-slate', 'st-time')),
      stageProgressCard(stage, { id: 'statistics-stage', context: 'Auswahl', onClick: () => { values.tab = 'progress'; tabs.querySelector('[data-value="progress"]').click(); } }),
      sectionTitle('Problemkarten'), renderProblems(result.problems || [], ctx.navigate));
    } else if (values.tab === 'progress') {
      body.append(stageProgressCard(stage, { id: 'statistics-stage', context: 'Auswahl' }),
        sectionTitle('Levelverteilung'), h('section', { class: 'card distribution', id: 'statistics-levels' },
          (result.levels || []).map((item) => groupRow(item, { label: item.level === 'mastered' ? 'Gekonnt' : `Level ${item.level}`, maximum: total, navigate: ctx.navigate }))),
        sectionTitle('Mindest-Level'), h('p', { class: 'small muted', text: 'Der Anteil der Karten, die diese Stufe bereits erreicht haben. Gekonnte Karten zählen zu jedem Mindest-Level.' }),
        h('section', { class: 'card distribution', id: 'statistics-cumulative' },
          (result.cumulative || []).map((item) => groupRow(item, { label: item.level === 'mastered' ? 'Gekonnt' : `Mindestens Level ${item.level}`, cumulative: true, navigate: ctx.navigate }))),
        sectionTitle('Problemkarten'), renderProblems(result.problems || [], ctx.navigate));
    } else if (values.tab === 'activity') {
      let activity = result.activity || [];
      if (values.todayOnly) {
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        activity = activity.filter((item) => item.day === today);
        body.append(h('p', { class: 'banner is-info', text: 'Heute gelernt · Aktivität des heutigen Tages' }));
      }
      const correct = activity.reduce((sum, item) => sum + (Number(item.correct) || 0), 0);
      const incorrect = activity.reduce((sum, item) => sum + (Number(item.incorrect) || Math.max(0, (item.reviews || 0) - (item.correct || 0))), 0);
      body.append(h('div', { class: 'stats-grid' },
        tile('Richtig', String(correct), 'Antworten', 'check', 'tone-learn', 'activity-correct'),
        tile('Falsch', String(incorrect), 'Antworten', 'target', 'tone-apricot', 'activity-incorrect'),
        tile('Erfolgsquote', percent(correct + incorrect ? correct / (correct + incorrect) * 100 : 0), 'im dargestellten Zeitraum', 'chart', 'tone-blue', 'activity-accuracy')),
      activityBars(activity, 'cards', 'Gelernte Karten pro Tag', (value) => plural(value, 'Karte', 'Karten')),
      activityBars(activity, 'duration_seconds', 'Lernzeit pro Tag', formatDuration));
    } else {
      const decks = result.decks || [];
      let count = PAGE_SIZE;
      const list = h('div', { class: 'stack', id: 'statistics-deck-comparison' });
      const more = h('button', { class: 'btn btn-secondary btn-block', type: 'button', id: 'statistics-decks-more', text: 'Weitere Decks anzeigen' });
      const drawDecks = () => {
        clear(list);
        list.append(...decks.slice(0, count).map((deck) => h('section', { class: 'card stack comparison-card', dataset: { deck: deck.deck_id }, vars: { '--deck-color': deck.color || '#3F64DF', '--deck-soft': softColor(deck.color || '#3F64DF', 0.14) } },
          h('div', { class: 'row' }, h('span', { class: 'deck-icon' }, icon('layers')), h('div', { class: 'deck-main' },
            h('h3', { class: 'deck-name', text: deck.deck_name }), h('p', { class: 'deck-meta', text: `${plural(deck.total_cards, 'Karte', 'Karten')} · Ø Level ${Number(deck.average_level || 0).toFixed(1).replace('.', ',')}` }))),
          h('div', { class: 'row-wrap' }, h('span', { class: 'chip chip-due', text: `${deck.due_cards} fällig` }), h('span', { class: 'chip chip-mastered', text: `${deck.mastered_cards} gekonnt` }), h('span', { class: 'chip', text: `${percent(deck.accuracy)} Treffer` })),
          h('p', { class: 'small muted', text: `Lernzeit ${formatDuration(deck.learning_seconds)} · im gewählten Zeitraum` }),
          h('button', { class: 'btn btn-soft btn-block', type: 'button', disabled: !deck.total_cards, on: { click: () => learnGroup(deck.card_ids || [], deck.deck_name, ctx.navigate) } }, icon('play', 'icon-sm'), 'Diese Karten lernen'))));
        more.hidden = count >= decks.length;
      };
      more.addEventListener('click', () => { count += PAGE_SIZE; drawDecks(); });
      drawDecks();
      body.append(decks.length ? list : emptyState('layers', 'Keine Decks ausgewählt', 'Über den Deckfilter kannst du deinen Vergleich zusammenstellen.'), more);
    }
  }

  async function load() {
    if (!ready || !alive) return;
    const request = ++generation;
    drawFilters();
    body.setAttribute('aria-busy', 'true');
    try {
      const next = await fetchAdvanced(values);
      if (!alive || request !== generation) return;
      result = next; draw();
    } catch (error) {
      if (!alive || request !== generation) return;
      clear(body); body.append(h('p', { class: 'banner', text: errorMessage(error) }),
        h('button', { class: 'btn btn-secondary btn-block', type: 'button', on: { click: load } }, icon('refresh'), 'Erneut laden'));
    } finally { if (alive && request === generation) body.removeAttribute('aria-busy'); }
  }
  async function initialize() {
    try {
      const focus = await readFocus();
      if (!alive) return;
      focusIds = resolveFocus(focus, store.decks());
      values.deckIds = [...focusIds]; ready = true; await load();
    } catch (error) { if (alive) { clear(body); body.append(h('p', { class: 'banner', text: errorMessage(error) })); } }
  }
  initialize();
  return { cleanup: () => { alive = false; generation += 1; }, onData: async () => {
    if (!ready || !alive) return;
    try {
      focusIds = resolveFocus(await readFocus(), store.decks());
      if (!deckOverride) {
        values.deckIds = [...focusIds];
        if (values.categoryId && !focusIds.includes(store.state.categories.get(values.categoryId)?.deck_id)) values.categoryId = '';
      }
    } catch { /* keep the last valid focus */ }
    load();
  } };
}
