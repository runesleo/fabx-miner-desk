import test from 'node:test';
import assert from 'node:assert/strict';
import { sendHit } from '../track.mjs';
import { HOSTED_API_ORIGIN } from '../api-url.mjs';

function browser({ dnt = null, storage = 'ok', lang = 'en-US', saved = {}, pathname = '/', referrer = '', beacon = true } = {}) {
  const local = new Map(Object.entries(saved)), beacons = [], fetches = [];
  const localStorage = storage === 'ok' ? { getItem: k => local.get(k) ?? null, setItem: (k, v) => local.set(k, v) }
    : { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  return {
    beacons, fetches, local,
    env: {
      navigator: { doNotTrack: dnt, language: lang, sendBeacon: beacon ? (url, blob) => (beacons.push({ url, blob }), true) : undefined },
      localStorage, location: { pathname, hostname: 'fabx-miner-desk.pages.dev', search: '?address=0xabc' }, document: { referrer },
      crypto: globalThis.crypto, Blob,
      fetch: async (url, init) => { fetches.push({ url, init }); throw new Error('404'); },
    },
  };
}

test('track sends one beacon with random id, path, language and referrer host only', async () => {
  const b = browser({ pathname: '/rigs/', referrer: 'https://x.com/user/status/1?ref=abc', saved: { 'fmd.lang': 'zh' } });
  const payload = sendHit(b.env);
  assert.equal(b.beacons.length, 1);
  assert.equal(b.beacons[0].url, '/api/hit');
  const body = JSON.parse(await b.beacons[0].blob.text());
  assert.deepEqual(body, payload);
  assert.deepEqual(Object.keys(body).sort(), ['cid', 'lang', 'path', 'ref']);
  assert.match(body.cid, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ path: body.path, lang: body.lang, ref: body.ref }, { path: '/rigs', lang: 'zh', ref: 'x.com' });
  assert.equal(b.local.get('fmd.cid'), body.cid);
  assert.equal(sendHit(b.env).cid, body.cid, 'the id is reused from local storage');
});

test('track omits own-site referrers and falls back to keepalive fetch, swallowing failures', async () => {
  const b = browser({ beacon: false, referrer: 'https://fabx-miner-desk.pages.dev/', lang: 'zh-CN' });
  const payload = sendHit(b.env);
  assert.equal(payload.ref, null);
  assert.equal(payload.lang, 'zh');
  assert.equal(b.fetches.length, 1);
  assert.equal(b.fetches[0].init.keepalive, true);
  assert.ok(!b.fetches[0].init.body.includes('0xabc'));
  await new Promise(resolve => setTimeout(resolve, 0));
});

test('track uses hosted API origin on DeWeb hostnames', async () => {
  const host = 'r1-dc945fd3aee9829a3c9065459e82aa503572da5f-deweb.fabx.tech';
  const b = browser({ pathname: '/v/2/rigs/', referrer: '', saved: { 'fmd.cid': '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b' } });
  b.env.location.hostname = host;
  sendHit(b.env);
  assert.equal(b.beacons[0].url, `${HOSTED_API_ORIGIN}/api/hit`);
  const body = JSON.parse(await b.beacons[0].blob.text());
  assert.equal(body.path, '/rigs');
});

test('track does nothing when Do Not Track is on or local storage is unavailable', () => {
  const dnt = browser({ dnt: '1' });
  assert.equal(sendHit(dnt.env), null);
  assert.equal(dnt.beacons.length + dnt.fetches.length, 0);
  assert.equal(dnt.local.size, 0);
  const blocked = browser({ storage: 'blocked' });
  assert.equal(sendHit(blocked.env), null);
  assert.equal(blocked.beacons.length + blocked.fetches.length, 0);
  assert.equal(sendHit({}), null);
  assert.doesNotThrow(() => sendHit({ navigator: { sendBeacon() { throw new Error('boom'); } }, localStorage: { getItem: () => 'x', setItem() {} } }));
});
