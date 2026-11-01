// GET /api/bsc-rigs?addr=0x… — current BSC circuit ids for one holder, plus index progress.
// Until the cron backfill catches the chain head, the body says 索引建设中 and rigs is empty.

import { bscRigsForAddress, BSC_INDEX_BUILDING } from '../../alerts/bsc-index.mjs';
import { optionsResponse, withCors } from './cors.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CORS = { methods: 'GET, OPTIONS', headers: 'content-type' };

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
});

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse(request, CORS);
  const cors = (response) => withCors(request, response, CORS);
  if (request.method !== 'GET') return cors(new Response(null, { status: 405, headers: { allow: 'GET' } }));
  if (!env?.DB) return cors(json(503, { ok: false, error: 'unavailable' }));
  const address = new URL(request.url).searchParams.get('addr')?.trim() || '';
  if (!ADDRESS.test(address)) return cors(json(400, { ok: false, error: 'bad_address' }));
  const result = await bscRigsForAddress(env.DB, address);
  return cors(json(200, {
    ok: true,
    building: result.building,
    message: result.building ? BSC_INDEX_BUILDING : null,
    address: result.address,
    rigs: result.rigs,
    progress: result.progress,
  }));
}
