// GET /api/radar — TapeOut ecosystem items from the Leo Labs opportunity radar (theme pack `tapeout`).
// Same-origin proxy so the homepage (and the DeWeb copy, via CORS) can read it; only public fields pass through.

import { optionsResponse, withCors } from './cors.js';

export const UPSTREAM = 'https://leolabs.me/api/radar-activities?theme=tapeout&days=14&limit=50';
const CORS = { methods: 'GET, OPTIONS', headers: 'content-type' };
const FIELDS = ['key', 'name', 'method', 'chain', 'summary', 'summary_zh', 'official_url', 'observed_at', 'first_seen_at', 'deadline', 'status'];

const json = (status, body, cache) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
});

export function trimItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(it => it && typeof it.name === 'string' && /^https:\/\//.test(it.official_url || ''))
    .map(it => Object.fromEntries(FIELDS.map(k => [k, it[k] ?? null])));
}

export async function onRequest({ request }, fetchImpl = fetch) {
  if (request.method === 'OPTIONS') return optionsResponse(request, CORS);
  const cors = (response) => withCors(request, response, CORS);
  if (request.method !== 'GET') return cors(new Response(null, { status: 405, headers: { allow: 'GET' } }));
  try {
    const res = await fetchImpl(UPSTREAM, { cf: { cacheTtl: 300, cacheEverything: true } });
    const body = res.ok ? await res.json() : null;
    if (!body?.ok) return cors(json(502, { ok: false, error: 'radar_unavailable' }, 'no-store'));
    return cors(json(200, { ok: true, items: trimItems(body.items), more: 'https://leolabs.me/radar?theme=tapeout' }, 'public, max-age=300'));
  } catch {
    return cors(json(502, { ok: false, error: 'radar_unavailable' }, 'no-store'));
  }
}
