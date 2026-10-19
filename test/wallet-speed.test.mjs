import test from 'node:test';
import assert from 'node:assert/strict';

const uint = value => BigInt(value).toString(16).padStart(64, '0');
const hex = value => '0x' + BigInt(value).toString(16);
const word = (data, byte) => BigInt('0x' + data.slice(byte * 2, (byte + 32) * 2));
const HEAD = 80_000_000;
const snap = { head: HEAD, blockTime: 2, prices: { fabUsd: 2, okbUsd: 50 } };
const selectors = { key: '0x10eafa00', pending: '0x1808eeb8', realtime: '0x024b2c13' };
const abi = (...values) => '0x' + values.map(uint).join('');

// Independent fixture ABI parsing exercises targets, calldata lengths, offsets and block pins.
function callsIn(data) {
  assert.equal(data.slice(0, 10), '0xbce38bd7');
  data = data.slice(10);
  assert.equal(word(data, 0), 0n);
  const start = Number(word(data, 32)), count = Number(word(data, start));
  assert.equal(start, 64);
  assert.ok(count > 0 && count <= 256);
  return Array.from({ length: count }, (_, i) => {
    const tuple = start + 32 + Number(word(data, start + 32 + i * 32));
    const bytes = tuple + Number(word(data, tuple + 32));
    const size = Number(word(data, bytes));
    return { to: '0x' + word(data, tuple).toString(16).padStart(40, '0'),
      data: '0x' + data.slice((bytes + 32) * 2, (bytes + 32 + size) * 2) };
  });
}
function resultFor(values) {
  const tuples = values.map(value => value == null ? uint(0) + uint(64) + uint(0)
    : uint(1) + uint(64) + uint((value.length - 2) / 2) + value.slice(2).padEnd(Math.ceil((value.length - 2) / 64) * 64, '0'));
  let offset = values.length * 32;
  const offsets = tuples.map(tuple => { const prev = uint(offset); offset += tuple.length / 2; return prev; });
  return '0x' + uint(32) + uint(values.length) + offsets.join('') + tuples.join('');
}
async function setup(t, rigs, { malformed = false, headTimestamp, missingHeader = false, missingHistory = false } = {}) {
  const engine = await import(`../desk.mjs?walletSpeed=${encodeURIComponent(t.name)}`);
  const { CFG } = engine;
  const reads = [], requests = [], aggregates = [], progress = [];
  const value = (call, block) => {
    reads.push({ ...call, block });
    const selector = call.data.slice(0, 10);
    const id = call.data.length > 10 ? Number(BigInt('0x' + call.data.slice(-64))) : null;
    if (selector === '0x70a08231') return abi(rigs.length);
    if (selector === '0x6352211e') return abi(BigInt(CFG.exampleWallet));
    assert.equal(call.to, CFG.mining);
    if (selector === '0xf9f8bdb7') return abi(8333333);
    if (selector === '0xd8d56ffb') return abi(100);
    const rig = rigs.find(rig => rig.id === id);
    if (selector === selectors.key) return rig.keyFailure ? null : rig.zeroKey ? abi(0) : rig.badKey ? '0x1234' : abi(id);
    const current = Number(block) === HEAD;
    if (!current && missingHistory) return null;
    if (selector === selectors.realtime) {
      if (rig.badPending) return '0x1234';
      if (rig.missingPending) return null;
      if (rig.sentinel && current === (rig.sentinel === 'current')) return abi(2n ** 256n - 1n);
      return abi(current ? rig.now ?? 1516031 : rig.before ?? 687732);
    }
    if (selector === '0x0527edc2') {
      const fields = Array(23).fill(0n);
      fields[0] = BigInt(CFG.circuits); fields[1] = BigInt(id);
      fields[8] = BigInt(HEAD * 2 - 3600); fields[9] = 1n;
      fields[19] = rig.weightChanged && current ? 2n : 1n;
      fields[21] = rig.claimed && current ? 1n : 0n;
      return abi(...fields);
    }
    if (selector === '0xa6a20acd') return abi(rig.zeroWeight ? 0 : 119275056, 0, rig.invalidWeights ? 0 : 7128 * 1e8, 1);
    assert.fail(`unexpected selector ${selector}; raw pending is forbidden`);
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.startsWith(CFG.fabxApi)) return { ok: true, json: async () => ({ account: CFG.exampleWallet,
      items: rigs.map(rig => ({ cpu: CFG.circuits, id: String(rig.id) })) }) };
    const body = JSON.parse(init.body), rows = Array.isArray(body) ? body : [body];
    assert.ok(rows.length <= 5);
    const results = rows.map(req => {
      requests.push(req);
      if (req.method === 'eth_getBlockByNumber') return { id: req.id, result: missingHeader ? null : { timestamp: hex(Number(req.params[0]) * 2) } };
      assert.equal(req.method, 'eth_call');
      const [call, block] = req.params;
      assert.ok([HEAD, HEAD - 300].includes(Number(block)), 'only current and ten-minute historical state');
      if (call.to === CFG.multicall) {
        const calls = callsIn(call.data);
        aggregates.push({ calls, block });
        if (malformed && calls[0].to === CFG.mining) return { id: req.id, result: '0x1234' };
        return { id: req.id, result: resultFor(calls.map(call => value(call, block))) };
      }
      const result = value(call, block);
      return result == null ? { id: req.id, error: { code: 3, message: 'execution reverted' } } : { id: req.id, result };
    });
    return { ok: true, json: async () => Array.isArray(body) ? results.reverse() : results[0] };
  });
  const run = (options = {}) => engine.wallet(CFG.exampleWallet, { ...snap, headTimestamp },
    (step, details) => progress.push({ step, details, reads: reads.length }), options);
  return { engine, run, reads, requests, aggregates, progress };
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('wallet publishes the rig list before measuring and batches all realtime reward reads', async t => {
  const f = await setup(t, Array.from({ length: 76 }, (_, i) => ({ id: i + 1 })));
  const wallet = await f.run();
  close(wallet.fabPerDay, 90.64904256);
  assert.equal(wallet.measured, 76);
  const measure = f.progress.find(event => event.step === 'measure');
  assert.equal(measure.details?.ids.length, 76, 'rig IDs must be available while numbers load');
  assert.equal(measure.details.discovery.complete, true);
  assert.equal(f.reads.slice(0, measure.reads).some(call => call.to === f.engine.CFG.mining), false);
  const directMining = f.requests.filter(req => req.method === 'eth_call' && req.params[0].to === f.engine.CFG.mining);
  assert.equal(directMining.length, 0, 'no per-rig HTTP calls on the normal Multicall path');
  assert.equal(f.aggregates.filter(a => a.calls[0].to === f.engine.CFG.mining).length, 3);
  assert.equal(wallet.rigs.length, 76);
  assert.equal(wallet.rigs[0].id, '1');
  assert.equal(wallet.rigs[0].status, 'mining');
  close(wallet.rigs[0].fabPerDay, 1.19275056);
});

