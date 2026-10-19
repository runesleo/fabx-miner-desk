import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../desk.mjs';
import { readFile } from 'node:fs/promises';

const word = n => BigInt(n).toString(16).padStart(64, '0');
const hex = n => '0x' + BigInt(n).toString(16);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const memoryStorage = () => {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
};
function mockData(t, logs = () => { throw new Error('unexpected log read'); }, quote = () => { throw new Error('ask book unavailable'); }) {
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).includes('dexscreener')) return { ok: true, json: async () => ({ pairs: [{ priceUsd: '4' }] }) };
    if (String(url).includes('/api/v5')) return { ok: true, json: async () => ({ data: [{ last: '50' }] }) };
    const payload = JSON.parse(init.body);
    const result = async req => {
      if (req.method === 'eth_getLogs') return { id: req.id, result: await logs(req, init.signal) };
      if (req.method === 'eth_blockNumber') return { id: req.id, result: hex(74_000_000) };
      if (req.method === 'eth_getBlockByNumber') return { id: req.id, result: { timestamp: hex(Number(req.params[0]) * 2) } };
      assert.equal(req.method, 'eth_call');
      const [{ to, data }, block] = req.params;
      if (to === engine.CFG.market || to === engine.CFG.multicall) {
        try { return { id: req.id, result: await quote(req, init.signal) }; }
        catch (error) { return { id: req.id, error: { code: 3, message: error.message } }; }
      }
      if (data.startsWith('0x70a08231')) return { id: req.id, error: { code: 3, message: 'balance read unavailable' } };
      if (to === engine.CFG.poolManager) {
        assert.equal(block, hex(74_000_000));
        assert.equal(data, '0x1e2eaeaf9f11333b5461b9121b4bf1bc65a4c3d0eb304f2cb60281f03b3fd60de4a9bf18');
        // Nonzero high tick/fee bits must never enter sqrtPrice.
        return { id: req.id, result: '0x' + word((123456n << 160n) | (2n ** 97n)) };
      }
      const v = { '0xef6aff46': 600_000, '0x6d1da431': 12, '0x78e97925': 1_700_000_000, '0x631f9852': 0 }[data];
      assert.notEqual(v, undefined, data);
      return { id: req.id, result: hex(v) };
    };
    return { ok: true, json: async () => Array.isArray(payload) ? Promise.all(payload.map(result)) : result(payload) };
  });
}

test('sqrtPrice conversion quotes one FAB in BEM, respecting currency order and decimals', () => {
  assert.equal(typeof engine.fabInBemFromSqrtPriceX96, 'function');
  close(engine.fabInBemFromSqrtPriceX96(2n ** 96n), 1);
  close(engine.fabInBemFromSqrtPriceX96(2n ** 97n), 0.25);
  assert.throws(() => engine.fabInBemFromSqrtPriceX96(0n), /sqrtPrice/);
});

test('snapshot returns Slot0 price and manual payback without any log dependency', async t => {
  const engine = await import(`../desk.mjs?test=${encodeURIComponent(t.name)}`);
  assert.equal(typeof engine.refreshOptional, 'function');
  mockData(t);
  const s = await engine.snapshot({ nandOkb: 0.1, storage: memoryStorage() });
  close(s.prices.fabBem, 0.25);
  close(s.prices.fabUsd, 1);
  assert.equal(s.prices.source, 'slot0');
  assert.equal(s.prices.anchorUsd, null);
  assert.equal(s.decision.ratio, null);
  assert.equal(s.decision.tier, null);
  assert.equal(s.availability.nand.state, 'manual');
  close(s.decision.paybackDays, 5 / (7128 / 1001));
});

test('snapshot total budget aborts slow I/O even when fetch ignores cancellation', async t => {
  const engine = await import(`../desk.mjs?budget=${encodeURIComponent(t.name)}`);
  mockData(t);
  const fetchData = globalThis.fetch;
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    signals.push(args[1].signal);
    await new Promise(resolve => setTimeout(resolve, 50));
    return fetchData(...args);
  });
  await assert.rejects(engine.snapshot({ timeoutMs: 15, storage: memoryStorage() }), /timeout/);
  assert.ok(signals.length > 0 && signals.every(signal => signal.aborted));
  // Let the deliberately uncooperative fake settle before restoring global fetch.
  await new Promise(resolve => setTimeout(resolve, 120));
});

test('wallet total budget includes ownership and cancels slow reads', async t => {
  const engine = await import(`../desk.mjs?budget=${encodeURIComponent(t.name)}`);
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal;
    await new Promise(resolve => setTimeout(resolve, 50));
    return { ok: true, json: async () => ({ id: JSON.parse(init.body).id, result: '0x' + word(0) }) };
  });
  await assert.rejects(engine.wallet(engine.CFG.exampleWallet, { head: 74_000_000, prices: { fabUsd: 1 } }, () => {}, { timeoutMs: 15 }), /timeout/);
  assert.equal(signal.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 60));
});

