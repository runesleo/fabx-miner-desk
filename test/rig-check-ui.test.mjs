import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../check/index.html', import.meta.url), 'utf8');
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .+;$/gm, '');

function page(checkRig) {
  const elements = new Map();
  const element = () => ({
    textContent: '', value: '', hidden: false, disabled: false, children: [],
    addEventListener() {},
    replaceChildren(...children) { this.children = children; },
  });
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, element());
  elements.get('chain').value = 'fabx';
  const context = {
    checkRig, verifyRelayUrl: () => '/api/pod-verify',
    AbortController, URLSearchParams,
    document: { documentElement: {}, getElementById: (id) => elements.get(id), createElement: element },
    location: { search: '', hash: '' }, history: { replaceState() {} },
    localStorage: { getItem() {}, setItem() {} },
  };
  vm.runInNewContext(source, context);
  return (id) => elements.get(id);
}

const result = (id, vectors = { state: 'pending' }) => ({
  ok: true, chain: 'fabx', displayId: `FAB-Genisis#${id}`, block: 100,
  owner: '0x' + 'ab'.repeat(20), readState: 'complete', readErrors: [],
  chainStatus: { miningLabel: 'mining', taskId: 2, mining: true, verified: true, optimal: true, revoked: false, processorOk: true },
  vectors,
});

test('check page displays chain status while official verification is pending', async () => {
  let finish, options;
  const $ = page((_query, opts) => { options = opts; return new Promise((resolve) => { finish = resolve; }); });
  $('rig').value = '9';
  const pending = $('go').onclick();
  options.onProgress?.(result(9));
  assert.equal($('out').hidden, false);
  assert.match($('chainVerdict')?.textContent ?? '', /已读取/);
  assert.match($('verdict').textContent, /查验中/);
  assert.equal($('go').disabled, false);
  finish(result(9, { state: 'all_pass', passed: 3, total: 3 }));
  await pending;
  assert.match($('verdict').textContent, /3\/3/);
});

test('another click cancels the prior request and a late reply cannot overwrite the newer result', async () => {
  const calls = [];
  const $ = page((_query, opts) => new Promise((resolve) => calls.push({ opts, resolve })));
  $('rig').value = '9';
  const first = $('go').onclick();
  $('rig').value = '10';
  const second = $('go').onclick();
  assert.equal(calls[0].opts.signal?.aborted, true);
  calls[1].resolve(result(10, { state: 'all_pass', passed: 10, total: 10 }));
  await second;
  calls[0].opts.onProgress?.(result(9));
  calls[0].resolve(result(9, { state: 'fail_at', index: 0, passed: 0, total: 3 }));
  await first;
  assert.match($('verdict').textContent, /10\/10/);
  assert.equal($('formErr').hidden, true);
});

test('a hidden BSC processor choice is not submitted when the selected chain is FabX', async () => {
  let query;
  const $ = page(async (value) => { query = value; return result(9); });
  $('rig').value = '9';
  $('processor').value = 'behemoth';
  await $('go').onclick();
  assert.equal(query.processor, undefined);
});

test('chain failures and incomplete vector responses have separate visible conclusions', async () => {
  const $ = page(async () => ({ ...result(9, { state: 'incomplete', reason: 'verify_incomplete' }), readState: 'read_failed' }));
  $('rig').value = '9';
  await $('go').onclick();
  assert.match($('chainVerdict')?.textContent ?? '', /读取失败.*重试/);
  assert.match($('verdict').textContent, /结果不完整/);
  assert.equal($('verdict').className, 'verdict warn');
  assert.doesNotMatch($('verdict').textContent, /官方接口报告向量|全部官方向量通过|没有这个电路/);
});
