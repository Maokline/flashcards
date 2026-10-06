// Reusable UI pieces: bottom sheets, confirmations, toasts and form controls.

import { clear, h, icon, uuid } from './util.js';

// -- on-screen keyboard -------------------------------------------------------
// The visual viewport shrinks while the keyboard is open.  The difference is
// published as --keyboard so sticky action bars stay above the keyboard, and
// `keyboard-open` hides the bottom navigation meanwhile.
if (window.visualViewport) {
  const root = document.documentElement;
  const update = () => {
    const viewport = window.visualViewport;
    const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    const open = covered > 120;
    root.style.setProperty('--keyboard', `${open ? Math.round(covered) : 0}px`);
    root.classList.toggle('keyboard-open', open);
  };
  window.visualViewport.addEventListener('resize', update);
  window.visualViewport.addEventListener('scroll', update);
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const openSheets = [];

document.addEventListener('keydown', (event) => {
  const top = openSheets[openSheets.length - 1];
  if (!top) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    top.close();
  } else if (event.key === 'Tab') {
    const items = [...top.element.querySelectorAll(FOCUSABLE)].filter((item) => item.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

export function sheetIsOpen() {
  return openSheets.length > 0;
}

export function openSheet({ title, body = [], actions = [], stacked = false, onClose, className = '' } = {}) {
  const titleId = `sheet-${uuid()}`;
  const previousFocus = document.activeElement;
  const bodyEl = h('div', { class: 'sheet-body' }, body);
  const actionsEl = actions.length ? h('div', { class: `sheet-actions${stacked ? ' is-stacked' : ''}` }) : null;
  const grip = h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }, h('div', { class: 'sheet-handle' }));
  const header = h('div', { class: 'sheet-header' },
    h('h2', { class: 'sheet-title', id: titleId, text: title }),
    h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Schließen', on: { click: () => api.close() } }, icon('x')));
  const panel = h('div', { class: `sheet ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    grip,
    header,
    bodyEl,
    actionsEl);
  // Drag the handle or header down to dismiss (like a native bottom sheet).
  let dragStart = null;
  let dragDistance = 0;
  const onDown = (event) => {
    if (event.target.closest('button')) return;
    dragStart = event.clientY;
    dragDistance = 0;
    panel.classList.add('is-dragging');
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onMove = (event) => {
    if (dragStart === null) return;
    dragDistance = Math.max(0, event.clientY - dragStart);
    panel.style.setProperty('--drag', `${dragDistance}px`);
  };
  const onUp = () => {
    if (dragStart === null) return;
    dragStart = null;
    panel.classList.remove('is-dragging');
    if (dragDistance > 110) {
      api.close();
      return;
    }
    panel.classList.add('is-settling');
    panel.style.removeProperty('--drag');
    setTimeout(() => panel.classList.remove('is-settling'), 240);
  };
  for (const handle of [grip, header]) {
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }
  // Sheets live outside #app; they keep the colour of the current area.
  const area = document.getElementById('app')?.dataset.area;
  const backdrop = h('div', { class: 'backdrop', dataset: area ? { area } : undefined }, panel);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) api.close();
  });

  let closed = false;
  const api = {
    element: panel,
    body: bodyEl,
    close(reason = 'dismiss') {
      if (closed) return;
      closed = true;
      backdrop.remove();
      const index = openSheets.indexOf(api);
      if (index >= 0) openSheets.splice(index, 1);
      if (!openSheets.length) document.body.classList.remove('is-locked');
      if (previousFocus && typeof previousFocus.focus === 'function' && document.contains(previousFocus)) previousFocus.focus();
      if (onClose) onClose(reason);
    },
    setActions(list) {
      if (!actionsEl) return;
      clear(actionsEl);
      for (const action of list) actionsEl.append(actionButton(action, api));
    },
    setBusy(busy) {
      for (const button of panel.querySelectorAll('.sheet-actions .btn')) button.disabled = busy;
    },
  };
  if (actionsEl) for (const action of actions) actionsEl.append(actionButton(action, api));
  document.body.append(backdrop);
  document.body.classList.add('is-locked');
  openSheets.push(api);
  requestAnimationFrame(() => {
    const target = panel.querySelector('[autofocus]') || panel.querySelector('.sheet-body ' + FOCUSABLE) || panel.querySelector(FOCUSABLE);
    if (target) target.focus({ preventScroll: true });
  });
  return api;
}

function actionButton(action, sheet) {
  return h('button', {
    class: `btn ${action.variant || 'btn-secondary'} btn-lg`,
    type: 'button',
    id: action.id,
    disabled: action.disabled,
    on: { click: () => action.onClick && action.onClick(sheet) },
  }, action.icon ? icon(action.icon) : null, action.label);
}

export function confirmDialog({ title, text, confirm = 'Bestätigen', cancel = 'Abbrechen', danger = false, icon: iconName } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const sheet = openSheet({
      title,
      body: [h('p', { class: 'muted', text })],
      actions: [
        { label: cancel, variant: 'btn-secondary', id: 'confirm-cancel', onClick: (s) => { answered = true; resolve(false); s.close('cancel'); } },
        {
          label: confirm,
          icon: iconName,
          variant: danger ? 'btn-danger' : 'btn-primary',
          id: 'confirm-ok',
          onClick: (s) => { answered = true; resolve(true); s.close('confirm'); },
        },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
    return sheet;
  });
}

export function toast(message, { tone = '', action = null, duration = 3600, key = '' } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  // A toast with the same key replaces the older one (e.g. device switches).
  if (key) for (const old of [...host.children]) if (old.dataset.key === key) old.remove();
  const element = h('div', { class: `toast${tone ? ` is-${tone}` : ''}`, dataset: key ? { key } : {} }, h('span', { text: message }));
  if (action) {
    element.append(h('button', {
      class: 'toast-action',
      type: 'button',
      text: action.label,
      on: { click: () => { action.onClick(); element.remove(); } },
    }));
  }
  host.append(element);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => element.remove(), action ? Math.max(duration, 6000) : duration);
}

// -- form controls -----------------------------------------------------------
export function field(labelText, control, hint) {
  const id = control.id || `f-${uuid()}`;
  control.id = id;
  return h('div', { class: 'field' },
    h('label', { class: 'field-label', for: id, text: labelText }),
    control,
    hint ? h('p', { class: 'field-hint', text: hint }) : null);
}

export function select(options, value, props = {}) {
  const element = h('select', { class: 'select', ...props });
  for (const option of options) {
    element.append(h('option', { value: option.value, text: option.label }));
  }
  element.value = value ?? '';
  return element;
}

export function toggle(labelText, checked, props = {}) {
  const input = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked, ...props });
  const element = h('label', { class: 'toggle' }, h('span', { class: 'toggle-text', text: labelText }), input);
  return { element, input };
}

export function choices(items, current, onChange, label) {
  const group = h('div', { class: 'choices', role: 'group', 'aria-label': label });
  const buttons = items.map((item) => h('button', {
    class: 'choice',
    type: 'button',
    'aria-pressed': String(item.value === current),
    dataset: { value: item.value },
    text: item.label,
    on: {
      click: () => {
        for (const button of buttons) button.setAttribute('aria-pressed', String(button === buttonFor(item)));
        onChange(item.value);
      },
    },
  }));
  const buttonFor = (item) => buttons[items.indexOf(item)];
  group.append(...buttons);
  return group;
}

export function segmented(items, current, onChange, label, { fit = false } = {}) {
  const group = h('div', { class: `segmented${fit ? ' segmented-fit' : ''}`, role: 'group', 'aria-label': label });
  const buttons = items.map((item) => h('button', {
    class: 'segment',
    type: 'button',
    'aria-pressed': String(item.value === current),
    dataset: { value: item.value },
    text: item.label,
  }));
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => {
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === button));
      onChange(items[index].value);
    });
  });
  group.append(...buttons);
  return group;
}

export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' },
    h('div', { class: 'stat-icon tone-slate' }, icon(iconName)),
    h('p', { class: 'empty-title', text: title }),
    text ? h('p', { text }) : null,
    action || null);
}

export function sectionTitle(text, extra) {
  return h('h2', { class: 'section-title' }, h('span', { text }), extra || null);
}

export function levelBadge(card) {
  if (card.mastered) return h('span', { class: 'level level-mastered', text: 'Gekonnt' });
  const level = Math.min(10, Math.max(1, Number(card.level) || 1));
  return h('span', { class: 'level', vars: { '--lv': `var(--lv-${level})` }, text: `L${level}` });
}

const savedChildren = new WeakMap();

export function busyButton(button, busy, busyText = 'Bitte warten …') {
  if (busy) {
    if (!savedChildren.has(button)) savedChildren.set(button, [...button.childNodes]);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    clear(button);
    button.append(h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), busyText);
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    const children = savedChildren.get(button);
    if (children) {
      clear(button);
      button.append(...children);
      savedChildren.delete(button);
    }
  }
}
