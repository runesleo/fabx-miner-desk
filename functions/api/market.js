// GET /api/market — precomputed FAB/BEM 24h median and range (alerts worker → D1).

import { rowToMarketApi } from '../../alerts/market.mjs';
import { optionsResponse, withCors } from './cors.js';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
});

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse(request, { methods: 'GET, OPTIONS', headers: 'content-type' });
  if (request.method !== 'GET') return withCors(request, new Response(null, { status: 405, headers: { allow: 'GET' } }), { methods: 'GET, OPTIONS' });
  if (!env?.DB) return withCors(request, json(503, { ok: false, error: 'unavailable' }), { methods: 'GET, OPTIONS' });
  const row = await env.DB.prepare('SELECT * FROM market_fab_24h WHERE id = 1').first();
  const payload = rowToMarketApi(row);
  if (!payload) return withCors(request, json(503, { ok: false, error: 'unavailable' }), { methods: 'GET, OPTIONS' });
  return withCors(request, json(200, { ok: true, ...payload }), { methods: 'GET, OPTIONS' });
}
