import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { d1 } from './helpers/d1.mjs';
import {
  MARKET_LOG_HEAD_KEY,
  runMarketUpdate,
  rowToMarketApi,
  statsFromBemSeries,
  estimateBlockTimestamp,
} from '../alerts/market.mjs';
import * as marketApi from '../functions/api/market.js';
import { parseMarketResponse, fetchServerMarket } from '../market-client.mjs';
import { applyHistory, refreshOptional } from '../desk.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/fab-bem-swap.json', import.meta.url), 'utf8'));
const SNAP = { head: 73_000_000, headTimestamp: 1_800_000_000, blockTime: 2 };

function swapAt(block, logIndex = 1) {
  return {
    ...fixture.log,
    blockNumber: '0x' + block.toString(16),
    logIndex: '0x' + logIndex.toString(16),
  };
}

test('runMarketUpdate incrementally scans only blocks after the stored cursor', async () => {
  const db = d1();
  const ranges = [];
  const logsChunked = async (_filter, from, to) => { ranges.push([from, to]); return []; };
  const day = Math.round(86400 / SNAP.blockTime);
  await runMarketUpdate(db, SNAP, { logsChunked, maxBlocksPerRun: Infinity, now: () => new Date('2026-10-22T00:00:00.000Z') });
  assert.deepEqual(ranges, [[Math.max(0, SNAP.head - day), SNAP.head]]);
  await runMarketUpdate(db, { ...SNAP, head: SNAP.head + 500, headTimestamp: SNAP.headTimestamp + 1000 }, { logsChunked, maxBlocksPerRun: Infinity });
  assert.deepEqual(ranges[1], [SNAP.head + 1, SNAP.head + 500]);
  const head = await db.prepare("SELECT value FROM alert_worker_state WHERE key = ?").bind(MARKET_LOG_HEAD_KEY).first('value');
  assert.equal(Number(head), SNAP.head + 500);
});

test('runMarketUpdate stores median, range and sample count from new swap logs', async () => {
  const db = d1();
  const bem = fixture.expectedFabInBem;
  const logs = [swapAt(SNAP.head - 10, 1), swapAt(SNAP.head - 5, 2)];
  const logsChunked = async () => logs;
  const result = await runMarketUpdate(db, SNAP, { logsChunked, maxBlocksPerRun: Infinity, now: () => new Date('2026-10-22T12:00:00.000Z') });
  assert.equal(result.swaps24h, 2);
  assert.ok(Math.abs(result.medianBem - bem) < 1e-9);
  const row = await db.prepare('SELECT * FROM market_fab_24h WHERE id = 1').first();
  assert.ok(row);
  const api = rowToMarketApi(row);
  assert.equal(api.swaps24h, 2);
  assert.equal(api.computedAt, '2026-10-22T12:00:00.000Z');
});

test('logsChunked 429 block-cap shrink still lets runMarketUpdate finish via injected reader', async t => {
  const mod = await import(`../desk.mjs?market429=${Date.now()}`);
  const db = d1();
  const filter = mod.swapLogFilter?.() || { address: mod.CFG.poolManager, topics: ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', mod.CFG.poolId] };
  let logCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const payload = JSON.parse(init.body);
    if (payload.method !== 'eth_getLogs') {
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: payload.id, result: '0x1' }) };
    }
    logCalls++;
    const from = Number.parseInt(payload.params[0].fromBlock, 16);
    const to = Number.parseInt(payload.params[0].toBlock, 16);
    if (to - from + 1 > 1000) {
      return { ok: false, status: 429, headers: { get: () => null }, text: async () => JSON.stringify({ message: 'limited to 1000 blocks' }) };
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: payload.id, result: [] }) };
  });
  await runMarketUpdate(db, SNAP, { logsChunked: (f, lo, hi, signal) => mod.logsChunked(f || filter, lo, hi, signal) });
  assert.ok(logCalls >= 3);
});

