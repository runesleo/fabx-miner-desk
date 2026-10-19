import test from 'node:test';
import assert from 'node:assert/strict';
import * as hit from '../functions/api/hit.js';
import * as alerts from '../functions/api/alerts.js';

// In-memory stand-in for the D1 statements the two handlers use (prepare/bind/run/first).
function fakeD1() {
  const tables = { hits: [], alert_signups: [] }, calls = [];
  const exec = (sql, args) => {
    if (/^INSERT INTO hits/.test(sql)) {
      const [day, path, lang, ref, cid, ts] = args;
      tables.hits.push({ day, path, lang, ref, cid, ts });
      return { first: null };
    }
    if (/^SELECT COUNT\(\*\) AS n/.test(sql)) {
      const [address, telegram] = args;
      const rows = tables.alert_signups.filter(r => r.telegram === telegram);
      return { first: { n: rows.length, same: rows.filter(r => r.address === address).length || null } };
    }
    if (/^INSERT INTO alert_signups/.test(sql)) {
      const [address, telegram, lang, created_at, updated_at] = args;
      const row = tables.alert_signups.find(r => r.address === address && r.telegram === telegram);
      if (row) Object.assign(row, { lang, updated_at }); else tables.alert_signups.push({ address, telegram, lang, created_at, updated_at });
      return { first: null };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return {
    tables, calls,
    prepare(sql) {
      return { bind(...args) {
        calls.push({ sql, args });
        return { run: async () => (exec(sql, args), { success: true }), first: async () => exec(sql, args).first };
      } };
    },
  };
}

const UA = 'Mozilla/5.0 (Macintosh) TestBrowser/1.0';
const IP = '203.0.113.7';
const post = (url, body, extra = {}) => new Request(`https://fabx-miner-desk.pages.dev${url}`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'user-agent': UA, 'cf-connecting-ip': IP, 'x-forwarded-for': IP, ...extra },
});
const CID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const ADDR = '0xE0cb3d9542a786c60605dd55efb9ef79490a3d6c';

test('hit stores day, whitelisted path, language, referrer host and cid only, and returns 204', async () => {
  const DB = fakeD1();
  const res = await hit.onRequest({ request: post('/api/hit', { cid: CID.toUpperCase(), path: '/rigs', lang: 'zh', ref: 'https://www.X.com/someone/status/1?utm=1#a' }), env: { DB } });
  assert.equal(res.status, 204);
  assert.equal(DB.tables.hits.length, 1);
  const row = DB.tables.hits[0];
  assert.deepEqual(Object.keys(row).sort(), ['cid', 'day', 'lang', 'path', 'ref', 'ts']);
  assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(row.day, new Date(row.ts).toISOString().slice(0, 10));
  assert.deepEqual({ path: row.path, lang: row.lang, ref: row.ref, cid: row.cid }, { path: '/rigs', lang: 'zh', ref: 'x.com', cid: CID });
  const stored = JSON.stringify(DB.calls);
  for (const secret of [IP, UA, 'TestBrowser', 'status/1', 'utm', ADDR.toLowerCase()]) assert.ok(!stored.includes(secret), `stored ${secret}`);
});

test('hit keeps referrer as host only or null and normalizes the /rigs/ alias', async () => {
  assert.equal(hit.refHost('google.com'), 'google.com');
  assert.equal(hit.refHost('https://t.me:443/channel?x=1'), 't.me');
  assert.equal(hit.refHost(''), null);
  assert.equal(hit.refHost('not a host!'), null);
  assert.equal(hit.refHost('x'.repeat(600)), null);
  assert.equal(hit.refHost(42), null);
  assert.equal(hit.parseHit({ cid: CID, path: '/rigs/', lang: 'en' }).path, '/rigs');
  assert.equal(hit.parseHit({ cid: CID, path: '/', lang: 'en' }).ref, null);
});

