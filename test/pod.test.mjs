import test from 'node:test';
import assert from 'node:assert/strict';
import { configurePodRpc, podRigs, podRigsForIds, podEntryWindow, podNetworkGrowth, POD_CFG } from '../pod.mjs';

const PROC = POD_CFG.processors[0].address.toLowerCase();
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const owner = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ownerTopic = '0x' + owner.slice(2).padStart(64, '0');
const head = 128_900_000;

function fakePodRpc(t, rigs, options = {}) {
  const transferLogs = rigs.map((rig) => ({
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + '0'.repeat(24) + 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ownerTopic,
      '0x' + BigInt(rig.id).toString(16).padStart(64, '0'),
    ],
  }));
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    const reply = (req) => {
      const { method, params } = req;
      const wrap = (result) => ({ jsonrpc: '2.0', id: req.id, result });
      if (method === 'eth_getBlockByNumber') return wrap({ timestamp: hex(Number(params[0]) * 2) });
      if (method === 'eth_getLogs') {
        const addr = params[0].address?.toLowerCase();
        if (addr !== PROC) return wrap([]);
        const topics = params[0].topics || [];
        if (topics[2] === ownerTopic || topics[1] === ownerTopic) return wrap(transferLogs);
        return wrap([]);
      }
      if (method === 'eth_call') {
        const [{ data }, block] = params;
        const selector = data.slice(0, 10);
        const blockNum = Number(block);
        if (selector === '0x70a08231') {
          const to = params[0].to.toLowerCase();
          const count = to === PROC ? (options.expected ?? rigs.length) : 0;
          return wrap(`0x${word(count)}`);
        }
        if (selector === '0x01ffc9a7') return { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } };
        if (selector === '0x61b8ce8c') {
          const to = params[0].to.toLowerCase();
          const maxId = to === PROC ? Math.max(...rigs.map((row) => row.id), 0) + 2 : 0;
          return wrap(`0x${word(maxId)}`);
        }
        if (selector === '0xf9f8bdb7') return wrap(`0x${word(8333333)}`);
        if (selector === '0xd8d56ffb') return wrap(`0x${word(100)}`);
        if (selector === '0xef6aff46') return wrap(`0x${word(1_581_472)}`);
        if (selector === '0x63967742') return wrap(`0x${word(40_656)}`);
        const tail = data.slice(-64);
        const id = Number(BigInt(`0x${tail}`));
        const rigByKey = rigs.find((row) => word(row.id) === tail);
        const rig = rigs.find((row) => row.id === id) || rigByKey;
        if (selector === '0x6352211e') return wrap(rig ? `0x${owner.slice(2).padStart(64, '0')}` : null);
        if (selector === '0x10eafa00') return wrap(rig?.missingKey ? null : `0x${word(rig?.id ?? id)}`);
        if (selector === '0xbce38bd7') return { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted', retryable: false } };
        if (selector === '0x0527edc2') {
          const fields = Array(22).fill(0n);
          fields[0] = BigInt('0x' + PROC.slice(2));
          fields[1] = BigInt(rig?.id ?? id);
          fields[2] = rig?.taskId ?? 1n;
          fields[8] = BigInt(head * 2 - 3600);
          fields[9] = rig?.chainStatus ?? 1n;
          fields[15] = rig?.optimal ? 1n : 0n;
          fields[19] = rig?.verifWeight ?? 100n;
          fields[21] = blockNum === head && rig?.claimed ? 1n : 0n;
          return wrap('0x' + fields.map(word).join(''));
        }
        assert.equal(selector, '0x1808eeb8');
        const current = blockNum === head;
        const pendingRig = rigByKey || rig;
        const amount = current ? pendingRig?.now : pendingRig?.before;
        return wrap(amount == null ? null : `0x${word(Math.round(amount * 1e8))}`);
      }
      if (method === 'eth_blockNumber') return wrap(hex(head));
      throw new Error(`unexpected ${method}`);
    };
    return { ok: true, json: async () => Array.isArray(body) ? body.map(reply) : reply(body) };
  });
  configurePodRpc({
    endpoints: ['https://pod-test.invalid'],
    logEndpoint: 'https://pod-test.invalid',
    logRpcFallback: 'https://pod-test.invalid',
    transferFromBlock: head - 1_000,
  });
}

const snap = { head, headTimestamp: head * 2, blockTime: 2, prices: { bemUsd: 0.12 } };

test('podEntryWindow targets a ten-minute block span', async (t) => {
  fakePodRpc(t, []);
  const window = await podEntryWindow(snap, new AbortController().signal);
  assert.equal(window.windowSeconds, 600);
  assert.equal(window.previousHead, head - 300);
});

