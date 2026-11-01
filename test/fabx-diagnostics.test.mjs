import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, measuredEntry, parseGetMiner } from '../desk.mjs';
import { diagnoseRig, diagnosisText } from '../fabx-diagnostics.mjs';

const abi = (...values) => '0x' + values.map(value => BigInt(value).toString(16).padStart(64, '0')).join('');
const window = { blockTimestamp: 10000, windowSeconds: 600 };
const emission = { rate: 8333333n, unverifiedBps: 100n };
function miner(overrides = {}) {
  const values = Array(23).fill(0n);
  Object.assign(values, { 0: BigInt(CFG.circuits), 1: 7n, 2: 3n, 3: 100n,
    8: 1000n, 9: 1n, 19: 1n, ...overrides });
  return abi(...values);
}

test('current mining state and pool remain readable when the historical miner is unavailable', () => {
  const row = measuredEntry({ id: '7' }, [abi(100), null, miner(), null, null], window, emission);
  assert.equal(row.chainStatus, 1);
  assert.equal(row.taskId, '3');
  assert.equal(row.pool, 'verified');
  assert.equal(row.fabPerDay, null);
  assert.equal(row.status, 'unread');
});

test('stopped and revoked states keep verified zero even without history, timing or emission', () => {
  for (const status of [2n, 3n]) {
    const row = measuredEntry({ id: '7' }, [null, null, miner({ 9: status, 18: 900n, 19: 0n }), null, null], {}, null);
    assert.equal(row.chainStatus, Number(status));
    assert.equal(row.status, status === 2n ? 'revoked' : 'stopped');
    assert.equal(row.fabPerDay, 0);
    assert.equal(row.stopBlock, '900');
  }
});

test('getMiner extracts actual task and stored weights without relying on reward reads', () => {
  const row = parseGetMiner(miner({ 2: 0n, 19: 0n, 20: 100n }));
  assert.equal(row.taskId, 0n);
  assert.equal(row.verifWeight, 0n);
  assert.equal(row.unverWeight, 100n);
  assert.equal(row.gateCount, 100n);
  assert.equal(parseGetMiner('0x1234'), null);
});

test('measured pool shares use both current deweb rate contributions', () => {
  // Equal 99/99 verified and 1/1 unverified pool fractions produce a 99:1 split.
  const raw = miner({ 19: 99n, 20: 1n });
  const row = measuredEntry({ id: '7' }, [abi(5000000800), abi(1000), raw, raw, abi(99, 1, 99, 1)], window, emission);
  assert.equal(row.status, 'measured');
  assert.equal(row.pool, 'mixed');
  assert.ok(Math.abs(row.poolShares.verified - 0.99) < 0.000001);
  assert.ok(Math.abs(row.poolShares.unverified - 0.01) < 0.000001);
  assert.ok(Math.abs(row.poolShares.verified + row.poolShares.unverified - 1) < 1e-10);
});

test('unclaimed task enters the 1% pool only with actual unverified weight', () => {
  const active = diagnoseRig(parseGetMiner(miner({ 2: 0n, 19: 0n, 20: 99n })), { processorMultiplier: 6n });
  assert.ok(active.some(item => item.code === 'unclaimed_task'));
  assert.match(diagnosisText(active.find(item => item.code === 'unclaimed_task'), 'zh'), /1%/);
  assert.ok(active.some(item => item.code === 'gas_gate_unknown'));
  const idle = diagnoseRig(parseGetMiner(miner({ 2: 0n, 9: 0n, 19: 0n })), { processorMultiplier: 6n });
  assert.ok(idle.some(item => item.code === 'not_started'));
  assert.equal(idle.some(item => item.code === 'unclaimed_task'), false);
});

test('cooldown uses the current chain constant and remains stopped at the boundary', () => {
  const stopped = parseGetMiner(miner({ 9: 3n, 18: 100n, 19: 0n }));
  const current = diagnoseRig(stopped, { head: 150, cooldownBlocks: 100n, processorMultiplier: 6n });
  const remaining = current.find(item => item.code === 'cooldown_remaining');
  assert.equal(remaining.evidence.remainingBlocks, '50');
  assert.match(diagnosisText(remaining, 'zh'), /50.*区块/);
  assert.ok(diagnoseRig(stopped, { head: 200, cooldownBlocks: 100n }).some(item => item.code === 'cooldown_complete'));
  for (const options of [{ head: 150 }, { head: 99, cooldownBlocks: 100n }]) {
    assert.ok(diagnoseRig(stopped, options).some(item => item.code === 'cooldown_unknown'));
  }
});