test('GET /api/market returns CORS JSON with median fields', async () => {
  const DB = d1();
  await DB.prepare(`INSERT INTO market_fab_24h (id, median_bem, low_bem, high_bem, last_swap_bem, swaps_24h, head, computed_at)
    VALUES (1, 0.2, 0.18, 0.22, 0.21, 12, 80000000, '2026-10-22T08:00:00.000Z')`).run();
  const origin = 'https://r1-dc945fd3aee9829a3c9065459e82aa503572da5f-deweb.fabx.tech';
  const res = await marketApi.onRequest({
    request: new Request('https://fabx-miner-desk.pages.dev/api/market', { method: 'GET', headers: { Origin: origin } }),
    env: { DB },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.swaps24h, 12);
  assert.equal(body.computedAt, '2026-10-22T08:00:00.000Z');
});

test('GET /api/market 503 when snapshot row is missing', async () => {
  const res = await marketApi.onRequest({
    request: new Request('https://fabx-miner-desk.pages.dev/api/market', { method: 'GET' }),
    env: { DB: d1() },
  });
  assert.equal(res.status, 503);
});

test('parseMarketResponse and fetchServerMarket gate bad payloads; refreshOptional keeps browser fallback', async t => {
  assert.equal(parseMarketResponse(null), null);
  assert.equal(parseMarketResponse({ medianBem: 1, lowBem: 2, highBem: 3, lastSwapBem: 1, swaps24h: 1, computedAt: '2026-01-01T00:00:00.000Z' }), null);
  const good = parseMarketResponse({
    medianBem: 0.2, lowBem: 0.1, highBem: 0.3, lastSwapBem: 0.25, swaps24h: 4, computedAt: '2026-10-22T08:00:00.000Z',
  });
  assert.ok(good?.value.medianBem === 0.2);

  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetchCalls++;
    if (String(url).includes('/api/market')) {
      return { ok: true, json: async () => ({ medianBem: 0.2, lowBem: 0.1, highBem: 0.3, lastSwapBem: 0.25, swaps24h: 4, computedAt: '2026-10-22T08:00:00.000Z' }) };
    }
    throw new Error('unexpected fetch');
  });
  const server = await fetchServerMarket({ location: { hostname: 'fabx-miner-desk.pages.dev' } });
  assert.equal(fetchCalls, 1);
  assert.equal(server.asOf, '2026-10-22T08:00:00.000Z');

  const snap = {
    head: 80_000_000, blockTime: 2, asOf: '2026-10-22T00:00:00.000Z',
    prices: { fabUsd: 2, fabBem: 0.2, bemUsd: 10, okbUsd: 50, source: 'slot0', crossCheck: null, anchorUsd: null, lowUsd: null, highUsd: null, rangePos: null, swaps24h: null, asOf: '2026-10-22T00:00:00.000Z' },
    network: { weight: 1, networkNand: 1, miners: 1, sealed: true, startTime: 0, burnedPctEst: 0, fabPerNandDay: 1, verifiedFabPerDay: 1, usdPerNandDay: 2 },
    decision: { nandOkb: null, nandSource: null, okbPerFabDay: null, paybackDays: null, ratio: null, tier: null },
    availability: { history: { state: 'pending' }, nand: { state: 'skipped' } },
    rule: [],
  };
  const withServer = applyHistory(snap, server.value, true);
  assert.equal(withServer.prices.anchorUsd, 2);

  let logScans = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const payload = init.body ? JSON.parse(init.body) : null;
    if (payload?.method === 'eth_getLogs') { logScans++; return { ok: true, json: async () => ({ jsonrpc: '2.0', id: payload.id, result: [] }) }; }
    if (String(url).includes('dexscreener') || String(url).includes('okx.com')) {
      return { ok: true, json: async () => ({ pairs: [{ priceUsd: '10' }], data: [{ last: '50' }] }) };
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + (1n).toString(16) }) };
  });
  const afterSkip = await refreshOptional(snap, { skipHistory: true, skipNand: true, timeoutMs: 2000 });
  assert.equal(logScans, 0);
  assert.equal(afterSkip.availability.history.state, 'pending');
  const beforeBrowser = logScans;
  await refreshOptional(snap, { skipNand: true, timeoutMs: 2000 });
  assert.ok(logScans > beforeBrowser, 'browser fallback still scans logs when server data is not applied');
});

test('estimateBlockTimestamp and statsFromBemSeries enforce ordering', () => {
  assert.equal(estimateBlockTimestamp(SNAP.head, SNAP.head, SNAP.headTimestamp, SNAP.blockTime), SNAP.headTimestamp);
  assert.equal(statsFromBemSeries([0.2, 0.3, 0.25]).medianBem, 0.25);
  assert.equal(statsFromBemSeries([]), null);
});

test('cold backfill is split across runs and publishes only once caught up', async () => {
  const { runMarketUpdate, MARKET_LOG_HEAD_KEY } = await import('../alerts/market.mjs');
  const state = new Map(); const writes = [];
  const stmt = (sql) => ({
    bind: (...args) => ({
      first: async () => (sql.includes('alert_worker_state') && sql.startsWith('SELECT') ? state.get(args[0]) ?? null : null),
      run: async () => { if (sql.includes('alert_worker_state')) state.set(args[0], args[1]); if (sql.includes('market_fab_24h')) writes.push(args); },
      all: async () => ({ results: [{ bem_per_fab: 2 }] }),
    }),
  });
  const db = { prepare: stmt, batch: async () => {} };
  const ranges = [];
  const opts = { maxBlocksPerRun: 30_000, logsChunked: async (_f, from, to) => { ranges.push([from, to]); return []; } };
  const snap = { head: 100_000, headTimestamp: 1_000_000, blockTime: 1 };
  const first = await runMarketUpdate(db, snap, opts);
  assert.equal(first.backfilling, true);
  assert.equal(writes.length, 0);
  assert.equal(state.get(MARKET_LOG_HEAD_KEY), String(13_600 + 30_000 - 1));
  let r = first;
  for (let i = 0; i < 5 && r.backfilling; i++) r = await runMarketUpdate(db, snap, opts);
  assert.equal(r.backfilling, false);
  assert.equal(writes.length, 1);
  assert.equal(ranges.at(-1)[1], 100_000);
});