test('claims remain unknown even with positive reward deltas and never trigger a longer-window retry', async t => {
  const f = await setup(t, [{ id: 1, claimed: true }, { id: 2, now: 1 }]);
  const wallet = await f.run();
  assert.equal(wallet.hours, 1 / 6);
  assert.equal(wallet.fabPerDay, null);
  assert.deepEqual(wallet.rigs.map(rig => rig.status), ['claimed-in-window', 'claimed-in-window']);
  const headers = f.requests.filter(req => req.method === 'eth_getBlockByNumber').map(req => Number(req.params[0]));
  assert.deepEqual(headers.sort((a, b) => b - a), [HEAD, HEAD - 300]);
});

for (const historical of [false, true]) {
  test(`wallet deadline cancels ${historical ? 'historical' : 'current'} realtime reads after discovery`, async t => {
    const f = await setup(t, [{ id: 1 }]);
    const fetchData = globalThis.fetch;
    let signal, release, reached;
    const pendingRead = new Promise(resolve => { reached = resolve; });
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (init.body) {
        const body = JSON.parse(init.body), rows = Array.isArray(body) ? body : [body];
        const target = rows.some(req => req.method === 'eth_call' && req.params[0].to === f.engine.CFG.multicall
          && Number(req.params[1]) === (historical ? HEAD - 300 : HEAD)
          && callsIn(req.params[0].data).some(call => call.data.startsWith(selectors.realtime)));
        if (target) {
          signal = init.signal;
          reached();
          // Deliberately ignore abort, then resolve after timeout to exercise late-response isolation.
          return new Promise(resolve => { release = () => resolve(fetchData(url, init)); });
        }
      }
      return fetchData(url, init);
    });
    const reading = f.run({ timeoutMs: 50 });
    const rejected = assert.rejects(reading, error => error.name === 'TimeoutError');
    await pendingRead;
    assert.deepEqual(f.progress.map(event => event.step), ['scan', 'measure']);
    assert.deepEqual(f.progress[1].details.ids, ['1']);
    assert.equal(f.progress[1].details.discovery.complete, true);
    await rejected;
    assert.equal(signal.aborted, true, 'deadline must reach the pending RPC fetch');
    const requestCount = f.requests.length;
    release();
    for (let i = 0; i < 15; i++) await Promise.resolve();
    assert.equal(f.requests.length, requestCount + 1, 'only the already-started fake response may finish');
    assert.deepEqual(f.progress.map(event => event.step), ['scan', 'measure']);
  });
}

