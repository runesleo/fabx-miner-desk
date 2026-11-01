// POST /api/alerts — rig income alert beta waitlist.
// Stores only the rig address, the Telegram username and the interface language, with timestamps. No IP storage.

import { optionsResponse, withCors } from './cors.js';
import { createBindToken, parseBindBody, saveBindToken } from '../../alerts/bind.mjs';

const MAX_BODY = 2048;
const MAX_PER_TELEGRAM = 20;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TELEGRAM = /^@?[A-Za-z0-9_]{5,32}$/;

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function readJson(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) return { error: 413 };
  let text;
  try { text = await request.text(); } catch { return { error: 400 }; }
  if (new TextEncoder().encode(text).length > MAX_BODY) return { error: 413 };
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 400 };
  } catch { return { error: 400 }; }
}

export function parseSignup(body) {
  if (typeof body.address !== 'string' || !ADDRESS.test(body.address.trim())) return { error: 'bad_address' };
  if (typeof body.telegram !== 'string' || !TELEGRAM.test(body.telegram.trim())) return { error: 'bad_telegram' };
  return {
    address: body.address.trim().toLowerCase(),
    // Telegram usernames are case-insensitive; store without the leading @.
    telegram: body.telegram.trim().replace(/^@/, '').toLowerCase(),
    lang: body.lang === 'zh' ? 'zh' : 'en',
    chain: body.chain === 'bsc' ? 'bsc' : 'xlayer',
  };
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse(request);
  if (request.method !== 'POST') return withCors(request, new Response(null, { status: 405, headers: { allow: 'POST' } }));
  const { value, error } = await readJson(request);
  if (error) return withCors(request, json(error, { ok: false, error: error === 413 ? 'too_large' : 'bad_json' }));
  if (value.bind === true) {
    const parsed = parseBindBody(value);
    if (parsed.error) return withCors(request, json(400, { ok: false, error: parsed.error }));
    if (!env?.DB) return withCors(request, json(503, { ok: false, error: 'unavailable' }));
    const saved = await saveBindToken(env.DB, parsed, { token: createBindToken() });
    return withCors(request, json(200, { ok: true, url: saved.url, expiresAt: saved.expiresAt }));
  }
  const signup = parseSignup(value);
  if (signup.error) return withCors(request, json(400, { ok: false, error: signup.error }));
  if (!env?.DB) return withCors(request, json(503, { ok: false, error: 'unavailable' }));
  const db = env.DB;
  const existing = await db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN address = ? AND chain = ? THEN 1 ELSE 0 END) AS same FROM alert_signups WHERE telegram = ?`)
    .bind(signup.address, signup.chain, signup.telegram).first();
  if (!Number(existing?.same) && Number(existing?.n) >= MAX_PER_TELEGRAM) return withCors(request, json(429, { ok: false, error: 'limit' }));
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO alert_signups (address, telegram, lang, chain, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(address, telegram, chain) DO UPDATE SET lang = excluded.lang, updated_at = excluded.updated_at`)
    .bind(signup.address, signup.telegram, signup.lang, signup.chain, now, now).run();
  return withCors(request, json(200, { ok: true }));
}
