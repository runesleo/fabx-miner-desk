import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../desk.mjs';

const snapshot = {
  head: 73_573_806, headTimestamp: 1_792_342_842, blockTime: 1,
  asOf: '2026-10-18T17:00:44.000Z',
  network: { weight: 301_206_000, networkNand: 502_010 },
  prices: { fabUsd: 0.657863, okbUsd: 112.59 },
  decision: { nandOkb: 0.01879, nandSource: 'onchain-ask' },
  availability: { nand: { state: 'live', asOf: '2026-10-18T17:00:42.000Z' } },
};
const listing = (listingId, id, priceOkb, fabPerDay, status = 'measured') => ({ listingId, id, priceOkb, fabPerDay, status });
const rows = [listing('1334', '5595', 2.34, 1.19275056), listing('1333', '5594', 2.30, 1.19275056),
  listing('1332', '4580', 4, 2.300306), listing('1331', '1315', 2.8, 1.647132), listing('1330', '24', 1, 0.463448)];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const emission = { emissionRate: 8333333n, unverifiedBps: 100n };

test('entry comparison ranks direct buyer prices and solves the dilution-inclusive 1 FAB/day baseline', () => {
  const original = JSON.stringify({ snapshot, rows });
  const result = engine.entryComparison(snapshot, rows, emission);
  assert.deepEqual(result.ranked.map(row => row.id), ['1315', '4580', '5594', '5595', '24']);
  close(result.ranked[0].okbPerFabDay, 2.8 / 1.647132);
  close(result.ranked[0].apr, 1.647132 * (0.657863 / 112.59) * 365 / 2.8);
  close(result.baseline.nandRequired, 502010 / 7127);
  assert.equal(result.baseline.emissionVerified, true);
  assert.equal(result.baseline.emissionFabPerDay, 7128);
  close(result.baseline.okbPerFabDay, 502010 / 7127 * 0.01879);
  close(7128 * result.baseline.nandRequired / (502010 + result.baseline.nandRequired), 1);
  assert.equal(result.cheaper, 'build');
  close(result.deltaOkb, 2.8 / 1.647132 - result.baseline.okbPerFabDay);
  close(result.deltaPct, result.deltaOkb / (2.8 / 1.647132) * 100);
  assert.equal(JSON.stringify({ snapshot, rows }), original);
});

test('entry comparison never ranks incomplete scans, stopped rigs, unknown yields or invalid prices', () => {
  const invalid = [listing('1', '1', 1, 0, 'stopped'), listing('2', '2', 1, null, 'claimed-in-window'),
    listing('3', '3', 1, null, 'unread'), listing('4', '4', NaN, 2), listing('5', '5', 1, Infinity)];
  const result = engine.entryComparison(snapshot, [...rows, ...invalid], emission);
  assert.equal(result.ranked.length, 5);
  assert.equal(result.unknown.length, 5);
  const partial = engine.entryComparison(snapshot, rows, { ...emission, complete: false });
  assert.deepEqual(partial.ranked, []);
  assert.equal(partial.cheaper, null);
  assert.equal(partial.deltaOkb, null);
  assert.equal(partial.deltaPct, null);
});

test('entry comparison retains manual or missing NAND provenance without inventing a comparison', () => {
  const manual = engine.entryComparison({ ...snapshot, availability: { nand: { state: 'manual', asOf: null } },
    decision: { nandOkb: 0.1, nandSource: 'manual' } }, rows, emission);
  assert.equal(manual.baseline.nandState, 'manual');
  assert.equal(manual.baseline.nandSource, 'manual');
  assert.equal(manual.cheaper, 'listing');
  const unknown = engine.entryComparison({ ...snapshot, decision: { nandOkb: null } }, rows, emission);
  assert.equal(unknown.baseline.okbPerFabDay, null);
  assert.equal(unknown.ranked.length, 5);
  assert.equal(unknown.cheaper, null);
});

test('entry comparison requires explicit valid emission inputs before declaring either side cheaper', () => {
  for (const options of [{}, { emissionRate: 8333333n }, { unverifiedBps: 100n },
    { emissionRate: -1n, unverifiedBps: 100n }, { emissionRate: 8333333n, unverifiedBps: 10001n },
    { emissionRate: 8333333n, unverifiedBps: -1n }, { emissionRate: 8333333, unverifiedBps: 100n },
    { emissionRate: 2n ** 256n - 1n, unverifiedBps: 100n }]) {
    const result = engine.entryComparison(snapshot, rows, options);
    assert.equal(result.ranked.length, 5);
    assert.equal(result.baseline.emissionVerified, false);
    assert.equal(result.baseline.emissionFabPerDay, null);
    assert.equal(result.baseline.nandRequired, null);
    assert.equal(result.baseline.okbPerFabDay, null);
    for (const key of ['cheaper', 'deltaOkb', 'deltaPct']) assert.equal(result[key], null);
  }
});

