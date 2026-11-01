// POST /api/pod-verify?chainId=196 — same-origin relay to the official FabX verify API.
// api.fabx.tech sends no CORS headers, so the browser cannot call it from this site directly.
// Forwards only { taskId, netlist } for X Layer; stores nothing.

import { readJson } from './hit.js';
import { optionsResponse, withCors } from './cors.js';

export const UPSTREAM = 'https://api.fabx.tech/v1/pod/verify';
export const MAX_NETLIST_BYTES = 2 * 1024 * 1024;
const CHAINS = new Set(['196']);

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export function parseVerifyRequest(body) {
  const taskId = body.taskId;
  if (!Number.isSafeInteger(taskId) || taskId <= 0) return { error: 'bad_task' };
  if (typeof body.netlist !== 'string' || !body.netlist) return { error: 'bad_netlist' };
  return { taskId, netlist: body.netlist };
}

export async function relayVerify(request, fetchImpl = fetch) {
  if (request.method === 'OPTIONS') return optionsResponse(request);
  if (request.method !== 'POST') return withCors(request, new Response(null, { status: 405, headers: { allow: 'POST' } }));
  const chainId = new URL(request.url).searchParams.get('chainId');
  if (!CHAINS.has(chainId)) return withCors(request, json(404, { code: 'CHAIN_NOT_SUPPORTED' }));
  const { value, error } = await readJson(request, MAX_NETLIST_BYTES);
  if (error) return withCors(request, json(error, { ok: false, error: error === 413 ? 'too_large' : 'bad_json' }));
  const parsed = parseVerifyRequest(value);
  if (parsed.error) return withCors(request, json(400, { ok: false, error: parsed.error }));
  let upstream;
  try {
    upstream = await fetchImpl(`${UPSTREAM}?chainId=${chainId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
  } catch {
    return withCors(request, json(502, { ok: false, error: 'upstream_unreachable' }));
  }
  return withCors(request, new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  }));
}

export const onRequest = ({ request }) => relayVerify(request);
