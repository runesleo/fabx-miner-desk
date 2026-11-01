// Browser + Node client for GET /api/bsc-rigs.
// BSC_ADDRESS_LOOKUP stays false until the holder index has finished backfill
// and a browser measurement of the indexed getMiner path succeeds.

import { apiUrl } from './api-url.mjs';

export const BSC_ADDRESS_LOOKUP = false;
export const BSC_INDEX_BUILDING = '索引建设中';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function progressOf(progress) {
  const source = progress && typeof progress === 'object' ? progress : {};
  const scannedTo = Number(source.scannedTo);
  const head = Number(source.head);
  const updatedAt = typeof source.updatedAt === 'string' && Number.isFinite(Date.parse(source.updatedAt)) ? source.updatedAt : null;
  return {
    scannedTo: Number.isSafeInteger(scannedTo) ? scannedTo : null,
    head: Number.isSafeInteger(head) ? head : null,
    complete: source.complete === true,
    updatedAt,
    fromBlock: Number.isSafeInteger(Number(source.fromBlock)) ? Number(source.fromBlock) : null,
  };
}

/** Null when a ready payload is malformed. Building payloads never expose partial rigs. */
export function parseBscRigsResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok !== true) return null;
  const progress = progressOf(data.progress);
  const address = typeof data.address === 'string' ? data.address.toLowerCase() : null;
  if (data.building === true || progress.complete !== true || data.message === BSC_INDEX_BUILDING) {
    return { building: true, message: BSC_INDEX_BUILDING, address, rigs: [], progress: { ...progress, complete: false } };
  }
  if (!Array.isArray(data.rigs)) return null;
  const rigs = [];
  for (const rig of data.rigs) {
    const id = String(rig?.id ?? '');
    const processor = String(rig?.processor || '').toLowerCase();
    if (!/^\d+$/.test(id) || !ADDRESS.test(processor)) return null;
    rigs.push({ id, processor, label: typeof rig.label === 'string' ? rig.label : '' });
  }
  return { building: false, message: null, address, rigs, progress };
}

export async function fetchBscRigs(address, { fetchImpl = globalThis.fetch, signal, location } = {}) {
  if (!ADDRESS.test(address || '')) throw new Error('not an address');
  const url = apiUrl(`/api/bsc-rigs?addr=${encodeURIComponent(address)}`, location);
  const response = await fetchImpl(url, { method: 'GET', signal, credentials: 'omit', cache: 'no-store' });
  const contentType = response.headers?.get?.('content-type') || '';
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  const parsed = parseBscRigsResponse(data);
  if (!response.ok || !parsed) {
    const error = new Error(response.ok ? 'invalid bsc rigs response' : `bsc rigs HTTP ${response.status}`);
    error.status = response.status;
    error.contentType = contentType;
    throw error;
  }
  return parsed;
}
