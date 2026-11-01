import assert from 'node:assert/strict';
import test from 'node:test';
import { RPC_ENDPOINTS } from '../rpc.mjs';
import {
  CHAINS,
  checkRig,
  decodeAbiBytes,
  minerWords,
  parseRigQuery,
  rigChainStatus,
  summarizeVectors,
  verifyNetlistAgainstTask,
} from '../rig-check.mjs';

const pad = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hex = (n) => '0x' + BigInt(n).toString(16);
const word = (n) => '0x' + pad(hex(n));

function minerData(fields, count = 23) {
  const w = Array.from({ length: count }, () => 0n);
  Object.assign(w, fields);
  return '0x' + w.map((v) => pad(hex(v))).join('');
}

function encodeBytes(bytesHex) {
  const body = bytesHex.replace(/^0x/, '');
  const len = body.length / 2;
  return '0x' + pad(hex(32)) + pad(hex(len)) + body.padEnd(Math.ceil(body.length / 64) * 64, '0');
}

test('parseRigQuery accepts numeric id and TapeOut# labels', () => {
  const fabx = parseRigQuery('42', 'fabx');
  assert.equal(fabx.circuitId, '42');
  assert.equal(fabx.chain.id, 'fabx');
  const bsc = parseRigQuery('Behemoth#7', 'bsc');
  assert.equal(bsc.circuitId, '7');
  assert.equal(bsc.processor.key, 'behemoth');
  const tape = parseRigQuery('TapeOut#11', 'tapeout');
  assert.equal(tape.circuitId, '11');
  assert.equal(tape.processor.key, 'tapeout');
});

test('rigChainStatus follows SSOT field mapping', () => {
  const miner = minerWords(minerData({
    2: 3n, 9: 1n, 14: 100n, 15: 1n, 19: 50n, 20: 0n,
  }), 23);
  const s = rigChainStatus(miner, 6n);
  assert.equal(s.mining, true);
  assert.equal(s.verified, true);
  assert.equal(s.optimal, true);
  assert.equal(s.revoked, false);
  const revoked = rigChainStatus(minerWords(minerData({ 9: 2n }), 23), 6n);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.mining, false);
});

test('verifyNetlistAgainstTask maps API pass and fail', async () => {
  const pass = await verifyNetlistAgainstTask({
    chainId: 196,
    taskId: 1,
    netlist: '0x01',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ pass: true, passed: 10, total: 10, firstFailure: null }),
    }),
  });
  assert.deepEqual(summarizeVectors(pass), { state: 'all_pass', passed: 10, total: 10 });

  const fail = await verifyNetlistAgainstTask({
    chainId: 196,
    taskId: 1,
    netlist: '0x01',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ pass: false, passed: 4, total: 10, firstFailure: { index: 4 } }),
    }),
  });
  assert.deepEqual(summarizeVectors(fail), { state: 'fail_at', index: 4, passed: 4, total: 10 });

  const unsupported = await verifyNetlistAgainstTask({
    chainId: 56,
    taskId: 4,
    netlist: '0x01',
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ code: 'CHAIN_NOT_SUPPORTED' }),
    }),
  });
  assert.equal(summarizeVectors(unsupported).state, 'undetectable');
  assert.equal(summarizeVectors(unsupported).reason, 'vectors_api_unsupported');
});

test('decodeAbiBytes reads dynamic bytes from eth_call', () => {
  const encoded = encodeBytes('0xabcdef');
  assert.equal(decodeAbiBytes(encoded).toLowerCase(), '0xabcdef');
});

