import test from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl, isHostedApiOrigin, HOSTED_API_ORIGIN } from '../api-url.mjs';

test('apiUrl keeps relative paths on Pages and localhost', () => {
  assert.equal(apiUrl('/api/hit', { hostname: 'fabx-miner-desk.pages.dev' }), '/api/hit');
  assert.equal(apiUrl('/api/hit', { hostname: 'abc123.fabx-miner-desk.pages.dev' }), '/api/hit');
  assert.equal(apiUrl('/api/hit', { hostname: 'fabx.leolabs.me' }), '/api/hit');
  assert.equal(apiUrl('/api/hit', { hostname: 'evil.leolabs.me' }), 'https://fabx-miner-desk.pages.dev/api/hit');
  assert.equal(apiUrl('/api/hit', { hostname: 'localhost' }), '/api/hit');
  assert.equal(apiUrl('/api/hit', { hostname: '127.0.0.1' }), '/api/hit');
});

test('apiUrl points DeWeb mirror traffic at hosted API origin', () => {
  const host = 'r1-dc945fd3aee9829a3c9065459e82aa503572da5f-deweb.fabx.tech';
  assert.equal(apiUrl('/api/hit', { hostname: host }), `${HOSTED_API_ORIGIN}/api/hit`);
  assert.equal(isHostedApiOrigin(host), false);
});
