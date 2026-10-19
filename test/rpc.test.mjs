import test from 'node:test';
import assert from 'node:assert/strict';

import { createRpcClient } from '../rpc.mjs';
const endpoints = ['https://sentio.test', 'https://xlayer.test', 'https://okx.test'];
const logEndpoint = 'https://logs.test';
const json = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});
const success = (init, result = '0x2a') => json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result });

test('default state reads use browser-compatible endpoints while logs use only Sentio', async () => {
  const visited = [];
  const client = createRpcClient({ backoffMs: 0, fetchImpl: async (url, init) => {
    const request = JSON.parse(init.body);
    visited.push([url, request.method]);
    if (url === 'https://xlayerrpc.okx.com') throw new TypeError('Failed to fetch');
    return success(init, request.method === 'eth_getLogs' ? [] : '0x2a');
  } });
  assert.equal(await client.rpc('eth_blockNumber', []), '0x2a');
  assert.equal(await client.rpc('eth_call', []), '0x2a');
  assert.deepEqual(await client.rpc('eth_getLogs', [{}]), []);
  assert.deepEqual(visited, [
    ['https://xlayerrpc.okx.com', 'eth_blockNumber'],
    ['https://rpc.xlayer.tech', 'eth_blockNumber'],
    ['https://rpc.xlayer.tech', 'eth_call'],
    ['https://xlayer-mainnet.rpc.sentio.xyz', 'eth_getLogs'],
  ]);
});

test('malformed JSON-RPC and non-JSON responses both rotate to a healthy state endpoint', async () => {
  const visited = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url, init) => {
    visited.push(url);
    if (url === endpoints[0]) return json({});
    if (url === endpoints[1]) return { ...json({}), json: async () => { throw new SyntaxError('Unexpected token <'); } };
    return success(init);
  } });
  assert.equal(await client.rpc('eth_call', []), '0x2a');
  assert.deepEqual(visited, endpoints);
});

test('malformed batch responses fail over instead of silently replacing results with null', async () => {
  const visited = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url, init) => {
    const requests = JSON.parse(init.body);
    visited.push(url);
    if (url === endpoints[0]) return json([]);
    if (url === endpoints[1]) return json(requests.map(() => ({ id: 999, result: '0x1' })));
    return json(requests.map((request) => ({ id: request.id, result: request.params[0] })));
  } });
  assert.deepEqual(await client.batch([['eth_call', ['first']], ['eth_call', ['second']]]), ['first', 'second']);
  assert.deepEqual(visited, endpoints);
});

test('malformed error payloads are transport failures rather than application reverts', async () => {
  const visited = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url, init) => {
    visited.push(url);
    if (url === endpoints[0]) return json({ error: 'Bad gateway' });
    if (url === endpoints[1]) return json({ error: {} });
    return success(init);
  } });
  assert.equal(await client.rpc('eth_call', []), '0x2a');
  assert.deepEqual(visited, endpoints);
});

test('state endpoint cooldown is shared across requests and expires without a background retry', async () => {
  let clock = 1000, healthy = false;
  const visited = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, endpointCooldownMs: 100, now: () => clock, fetchImpl: async (url, init) => {
    visited.push(url);
    if (!healthy) throw new TypeError('NetworkError when attempting to fetch resource');
    return success(init);
  } });
  await assert.rejects(client.rpc('eth_blockNumber', []), (error) => error.retryable);
  assert.deepEqual(visited, endpoints);
  clock += 50;
  await assert.rejects(client.rpc('eth_call', []), (error) => error.retryable && error.retryAfterMs === 50);
  assert.deepEqual(visited, endpoints);
  healthy = true;
  clock += 51;
  assert.equal(await client.rpc('eth_blockNumber', []), '0x2a');
  assert.deepEqual(visited, [...endpoints, endpoints[0]]);
});