test('checkRig returns chain status and vector summary from mocked RPC', async () => {
  const proc = CHAINS.fabx.defaultProcessor.toLowerCase();
  const mining = CHAINS.fabx.mining.toLowerCase();
  const circuitId = 9n;
  const key = 0xabcn;
  const minerHex = minerData({ 2: 2n, 9: 1n, 15: 1n, 19: 10n }, 23);

  const rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x64';
    assert.equal(method, 'eth_call');
    const [{ to, data }] = params;
    const dest = to.toLowerCase();
    const sel = data.slice(0, 10);
    if (dest === mining && sel === '0x0f03daba') return word(6);
    if (dest === proc && sel === '0x6352211e') return '0x' + '0'.repeat(24) + 'ab'.repeat(20);
    if (dest === mining && sel === '0x10eafa00') return word(key);
    if (dest === mining && sel === '0x0527edc2') return minerHex;
    if (dest === proc && sel === '0x3fc4be56') return encodeBytes('0x0102');
    throw new Error(`unexpected ${to} ${sel}`);
  };

  const result = await checkRig({ rig: '9', chain: 'fabx' }, {
    rpc,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ pass: true, passed: 3, total: 3 }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.chainStatus.mining, true);
  assert.equal(result.chainStatus.verified, true);
  assert.equal(result.vectors.state, 'all_pass');
  assert.equal(result.vectors.total, 3);
});

test('checkRig keeps BSC vector support separate from a missing circuit', async () => {
  const proc = CHAINS.bsc.processors[0].address.toLowerCase();
  const mining = CHAINS.bsc.mining.toLowerCase();
  const rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x100';
    if (method !== 'eth_call') throw new Error(method);
    const [{ to, data }] = params;
    const dest = to.toLowerCase();
    if (dest === mining && data.startsWith('0x0f03daba')) return word(1);
    if (dest === proc && data.startsWith('0x6352211e')) throw new Error('ERC721: owner query for nonexistent token');
    if (dest === mining && data.startsWith('0x10eafa00')) return word(0);
    if (dest === mining && data.startsWith('0x0527edc2')) return minerData({}, 22);
    throw new Error(`unexpected ${dest} ${data.slice(0, 10)}`);
  };
  const result = await checkRig({ rig: '999', chain: 'bsc' }, { rpc });
  assert.equal(result.readState, 'not_found');
  assert.equal(result.vectors.state, 'undetectable');
  assert.equal(result.vectors.reason, 'vectors_api_unsupported');
});

const jsonResponse = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

for (const body of [
  {}, { pass: true, passed: 1, total: 256 }, { pass: true, passed: 0, total: 0 },
  { pass: false, passed: 0, total: 0, firstFailure: { index: 0 } },
  { pass: true, passed: '2', total: 2 }, { pass: true, passed: 2, total: '2' },
  { pass: false, passed: 1, total: 2 },
  { pass: false, passed: 1, total: 2, firstFailure: { index: -1 } },
  { pass: false, passed: 1, total: 2, firstFailure: { index: 2 } },
  { pass: false, passed: 1, total: 2, firstFailure: { index: 0.5 } },
  { pass: false, passed: 2, total: 2, firstFailure: { index: 1 } },
  { pass: true, passed: 2, total: 2, firstFailure: { index: 1 } },
  { passed: 1, total: 2, firstFailure: { index: 1 } },
  { pass: false, passed: -1, total: 2, firstFailure: { index: 0 } },
  { pass: false, passed: 0.5, total: 2, firstFailure: { index: 0 } },
  { pass: true, passed: 2, total: 1 },
  { pass: true, passed: 2.5, total: 2.5 },
  { pass: true, passed: -1, total: -1 },
  { pass: false, passed: 0, total: 10, firstFailure: { index: 5 } },
]) {
  test(`verify rejects incomplete or contradictory evidence ${JSON.stringify(body)}`, async () => {
    const result = await verifyNetlistAgainstTask({ chainId: 196, taskId: 1, netlist: '0x01', fetchImpl: async () => jsonResponse(body) });
    assert.equal(summarizeVectors(result).state, 'incomplete');
  });
}

