import test from 'node:test';
import assert from 'node:assert/strict';
import * as hit from '../functions/api/hit.js';
import * as alerts from '../functions/api/alerts.js';
import * as feedback from '../functions/api/feedback.js';
import * as market from '../functions/api/market.js';

// In-memory stand-in for the D1 statements the two handlers use (prepare/bind/run/first).
function fakeD1() {
  const tables = { hits: [], alert_signups: [], feedback: [], market_fab_24h: [] }, calls = [];
  const exec = (sql, args) => {
    if (/^INSERT INTO hits/.test(sql)) {
      const [day, path, lang, ref, cid, ts, surface] = args;
      tables.hits.push({ day, path, lang, ref, cid, ts, surface });
      return { first: null };
    }
    if (/^SELECT COUNT\(\*\) AS n/.test(sql)) {
      const [address, chain, telegram] = args;
      const rows = tables.alert_signups.filter(r => r.telegram === telegram);
      return { first: { n: rows.length, same: rows.filter(r => r.address === address && r.chain === chain).length || null } };
    }
    if (/^INSERT INTO feedback/.test(sql)) {
      const [text, lang, source, page, created_at] = args;
      tables.feedback.push({ text, lang, source, page, telegram: null, created_at });
      return { first: null };
    }
    if (/^INSERT INTO alert_signups/.test(sql)) {
      const [address, telegram, lang, chain, created_at, updated_at] = args;
      const row = tables.alert_signups.find(r => r.address === address && r.telegram === telegram && r.chain === chain);
      if (row) Object.assign(row, { lang, updated_at });
      else tables.alert_signups.push({ address, telegram, lang, chain, created_at, updated_at });
      return { first: null };
    }
    if (/FROM market_fab_24h/.test(sql)) {
      const row = tables.market_fab_24h[0] || null;
      return { first: row };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const stmt = (sql, args = []) => ({
    run: async () => (exec(sql, args), { success: true }),
    first: async (column) => {
      const row = exec(sql, args).first;
      return column ? (row?.[column] ?? null) : row;
    },
  });
  return {
    tables, calls,
    prepare(sql) {
      const api = {
        bind(...args) {
          calls.push({ sql, args });
          return stmt(sql, args);
        },
        run: async () => stmt(sql, []).run(),
        first: async (column) => stmt(sql, []).first(column),
      };
      return api;
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
  assert.deepEqual(Object.keys(row).sort(), ['cid', 'day', 'lang', 'path', 'ref', 'surface', 'ts']);
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
  assert.equal(hit.parseHit({ cid: CID, path: '/v/9/rigs/index.html', lang: 'en' }).path, '/rigs');
  assert.equal(hit.parseHit({ cid: CID, path: '/v/1/', lang: 'en' }).path, '/');
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

test('hit records deweb surface from Origin on cross-origin posts', async () => {
  const DB = fakeD1();
  const origin = 'https://r1-dc945fd3aee9829a3c9065459e82aa503572da5f-deweb.fabx.tech';
  const res = await hit.onRequest({
    request: post('/api/hit', { cid: CID, path: '/v/2/', lang: 'en' }, { Origin: origin }),
    env: { DB },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
  assert.equal(DB.tables.hits[0].surface, 'deweb');
});

test('hit OPTIONS preflight for DeWeb', async () => {
  const origin = 'https://r1-dc945fd3aee9829a3c9065459e82aa503572da5f-deweb.fabx.tech';
  const res = await hit.onRequest({ request: new Request('https://fabx-miner-desk.pages.dev/api/hit', { method: 'OPTIONS', headers: { Origin: origin } }), env: {} });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
});

test('market GET returns stored median payload and OPTIONS for DeWeb', async () => {
  const DB = fakeD1();
  DB.tables.market_fab_24h.push({
    id: 1, median_bem: 0.2, low_bem: 0.15, high_bem: 0.25, last_swap_bem: 0.21, swaps_24h: 9, head: 1, computed_at: '2026-10-22T09:00:00.000Z',
  });
  const origin = 'https://r1-dc945fd3aee9829a3c9065459e82aa503572da5f-deweb.fabx.tech';
  const res = await market.onRequest({ request: new Request('https://fabx-miner-desk.pages.dev/api/market', { method: 'GET', headers: { Origin: origin } }), env: { DB } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.medianBem, 0.2);
  assert.equal(body.swaps24h, 9);
  const opt = await market.onRequest({ request: new Request('https://fabx-miner-desk.pages.dev/api/market', { method: 'OPTIONS', headers: { Origin: origin } }), env: { DB } });
  assert.equal(opt.status, 204);
  assert.match(opt.headers.get('access-control-allow-methods'), /GET/);
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
  assert.equal(DB.tables.alert_signups[0].chain, 'xlayer');
  assert.deepEqual(Object.keys(DB.tables.alert_signups[0]).sort(), ['address', 'chain', 'created_at', 'lang', 'telegram', 'updated_at']);
  const bscAddr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.deepEqual(await send({ address: bscAddr, telegram: 'leo_miner', lang: 'zh', chain: 'bsc' }), { status: 200, body: { ok: true } });
  assert.equal(DB.tables.alert_signups.length, 2);
  assert.equal(DB.tables.alert_signups.find(row => row.chain === 'bsc').address, bscAddr);
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

test('feedback stores text, language and page only; trims, caps at 500 chars and rejects empty or non-POST', async () => {
  const DB = fakeD1();
  const res = await feedback.onRequest({ request: post('/api/feedback', { text: '  想看\n BSC   矿机  ', lang: 'zh', page: '/rigs/' }), env: { DB } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(DB.tables.feedback.length, 1);
  assert.deepEqual({ ...DB.tables.feedback[0], created_at: null }, { text: '想看 BSC 矿机', lang: 'zh', source: 'site', page: '/rigs', telegram: null, created_at: null });
  assert.match(DB.tables.feedback[0].created_at, /^\d{4}-\d{2}-\d{2}T/);
  const stored = JSON.stringify(DB.calls);
  for (const secret of [IP, UA, 'TestBrowser']) assert.ok(!stored.includes(secret), `stored ${secret}`);
  const status = async (body, extra) => (await feedback.onRequest({ request: post('/api/feedback', body, extra), env: { DB } })).status;
  assert.equal(await status({ text: '   ', lang: 'en', page: '/' }), 400);
  assert.equal(await status({ lang: 'en' }), 400);
  assert.equal(await status({ text: 'x'.repeat(501), lang: 'en', page: '/' }), 400);
  assert.equal(await status('{bad'), 400);
  assert.equal(await status({ text: 'x'.repeat(5000) }), 413);
  assert.equal(await status({ text: 'fine', lang: 'fr', page: '/admin' }), 200, 'unknown language and page fall back');
  assert.deepEqual([DB.tables.feedback.at(-1).lang, DB.tables.feedback.at(-1).page], ['en', '/']);
  assert.equal((await feedback.onRequest({ request: new Request('https://fabx-miner-desk.pages.dev/api/feedback'), env: { DB } })).status, 405);
  assert.equal((await feedback.onRequest({ request: post('/api/feedback', { text: 'hi' }), env: {} })).status, 503);
});
