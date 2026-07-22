// Compact, versioned URL payload for committed regular-house opening edits.
//
// The runtime remains authoritative: it supplies already-normalized records and
// rebuilds decoded records through the normal parcel contract. This module only
// owns a small transport envelope, so it deliberately has no DOM, Svelte, or
// three.js dependency and can be exercised as a fast pure contract.

export const RESIDENTIAL_EDIT_QUERY_KEY = 'vedit';
export const RESIDENTIAL_EDIT_URL_VERSION = 1;
export const MAX_RESIDENTIAL_EDIT_RECORDS = 8;

export const RESIDENTIAL_EDIT_PARAM_KEYS = Object.freeze([
  'doorCount', 'windowCount',
  'doorWidthK', 'windowWidthK',
  'doorHeightK', 'windowHeightK',
]);

const COUNT_KEYS = new Set(['doorCount', 'windowCount']);
const MAX_PAYLOAD_LENGTH = 768;
const MAX_PARCEL_ID_LENGTH = 32;
const RATIO_SCALE = 1000;
const MAX_COUNT = 35;
const MAX_RATIO = 2;
const PARCEL_ID_RE = /^[A-Za-z0-9_-]+$/;
const BASE36_RE = /^[0-9a-z]+$/;

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validParcelId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PARCEL_ID_LENGTH
    && PARCEL_ID_RE.test(value);
}

function encodeNumber(key, value) {
  if (!Number.isFinite(value)) return null;
  if (COUNT_KEYS.has(key)) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_COUNT) return null;
    return value.toString(36);
  }
  if (value <= 0 || value > MAX_RATIO) return null;
  const scaled = Math.round(value * RATIO_SCALE);
  if (Math.abs(scaled / RATIO_SCALE - value) > 1e-9) return null;
  return scaled.toString(36);
}

function decodeNumber(key, token) {
  if (!BASE36_RE.test(token) || token.length > 4) return null;
  const encoded = Number.parseInt(token, 36);
  if (!Number.isSafeInteger(encoded)) return null;
  if (COUNT_KEYS.has(key)) return encoded >= 1 && encoded <= MAX_COUNT ? encoded : null;
  const value = encoded / RATIO_SCALE;
  return value > 0 && value <= MAX_RATIO ? value : null;
}

function canonicalRecord(record) {
  if (!record || typeof record !== 'object' || !validParcelId(record.parcelId)) return null;
  if (record.kind !== 'giwa' && record.kind !== 'choga') return null;
  const source = record.params;
  if (!source || typeof source !== 'object') return null;
  const params = {};
  const tokens = [];
  for (const key of RESIDENTIAL_EDIT_PARAM_KEYS) {
    const token = encodeNumber(key, source[key]);
    if (token == null) return null;
    params[key] = source[key];
    tokens.push(token);
  }
  return {
    record: { parcelId: record.parcelId, kind: record.kind, params },
    token: [record.parcelId, record.kind === 'giwa' ? 'g' : 'c', ...tokens].join('.'),
  };
}

// Returns null for an empty or invalid state. Callers then remove the query
// parameter, preserving the intentionally terse default-home URL.
export function encodeResidentialEditState({ records = [], focusedParcelId = null } = {}) {
  if (!Array.isArray(records) || records.length === 0) return null;
  if (records.length > MAX_RESIDENTIAL_EDIT_RECORDS) return null;
  if (focusedParcelId != null && !validParcelId(focusedParcelId)) return null;

  const canonical = [];
  const ids = new Set();
  for (const source of records) {
    const item = canonicalRecord(source);
    if (!item || ids.has(item.record.parcelId)) return null;
    ids.add(item.record.parcelId);
    canonical.push(item);
  }
  canonical.sort((a, b) => compareText(a.record.parcelId, b.record.parcelId));
  const payload = `${RESIDENTIAL_EDIT_URL_VERSION}~${focusedParcelId || '-'}~${canonical.map((item) => item.token).join(';')}`;
  return payload.length <= MAX_PAYLOAD_LENGTH ? payload : null;
}

// Any malformed field invalidates the whole envelope. Partial restoration is
// more surprising than ignoring an untrusted or truncated share parameter.
export function decodeResidentialEditState(payload) {
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_PAYLOAD_LENGTH) return null;
  const envelope = payload.split('~');
  if (envelope.length !== 3 || envelope[0] !== String(RESIDENTIAL_EDIT_URL_VERSION)) return null;
  const focusedParcelId = envelope[1] === '-' ? null : envelope[1];
  if (focusedParcelId != null && !validParcelId(focusedParcelId)) return null;

  const rows = envelope[2].split(';');
  if (rows.length === 0 || rows.length > MAX_RESIDENTIAL_EDIT_RECORDS || rows.some((row) => !row)) return null;
  const records = [];
  const ids = new Set();
  for (const row of rows) {
    const fields = row.split('.');
    if (fields.length !== 2 + RESIDENTIAL_EDIT_PARAM_KEYS.length) return null;
    const [parcelId, kindToken, ...valueTokens] = fields;
    if (!validParcelId(parcelId) || ids.has(parcelId)) return null;
    const kind = kindToken === 'g' ? 'giwa' : kindToken === 'c' ? 'choga' : null;
    if (!kind) return null;
    const params = {};
    for (let i = 0; i < RESIDENTIAL_EDIT_PARAM_KEYS.length; i++) {
      const value = decodeNumber(RESIDENTIAL_EDIT_PARAM_KEYS[i], valueTokens[i]);
      if (value == null) return null;
      params[RESIDENTIAL_EDIT_PARAM_KEYS[i]] = value;
    }
    ids.add(parcelId);
    records.push({ parcelId, kind, params });
  }
  records.sort((a, b) => compareText(a.parcelId, b.parcelId));
  return { version: RESIDENTIAL_EDIT_URL_VERSION, records, focusedParcelId };
}
