import test from 'node:test';
import assert from 'node:assert/strict';

const HEAD = 73_571_475;
const OTHER = '0x1111111111111111111111111111111111111111';
const uint = value => BigInt(value).toString(16).padStart(64, '0');
const encodedUint = value => '0x' + uint(value);
const ownerWord = owner => '0x' + owner.slice(2).toLowerCase().padStart(64, '0');
const readWord = (data, byte) => BigInt('0x' + data.slice(byte * 2, (byte + 32) * 2));
const json = body => ({ ok: true, status: 200, json: async () => body });
const revert = () => ({ error: { code: 3, message: 'execution reverted' } });

// Independent ABI fixture for tryAggregate(bool,(address,bytes)[]). Parsing the input
// also verifies that production only asks Multicall3 to read this collection's ownerOf.
function aggregateIds(calldata, circuits) {
  assert.equal(calldata.slice(0, 10), '0xbce38bd7');
  const data = calldata.slice(10);
  assert.equal(readWord(data, 0), 0n);
  const array = Number(readWord(data, 32));
  assert.equal(array, 64);
  const count = Number(readWord(data, array));
  assert.ok(count > 0 && count <= 256);
  return Array.from({ length: count }, (_, index) => {
    const tuple = array + 32 + Number(readWord(data, array + 32 + index * 32));
    assert.equal(readWord(data, tuple), BigInt(circuits));
    const bytes = tuple + Number(readWord(data, tuple + 32));
    assert.equal(readWord(data, bytes), 36n);
    assert.equal(data.slice((bytes + 32) * 2, (bytes + 36) * 2), '6352211e');
    return readWord(data, bytes + 36);
  });
}

function aggregateResult(owners) {
  const tuples = owners.map(owner => owner == null
    ? uint(0) + uint(64) + uint(0)
    : uint(1) + uint(64) + uint(32) + ownerWord(owner).slice(2));
  let offset = owners.length * 32;
  const offsets = tuples.map(tuple => {
    const result = uint(offset);
    offset += tuple.length / 2;
    return result;
  });
  return '0x' + uint(32) + uint(owners.length) + offsets.join('') + tuples.join('');
}

async function fixture(t, options = {}) {
  const engine = await import(`../desk.mjs?ownership=${encodeURIComponent(t.name)}`);
  const { CFG } = engine;
  const wallet = CFG.exampleWallet;
  const owned = new Set((options.owned || []).map(String));
  const owners = new Map((options.foreign || []).map(id => [String(id), OTHER]));
  const resultFor = id => owned.has(String(id)) ? wallet : owners.get(String(id)) ?? null;
  const requests = [], apiCalls = [], multicalls = [], directBatches = [], aborts = [];
  if (options.maxIds !== undefined) CFG.ownershipMaxIds = options.maxIds;
  if (options.apiTimeout !== undefined) CFG.ownershipApiTimeoutMs = options.apiTimeout;
  const hang = (kind, signal) => new Promise(() => {
    signal.addEventListener('abort', () => aborts.push(kind), { once: true });
  });
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).startsWith(CFG.fabxApi + '/')) {
      apiCalls.push({ url, signal: init.signal, credentials: init.credentials });
      assert.equal(url, `${CFG.fabxApi}/v1/accounts/${wallet}/mining`);
      assert.equal(init.credentials, 'omit');
      if (options.api === 'error') throw new TypeError('Failed to fetch (CORS)');
      if (options.api === 'hang') return hang('api', init.signal);
      const items = options.items || [];
      return json({ account: wallet.toUpperCase(), items });
    }
    assert.ok(['https://xlayer-mainnet.rpc.sentio.xyz', 'https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com'].includes(url), `unexpected endpoint: ${url}`);
    const payload = JSON.parse(init.body);
    const rows = Array.isArray(payload) ? payload : [payload];
    assert.ok(rows.length <= 5, 'public JSON-RPC batch cap');
    const plain = rows.filter(req => req.params?.[0]?.data?.startsWith('0x6352211e'));
    if (plain.length) directBatches.push(plain.length);
    const handle = async req => {
      requests.push(req);
      assert.equal(req.method, 'eth_call', 'ownership discovery must not scan logs');
      const [{ to, data }, block] = req.params;
      assert.equal(block, '0x' + HEAD.toString(16), 'every ownership read uses the caller snapshot block');
      if (to === CFG.multicall) {
        const ids = aggregateIds(data, CFG.circuits);
        multicalls.push(ids);
        if (options.multicall === 'hang') return hang('multicall', init.signal);
        if (options.multicall === 'revert') return { id: req.id, ...revert() };
        if (options.multicall === 'malformed') return { id: req.id, result: encodedUint(32) };
        return { id: req.id, result: aggregateResult(ids.map(resultFor)) };
      }
      assert.equal(to, CFG.circuits);
      if (data.startsWith('0x70a08231')) {
        assert.equal(data, '0x70a08231' + uint(BigInt(wallet)));
        return options.balance === 'revert' ? { id: req.id, ...revert() }
          : { id: req.id, result: encodedUint(options.balance ?? owned.size) };
      }
      if (data === '0x61b8ce8c') return options.nextId === 'revert'
        ? { id: req.id, ...revert() }
        : { id: req.id, result: encodedUint(options.nextId ?? 0) };
      assert.equal(data.slice(0, 10), '0x6352211e');
      const owner = resultFor(BigInt('0x' + data.slice(10)));
      return owner ? { id: req.id, result: ownerWord(owner) } : { id: req.id, ...revert() };
    };
    const response = await Promise.all(rows.map(handle));
    return json(Array.isArray(payload) ? response.reverse() : response[0]);
  });
  return { ...engine, wallet, requests, apiCalls, multicalls, directBatches, aborts };
}