test('a concurrent request skips a fallback already cooled down by another request', async () => {
  const visited = [], rejectPrimary = [];
  let primaryCallsReady;
  const ready = new Promise((resolve) => { primaryCallsReady = resolve; });
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url, init) => {
    visited.push(url);
    if (url === endpoints[0]) return new Promise((_, reject) => {
      rejectPrimary.push(reject);
      if (rejectPrimary.length === 2) primaryCallsReady();
    });
    if (url === endpoints[1]) throw new TypeError('Failed to fetch');
    return success(init);
  } });
  const first = client.rpc('eth_blockNumber', []);
  const second = client.rpc('eth_call', []);
  await ready;
  rejectPrimary[0](new TypeError('Failed to fetch'));
  assert.equal(await first, '0x2a');
  rejectPrimary[1](new TypeError('Failed to fetch'));
  assert.equal(await second, '0x2a');
  assert.deepEqual(visited, [endpoints[0], endpoints[0], endpoints[1], endpoints[2], endpoints[2]]);
});

test('log CORS failures stay on the explicit log endpoint and do not cool down state endpoints', async () => {
  const visited = [];
  const client = createRpcClient({ endpoints, logEndpoint, backoffMs: 0, fetchImpl: async (url, init) => {
    visited.push(url);
    if (url === logEndpoint) throw new TypeError('Failed to fetch');
    return success(init);
  } });
  await assert.rejects(client.rpc('eth_getLogs', [{}]), (error) => error.retryable && error.endpoint === logEndpoint);
  await assert.rejects(client.rpc('eth_getLogs', [{}]), (error) => error.retryable && error.retryAfterMs > 0);
  assert.equal(await client.rpc('eth_blockNumber', []), '0x2a');
  assert.deepEqual(visited, [logEndpoint, endpoints[0]]);
});

test('state RPC rotates across rate limit and server failure, then keeps the working endpoint', async () => {
  const visited = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url, init) => {
    visited.push(url);
    if (url === endpoints[0]) return json({}, 429);
    if (url === endpoints[1]) return json({}, 503);
    return success(init);
  } });
  assert.equal(await client.rpc('eth_blockNumber', []), '0x2a');
  assert.equal(await client.rpc('eth_getBlockByNumber', ['latest', false]), '0x2a');
  assert.deepEqual(visited, [endpoints[0], endpoints[1], endpoints[2], endpoints[2]]);
});

test('state RPC rotates on JSON-RPC rate limits and network failure', async () => {
  const visited = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url, init) => {
    visited.push(url);
    if (url === endpoints[0]) return json({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limit exceeded' } });
    if (url === endpoints[1]) throw new TypeError('fetch failed');
    return success(init, '0x1234');
  } });
  assert.equal(await client.rpc('eth_call', [{ to: '0xabc', data: '0x' }, 'latest']), '0x1234');
  assert.deepEqual(visited, endpoints);
});

test('a hard deadline rotates even when response JSON ignores abort', async () => {
  const visited = [], signals = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, timeoutMs: 15, fetchImpl: async (url, init) => {
    visited.push(url); signals.push(init.signal);
    if (url === endpoints[0]) return { ...json({}), json: () => new Promise(() => {}) };
    return success(init);
  } });
  assert.equal(await client.rpc('eth_blockNumber', []), '0x2a');
  assert.deepEqual(visited, endpoints.slice(0, 2));
  assert.equal(signals[0].aborted, true);
});

test('uncooperative fetch is bounded and the call stops after one attempt per endpoint', async () => {
  let requests = 0;
  const client = createRpcClient({ endpoints, backoffMs: 0, timeoutMs: 10, fetchImpl: () => {
    requests++;
    return new Promise(() => {});
  } });
  await assert.rejects(client.rpc('eth_blockNumber', []), (error) => error.retryable && /timeout/i.test(error.message));
  assert.equal(requests, 3);
});

test('application errors are surfaced without state failover', async () => {
  const visited = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url) => {
    visited.push(url);
    return json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } });
  } });
  await assert.rejects(client.rpc('eth_call', []), (error) => error.code === 3 && !error.retryable && /execution reverted/.test(error.message));
  assert.deepEqual(visited, [endpoints[0]]);
});

