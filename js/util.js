// Small DOM and formatting helpers.  User content is only ever inserted as
// text nodes – never as HTML – so card text cannot inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = String(value);
    else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) element.addEventListener(event, handler);
    } else if (key === 'dataset') {
      for (const [name, data] of Object.entries(value)) element.dataset[name] = String(data);
    } else if (key === 'vars') {
      // Dynamic values only through the CSSOM (allowed by the CSP).
      for (const [name, data] of Object.entries(value)) element.style.setProperty(name, String(data));
    } else if (key === 'value') element.value = value;
    else if (key === 'checked') element.checked = Boolean(value);
    else if (key === 'disabled') element.disabled = Boolean(value);
    else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
  return element;
}

export function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function uuid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function plural(count, one, many) {
  return `${count.toLocaleString('de-DE')} ${count === 1 ? one : many}`;
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function formatDate(value) {
  if (!value) return '–';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatDateTime(value) {
  if (!value) return '–';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Human wording for a stored due date (display only – the date itself is
// always computed by the server's LearningEngine).
export function dueLabel(card) {
  if (card.mastered) return 'Gekonnt';
  if (!card.next_review) return 'Sofort';
  const due = new Date(card.next_review);
  const days = Math.round((startOfDay(due) - startOfDay(new Date())) / DAY);
  if (days <= 0) {
    if (days >= 0) return 'Heute fällig';
    return days === -1 ? 'Seit gestern fällig' : `Seit ${-days} Tagen fällig`;
  }
  if (days === 1) return 'Morgen';
  if (days < 7) return `In ${days} Tagen`;
  return formatDate(card.next_review);
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours} h ${minutes} min`;
  if (minutes) return `${minutes} min`;
  return `${total} s`;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export function percent(value) {
  return `${Math.round(Number(value) || 0)} %`;
}

export function pointsText(delta) {
  const value = Number(delta) || 0;
  if (value > 0) return `+${value} Punkte`;
  if (value < 0) return `−${Math.abs(value)} Punkte`;
  return '±0 Punkte';
}

export function deviceGuess() {
  const agent = navigator.userAgent || '';
  if (/iPhone/i.test(agent)) return 'iPhone';
  if (/iPad/i.test(agent)) return 'iPad';
  if (/Android/i.test(agent)) return /Mobile/i.test(agent) ? 'Android-Smartphone' : 'Android-Tablet';
  return 'Browser';
}

export function tzOffset() {
  return -new Date().getTimezoneOffset();
}

export function greeting() {
  const hour = new Date().getHours();
  if (hour < 11) return 'Guten Morgen';
  if (hour < 18) return 'Guten Tag';
  return 'Guten Abend';
}

export function todayText() {
  return new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function softColor(hex, alpha = 0.16) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return 'rgba(63, 100, 223, 0.16)';
  const value = parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