test('verified zero or insufficient daily emission cannot support a 1 FAB/day build baseline', () => {
  for (const options of [{ emissionRate: 0n, unverifiedBps: 100n },
    { emissionRate: 1000n, unverifiedBps: 0n }, { emissionRate: 8333333n, unverifiedBps: 10000n }]) {
    const result = engine.entryComparison(snapshot, rows, options);
    assert.equal(result.baseline.emissionVerified, true);
    assert.ok(result.baseline.emissionFabPerDay >= 0 && result.baseline.emissionFabPerDay <= 1);
    assert.equal(result.baseline.nandRequired, null);
    assert.equal(result.baseline.okbPerFabDay, null);
    for (const key of ['cheaper', 'deltaOkb', 'deltaPct']) assert.equal(result[key], null);
  }
});

const uint = value => BigInt(value).toString(16).padStart(64, '0');
const hex = value => '0x' + BigInt(value).toString(16);
const abi = (...values) => '0x' + values.map(uint).join('');
const word = (data, byte) => BigInt('0x' + data.slice(byte * 2, (byte + 32) * 2));
function callsIn(data) {
  assert.equal(data.slice(0, 10), '0xbce38bd7');
  data = data.slice(10);
  const start = Number(word(data, 32)), count = Number(word(data, start));
  assert.ok(count > 0 && count <= 128, 'at most 128 leaf calls per aggregate');
  return Array.from({ length: count }, (_, i) => {
    const tuple = start + 32 + Number(word(data, start + 32 + i * 32));
    const bytes = tuple + Number(word(data, tuple + 32)), size = Number(word(data, bytes));
    return { to: '0x' + word(data, tuple).toString(16).padStart(40, '0'),
      data: '0x' + data.slice((bytes + 32) * 2, (bytes + 32 + size) * 2) };
  });
}
function aggregate(values) {
  const tuples = values.map(value => value == null ? uint(0) + uint(64) + uint(0)
    : uint(1) + uint(64) + uint((value.length - 2) / 2) + value.slice(2).padEnd(Math.ceil((value.length - 2) / 64) * 64, '0'));
  let offset = values.length * 32;
  return '0x' + uint(32) + uint(values.length) + tuples.map(tuple => {
    const prev = uint(offset); offset += tuple.length / 2; return prev;
  }).join('') + tuples.join('');
}
function memory() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map };
}
async function setup(t, options = {}) {
  const app = await import(`../desk.mjs?entry=${encodeURIComponent(t.name)}`);
  const { CFG } = app;
  const requests = [], leaves = [];
  const rigs = options.rigs ?? [{ id: 5595, price: 2.34 }];
  const total = options.total ?? rigs.length;
  const current = snapshot.head, previous = current - 600;
  const respond = (call, block) => {
    const selector = call.data.slice(0, 10), id = call.data.length > 10 ? Number(BigInt('0x' + call.data.slice(-64))) : null;
    leaves.push({ ...call, block });
    if (selector === '0xaaccf1ec') { assert.equal(call.to, CFG.rigMarket); return abi(total); }
    if (selector === '0xbeab7067') {
      assert.equal(call.to, CFG.rigMarket);
      if (id === options.failedListing) return null;
      const rig = rigs[id - 1];
      if (!rig) return abi(0, 0, 0, 0, 0, 0);
      return abi(BigInt(CFG.exampleWallet), BigInt(CFG.circuits), rig.id, BigInt(Math.round(rig.price * 1e18)), 100, 1);
    }
    assert.equal(call.to, CFG.mining);
    if (selector === '0xf9f8bdb7') return options.missingEmission ? null : abi(options.emissionRate ?? 8333333);
    if (selector === '0xd8d56ffb') return options.missingEmissionSplit ? null : abi(options.unverifiedBps ?? 100);
    const rig = rigs.find(row => row.id === id);
    assert.ok(rig);
    if (selector === '0x10eafa00') return rig.badKey ? '0x1234' : abi(id);
    const isCurrent = Number(block) === current;
    if (selector === '0x024b2c13') {
      if (!isCurrent && options.missingHistory) return null;
      if (!isCurrent && rig.sentinel) return abi(2n ** 256n - 1n);
      return abi(isCurrent ? rig.now ?? 1516031 : rig.before ?? 687732);
    }
    if (selector === '0x0527edc2') {
      if (!isCurrent && options.missingHistory) return null;
      const fields = Array(23).fill(0n);
      fields[0] = BigInt(CFG.circuits); fields[1] = BigInt(id); fields[8] = BigInt(snapshot.headTimestamp - 3600);
      fields[9] = 1n; fields[19] = rig.weightChanged && isCurrent ? 2n : 1n; fields[21] = rig.claimed && isCurrent ? 1n : 0n;
      return abi(...fields);
    }
    assert.equal(selector, '0xa6a20acd');
    return abi(rig.zeroWeight ? 0 : 1_192_750_56, 0, 7128 * 1e8, 1);
  };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body), parts = Array.isArray(body) ? body : [body];
    assert.ok(parts.length <= 5, 'HTTP batch <= 5');
    const replies = parts.map(req => {
      requests.push(req);
      if (req.method === 'eth_getBlockByNumber') return { id: req.id, result: options.missingHeader ? null :
        { timestamp: hex(snapshot.headTimestamp - (current - Number(req.params[0]))) } };
      assert.equal(req.method, 'eth_call', 'only reads; no logs or transactions');
      const [call, block] = req.params;
      assert.ok([current, previous].includes(Number(block)), 'all state reads pinned to snapshot blocks');
      const result = call.to === CFG.multicall ? aggregate(callsIn(call.data).map(leaf => respond(leaf, block))) : respond(call, block);
      return result == null ? { id: req.id, error: { code: 3, message: 'execution reverted' } } : { id: req.id, result };
    });
    return { ok: true, json: async () => Array.isArray(body) ? replies.reverse() : replies[0] };
  });
  return { app, requests, leaves, options, run: (opts = {}) => app.loadEntryComparison(snapshot, { storage: null, ...opts }) };
}