test('log rate limits never fail over and shared cooldown honors Retry-After', async () => {
  let clock = 1000;
  const visited = [];
  const client = createRpcClient({ endpoints, logEndpoint: endpoints[0], now: () => clock, logBackoffMs: 100, fetchImpl: async (url) => {
    visited.push(url);
    return json({}, 429, { 'retry-after': '2' });
  } });
  await assert.rejects(client.rpc('eth_getLogs', [{}]), (error) => error.rateLimited && error.retryAfterMs === 2000);
  clock += 1500;
  await assert.rejects(client.rpc('eth_getLogs', [{}]), (error) => error.rateLimited && error.retryAfterMs === 500);
  assert.deepEqual(visited, [endpoints[0]]);
  clock += 501;
  await assert.rejects(client.rpc('eth_getLogs', [{}]), /429/);
  assert.deepEqual(visited, [endpoints[0], endpoints[0]]);
});

test('log range limits remain distinguishable from rate limits and permit a smaller range', async () => {
  let requests = 0;
  const client = createRpcClient({ endpoints, fetchImpl: async (_url, init) => {
    if (++requests === 1) return json({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'maximum block range is 100 blocks' } });
    return success(init, []);
  } });
  await assert.rejects(client.rpc('eth_getLogs', [{}]), (error) => error.rangeLimited && !error.rateLimited && !error.retryable);
  assert.deepEqual(await client.rpc('eth_getLogs', [{}]), []);
  assert.equal(requests, 2);
});

test('HTTP 429 preserves provider range diagnostic but remains rate limited without range retries', async () => {
  let requests = 0;
  const client = createRpcClient({ endpoints, fetchImpl: async () => {
    requests++;
    return json({ code: 8, message: 'public eth_getLogs is limited to 1000 blocks' }, 429);
  } });
  await assert.rejects(client.rpc('eth_getLogs', [{}]), (error) => {
    assert.match(error.message, /HTTP 429.*public eth_getLogs is limited to 1000 blocks/);
    assert.equal(error.rateLimited, true);
    assert.equal(error.rangeLimited, false);
    assert.equal(error.retryable, true);
    return true;
  });
  await assert.rejects(client.rpc('eth_getLogs', [{}]), /public eth_getLogs is limited to 1000 blocks/);
  assert.equal(requests, 1);
});

test('HTTP errors include available text diagnostics and tolerate missing or hung bodies', async () => {
  const responses = [
    { ok: false, status: 400, text: async () => 'invalid JSON-RPC request' },
    { ok: false, status: 400 },
    { ok: false, status: 429, json: async () => new Promise(() => {}) },
  ];
  const client = createRpcClient({ endpoints, timeoutMs: 100, fetchImpl: async () => responses.shift() });
  await assert.rejects(client.rpc('eth_call', []), /HTTP 400.*invalid JSON-RPC request/);
  await assert.rejects(client.rpc('eth_call', []), (error) => error.status === 400);
  await assert.rejects(client.rpc('eth_getLogs', [{}]), (error) => error.status === 429 && error.rateLimited);
  assert.equal(responses.length, 0);
});

test('batch preserves request order and null application errors while failing over transport errors', async () => {
  const visited = [];
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url, init) => {
    visited.push(url);
    if (url === endpoints[0]) return json({}, 502);
    const requests = JSON.parse(init.body);
    return json(requests.map((request) => request.params[0] === 'bad'
      ? { jsonrpc: '2.0', id: request.id, error: { code: 3, message: 'execution reverted' } }
      : { jsonrpc: '2.0', id: request.id, result: request.params[0] }).reverse());
  } });
  assert.deepEqual(await client.batch([
    ['eth_call', ['first']], ['eth_call', ['bad']], ['eth_call', ['third']],
  ], 2), ['first', null, 'third']);
  assert.deepEqual(visited, [endpoints[0], endpoints[1], endpoints[1]]);
});

