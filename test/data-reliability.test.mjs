import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpcClient } from '../rpc.mjs';

const json = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});

test('A2: HTTP 403 and 408 rotate to the next state endpoint', async () => {
  const endpoints = ['https://a.test', 'https://b.test'];
  const visited = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url, init) => {
    visited.push(url);
    if (url === endpoints[0]) return json({ message: 'forbidden' }, 403);
    return json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x2a' });
  } });
  assert.equal(await client.rpc('eth_blockNumber', []), '0x2a');
  assert.deepEqual(visited, endpoints);
});

test('A2: historical state missing rotates instead of treating as revert', async () => {
  const endpoints = ['https://a.test', 'https://b.test'];
  const visited = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url, init) => {
    visited.push(url);
    if (url === endpoints[0]) return json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'missing trie node' } });
    return json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x64' });
  } });
  assert.equal(await client.rpc('eth_call', [{ to: '0x1', data: '0x' }, 'latest']), '0x64');
  assert.deepEqual(visited, endpoints);
});

test('A2: JSON-RPC batch limit errors are retryable', async () => {
  const endpoints = ['https://sentio.test', 'https://okx.test'];
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url, init) => {
    if (url === endpoints[1]) {
      const requests = JSON.parse(init.body);
      return json((Array.isArray(requests) ? requests : [requests]).map((r) => ({ jsonrpc: '2.0', id: r.id, result: '0x1' })));
    }
    const requests = JSON.parse(init.body);
    if ((Array.isArray(requests) ? requests.length : 1) > 2) {
      return json({ message: 'JSON-RPC batch exceeds the maximum of 2 requests' }, 429);
    }
    return json((Array.isArray(requests) ? requests : [requests]).map((r) => ({ jsonrpc: '2.0', id: r.id, result: '0x1' })));
  } });
  const out = await client.batch([['eth_call', ['a']], ['eth_call', ['b']], ['eth_call', ['c']]], 3);
  assert.equal(out.length, 3);
});

test('A2: execution reverted does not failover to another endpoint', async () => {
  const endpoints = ['https://a.test', 'https://b.test'];
  const visited = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url) => {
    visited.push(url);
    return json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } });
  } });
  await assert.rejects(client.rpc('eth_call', []), (e) => e.code === 3 && !e.retryable);
  assert.deepEqual(visited, [endpoints[0]]);
});

test('A1: snapshot keeps chain fields when market APIs fail', async (t) => {
  const engine = await import(`../desk.mjs?a1=${Date.now()}`);
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const hex = (n) => '0x' + BigInt(n).toString(16);
  let marketCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).includes('dexscreener') || String(url).includes('okx.com')) {
      marketCalls++;
      throw new Error('market down');
    }
    const payload = JSON.parse(init.body);
    const reply = (req) => {
      if (req.method === 'eth_blockNumber') return { id: req.id, result: hex(74_000_000) };
      if (req.method === 'eth_getBlockByNumber') {
        const block = Number(req.params[0]);
        return { id: req.id, result: { timestamp: hex(block * 2) } };
      }
      const data = req.params[0].data.slice(0, 10);
      const map = { '0xef6aff46': 600_000, '0x6d1da431': 12, '0x78e97925': 1, '0x631f9852': 0,
        '0xf9f8bdb7': 8_333_333, '0xd8d56ffb': 100 };
      if (data.startsWith('0x1e2eaeaf')) return { id: req.id, result: '0x' + word((123456n << 160n) | (2n ** 97n)) };
      return { id: req.id, result: hex(map[data]) };
    };
    return { ok: true, json: async () => Array.isArray(payload) ? payload.map(reply) : reply(payload) };
  });
  const snap = await engine.snapshot({ storage: null, skipNand: true });
  assert.ok(marketCalls >= 2);
  assert.equal(snap.network.miners, 12);
  assert.equal(snap.prices.fabUsd, null);
  assert.ok(snap.network.weight > 0);
});

test('A4: stopped chain status shows zero output despite pending sentinel', async () => {
  const { measuredEntry } = await import(`../desk.mjs?a4=${Date.now()}`);
  const UINT = 2n ** 256n - 1n;
  const words = Array(23).fill(0n);
  words[9] = 3n;
  words[18] = 99n;
  const data = '0x' + words.map((w) => w.toString(16).padStart(64, '0')).join('');
  const row = measuredEntry(
    { id: '9' },
    [UINT, UINT, data, data, '0x' + '0'.repeat(256)],
    { blockTimestamp: 1000, windowSeconds: 600 },
    { rate: 8333333n, unverifiedBps: 100n },
  );
  assert.equal(row.status, 'stopped');
  assert.equal(row.fabPerDay, 0);
});

test('A5: entry comparison stays inconclusive when emission or NAND is missing', async () => {
  const engine = await import(`../desk.mjs?a5=${Date.now()}`);
  const snap = {
    head: 80_000_000,
    network: { networkNand: 1000, weight: 1e6 },
    prices: { fabUsd: 1, okbUsd: 100 },
    decision: { nandOkb: null },
    availability: { nand: { state: 'unavailable', asOf: null, error: 'quote read failed' } },
  };
  const cmp = engine.entryComparison(snap, [], { complete: false });
  assert.equal(cmp.baseline.emissionVerified, false);
  assert.equal(cmp.cheaper, null);
});

test('A10: networkGrowth failure is not treated as zero-growth measured', async () => {
  const engine = await import(`../desk.mjs?a10=${Date.now()}`);
  const snap = { head: 80_000_000, blockTime: 2, network: { weight: 200_000 } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } }) });
  const growth = await engine.networkGrowth(snap);
  assert.equal(growth.measured, false);
  assert.equal(growth.daily, 0);
});