test('hung optional history and NAND are aborted at a hard deadline, retaining useful state', async t => {
  const engine = await import(`../desk.mjs?test=${encodeURIComponent(t.name)}`);
  assert.equal(typeof engine.refreshOptional, 'function');
  let aborted = 0;
  const hang = (_req, signal) => new Promise(() => { signal.addEventListener('abort', () => aborted++); });
  mockData(t, hang, hang);
  const storage = memoryStorage();
  const s = await engine.snapshot({ storage });
  const started = performance.now();
  const updates = [];
  const degraded = await engine.refreshOptional(s, { storage, timeoutMs: 25, onUpdate: v => updates.push(v) });
  assert.ok(performance.now() - started < 500);
  assert.ok(aborted >= 2);
  assert.equal(degraded.prices.fabUsd, 1);
  assert.equal(degraded.prices.anchorUsd, null);
  assert.equal(degraded.decision.nandOkb, null);
  assert.equal(degraded.availability.history.state, 'unavailable');
  assert.equal(degraded.availability.nand.state, 'unavailable');
  assert.match(degraded.availability.history.error, /timeout/i);
  assert.equal(updates.length, 2);
  const card = engine.assetCard(degraded, { rigs: [{ id: '1', status: 'mining', fabPerDay: 2 }] });
  assert.equal(card.usdPerDay, 2);
  assert.equal(card.valueUsd, null);
});

const swapLog = sqrt => ({ data: '0x' + word(1) + word(2) + word(sqrt), blockNumber: hex(74_000_000), logIndex: '0x2' });
function liveLogs(req) {
  const f = req.params[0];
  if (f.address === engine.CFG.poolManager) return [swapLog(2n ** 97n)];
  assert.fail('NAND must not scan logs');
}
function liveQuote(req) {
  assert.equal(req.params[1], hex(74_000_000));
  if (req.params[0].to === engine.CFG.market) return '0x' + word(1);
  const ask = [1, '0xbe6f94115d32f3ac3252bc4626573e739beeb714', 10n ** 17n, 0, 0, 200].map(word).join('');
  return '0x' + [32, 1, 32, 1, 64, 192].map(word).join('') + ask;
}

test('successful history and NAND cache independently; failures reuse values without resetting age', async t => {
  const engine = await import(`../desk.mjs?test=${encodeURIComponent(t.name)}`);
  assert.equal(typeof engine.refreshOptional, 'function');
  let failing = false;
  mockData(t, req => { if (failing) throw new Error('RPC unavailable'); return liveLogs(req); },
    req => { if (failing) throw new Error('ask book unavailable'); return liveQuote(req); });
  const storage = memoryStorage();
  const fresh = await engine.refreshOptional(await engine.snapshot({ storage }), { storage });
  close(fresh.prices.anchorUsd, 1);
  close(fresh.decision.nandOkb, 0.1);
  assert.equal(fresh.prices.crossCheck.state, 'match');
  assert.equal(fresh.availability.history.state, 'live');
  assert.equal(fresh.availability.nand.state, 'live');
  assert.match(fresh.decision.nandSource, /On-chain best ask · 200 NAND/);
  assert.deepEqual(fresh.decision.nandQuote, { kind: 'onchain-ask', qty: 200, hours: undefined });
  assert.equal(fresh.availability.nand.asOf, new Date(fresh.headTimestamp * 1000).toISOString());
  failing = true;
  const cached = await engine.snapshot({ storage });
  assert.equal(cached.availability.history.state, 'cached');
  assert.deepEqual(cached.decision.nandQuote, fresh.decision.nandQuote);
  close(cached.decision.nandOkb, 0.1);
  const old = await engine.refreshOptional(cached, { storage, timeoutMs: 25 });
  close(old.prices.anchorUsd, 1);
  close(old.decision.nandOkb, 0.1);
  assert.equal(old.availability.history.state, 'cached');
  assert.equal(old.availability.history.asOf, fresh.availability.history.asOf);
  assert.equal(old.availability.nand.asOf, fresh.availability.nand.asOf);
  assert.equal(old.prices.crossCheck, null);
});

test('manual NAND overrides cached and arriving market values; bad storage cannot break first screen', async t => {
  const engine = await import(`../desk.mjs?test=${encodeURIComponent(t.name)}`);
  assert.equal(typeof engine.refreshOptional, 'function');
  let marketReads = 0;
  mockData(t, liveLogs, req => { marketReads++; return liveQuote(req); });
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  const s = await engine.snapshot({ storage, nandOkb: 0.2 });
  const result = await engine.refreshOptional(s, { storage });
  assert.equal(result.decision.nandOkb, 0.2);
  assert.equal(result.availability.nand.state, 'manual');
  assert.equal(marketReads, 0);
  assert.equal(result.prices.anchorUsd, 1);
});

