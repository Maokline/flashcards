// Thumbnails, fullscreen lightbox and photo uploads.
//
// Server mode: images are URLs below /api/media (cached by the service worker).
// OneDrive mode: images live in IndexedDB (or are fetched once from OneDrive)
// and are shown through object URLs.

import { api, isLocal } from './api.js';
import * as dataset from './core/dataset.js';
import { rememberMedia } from './store.js';
import { h, icon } from './util.js';

const objectUrls = new Map();

export function mediaUrl(id) {
  return `/api/media/${encodeURIComponent(id)}`;
}

export function cardImages(ids, side) {
  const label = side === 'answer' ? 'Antwortbild' : 'Fragebild';
  return (ids || []).map((id, index) => ({ url: mediaUrl(id), mediaId: id, alt: `${label} ${index + 1}` }));
}

/** Resolve an image item to a displayable URL (object URL in OneDrive mode). */
export async function resolveUrl(item) {
  if (!isLocal()) return item.url;
  const key = item.mediaId ? `m:${item.mediaId}` : item.file ? `f:${item.file}` : null;
  if (!key) return item.url;
  if (objectUrls.has(key)) return objectUrls.get(key);
  const blob = item.mediaId ? await dataset.mediaBlob(item.mediaId) : await dataset.fileBlob(item.file);
  if (!blob) throw new Error('missing');
  const typed = item.file && !blob.type ? new Blob([blob], { type: guessType(item.file) }) : blob;
  const url = URL.createObjectURL(typed);
  objectUrls.set(key, url);
  return url;
}

function guessType(path) {
  const extension = String(path).split('.').pop().toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' }[extension] || 'application/octet-stream';
}

export function imageElement(item, extra = {}) {
  const img = h('img', { alt: item.alt || 'Bild', loading: 'lazy', decoding: 'async', ...extra });
  const fail = () => {
    const fallback = h('span', { class: 'thumb-missing' }, icon('image', 'icon-sm'), h('span', { text: navigator.onLine ? 'Bild nicht verfügbar' : 'Bild offline nicht verfügbar' }));
    img.replaceWith(fallback);
  };
  img.addEventListener('error', fail, { once: true });
  if (!isLocal() || (!item.mediaId && !item.file)) {
    img.src = item.url;
    return img;
  }
  img.classList.add('is-loading');
  resolveUrl(item).then((url) => {
    img.src = url;
    img.classList.remove('is-loading');
  }, fail);
  return img;
}

/** Responsive thumbnail grid; tapping an image opens the lightbox. */
export function thumbGrid(items, { variant = '', label = 'Bilder' } = {}) {
  if (!items || !items.length) return null;
  const single = items.length === 1 && variant === 'lg';
  const grid = h('div', { class: `thumbs ${variant === 'lg' ? 'thumbs-lg thumbs-contain' : ''} ${single ? 'thumbs-single' : ''}`.trim(), role: 'list', 'aria-label': label });
  items.forEach((item, index) => {
    const button = h('button', {
      class: 'thumb',
      type: 'button',
      role: 'listitem',
      'aria-label': `${item.alt || 'Bild'} vergrößern`,
      on: { click: (event) => { event.stopPropagation(); openLightbox(items, index); } },
    }, imageElement(item));
    if (items.length > 1 && index === 0 && variant !== 'lg') button.append(h('span', { class: 'thumb-count', text: `${items.length}` }));
    grid.append(button);
  });
  return grid;
}