test('processor prefixes and explicit selections must agree with the selected chain', async () => {
  assert.equal(parseRigQuery('Behemoth#7', 'fabx').error, 'processor_mismatch');
  assert.equal(parseRigQuery('Genesis#7', 'bsc').error, 'processor_mismatch');
  assert.equal(parseRigQuery('Behemoth#7', 'bsc', 'tapeout').error, 'processor_mismatch');
  assert.equal(parseRigQuery('7', 'fabx', 'behemoth').error, 'processor_mismatch');
  assert.equal(parseRigQuery('Mystery#7', 'fabx').error, 'unknown_processor');
  assert.equal(parseRigQuery('FAB-Genisis#7', 'fabx').circuitId, '7');
  assert.equal(parseRigQuery('Blonskr_No1#7', 'bsc').processor.key, 'behemoth');
  const result = await checkRig({ rig: 'Behemoth#7', chain: 'fabx' }, { rpc: () => assert.fail('must validate before RPC') });
  assert.equal(result.error, 'processor_mismatch');
});

function mockRigRpc({ chain = 'fabx', owner = '0x' + '0'.repeat(24) + 'ab'.repeat(20), fail = {}, miner } = {}) {
  const cfg = CHAINS[chain];
  return async (method, params, options) => {
    options?.signal?.throwIfAborted();
    if (method === 'eth_blockNumber') {
      if (fail.block) throw fail.block;
      return '0x64';
    }
    assert.equal(method, 'eth_call');
    assert.equal(params[1], '0x64');
    const sel = params[0].data.slice(0, 10);
    const field = { '0x0f03daba': 'multiplier', '0x6352211e': 'owner', '0x10eafa00': 'key', '0x0527edc2': 'miner', '0x3fc4be56': 'netlist' }[sel];
    if (fail[field]) throw fail[field];
    if (field === 'multiplier') return word(6);
    if (field === 'owner') return owner;
    if (field === 'key') return word(123);
    if (field === 'miner') return miner ?? minerData({ 2: 2n, 9: 1n, 15: 1n, 19: 10n }, cfg.minerFields);
    if (field === 'netlist') return encodeBytes('0x0102');
    assert.fail(`unexpected ${sel}`);
  };
}

test('429 owner lookup is retryable and cannot imply no circuit', async () => {
  const result = await checkRig({ rig: '9', chain: 'fabx' }, {
    rpc: mockRigRpc({ fail: { owner: Object.assign(new Error('RPC HTTP 429'), { status: 429, retryable: true }) } }),
    fetchImpl: () => assert.fail('must not verify without an owner'),
  });
  assert.equal(result.readState, 'read_failed');
  assert.equal(result.ownerState, 'read_failed');
  assert.equal(result.readErrors[0].status, 429);
  assert.equal(result.chainStatus.mining, true);
  assert.equal(result.vectors.state, 'read_failed');
  assert.notEqual(result.vectors.reason, 'circuit_not_found');
});

test('explicit nonexistent token evidence is separate from generic reverts and invalid responses', async () => {
  const absent = await checkRig({ rig: '9', chain: 'fabx' }, { rpc: mockRigRpc({ fail: { owner: new Error('ERC721: owner query for nonexistent token') } }) });
  assert.equal(absent.readState, 'not_found');
  const revert = await checkRig({ rig: '9', chain: 'fabx' }, { rpc: mockRigRpc({ fail: { owner: new Error('execution reverted') } }) });
  assert.equal(revert.readState, 'read_failed');
  const malformed = await checkRig({ rig: '9', chain: 'fabx' }, { rpc: mockRigRpc({ owner: '0x' }) });
  assert.equal(malformed.readState, 'incomplete');
  const zero = await checkRig({ rig: '9', chain: 'fabx' }, { rpc: mockRigRpc({ owner: word(0) }) });
  assert.equal(zero.readState, 'incomplete');
  const rateLimited = await checkRig({ rig: '9', chain: 'fabx' }, {
    rpc: mockRigRpc({ fail: { owner: Object.assign(new Error('429: nonexistent token query rate limited'), { status: 429, retryable: true }) } }),
  });
  assert.equal(rateLimited.readState, 'read_failed');
});

