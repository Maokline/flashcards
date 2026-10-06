// Timestamps exactly as the desktop (Python) writes them.
//
// Python's `datetime.isoformat()` of an aware UTC value:
//   2026-10-05T07:12:03+00:00          (no fraction when microseconds == 0)
//   2026-10-05T07:12:03.120000+00:00   (six digits otherwise)
// Both apps read and write this format, so stored data looks the same no
// matter which device wrote it.

const pad = (value, width = 2) => String(value).padStart(width, '0');

export function toMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  // Keep microseconds out of Date parsing (JavaScript knows milliseconds).
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!match) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const fraction = (match[2] || '').slice(0, 3).padEnd(3, '0');
  const zone = match[3] || '+00:00';
  const parsed = Date.parse(`${match[1]}.${fraction}${zone === 'Z' ? 'Z' : zone}`);
  return Number.isNaN(parsed) ? null : parsed;
}

/** UTC text like Python's `isoformat()` of an aware UTC datetime. */
export function utcIso(value = Date.now()) {
  const millis = value instanceof Date ? value.getTime() : Number(value);
  const date = new Date(millis);
  const base = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  const ms = date.getUTCMilliseconds();
  return ms ? `${base}.${pad(ms, 3)}000+00:00` : `${base}+00:00`;
}

/** Local time with offset, like Python's `datetime.now().astimezone().isoformat()`. */
export function localIso(value = Date.now()) {
  const date = new Date(value instanceof Date ? value.getTime() : Number(value));
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const ms = date.getMilliseconds();
  return `${base}${ms ? `.${pad(ms, 3)}000` : ''}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * What Python's `datetime_to_text(datetime_from_text(text))` returns: UTC text
 * with microseconds preserved (JavaScript dates only know milliseconds).
 */
export function pythonUtc(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|\+00:00)$/.exec(String(value).trim());
  if (match) {
    const micro = (match[2] || '').slice(0, 6).padEnd(6, '0');
    return /^0*$/.test(micro) ? `${match[1]}+00:00` : `${match[1]}.${micro}+00:00`;
  }
  const millis = toMillis(value);
  return millis === null ? null : utcIso(millis);
}

export function normalizeTimestamp(value) {
  const millis = toMillis(value);
  return millis === null ? null : utcIso(millis);
}

export function addDays(millis, days) {
  return millis + days * 24 * 60 * 60 * 1000;
}

export function later(first, second) {
  const a = toMillis(first);
  const b = toMillis(second);
  if (a === null) return second;
  if (b === null) return first;
  return a >= b ? first : second;
}