test('failed leaves and zero baselines remain unknown while a valid stopped rig retains zero', async t => {
  const f = await setup(t, [
    { id: 1 }, { id: 2, now: 0, before: 0, zeroWeight: true }, { id: 3, before: 0 },
    { id: 4, missingPending: true }, { id: 5, keyFailure: true },
  ]);
  const wallet = await f.run();
  assert.deepEqual(wallet.rigs.map(rig => rig.status), ['mining', 'stopped', 'unread', 'unread', 'unread']);
  close(wallet.fabPerDay, 1.19275056);
  assert.equal(wallet.pendingFab, null);
  assert.equal(wallet.pendingUsd, null);
  close(wallet.pendingSubtotalFab, 0.03032062);
  assert.equal(wallet.pendingKnown, 3);
  assert.equal(wallet.pendingTotal, 5);
  assert.equal(wallet.pendingComplete, false);
  assert.equal(wallet.rigs[1].fabPerDay, 0);
});

test('malformed aggregate falls back to bounded direct reads with the same pinned results', async t => {
  const f = await setup(t, [{ id: 1 }, { id: 2 }], { malformed: true });
  const wallet = await f.run();
  close(wallet.fabPerDay, 2.38550112);
  assert.equal(wallet.hours, 1 / 6);
  assert.deepEqual(wallet.rigs.map(rig => rig.status), ['mining', 'mining']);
});

test('empty wallets finish without headers or pending/minerKey reads', async t => {
  const f = await setup(t, []);
  const wallet = await f.run();
  assert.equal(wallet.circuits, 0);
  assert.equal(wallet.fabPerDay, 0);
  assert.equal(f.requests.length, 1);
});

test('snapshot timestamp avoids rereading the current header while historical timing stays exact', async t => {
  const f = await setup(t, [{ id: 1 }], { headTimestamp: HEAD * 2 });
  const wallet = await f.run();
  close(wallet.fabPerDay, 1.19275056);
  assert.equal(wallet.hours, 1 / 6);
  assert.deepEqual(f.requests.filter(req => req.method === 'eth_getBlockByNumber').map(req => Number(req.params[0])), [HEAD - 300]);
});

test('more than 256 rigs are split into bounded aggregates without changing row ordering or totals', async t => {
  const f = await setup(t, Array.from({ length: 300 }, (_, i) => ({ id: i + 1 })));
  const wallet = await f.run();
  close(wallet.fabPerDay, 357.825168);
  assert.equal(wallet.measured, 300);
  assert.equal(wallet.rigs.at(-1).id, '300');
  assert.equal(f.requests.some(req => req.params[0]?.to === f.engine.CFG.mining), false);
  const miningAggregates = f.aggregates.filter(a => a.calls[0].to === f.engine.CFG.mining);
  assert.equal(miningAggregates.length, 9);
  assert.equal(miningAggregates.reduce((sum, row) => sum + row.calls.length, 0), 1802);
});