test('entry loader fully scans inclusive IDs and measures real-time pending at pinned block timestamps', async t => {
  const f = await setup(t, { total: 260 });
  const result = await f.run();
  assert.equal(result.state, 'live', result.error);
  assert.equal(result.totalScanned, 260);
  assert.equal(result.validCount, 1);
  assert.equal(result.head, snapshot.head);
  assert.equal(result.previousHead, snapshot.head - 600);
  assert.equal(result.windowSeconds, 600);
  close(result.ranked[0].fabPerDay, 1.19275056);
  assert.equal(result.ranked[0].url, `https://fabx.tech/c/${engine.CFG.circuits}/5595`);
  const scanned = f.leaves.filter(row => row.data.startsWith('0xbeab7067'));
  assert.equal(Number(BigInt('0x' + scanned[0].data.slice(-64))), 1);
  assert.equal(Number(BigInt('0x' + scanned.at(-1).data.slice(-64))), 260);
  assert.equal(f.leaves.some(row => row.data.startsWith('0x1808eeb8')), false, 'never use raw pending');
});

test('entry yield excludes claims with positive deltas, sentinels, missing keys, stopped and inconsistent rates', async t => {
  const f = await setup(t, { rigs: [{ id: 1, price: 1 }, { id: 2, price: 1, claimed: true },
    { id: 3, price: 1, sentinel: true }, { id: 4, price: 1, badKey: true },
    { id: 5, price: 1, now: 687732, zeroWeight: true }, { id: 6, price: 1, now: 3000000 }, { id: 7, price: 1, now: 1 }] });
  const result = await f.run();
  assert.equal(result.ranked.length, 1);
  assert.equal(result.unknown.length, 6);
  assert.equal(result.unknown.find(row => row.id === '2').status, 'claimed-in-window');
  assert.equal(result.unknown.find(row => row.id === '3').status, 'unread');
  assert.equal(result.unknown.find(row => row.id === '4').status, 'unread');
  assert.equal(result.unknown.find(row => row.id === '5').status, 'stopped');
  assert.equal(result.unknown.find(row => row.id === '6').status, 'rate-mismatch');
  assert.equal(result.unknown.find(row => row.id === '7').status, 'claimed-in-window');
});

test('missing historical state preserves complete coverage but leaves production unknown', async t => {
  const f = await setup(t, { missingHistory: true });
  const result = await f.run();
  assert.equal(result.state, 'live', result.error);
  assert.equal(result.complete, true);
  assert.equal(result.ranked.length, 0);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.cheaper, null);
});

