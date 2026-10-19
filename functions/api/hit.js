// POST /api/hit — one anonymous page-load count.
// Stores only: UTC day, whitelisted path, zh|en, coarse referrer host, a random per-browser id, and a timestamp.
// Never stores IP, user agent, wallet addresses, full URLs or query strings.

const MAX_BODY = 2048;
const PATHS = new Set(['/', '/rigs']);
const LANGS = new Set(['zh', 'en']);
const CID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const reply = (status, body = null) => new Response(body == null ? null : JSON.stringify(body), {
  status, headers: { 'cache-control': 'no-store', ...(body == null ? {} : { 'content-type': 'application/json; charset=utf-8' }) },
});

export async function readJson(request, max = MAX_BODY) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return { error: 413 };
  let text;
  try { text = await request.text(); } catch { return { error: 400 }; }
  if (new TextEncoder().encode(text).length > max) return { error: 413 };
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 400 };
  } catch { return { error: 400 }; }
}

// Accept a bare host or a URL, keep the lowercase hostname only (no scheme, port, path or query).
export function refHost(ref) {
  if (ref == null || ref === '') return null;
  if (typeof ref !== 'string' || ref.length > 512) return null;
  let host = ref.trim().toLowerCase();
  if (host.includes('/') || host.includes(':')) {
    try { host = new URL(host.includes('://') ? host : `https://${host}`).hostname; } catch { return null; }
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  return HOST.test(host) ? host : null;
}

export function parseHit(body) {
  const cid = typeof body.cid === 'string' ? body.cid.toLowerCase() : '';
  const path = body.path === '/rigs/' ? '/rigs' : body.path;
  if (!CID.test(cid) || !PATHS.has(path) || !LANGS.has(body.lang)) return null;
  return { cid, path, lang: body.lang, ref: refHost(body.ref) };
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const { value, error } = await readJson(request);
  if (error) return reply(error);
  const hit = parseHit(value);
  if (!hit) return reply(400);
  if (!env?.DB) return reply(503);
  const ts = Date.now();
  const day = new Date(ts).toISOString().slice(0, 10);
  await env.DB.prepare('INSERT INTO hits (day, path, lang, ref, cid, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(day, hit.path, hit.lang, hit.ref, hit.cid, ts).run();
  return reply(204);
}