test('official API candidates yield 76 owner-verified IDs after dedup and foreign collection/stale-owner filtering', async t => {
  const ids = Array.from({ length: 76 }, (_, i) => i + 101);
  const circuits = '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6';
  const items = [...ids.map(id => ({ cpu: circuits.toUpperCase(), id: String(id) })),
    { cpu: circuits, id: '101' }, { cpu: circuits, id: '0x65' },
    { cpu: OTHER, id: '999' }, { cpu: circuits, id: '177' }];
  const f = await fixture(t, { owned: ids, foreign: [177], items });
  const result = await f.ownedCircuits(f.wallet, HEAD);
  assert.deepEqual(result.ids, ids.map(BigInt));
  assert.deepEqual({ expected: result.expected, verified: result.verified, complete: result.complete, source: result.source, block: result.block },
    { expected: 76, verified: 76, complete: true, source: 'fabx-api', block: HEAD });
  assert.equal(result.scanned, 77);
  assert.deepEqual(result.errors, []);
  assert.equal(f.apiCalls.length, 1);
  assert.equal(f.requests.some(req => req.params[0].data === '0x61b8ce8c'), false);
  assert.deepEqual(f.multicalls.flat(), [...ids, 177].map(BigInt));
});

test('API ownership count below balance falls back and reconciles the missing ID', async t => {
  const circuits = '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6';
  const f = await fixture(t, { owned: [1, 6], nextId: 6,
    items: [{ cpu: circuits, id: '1' }, { cpu: circuits, id: '3' }], foreign: [3] });
  const result = await f.ownedCircuits(f.wallet, HEAD);
  assert.deepEqual(result.ids, [1n, 6n]);
  assert.equal(result.complete, true);
  assert.equal(result.source, 'chain-scan');
  assert.match(result.errors.join('\n'), /coverage 1\/2/);
  assert.equal(f.multicalls.flat().filter(id => id === 1n).length, 1, 'already verified API IDs are not reread');
});

test('API CORS/network failure uses nextId inclusive with Multicall and scans through nonexistent IDs', async t => {
  const f = await fixture(t, { api: 'error', owned: [2, 6], nextId: 6 });
  const result = await f.ownedCircuits(f.wallet, HEAD);
  assert.deepEqual(result.ids, [2n, 6n]);
  assert.equal(result.complete, true);
  assert.equal(result.source, 'chain-scan');
  assert.equal(result.scanned, 7);
  assert.deepEqual(f.multicalls.flat(), [0n, 1n, 2n, 3n, 4n, 5n, 6n]);
  assert.match(result.errors.join('\n'), /FabX API unavailable.*CORS/);
  assert.deepEqual(f.directBatches, []);
});

test('browser chain-only discovery batches balance and counter without attempting the CORS-only API', async t => {
  const f = await fixture(t, { owned: [2, 6], nextId: 6 });
  const result = await f.ownedCircuits(f.wallet, HEAD, { apiCandidates: false });
  assert.deepEqual(result.ids, [2n, 6n]);
  assert.equal(result.complete, true);
  assert.equal(f.apiCalls.length, 0);
});