test('podRigs measures BEM/day and flags optimal and verified pools', async (t) => {
  fakePodRpc(t, [
    { id: 11, now: 10, before: 9, optimal: true, verifWeight: 32_000n },
    { id: 12, now: 5, before: 5, verifWeight: 0n, taskId: 0n },
    { id: 13, chainStatus: 2n, optimal: true },
    { id: 14, now: null, before: null },
  ]);
  const result = await podRigs(owner, snap);
  assert.equal(result.circuits, 4);
  assert.equal(result.windowSeconds, 600);
  assert.equal(result.rigs[0].id, 'TapeOut#11');
  assert.equal(result.rigs[0].status, 'mining');
  assert.equal(result.rigs[0].fabPerDay, 144);
  assert.equal(result.rigs[0].optimal, true);
  assert.equal(result.rigs[0].verified, true);
  assert.equal(result.rigs[1].verified, false);
  assert.equal(result.rigs[2].status, 'revoked');
  assert.equal(result.rigs[2].fabPerDay, 0);
  assert.equal(result.rigs[3].status, 'unread');
  assert.equal(result.fabPerDay, 144);
  assert.equal(result.measured, 3);
  assert.equal(result.unread, 1);
});

test('podNetworkGrowth compares verified weight with about seven days earlier', async (t) => {
  fakePodRpc(t, []);
  const flat = await podNetworkGrowth({ head, blockTime: 2, network: { weight: 1_581_472 } });
  assert.equal(flat.measured, true);
  assert.equal(flat.daily, 0);
  const missing = await podNetworkGrowth({ head: 10, blockTime: 2, network: { weight: 1 } });
  assert.equal(missing.measured, false);
});

test('podRigs maps stopped on-chain status to zero output', async (t) => {
  fakePodRpc(t, [{ id: 21, chainStatus: 3n }]);
  const result = await podRigs(owner, snap);
  assert.equal(result.rigs[0].status, 'stopped');
  assert.equal(result.fabPerDay, 0);
});

test('podRigsForIds measures indexed ids on one node and does not scan logs', async (t) => {
  const previousHead = head - 300;
  const headHex = hex(head).toLowerCase();
  const prevHex = hex(previousHead).toLowerCase();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    const rows = Array.isArray(body) ? body : [body];
    const blocks = new Set();
    for (const row of rows) {
      if (row.method === 'eth_getLogs') throw new Error('indexed lookup must not scan logs');
      if (row.method === 'eth_call') blocks.add(String(row.params[1]).toLowerCase());
    }
    const windowRead = blocks.has(prevHex);
    calls.push({ url: String(url), blocks, windowRead, ok: !windowRead || !String(url).includes('bsc-a.invalid') });
    if (windowRead && String(url).includes('bsc-a.invalid')) {
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'down' };
    }
    const reply = (req) => {
      const { method, params } = req;
      const wrap = (result) => ({ jsonrpc: '2.0', id: req.id, result });
      if (method === 'eth_getBlockByNumber') return wrap({ timestamp: hex(Number(params[0]) * 2) });
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const [{ data }, block] = params;
      const selector = data.slice(0, 10);
      const blockNum = Number(block);
      if (selector === '0xf9f8bdb7') return wrap(`0x${word(8333333)}`);
      if (selector === '0xd8d56ffb') return wrap(`0x${word(100)}`);
      if (selector === '0xef6aff46') return wrap(`0x${word(1_581_472)}`);
      if (selector === '0x63967742') return wrap(`0x${word(40_656)}`);
      if (selector === '0x10eafa00') return wrap(`0x${word(11)}`);
      if (selector === '0x0527edc2') {
        const fields = Array(22).fill(0n);
        fields[0] = BigInt(PROC);
        fields[1] = 11n;
        fields[2] = 1n;
        fields[8] = BigInt(head * 2 - 3600);
        fields[9] = 1n;
        fields[19] = 100n;
        fields[21] = 0n;
        return wrap(`0x${fields.map(word).join('')}`);
      }
      assert.equal(selector, '0x1808eeb8');
      const amount = blockNum === head ? 10 : 9;
      return wrap(`0x${word(Math.round(amount * 1e8))}`);
    };
    return { ok: true, json: async () => Array.isArray(body) ? body.map(reply) : reply(body) };
  });
  configurePodRpc({
    endpoints: ['https://bsc-a.invalid', 'https://bsc-b.invalid'],
    logEndpoint: 'https://bsc-b.invalid',
    logRpcFallback: 'https://bsc-b.invalid',
    timeoutMs: 5_000,
  });
  const result = await podRigsForIds(owner, [{ processor: PROC, id: '11', label: 'TapeOut' }], snap);
  assert.equal(result.circuits, 1);
  assert.equal(result.rigs[0].id, 'TapeOut#11');
  assert.equal(result.rigs[0].status, 'mining');
  assert.equal(result.discovery.source, 'bsc-index');
  const windowCalls = calls.filter((call) => call.windowRead);
  assert.ok(windowCalls.length >= 2);
  for (const call of windowCalls) {
    assert.equal(call.blocks.has(headHex), true);
    assert.equal(call.blocks.has(prevHex), true);
  }
  assert.equal(windowCalls.some((call) => call.url.includes('bsc-a.invalid') && call.ok === false), true);
  assert.equal(windowCalls.some((call) => call.url.includes('bsc-b.invalid') && call.ok === true), true);
});