test('a mismatched last swap is exposed without replacing the state price', async t => {
  const engine = await import(`../desk.mjs?test=${encodeURIComponent(t.name)}`);
  assert.equal(typeof engine.refreshOptional, 'function');
  mockData(t, () => [swapLog(2n ** 96n)]);
  const s = await engine.snapshot({ nandOkb: 0.2, storage: memoryStorage() });
  const result = await engine.refreshOptional(s, { storage: memoryStorage() });
  close(result.prices.fabBem, 0.25);
  assert.equal(result.prices.crossCheck.state, 'different');
  close(result.prices.crossCheck.lastSwapBem, 1);
});

// Frozen on-chain evidence; this test never calls a provider.
test('recorded FAB/BEM Swap and packed Slot0 use the same token order and decimal conversion', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/fab-bem-swap.json', import.meta.url), 'utf8'));
  assert.equal(fixture.pool.poolId, engine.CFG.poolId);
  assert.equal(fixture.pool.stateSlot, engine.CFG.poolStateSlot);
  assert.equal(fixture.pool.currency0Symbol, 'BEM');
  assert.equal(fixture.pool.currency1Symbol, 'FAB');
  assert.equal(fixture.pool.currency0Decimals, 8);
  assert.equal(fixture.pool.currency1Decimals, 8);
  const fromLog = BigInt('0x' + fixture.log.data.slice(130, 194));
  const fromSlot = BigInt(fixture.slot0.extsloadResult) & ((1n << 160n) - 1n);
  assert.equal(fromSlot, fromLog);
  assert.equal(fromSlot.toString(), fixture.slot0.sqrtPriceX96);
  // Independent legacy formula, not just two paths through the new helper.
  const sqrt = Number(fromLog) / 2 ** 96;
  const legacyPrice = 1 / (sqrt * sqrt);
  close(legacyPrice, fixture.expectedFabInBem);
  close(engine.fabInBemFromSqrtPriceX96(fromSlot), fixture.expectedFabInBem);
  close(engine.fabInBemFromSwap(fixture.log), legacyPrice);
});

test('history publishes independently when NAND hangs, and aborting a refresh cannot overwrite cache', async t => {
  const engine = await import(`../desk.mjs?test=${encodeURIComponent(t.name)}`);
  mockData(t, liveLogs, () => new Promise(() => {}));
  const storage = memoryStorage();
  const s = await engine.snapshot({ storage });
  const updates = [];
  const enriched = await engine.refreshOptional(s, { storage, timeoutMs: 25, onUpdate: next => updates.push(next) });
  assert.equal(updates[0].availability.history.state, 'live');
  assert.equal(updates[0].availability.nand.state, 'pending');
  assert.equal(enriched.prices.anchorUsd, 1);
  assert.equal(enriched.availability.nand.state, 'unavailable');
  const before = storage.getItem('fmd.history.v1');
  const abort = new AbortController();
  abort.abort();
  await engine.refreshOptional(s, { storage, signal: abort.signal, onUpdate: () => assert.fail('aborted update published') });
  assert.equal(storage.getItem('fmd.history.v1'), before);
});

test('ownership balance failures are explicit, make no log reads, and leave state reads usable', async t => {
  const engine = await import(`../desk.mjs?test=${encodeURIComponent(t.name)}`);
  let requests = 0;
  mockData(t, () => { requests++; throw new Error('rate limit 429'); });
  const s = await engine.snapshot({ storage: memoryStorage() });
  await assert.rejects(() => engine.wallet(engine.CFG.exampleWallet, s), /ownedCircuits: balanceOf unavailable.*balance read unavailable/);
  assert.equal(requests, 0);
  const next = await engine.snapshot({ storage: memoryStorage() });
  assert.equal(next.prices.fabUsd, 1);
  assert.equal(requests, 0);
});

test('malformed or future cached values are ignored instead of becoming apparent live prices', async t => {
  const engine = await import(`../desk.mjs?test=${encodeURIComponent(t.name)}`);
  mockData(t);
  const storage = memoryStorage();
  storage.setItem('fmd.history.v1', '{bad json');
  storage.setItem('fmd.nand.v1', JSON.stringify({ asOf: '2999-01-01T00:00:00Z', head: 73_000_000, value: { okb: 100, qty: 100, hours: 1 } }));
  const s = await engine.snapshot({ storage });
  assert.equal(s.prices.anchorUsd, null);
  assert.equal(s.decision.nandOkb, null);
  assert.equal(s.availability.history.state, 'pending');
  assert.equal(s.availability.nand.state, 'pending');
});
