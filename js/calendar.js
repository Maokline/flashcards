// Today metrics refresh at local midnight even without a changed snapshot.
import { emit } from './bus.js';

const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export function startCalendarWatch({ now = () => new Date(), notify = () => emit('data-changed', { source: 'calendar' }), intervalMs = 60000 } = {}) {
  let day = dayKey(now());
  const check = () => {
    if (document.visibilityState !== 'visible') return;
    const current = dayKey(now());
    if (current !== day) { day = current; notify(); }
  };
  const timer = setInterval(check, intervalMs);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
  };
}