test('failed enumeration returns a frozen complete cache, never partial rankings mixed with new prices', async t => {
  const f = await setup(t, { total: 260 });
  const storage = memory();
  const first = await f.run({ storage });
  assert.equal(first.state, 'live', first.error);
  assert.equal(storage.map.size, 1);
  f.options.failedListing = 130;
  const next = await f.app.loadEntryComparison({ ...snapshot, decision: { nandOkb: 999 }, prices: { fabUsd: 999, okbUsd: 1 } }, { storage });
  assert.equal(next.state, 'cached');
  assert.deepEqual(next.ranked, first.ranked);
  assert.deepEqual(next.baseline, first.baseline);
  assert.equal(next.head, first.head);
  assert.equal(next.asOf, first.asOf);
  assert.match(next.error, /listing/i);
  const missing = await f.run();
  assert.equal(missing.state, 'unavailable');
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.ranked, []);
});

test('entry loader deadline cancels outstanding IO without saving or displaying a late partial scan', async t => {
  const f = await setup(t);
  const storage = memory();
  let signal;
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  });
  const result = await f.run({ storage, timeoutMs: 20 });
  assert.equal(result.state, 'unavailable');
  assert.equal(signal.aborted, true);
  assert.equal(storage.map.size, 0);
  assert.deepEqual(result.ranked, []);
});

test('entry yield rate crosscheck reads the pinned current emission rate instead of assuming a permanent reward schedule', async t => {
  const f = await setup(t, { emissionRate: 4166666, rigs: [{ id: 1, price: 1, now: 1101881 }] });
  const result = await f.run();
  assert.equal(result.ranked.length, 1);
  close(result.ranked[0].fabPerDay, (1101881 - 687732) / 1e8 * 144);
  assert.equal(result.baseline.emissionVerified, true);
  assert.equal(result.baseline.emissionFabPerDay, 3564);
  close(result.baseline.okbPerFabDay, 2.647422930115072); // 502010 / (3564 - 1) * 0.01879.
  assert.equal(result.cheaper, 'listing');
  const emissionReads = f.leaves.filter(row => ['0xf9f8bdb7', '0xd8d56ffb'].includes(row.data));
  assert.equal(emissionReads.length, 2);
  assert.ok(emissionReads.every(row => Number(row.block) === snapshot.head));
});

for (const options of [{ missingEmission: true }, { missingEmissionSplit: true }, { unverifiedBps: 10001 }, { emissionRate: 0 }]) {
  test(`entry loader keeps emission failure or zero explicit with no listings: ${JSON.stringify(options)}`, async t => {
    const f = await setup(t, { ...options, rigs: [] });
    const result = await f.run();
    assert.equal(result.state, 'live');
    assert.equal(result.complete, true);
    assert.equal(result.validCount, 0);
    assert.equal(result.baseline.emissionVerified, options.emissionRate === 0);
    assert.equal(result.baseline.emissionFabPerDay, options.emissionRate === 0 ? 0 : null);
    assert.equal(result.baseline.okbPerFabDay, null);
    assert.equal(result.cheaper, null);
  });
}

test('entry loader does not reuse fixed-emission legacy comparisons when a new scan fails', async t => {
  const f = await setup(t);
  const first = await f.run();
  const storage = memory();
  const legacy = { ...first, baseline: { ...first.baseline }, cheaper: 'build' };
  delete legacy.baseline.emissionFabPerDay;
  delete legacy.baseline.emissionVerified;
  storage.setItem('fmd.entry.v1', JSON.stringify(legacy));
  f.options.failedListing = 1;
  const result = await f.run({ storage });
  assert.equal(result.state, 'unavailable');
  assert.equal(result.cheaper, null);
  assert.deepEqual(result.ranked, []);
});

test('entry cache observation age comes from the chain block, including slow scans', async t => {
  const f = await setup(t);
  const result = await f.run();
  assert.equal(result.asOf, new Date(snapshot.headTimestamp * 1000).toISOString());
  assert.equal(result.priceAsOf, snapshot.asOf, 'price retrieval time remains distinct from chain observation time');
});

test('entry yield treats in-window weight changes as unknown even when the pending delta looks plausible', async t => {
  const f = await setup(t, { rigs: [{ id: 1, price: 1, weightChanged: true }] });
  const result = await f.run();
  assert.equal(result.ranked.length, 0);
  assert.equal(result.unknown[0].status, 'changed-in-window');
});


test('entry excludes unchanged rewards with a positive current emission rate as inconsistent', async t => {
  const f = await setup(t, { rigs: [{ id: 1, price: 1, now: 687732 }] });
  const result = await f.run();
  assert.equal(result.ranked.length, 0);
  assert.equal(result.unknown[0].status, 'rate-mismatch');
  assert.equal(result.unknown[0].fabPerDay, null);
});
