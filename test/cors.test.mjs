import test from 'node:test';
import assert from 'node:assert/strict';
import { corsHeaders, optionsResponse, requestSurface, withCors } from '../functions/api/cors.js';

const DEWEB = 'https://r1-dc945fd3aee9829a3c9065459e82aa503572da5f-deweb.fabx.tech';
const req = (origin, method = 'POST') => new Request('https://fabx-miner-desk.pages.dev/api/hit', {
  method,
  headers: origin ? { Origin: origin } : {},
});

test('CORS allows only exact DeWeb origins', () => {
  const ok = corsHeaders(req(DEWEB));
  assert.equal(ok['access-control-allow-origin'], DEWEB);
  assert.equal(ok.vary, 'Origin');
  assert.equal(ok['access-control-allow-credentials'], 'true');
  assert.match(ok['access-control-allow-methods'], /POST/);
  assert.equal(corsHeaders(req('https://evil.example')), null);
  assert.equal(corsHeaders(req('https://r1-deadbeef-deweb.fabx.tech')), null);
});

test('OPTIONS returns 204 for DeWeb and 403 otherwise', () => {
  assert.equal(optionsResponse(req(DEWEB, 'OPTIONS')).status, 204);
  assert.equal(optionsResponse(req('https://fabx-miner-desk.pages.dev', 'OPTIONS')).status, 403);
});

test('requestSurface distinguishes DeWeb cross-origin calls', () => {
  assert.equal(requestSurface(req(DEWEB)), 'deweb');
  assert.equal(requestSurface(req(null)), 'hosted');
});

test('withCors echoes allowed Origin on JSON responses', async () => {
  const base = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  const wrapped = withCors(req(DEWEB), base);
  assert.equal(wrapped.headers.get('access-control-allow-origin'), DEWEB);
});