test('hit rejects non-whitelisted paths, languages, bad ids, bad JSON, oversize bodies and non-POST', async () => {
  const DB = fakeD1();
  const status = async (body, extra) => (await hit.onRequest({ request: post('/api/hit', body, extra), env: { DB } })).status;
  assert.equal(await status({ cid: CID, path: '/rigs?address=0xabc', lang: 'en' }), 400);
  assert.equal(await status({ cid: CID, path: '/admin', lang: 'en' }), 400);
  assert.equal(await status({ cid: CID, path: '/', lang: 'fr' }), 400);
  assert.equal(await status({ cid: 'not-a-uuid', path: '/', lang: 'en' }), 400);
  assert.equal(await status({ path: '/', lang: 'en' }), 400);
  assert.equal(await status('{not json'), 400);
  assert.equal(await status('[1,2]'), 400);
  assert.equal(await status(JSON.stringify({ cid: CID, path: '/', lang: 'en', pad: 'x'.repeat(2100) })), 413);
  assert.equal(await status('{}', { 'content-length': '5000' }), 413);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await hit.onRequest({ request: new Request('https://fabx-miner-desk.pages.dev/api/hit', { method }), env: { DB } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  }
  assert.equal(DB.tables.hits.length, 0);
});

test('hit reports 503 without a configured database instead of throwing', async () => {
  const res = await hit.onRequest({ request: post('/api/hit', { cid: CID, path: '/', lang: 'en' }), env: {} });
  assert.equal(res.status, 503);
});

test('alert signup validates, normalizes and upserts address + telegram without storing IP', async () => {
  const DB = fakeD1();
  const send = async (body, extra) => {
    const res = await alerts.onRequest({ request: post('/api/alerts', body, extra), env: { DB } });
    return { status: res.status, body: await res.json() };
  };
  assert.deepEqual(await send({ address: ADDR, telegram: '@Leo_Miner', lang: 'zh' }), { status: 200, body: { ok: true } });
  assert.deepEqual(DB.tables.alert_signups.map(({ address, telegram, lang }) => ({ address, telegram, lang })),
    [{ address: ADDR.toLowerCase(), telegram: 'leo_miner', lang: 'zh' }]);
  const first = DB.tables.alert_signups[0].created_at;
  assert.deepEqual(await send({ address: ADDR.toLowerCase(), telegram: 'leo_MINER', lang: 'en' }), { status: 200, body: { ok: true } });
  assert.equal(DB.tables.alert_signups.length, 1, 'same address + handle is an upsert');
  assert.equal(DB.tables.alert_signups[0].lang, 'en');
  assert.equal(DB.tables.alert_signups[0].created_at, first);
  const stored = JSON.stringify(DB.calls);
  assert.ok(!stored.includes(IP) && !stored.includes(UA));
  assert.deepEqual(Object.keys(DB.tables.alert_signups[0]).sort(), ['address', 'created_at', 'lang', 'telegram', 'updated_at']);
});

test('alert signup rejects bad address, bad telegram, bad JSON, oversize bodies and non-POST', async () => {
  const DB = fakeD1();
  const send = async (body, extra) => {
    const res = await alerts.onRequest({ request: post('/api/alerts', body, extra), env: { DB } });
    return { status: res.status, body: await res.json() };
  };
  assert.deepEqual(await send({ address: '0x123', telegram: 'leo_miner' }), { status: 400, body: { ok: false, error: 'bad_address' } });
  assert.deepEqual(await send({ address: ADDR + '00', telegram: 'leo_miner' }), { status: 400, body: { ok: false, error: 'bad_address' } });
  assert.deepEqual(await send({ address: ADDR, telegram: 'abc' }), { status: 400, body: { ok: false, error: 'bad_telegram' } });
  assert.deepEqual(await send({ address: ADDR, telegram: 'bad-name!' }), { status: 400, body: { ok: false, error: 'bad_telegram' } });
  assert.deepEqual(await send({ address: ADDR, telegram: 'a'.repeat(33) }), { status: 400, body: { ok: false, error: 'bad_telegram' } });
  assert.deepEqual(await send('nope'), { status: 400, body: { ok: false, error: 'bad_json' } });
  assert.deepEqual(await send({ address: ADDR, telegram: 'leo_miner', pad: 'x'.repeat(2100) }), { status: 413, body: { ok: false, error: 'too_large' } });
  const get = await alerts.onRequest({ request: new Request('https://fabx-miner-desk.pages.dev/api/alerts'), env: { DB } });
  assert.equal(get.status, 405);
  assert.equal(DB.tables.alert_signups.length, 0);
  assert.equal(alerts.parseSignup({ address: ADDR, telegram: 'leo_miner', lang: 'de' }).lang, 'en');
});

test('alert signup caps one telegram handle at 20 addresses but still updates existing ones', async () => {
  const DB = fakeD1();
  const address = i => '0x' + i.toString(16).padStart(40, '0');
  for (let i = 1; i <= 20; i++) {
    const res = await alerts.onRequest({ request: post('/api/alerts', { address: address(i), telegram: 'leo_miner', lang: 'en' }), env: { DB } });
    assert.equal(res.status, 200);
  }
  const over = await alerts.onRequest({ request: post('/api/alerts', { address: address(21), telegram: 'leo_miner', lang: 'en' }), env: { DB } });
  assert.equal(over.status, 429);
  assert.deepEqual(await over.json(), { ok: false, error: 'limit' });
  const again = await alerts.onRequest({ request: post('/api/alerts', { address: address(3), telegram: '@LEO_MINER', lang: 'zh' }), env: { DB } });
  assert.equal(again.status, 200);
  const other = await alerts.onRequest({ request: post('/api/alerts', { address: address(21), telegram: 'someone_else', lang: 'en' }), env: { DB } });
  assert.equal(other.status, 200);
  assert.equal(DB.tables.alert_signups.length, 21);
});