test('BSC skips both netlist reads and verify requests', async () => {
  const result = await checkRig({ rig: '9', chain: 'bsc' }, {
    rpc: mockRigRpc({ chain: 'bsc', fail: { netlist: new Error('must not read netlist') } }),
    fetchImpl: () => assert.fail('BSC has no official verifier'),
  });
  assert.equal(result.readState, 'complete');
  assert.equal(result.chainStatus.mining, true);
  assert.deepEqual(result.vectors, { state: 'undetectable', reason: 'vectors_api_unsupported' });
});

for (const status of [403, 408, 429, 503]) {
  test(`FabX retries another homepage endpoint after HTTP ${status}`, async () => {
    const endpoints = [];
    const rpc = mockRigRpc();
    const result = await checkRig({ rig: '9', chain: 'fabx' }, { fetchImpl: async (url, init) => {
      if (url.startsWith('https://api.fabx.tech')) return jsonResponse({ pass: true, passed: 3, total: 3 });
      endpoints.push(url);
      if (url === RPC_ENDPOINTS[0]) return { ok: false, status, text: async () => 'node temporarily unavailable' };
      assert.equal(url, RPC_ENDPOINTS[1]);
      const request = JSON.parse(init.body);
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: await rpc(request.method, request.params) }) };
    } });
    assert.equal(result.readState, 'complete');
    assert.equal(result.vectors.state, 'all_pass');
    assert.deepEqual([...new Set(endpoints)], RPC_ENDPOINTS);
  });
}

test('chain status is published before vectors finish and cancellation reaches verify I/O', async () => {
  const controller = new AbortController();
  let beginVerify;
  const started = new Promise((resolve) => { beginVerify = resolve; });
  const progress = [];
  let verifySignal;
  const pending = checkRig({ rig: '9', chain: 'fabx' }, {
    rpc: mockRigRpc(), signal: controller.signal,
    onProgress: (result) => progress.push(result),
    fetchImpl: async (_url, init) => {
      verifySignal = init.signal;
      beginVerify();
      return new Promise(() => {});
    },
  });
  await started;
  assert.equal(progress.at(-1)?.chainStatus?.mining, true);
  assert.equal(progress.at(-1)?.vectors?.state, 'pending');
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(verifySignal.aborted, true);
});

test('verify body timeout keeps already-read chain status', async () => {
  const result = await checkRig({ rig: '9', chain: 'fabx' }, {
    rpc: mockRigRpc(), timeoutMs: 20,
    fetchImpl: async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) }),
  });
  assert.equal(result.chainStatus.mining, true);
  assert.equal(result.readState, 'complete');
  assert.equal(result.vectors.state, 'read_failed');
});

test('unreadable chain head returns a retryable read failure', async () => {
  const result = await checkRig({ rig: '9', chain: 'fabx' }, { rpc: mockRigRpc({ fail: { block: new Error('node unreachable') } }) });
  assert.equal(result.readState, 'read_failed');
  assert.equal(result.block, null);
});

test('a provider that finishes after the deadline cannot publish or begin further reads', async () => {
  let release;
  const head = new Promise((resolve) => { release = resolve; });
  const progress = [];
  const methods = [];
  const result = await checkRig({ rig: '9', chain: 'fabx' }, {
    timeoutMs: 10,
    rpc: (method) => { methods.push(method); return head; },
    onProgress: (state) => progress.push(state),
  });
  assert.equal(result.readState, 'read_failed');
  const published = progress.length;
  release('0x64');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(progress.length, published);
  assert.deepEqual(methods, ['eth_blockNumber']);
});

test('a malformed miner record remains incomplete without erasing the confirmed owner', async () => {
  const result = await checkRig({ rig: '9', chain: 'fabx' }, { rpc: mockRigRpc({ miner: '0x' }) });
  assert.equal(result.readState, 'incomplete');
  assert.equal(result.owner, '0x' + 'ab'.repeat(20));
  assert.equal(result.chainStatus, null);
  assert.equal(result.vectors.state, 'incomplete');
});

test('truncated or empty ABI bytes do not become a valid netlist', () => {
  for (const data of ['0x', word(32), encodeBytes('0x'), '0x' + pad(hex(32)) + pad(hex(1000))]) {
    assert.throws(() => decodeAbiBytes(data));
  }
});