test('large chain scans use at most two concurrent bounded owner batches', async t => {
  const f = await fixture(t, { api: 'error', owned: [1, 1999], nextId: 1999 });
  const fetchData = globalThis.fetch;
  let active = 0, maxActive = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const rows = JSON.parse(init.body || '[]');
    const owners = Array.isArray(rows) && rows.some(row => row.params?.[0]?.to === f.CFG.multicall);
    if (!owners) return fetchData(url, init);
    maxActive = Math.max(maxActive, ++active);
    try { await new Promise(resolve => setTimeout(resolve, 15)); return await fetchData(url, init); }
    finally { active--; }
  });
  const result = await f.ownedCircuits(f.wallet, HEAD);
  assert.deepEqual(result.ids, [1n, 1999n]);
  assert.equal(result.complete, true);
  assert.equal(maxActive, 2);
});

test('Multicall revert falls back to direct ownerOf in batches no larger than five', async t => {
  const f = await fixture(t, { owned: [6, 12], nextId: 12, multicall: 'revert' });
  const result = await f.ownedCircuits(f.wallet, HEAD);
  assert.deepEqual(result.ids, [6n, 12n]);
  assert.equal(result.complete, true);
  assert.deepEqual(f.directBatches, [5, 5, 3]);
  assert.match(result.errors.join('\n'), /Multicall unavailable; using direct ownerOf/);
});

test('malformed Multicall ABI results trigger direct ownerOf verification', async t => {
  const f = await fixture(t, { owned: [3], nextId: 3, multicall: 'malformed' });
  const result = await f.ownedCircuits(f.wallet, HEAD);
  assert.deepEqual(result.ids, [3n]);
  assert.equal(result.complete, true);
  assert.deepEqual(f.directBatches, [4]);
  assert.match(result.errors.join('\n'), /Multicall unavailable.*invalid Multicall/);
});

test('unavailable nextId uses the configured bounded scan and reports incomplete coverage', async t => {
  const f = await fixture(t, { api: 'error', owned: [2, 9], nextId: 'revert', maxIds: 5 });
  const result = await f.ownedCircuits(f.wallet, HEAD);
  assert.deepEqual(result.ids, [2n]);
  assert.equal(result.expected, 2);
  assert.equal(result.verified, 1);
  assert.equal(result.complete, false);
  assert.equal(result.scanned, 5);
  assert.deepEqual(f.multicalls.flat(), [0n, 1n, 2n, 3n, 4n]);
  assert.match(result.errors.join('\n'), /nextId unavailable/);
  assert.match(result.errors.join('\n'), /confirmed 1\/2; scanned through ID 4/);
});

test('hanging API is aborted by its deadline and chain discovery can still complete', async t => {
  const f = await fixture(t, { api: 'hang', apiTimeout: 15, owned: [4], nextId: 4 });
  const start = performance.now();
  const result = await f.ownedCircuits(f.wallet, HEAD, { timeoutMs: 400 });
  assert.ok(performance.now() - start < 800);
  assert.deepEqual(result.ids, [4n]);
  assert.equal(result.complete, true);
  assert.equal(result.source, 'chain-scan');
  assert.equal(f.apiCalls[0].signal.aborted, true);
  assert.deepEqual(f.aborts, ['api']);
  assert.match(result.errors.join('\n'), /FabX API unavailable.*timeout/);
});

test('hanging ownership scan is bounded by the total deadline and returns partial zero coverage', async t => {
  const f = await fixture(t, { owned: [4], nextId: 4, multicall: 'hang' });
  const start = performance.now();
  const result = await f.ownedCircuits(f.wallet, HEAD, { timeoutMs: 25 });
  assert.ok(performance.now() - start < 800);
  assert.deepEqual(result.ids, []);
  assert.equal(result.expected, 1);
  assert.equal(result.verified, 0);
  assert.equal(result.complete, false);
  assert.equal(result.scanned, 0);
  assert.equal(result.source, 'chain-scan');
  assert.match(result.errors.join('\n'), /timeout/);
  assert.deepEqual(f.aborts, ['multicall']);
});

test('failed balanceOf is an error and never becomes a zero-balance result', async t => {
  const f = await fixture(t, { balance: 'revert' });
  await assert.rejects(f.ownedCircuits(f.wallet, HEAD), /balanceOf unavailable.*execution reverted/);
  assert.equal(f.apiCalls.length, 0);
  assert.equal(f.requests.length, 1);
});

test('zero balance completes without calling the API, scanning token IDs, or reading logs', async t => {
  const f = await fixture(t);
  const result = await f.ownedCircuits(f.wallet, HEAD);
  assert.deepEqual(result, { ids: [], expected: 0, verified: 0, complete: true, source: 'balanceOf', block: HEAD, scanned: 0, errors: [] });
  assert.equal(f.apiCalls.length, 0);
  assert.equal(f.requests.length, 1);
});