test('P=0 describes the verified start restriction without declaring existing output zero', () => {
  const diagnoses = diagnoseRig(parseGetMiner(miner()), { processorMultiplier: 0n });
  const disabled = diagnoses.find(item => item.code === 'processor_disabled');
  assert.ok(disabled);
  assert.match(diagnosisText(disabled, 'zh'), /已在挖.*无法判断/);
  assert.match(diagnosisText(disabled, 'en'), /existing.*unknown/i);
  assert.ok(diagnoseRig(null).some(item => item.code === 'state_unknown'));
});

test('revocation is a confirmed permanent restriction and missing processor reads stay unknown', () => {
  const revoked = diagnoseRig(parseGetMiner(miner({ 9: 2n, 19: 0n })));
  assert.ok(revoked.some(item => item.code === 'revoked'));
  assert.ok(revoked.some(item => item.code === 'processor_unknown'));
  assert.match(diagnosisText(revoked.find(item => item.code === 'revoked'), 'zh'), /永久/);
  assert.deepEqual(diagnoseRig(parseGetMiner(miner()), { processorMultiplier: 6n }), []);
});

async function walletFixture(t, { chainStatus = 3, constants = true, missingHistory = true, missingEmission = true } = {}) {
  const app = await import(`../desk.mjs?diagnostics=${encodeURIComponent(t.name)}`);
  const reads = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.startsWith(CFG.fabxApi)) return { ok: true, json: async () => ({ account: CFG.exampleWallet,
      items: [{ cpu: CFG.circuits, id: '7' }] }) };
    const body = JSON.parse(init.body), requests = Array.isArray(body) ? body : [body];
    const reply = req => {
      if (req.method === 'eth_getBlockByNumber') return { id: req.id, result: { timestamp: '0x24b8' } }; // 9400
      assert.equal(req.method, 'eth_call', 'diagnosis remains read-only');
      const [{ data }, block] = req.params, selector = data.slice(0, 10);
      reads.push({ selector, block });
      let result;
      if (selector === '0xbce38bd7') return { id: req.id, error: { code: 3, message: 'unsupported aggregate' } };
      if (selector === '0x70a08231') result = abi(1);
      else if (selector === '0x6352211e') result = abi(BigInt(CFG.exampleWallet));
      else if (selector === '0xf9f8bdb7') result = missingEmission ? null : abi(8333333);
      else if (selector === '0xd8d56ffb') result = abi(100);
      else if (selector === '0x10eafa00') result = abi(7);
      else if (selector === '0x0f03daba') result = constants ? abi(0) : null;
      else if (selector === '0x6f1e9d41') result = constants ? abi(1200) : null;
      else if (Number(block) !== 1000 && missingHistory) result = null;
      else if (selector === '0x0527edc2') result = miner({ 9: BigInt(chainStatus), 18: chainStatus === 3 ? 900n : 0n, 19: 0n });
      else if (selector === '0x024b2c13') result = abi(2n ** 256n - 1n);
      else if (selector === '0xa6a20acd') result = abi(0, 0, 100, 100);
      else assert.fail(`unexpected selector ${selector}`);
      return result == null ? { id: req.id, error: { code: 3, message: 'unavailable fixture read' } } : { id: req.id, result };
    };
    return { ok: true, json: async () => Array.isArray(body) ? requests.map(reply) : reply(body) };
  });
  const result = await app.wallet(CFG.exampleWallet, { head: 1000, headTimestamp: 10000, blockTime: 1,
    prices: {}, network: {} });
  return { result, reads };
}

test('wallet diagnosis reads P and cooldown at snapshot block despite unavailable historical production', async t => {
  const { result, reads } = await walletFixture(t);
  assert.equal(result.rigs[0].chainStatus, 3);
  assert.equal(result.rigs[0].fabPerDay, 0);
  assert.equal(result.rigs[0].status, 'stopped');
  assert.equal(result.rigs[0].diagnoses.find(item => item.code === 'cooldown_remaining').evidence.remainingBlocks, '1100');
  assert.ok(result.rigs[0].diagnoses.some(item => item.code === 'processor_disabled'));
  assert.ok(reads.filter(row => ['0x0f03daba', '0x6f1e9d41'].includes(row.selector)).every(row => Number(row.block) === 1000));
});

test('missing optional constants cannot erase current stopped state or invent cooldown and P', async t => {
  const { result } = await walletFixture(t, { constants: false });
  assert.equal(result.rigs[0].fabPerDay, 0);
  assert.equal(result.rigs[0].chainStatus, 3);
  assert.ok(result.rigs[0].diagnoses.some(item => item.code === 'cooldown_unknown'));
  assert.ok(result.rigs[0].diagnoses.some(item => item.code === 'processor_unknown'));
  assert.equal(result.rigs[0].diagnoses.some(item => item.code === 'processor_disabled'), false);
});