test('zero or malformed miner keys and malformed uint rewards remain unread', async t => {
  const f = await setup(t, [{ id: 1 }, { id: 2 },
    { id: 3, zeroKey: true }, { id: 4, badKey: true }, { id: 5, badPending: true }]);
  const wallet = await f.run();
  assert.deepEqual(wallet.rigs.map(rig => rig.status), ['mining', 'mining', 'unread', 'unread', 'unread']);
  assert.equal(wallet.measured, 2);
  assert.equal(wallet.unread, 3);
  close(wallet.fabPerDay, 2.38550112);
  assert.equal(f.reads.some(call => call.data === selectors.realtime + uint(0)), false, 'no fabricated reward reads');
});

test('missing block timestamps preserve discovered rigs with unknown production', async t => {
  const f = await setup(t, [{ id: 1 }], { missingHeader: true });
  const wallet = await f.run();
  assert.equal(wallet.circuits, 1);
  assert.equal(wallet.fabPerDay, null);
  assert.equal(wallet.rigs[0].status, 'unread');
  assert.match(wallet.error, /block timestamp unavailable|eth_getBlockByNumber: empty result/);
  assert.equal(wallet.windowSeconds, null);
});

test('wallet corrects raw pending output with the shared ten-minute realtime reward basis', async t => {
  const f = await setup(t, [{ id: 1 }]);
  const wallet = await f.run();
  close(wallet.fabPerDay, 1.19275056);
  assert.equal(wallet.windowSeconds, 600);
  assert.equal(wallet.head, HEAD);
  assert.equal(wallet.previousHead, HEAD - 300);
  assert.equal(wallet.blockTimestamp, HEAD * 2);
  assert.equal(wallet.asOf, new Date(HEAD * 2000).toISOString());
  assert.equal(f.reads.some(call => call.data.startsWith(selectors.pending)), false);
});

test('uint256.max rewards, changed weights and inconsistent rates never enter wallet output totals', async t => {
  const f = await setup(t, [{ id: 1 }, { id: 2, sentinel: 'current' }, { id: 3, sentinel: 'previous' },
    { id: 4, weightChanged: true }, { id: 5, now: 3000000 }]);
  const wallet = await f.run();
  assert.deepEqual(wallet.rigs.map(row => row.status), ['mining', 'unread', 'unread', 'changed-in-window', 'rate-mismatch']);
  close(wallet.fabPerDay, 1.19275056);
  assert.equal(wallet.pendingFab, null);
  assert.equal(wallet.pendingUsd, null);
  close(wallet.pendingSubtotalFab, 0.07548093);
  assert.equal(wallet.pendingKnown, 4);
  assert.equal(wallet.pendingTotal, 5);
  assert.equal(wallet.pendingComplete, false);
  assert.equal(wallet.measured, 1);
});

test('missing historical state leaves all production unknown while current rewards remain readable', async t => {
  const f = await setup(t, [{ id: 1 }], { missingHistory: true });
  const wallet = await f.run();
  assert.equal(wallet.discovery.complete, true);
  assert.equal(wallet.rigs[0].status, 'unread');
  assert.equal(wallet.fabPerDay, null);
  assert.equal(wallet.usdPerDay, null);
  close(wallet.pendingFab, 0.01516031);
});


test('unchanged rewards are known zero only when validated current weights also imply zero emission', async t => {
  const f = await setup(t, [{ id: 1, now: 687732 }, { id: 2, now: 687732, invalidWeights: true },
    { id: 3, now: 0, before: 0, zeroWeight: true }]);
  const wallet = await f.run();
  assert.deepEqual(wallet.rigs.map(row => row.status), ['rate-mismatch', 'unread', 'stopped']);
  assert.deepEqual(wallet.rigs.map(row => row.fabPerDay), [null, null, 0]);
  assert.equal(wallet.measured, 1);
});
