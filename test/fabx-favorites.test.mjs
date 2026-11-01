import test from 'node:test';
import assert from 'node:assert/strict';
import { createFavorites, favoriteSummary, refreshFavorites } from '../fabx-favorites.mjs';

const A = '0x' + 'aB'.repeat(20);
const B = '0x' + '12'.repeat(20);
const C = '0x' + '34'.repeat(20);
function storage(value = null) {
  let raw = value;
  return { getItem() { return raw; }, setItem(key, value) { raw = value; }, raw() { return raw; } };
}

test('saved addresses survive a fresh instance and normalize without duplicates or extra wallet data', () => {
  const disk = storage();
  const favorites = createFavorites({ storage: disk });
  assert.deepEqual(favorites.list(), []);
  assert.deepEqual(favorites.add('  ' + A + '  '), { ok: true, saved: true, addresses: [A.toLowerCase()] });
  favorites.add(A.toLowerCase());
  favorites.add(B);
  assert.deepEqual(JSON.parse(disk.raw()), [A.toLowerCase(), B]);
  assert.deepEqual(createFavorites({ storage: disk }).list(), [A.toLowerCase(), B]);
  assert.equal(favorites.add('<script>bad</script>').error, 'invalid-address');
  const copy = favorites.list();
  copy.push(C);
  assert.deepEqual(favorites.list(), [A.toLowerCase(), B]);
  assert.deepEqual(favorites.remove(A), { ok: true, saved: true, addresses: [B] });
  assert.deepEqual(createFavorites({ storage: disk }).list(), [B]);
});

test('corrupt and non-address stored values are safely ignored and startup work is bounded', () => {
  for (const bad of ['{bad', '{}', 'null', '"hello"']) {
    assert.deepEqual(createFavorites({ storage: storage(bad) }).list(), []);
  }
  const favorites = createFavorites({ storage: storage(JSON.stringify([A, 'bad', A.toLowerCase(), B, C])), maxAddresses: 2 });
  assert.deepEqual(favorites.list(), [A.toLowerCase(), B]);
  assert.equal(favorites.add(C).error, 'limit');
  assert.deepEqual(favorites.list(), [A.toLowerCase(), B]);
});

test('browser storage getter and read failures never prevent using favorites in this page', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : delete globalThis.localStorage);
  const favorites = createFavorites();
  assert.deepEqual(favorites.add(A), { ok: true, saved: false, addresses: [A.toLowerCase()], error: 'storage-unavailable' });
  assert.deepEqual(favorites.list(), [A.toLowerCase()]);
  const blocked = createFavorites({ storage: { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } } });
  assert.equal(blocked.add(B).saved, false);
  assert.deepEqual(blocked.list(), [B]);
});

test('quota failure is reported without discarding the in-memory add or remove', () => {
  const disk = storage(JSON.stringify([A]));
  disk.setItem = () => { throw new Error('QuotaExceededError'); };
  const favorites = createFavorites({ storage: disk });
  assert.equal(favorites.add(B).saved, false);
  assert.deepEqual(favorites.list(), [A.toLowerCase(), B]);
  assert.equal(favorites.remove(A).saved, false);
  assert.deepEqual(favorites.list(), [B]);
});

test('overview keeps partial daily output, chain anomalies and unknowns distinct', () => {
  assert.deepEqual(favoriteSummary({ circuits: 6, discovery: { expected: 8, complete: false }, rigs: [
    { fabPerDay: 2, chainStatus: 1, pool: 'verified' },
    { fabPerDay: 0, chainStatus: 3 },
    { fabPerDay: 0.1, chainStatus: 1, pool: 'unverified' },
    { fabPerDay: null, chainStatus: 2 },
    { fabPerDay: null, chainStatus: null, status: 'unread' },
    { fabPerDay: null, chainStatus: 1, pool: 'mixed' },
  ] }), { circuits: 6, expected: 8, discoveryComplete: false, measured: 3, fabPerDay: 2.1,
    productionComplete: false, anomalies: 4, unknown: 1 });
});

test('unknown production never becomes zero while an empty confirmed wallet does', () => {
  const unread = favoriteSummary({ circuits: 1, discovery: { expected: 1, complete: true }, rigs: [
    { fabPerDay: null, chainStatus: 1 },
  ] });
  assert.equal(unread.fabPerDay, null);
  assert.equal(unread.unknown, 1);
  assert.equal(unread.anomalies, 0);
  assert.equal(unread.productionComplete, false);
  const missing = favoriteSummary({ circuits: 2, discovery: { expected: 2, complete: true }, rigs: [] });
  assert.equal(missing.fabPerDay, null);
  assert.equal(missing.unknown, 2);
  const empty = favoriteSummary({ circuits: 0, discovery: { expected: 0, complete: true }, rigs: [] });
  assert.equal(empty.fabPerDay, 0);
  assert.equal(empty.productionComplete, true);
  const zero = favoriteSummary({ circuits: 1, discovery: { expected: 1, complete: true }, rigs: [
    { fabPerDay: 0, chainStatus: 0 },
  ] });
  assert.equal(zero.fabPerDay, 0);
  assert.equal(zero.anomalies, 1);
});

test('malformed production and unknown chain codes stay unknown in overview', () => {
  const summary = favoriteSummary({ circuits: 3, discovery: { expected: 3, complete: true }, rigs: [
    { fabPerDay: NaN, chainStatus: 4 }, { fabPerDay: -1, chainStatus: null },
    { fabPerDay: Infinity, chainStatus: 1, pool: 'verified' },
  ] });
  assert.equal(summary.fabPerDay, null);
  assert.equal(summary.measured, 0);
  assert.equal(summary.unknown, 2);
});

test('startup refresh publishes one overview per address and continues after an address fails', async () => {
  const updates = [], running = [];
  const results = await refreshFavorites([A, B, C], {
    readWallet: async (address, { signal }) => {
      assert.equal(running.length, 0, 'saved addresses must not flood the RPC concurrently');
      running.push(address);
      await Promise.resolve();
      running.pop();
      if (address === B) throw new Error('RPC unavailable');
      return { address, circuits: 0, discovery: { expected: 0, complete: true }, rigs: [] };
    },
    onUpdate: update => updates.push(update),
  });
  assert.deepEqual(updates.map(row => [row.address, row.status]), [[A.toLowerCase(), 'ready'], [B, 'error'], [C, 'ready']]);
  assert.equal(updates[0].summary.fabPerDay, 0);
  assert.equal(updates[1].error, 'RPC unavailable');
  assert.equal(results.length, 3);
});

test('canceled refresh cannot publish late results or start the next address', async () => {
  const controller = new AbortController(), updates = [], calls = [];
  let release;
  const refreshing = refreshFavorites([A, B], {
    signal: controller.signal,
    readWallet: async (address, { signal }) => {
      assert.equal(signal, controller.signal);
      calls.push(address);
      return new Promise(resolve => { release = resolve; });
    },
    onUpdate: update => updates.push(update),
  });
  controller.abort();
  release({ circuits: 0, discovery: { expected: 0, complete: true }, rigs: [] });
  assert.deepEqual(await refreshing, []);
  assert.deepEqual(updates, []);
  assert.deepEqual(calls, [A.toLowerCase()]);
});