/** Fullscreen viewer: swipe between images, pinch or double-tap to zoom, swipe down to close. */
export function openLightbox(items, startIndex = 0) {
  const previousFocus = document.activeElement;
  let index = Math.max(0, Math.min(items.length - 1, startIndex));
  const counter = h('span', { class: 'lightbox-count', 'aria-live': 'polite' });
  const track = h('div', { class: 'lightbox-track' });
  const dots = items.length > 1 ? h('div', { class: 'lightbox-dots', 'aria-hidden': 'true' }, items.map(() => h('span', { class: 'lightbox-dot' }))) : null;
  const slides = items.map((item) => {
    const slide = h('div', { class: 'lightbox-slide' }, imageElement(item, { loading: 'eager', draggable: 'false' }));
    slide.addEventListener('dblclick', () => slide.classList.toggle('is-zoomed'));
    track.append(slide);
    return slide;
  });
  const close = () => {
    overlay.classList.add('is-closing');
    setTimeout(() => overlay.remove(), 160);
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('is-locked');
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
  };
  const closeButton = h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Bild schließen', on: { click: close } }, icon('x'));
  const go = (target, smooth = true) => {
    index = Math.max(0, Math.min(items.length - 1, target));
    track.scrollTo({ left: index * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    update();
  };
  const update = () => {
    counter.textContent = `${index + 1} / ${items.length}`;
    if (prev) prev.disabled = index === 0;
    if (next) next.disabled = index === items.length - 1;
    if (dots) [...dots.children].forEach((dot, position) => dot.classList.toggle('is-active', position === index));
  };
  const prev = items.length > 1 ? h('button', { class: 'lightbox-nav prev', type: 'button', 'aria-label': 'Vorheriges Bild', on: { click: () => go(index - 1) } }, icon('chevron-left')) : null;
  const next = items.length > 1 ? h('button', { class: 'lightbox-nav next', type: 'button', 'aria-label': 'Nächstes Bild', on: { click: () => go(index + 1) } }, icon('chevron-right')) : null;
  let scrollTimer = null;
  track.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const width = track.clientWidth || 1;
      const current = Math.round(track.scrollLeft / width);
      if (current !== index) {
        slides[index]?.classList.remove('is-zoomed');
        index = Math.max(0, Math.min(items.length - 1, current));
        update();
      }
    }, 60);
  }, { passive: true });
  // Swipe down to close (only when the image is not zoomed).
  let startY = null;
  let startX = 0;
  track.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1 || slides[index]?.classList.contains('is-zoomed')) { startY = null; return; }
    startY = event.touches[0].clientY;
    startX = event.touches[0].clientX;
  }, { passive: true });
  track.addEventListener('touchmove', (event) => {
    if (startY === null || event.touches.length !== 1) return;
    const dy = event.touches[0].clientY - startY;
    const dx = Math.abs(event.touches[0].clientX - startX);
    if (dy > 0 && dy > dx * 1.5) {
      overlay.style.setProperty('--drag', `${dy}px`);
      overlay.classList.add('is-dragging');
    }
  }, { passive: true });
  track.addEventListener('touchend', (event) => {
    if (startY === null) return;
    const dy = (event.changedTouches[0] || {}).clientY - startY;
    overlay.classList.remove('is-dragging');
    overlay.style.removeProperty('--drag');
    startY = null;
    if (dy > 120) close();
  });
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); go(index + 1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); go(index - 1); }
  };
  const overlay = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bildansicht' },
    h('div', { class: 'lightbox-top' }, counter, closeButton),
    track,
    prev,
    next,
    dots,
    h('p', { class: 'lightbox-hint', text: items.length > 1 ? 'Wischen für weitere Bilder · Doppeltippen oder zwei Finger zum Zoomen · nach unten wischen zum Schließen' : 'Doppeltippen oder zwei Finger zum Zoomen · nach unten wischen zum Schließen' }));
  document.body.append(overlay);
  document.body.classList.add('is-locked');
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => {
    go(index, false);
    closeButton.focus();
  });
  update();
  return { close, overlay };
}

// -- uploads ---------------------------------------------------------------------
const MAX_EDGE = 2560;
const COMPRESS_ABOVE = 1.5 * 1024 * 1024;
const PASS_THROUGH = new Set(['image/svg+xml', 'image/gif']);

/**
 * Shrink large photos (e.g. a photographed book page) before saving.
 * Re-encoding through a canvas also turns formats other devices cannot show
 * (HEIC from an iPhone, where the browser can decode it) into JPEG.
 */
export async function prepareImage(file) {
  const type = file.type || '';
  if (PASS_THROUGH.has(type)) return file;
  const common = ['image/jpeg', 'image/png', 'image/webp'].includes(type);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  const longest = Math.max(bitmap.width, bitmap.height);
  if (common && file.size <= COMPRESS_ABOVE && longest <= MAX_EDGE) {
    bitmap.close?.();
    return file;
  }
  const scale = Math.min(1, MAX_EDGE / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) return file;
  const base = (file.name || 'foto').replace(/\.[^.]+$/, '') || 'foto';
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
}

export async function uploadImage(file) {
  const prepared = await prepareImage(file);
  const media = await api.upload('/api/media', prepared, prepared.name);
  if (!isLocal()) await rememberMedia(media);
  return media;
}

/**
 * The three ways to add a picture on a phone.  Each opens a hidden file
 * input; `capture` asks the browser for the camera directly.
 */
export function pickImageSources() {
  return [
    { key: 'camera', label: 'Foto aufnehmen', sub: 'Kamera öffnen, z. B. für eine Buchseite', icon: 'camera', accept: 'image/*', capture: 'environment', multiple: false },
    { key: 'library', label: 'Bild auswählen', sub: 'Aus der Fotomediathek', icon: 'image', accept: 'image/*', multiple: true },
    { key: 'file', label: 'Datei auswählen', sub: 'PNG, JPEG, GIF, WebP, BMP oder SVG', icon: 'file', accept: '', multiple: true },
  ];
}

export function fileInput(source, onFiles) {
  const input = h('input', {
    type: 'file',
    class: 'visually-hidden',
    accept: source.accept || undefined,
    capture: source.capture || undefined,
    multiple: source.multiple || undefined,
    dataset: { source: source.key },
    tabindex: '-1',
    'aria-hidden': 'true',
  });
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    input.value = '';
    if (files.length) onFiles(files);
  });
  return input;
}