test('default batches fit the five-request public provider cap and preserve per-call results', async () => {
  const sizes = [];
  const client = createRpcClient({ endpoints: [endpoints[0]], fetchImpl: async (_url, init) => {
    const requests = JSON.parse(init.body);
    sizes.push(requests.length);
    if (requests.length > 5) return json({ code: 8, message: 'JSON-RPC batch exceeds the maximum of 5 requests' }, 429);
    return json(requests.map((request) => request.params[0] === 'rig-6'
      ? { jsonrpc: '2.0', id: request.id, error: { code: 3, message: 'execution reverted' } }
      : { jsonrpc: '2.0', id: request.id, result: request.params[0] }).reverse());
  } });
  const calls = Array.from({ length: 12 }, (_, i) => ['eth_call', [`rig-${i}`]]);
  assert.deepEqual(await client.batch(calls), Array.from({ length: 12 }, (_, i) => i === 6 ? null : `rig-${i}`));
  assert.deepEqual(sizes, [5, 5, 2]);
});

test('rate-limited batch members cause failover instead of silently becoming null', async () => {
  const client = createRpcClient({ endpoints, backoffMs: 0, fetchImpl: async (url, init) => {
    const requests = JSON.parse(init.body);
    return json(requests.map((request) => url === endpoints[0]
      ? { jsonrpc: '2.0', id: request.id, error: { code: -32005, message: 'too many requests' } }
      : { jsonrpc: '2.0', id: request.id, result: '0x7' }));
  } });
  assert.deepEqual(await client.batch([['eth_call', []], ['eth_blockNumber', []]]), ['0x7', '0x7']);
});

test('caller abort stops an uncooperative request without trying another endpoint', async () => {
  const controller = new AbortController();
  let requests = 0, requestSignal;
  const client = createRpcClient({ endpoints, backoffMs: 1000, fetchImpl: async (_url, init) => {
    requests++; requestSignal = init.signal;
    controller.abort();
    return new Promise(() => {});
  } });
  await assert.rejects(client.rpc('eth_blockNumber', [], { signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.equal(requests, 1);
  assert.equal(requestSignal.aborted, true);
  await assert.rejects(client.rpc('eth_blockNumber', [], { signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.equal(requests, 1);
});

test('caller abort interrupts failover backoff without another request', async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = createRpcClient({ endpoints, backoffMs: 1000, fetchImpl: async () => {
    requests++;
    setTimeout(() => controller.abort(), 10);
    return json({}, 429);
  } });
  await assert.rejects(client.rpc('eth_blockNumber', [], { signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.equal(requests, 1);
});

test('abort before the queued fetch starts prevents the request entirely', async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = createRpcClient({ endpoints, fetchImpl: async (_url, init) => { requests++; return success(init); } });
  const pending = client.rpc('eth_blockNumber', [], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(requests, 0);
});

test('log calls remain on their explicit endpoint after state failover, including mixed batches', async () => {
  const visited = [];
  const client = createRpcClient({ endpoints, logEndpoint, backoffMs: 0, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    const requests = Array.isArray(body) ? body : [body];
    visited.push([url, requests.map((request) => request.method)]);
    if (url === endpoints[0] && requests[0].method === 'eth_blockNumber') return json({}, 503);
    const response = requests.map((request) => ({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_getLogs' ? [] : '0x3' }));
    return json(Array.isArray(body) ? response : response[0]);
  } });
  assert.equal(await client.rpc('eth_blockNumber', []), '0x3');
  assert.deepEqual(await client.batch([['eth_call', []], ['eth_getLogs', [{}]], ['eth_call', []]]), ['0x3', [], '0x3']);
  assert.deepEqual(visited, [
    [endpoints[0], ['eth_blockNumber']], [endpoints[1], ['eth_blockNumber']],
    [endpoints[1], ['eth_call']], [logEndpoint, ['eth_getLogs']], [endpoints[1], ['eth_call']],
  ]);
});

test('read-only whitelist rejects transaction methods before any request', async () => {
  let requests = 0;
  const client = createRpcClient({ endpoints, fetchImpl: async () => { requests++; return json({}); } });
  await assert.rejects(client.rpc('eth_sendRawTransaction', ['0xdead']), /read.only/i);
  await assert.rejects(client.batch([['eth_call', []], ['personal_sign', []]]), /read.only/i);
  assert.equal(requests, 0);
});
