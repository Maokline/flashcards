// Application-wide events: data-changed, status, pending-changed,
// review-synced, auth-required.

const target = new EventTarget();

export function emit(name, detail = {}) {
  target.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, handler) {
  const listener = (event) => handler(event.detail);
  target.addEventListener(name, listener);
  return () => target.removeEventListener(name, listener);
}
