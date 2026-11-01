import assert from 'node:assert/strict';
import test from 'node:test';

import { relayVerify, UPSTREAM } from '../functions/api/pod-verify.js';
import { verifyNetlistAgainstTask, VERIFY_RELAY } from '../rig-check.mjs';

const post = (url, body) => new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('relay forwards only taskId and netlist to the official X Layer verify API', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ pass: true, passed: 256, total: 256 }), { status: 200 });
  };
  const res = await relayVerify(post('https://desk.test/api/pod-verify?chainId=196', { taskId: 2, netlist: 'g1', extra: 'x' }), fetchImpl);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { pass: true, passed: 256, total: 256 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UPSTREAM}?chainId=196`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { taskId: 2, netlist: 'g1' });
});

test('relay rejects other chains, methods and malformed bodies without calling upstream', async () => {
  const fetchImpl = async () => { throw new Error('must not be called'); };
  const bsc = await relayVerify(post('https://desk.test/api/pod-verify?chainId=56', { taskId: 2, netlist: 'g1' }), fetchImpl);
  assert.equal(bsc.status, 404);
  assert.equal((await bsc.json()).code, 'CHAIN_NOT_SUPPORTED');
  const get = await relayVerify(new Request('https://desk.test/api/pod-verify?chainId=196'), fetchImpl);
  assert.equal(get.status, 405);
  const badTask = await relayVerify(post('https://desk.test/api/pod-verify?chainId=196', { taskId: 0, netlist: 'g1' }), fetchImpl);
  assert.equal(badTask.status, 400);
  const badNetlist = await relayVerify(post('https://desk.test/api/pod-verify?chainId=196', { taskId: 2, netlist: '' }), fetchImpl);
  assert.equal(badNetlist.status, 400);
});

test('relay reports an unreachable upstream as 502', async () => {
  const res = await relayVerify(post('https://desk.test/api/pod-verify?chainId=196', { taskId: 2, netlist: 'g1' }), async () => { throw new TypeError('offline'); });
  assert.equal(res.status, 502);
});

test('browser verify goes through the same-origin relay when asked', async () => {
  let seen;
  const result = await verifyNetlistAgainstTask({
    chainId: 196, taskId: 2, netlist: 'g1', verifyUrl: VERIFY_RELAY,
    fetchImpl: async (url) => { seen = url; return new Response(JSON.stringify({ pass: true, passed: 3, total: 3 }), { status: 200 }); },
  });
  assert.equal(seen, '/api/pod-verify?chainId=196');
  assert.equal(result.state, 'all_pass');
});
