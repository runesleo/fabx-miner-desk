// POST /api/feedback — one line of feedback from the website, no login.
// Stores only the text (≤500 characters), the interface language and the page. No IP, user agent, wallet address or id.

import { readJson } from './hit.js';
import { normalizeSitePath } from '../../site-path.mjs';
import { optionsResponse, withCors } from './cors.js';

export const MAX_FEEDBACK_CHARS = 500;

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export function parseFeedback(body) {
  const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) return { error: 'empty' };
  if (text.length > MAX_FEEDBACK_CHARS) return { error: 'too_long' };
  if (typeof body.page === 'string' && (body.page.includes('?') || body.page.includes('#'))) return { error: 'bad_page' };
  const page = normalizeSitePath(body.page) ?? '/';
  return { text, lang: body.lang === 'zh' ? 'zh' : 'en', page };
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse(request);
  if (request.method !== 'POST') return withCors(request, new Response(null, { status: 405, headers: { allow: 'POST' } }));
  const { value, error } = await readJson(request, 4096);
  if (error) return withCors(request, json(error, { ok: false, error: error === 413 ? 'too_large' : 'bad_json' }));
  const feedback = parseFeedback(value);
  if (feedback.error) return withCors(request, json(400, { ok: false, error: feedback.error }));
  if (!env?.DB) return withCors(request, json(503, { ok: false, error: 'unavailable' }));
  await env.DB.prepare('INSERT INTO feedback (text, lang, source, page, telegram, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
    .bind(feedback.text, feedback.lang, 'site', feedback.page, new Date().toISOString()).run();
  return withCors(request, json(200, { ok: true }));
}
