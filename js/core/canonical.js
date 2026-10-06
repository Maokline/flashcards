// Canonical JSON, SHA-256 and gzip – the byte conventions of the cloud
// data set (app/cloudsync/layout.py).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** JSON with recursively sorted keys and no whitespace. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = sortKeys(value[key]);
    }
    return result;
  }
  return value;
}

/**
 * Python's `json.dumps(value, ensure_ascii=False)` with the default
 * separators (", " and ": ") and insertion-ordered keys.
 */
export function pythonJson(value) {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  return `{${Object.keys(value).map((key) => `${JSON.stringify(key)}: ${pythonJson(value[key])}`).join(', ')}}`;
}

export function utf8(text) {
  return encoder.encode(text);
}

export function fromUtf8(bytes) {
  return decoder.decode(bytes);
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? utf8(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function streamThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzip(bytes) {
  return streamThrough(bytes, new CompressionStream('gzip'));
}

export async function gunzip(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length < 2 || view[0] !== 0x1f || view[1] !== 0x8b) return view;
  return streamThrough(view, new DecompressionStream('gzip'));
}

export async function encodeDocument(document) {
  return gzip(utf8(canonicalJson(document)));
}

export async function decodeDocument(bytes) {
  return JSON.parse(fromUtf8(await gunzip(bytes)));
}

export async function digestOf(value) {
  return sha256Hex(canonicalJson(value));
}

export function base64(bytes) {
  let text = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    text += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(text);
}
