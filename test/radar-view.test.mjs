import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { radarCards, radarItems, radarText } from '../radar-view.mjs';
import { onRequest, trimItems, UPSTREAM } from '../functions/api/radar.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const item = (over) => ({ key: 'k', name: 'FAB Mining Vault', method: 'yield', chain: 'X Layer', summary: 'Stake https://t.co/abc  FAB\nnow',
  summary_zh: null, official_url: 'https://x.com/Ignixbot/status/1', observed_at: '2026-10-31T00:00:00Z', first_seen_at: 't',
  deadline: null, status: 'open', ...over });

test('radar keeps open items with safe links, newest first', () => {
  const rows = radarItems([
    item({ key: 'old', observed_at: '2026-10-28T00:00:00Z' }),
    item({ key: 'new', observed_at: '2026-11-01T00:00:00Z' }),
    item({ key: 'ended', status: 'ended' }),
    item({ key: 'past', deadline: '2026-10-30T00:00:00Z' }),
    item({ key: 'js', official_url: 'javascript:alert(1)' }),
  ], NOW);
  assert.deepEqual(rows.map((r) => r.key), ['new', 'old']);
});

test('radar cards escape text, drop t.co links and prefer the Chinese summary in zh', () => {
  const html = radarCards([item({ name: '<b>Vault</b>', summary_zh: '质押 FAB 挖 BEM' })], 'zh', NOW);
  assert.ok(html.includes('&lt;b&gt;Vault&lt;/b&gt;'));
  assert.ok(html.includes('质押 FAB 挖 BEM'));
  assert.ok(html.includes('收益'));
  const en = radarCards([item()], 'en', NOW);
  assert.ok(en.includes('Stake FAB now') && !en.includes('t.co'));
  assert.ok(en.includes('href="https://x.com/Ignixbot/status/1"'));
  assert.equal(radarCards([], 'en', NOW), '');
  assert.equal(radarText('fr').tabRadar, 'TapeOut radar');
});

test('/api/radar passes only public fields through and fails closed', async () => {
  let asked = null;
  const ok = await onRequest({ request: new Request('https://fabx.leolabs.me/api/radar') }, async (url) => {
    asked = url;
    return new Response(JSON.stringify({ ok: true, items: [{ ...item(), secret: 'x' }, { name: 'bad', official_url: 'http://x' }] }));
  });
  assert.equal(asked, UPSTREAM);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].secret, undefined);
  const down = await onRequest({ request: new Request('https://fabx.leolabs.me/api/radar') }, async () => new Response('x', { status: 500 }));
  assert.equal(down.status, 502);
  const thrown = await onRequest({ request: new Request('https://fabx.leolabs.me/api/radar') }, async () => { throw new Error('net'); });
  assert.equal(thrown.status, 502);
  const post = await onRequest({ request: new Request('https://fabx.leolabs.me/api/radar', { method: 'POST' }) });
  assert.equal(post.status, 405);
  assert.deepEqual(trimItems(null), []);
});

test('homepage opens on the radar; rig pages and asset links open on the calculator', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="radarView"') < html.indexOf('id="calcView"'));
  assert.match(html, /calcFirst = location\.hash === '#calc' \|\| normalizeSitePath\(location\.pathname\) === '\/rigs' \|\| Boolean\(deep\.address \|\| deep\.rigId\)/);
});

test('fetchRadar turns any failure into the error state', async () => {
  const { fetchRadar } = await import('../radar-view.mjs');
  assert.deepEqual(await fetchRadar('/api/radar', async () => new Response(JSON.stringify({ ok: true, items: [1] }))), { status: 'ok', items: [1] });
  assert.equal((await fetchRadar('/api/radar', async () => new Response('x', { status: 502 }))).status, 'error');
  assert.equal((await fetchRadar('/api/radar', async () => { throw new Error('net'); })).status, 'error');
});
