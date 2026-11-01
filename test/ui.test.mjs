import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as engine from '../desk.mjs';
import * as share from '../share.mjs';
import { apiUrl } from '../api-url.mjs';
import { normalizeSitePath, isDeskEntryPath } from '../site-path.mjs';
import * as favoritesModule from '../fabx-favorites.mjs';
import * as paybackModule from '../fabx-payback.mjs';
import { diagnosisText } from '../fabx-diagnostics.mjs';
import * as slotDefense from '../slot-defense.mjs';
import * as crosschainYield from '../crosschain-yield.mjs';
import { RADAR_BOT, RADAR_MORE, radarCards, radarFilters, radarStats, radarText } from '../radar-view.mjs';
import { ECOSYSTEM_CHECKED, PROJECTS, ecosystemCards, ecosystemText, radarCounts } from '../ecosystem.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, '');
// One event-loop barrier drains nested snapshot/wallet deadline and retry promise chains.
const flush = () => new Promise(resolve => setImmediate(resolve));
const pending = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const fireTimer = async (h, ms) => {
  const timer = [...h.timers].find(([, value]) => value.ms === ms);
  assert.ok(timer, `expected a ${ms} ms timer`);
  h.timers.delete(timer[0]); timer[1].fn();
  await flush();
};
const state = (kind = 'pending', nandOkb = null) => ({
  head: 10, prices: { fabUsd: 0.25, bemUsd: 3, okbUsd: 100, anchorUsd: null, lowUsd: null, highUsd: null },
  network: { sealed: false, weight: 6000, networkNand: 10, miners: 4 },
  decision: { nandOkb, ratio: null, paybackDays: nandOkb == null ? null : 200, nandSource: nandOkb == null ? null : 'market' },
  availability: { history: { state: kind, asOf: null }, nand: { state: kind, asOf: null } },
});
function harness(overrides = {}, saved = {}) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, open: false,
      setAttribute() {}, getAttribute() { return null; },
      querySelectorAll: () => [], focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; },
    });
    return elements.get(id);
  };
  const events = new Map(), timers = new Map();
  let timerId = 0;
  const local = new Map(Object.entries(saved));
  const context = vm.createContext({
    document: { getElementById: get, documentElement: {}, hidden: false, addEventListener: (event, callback) => events.set(event, callback) },
    localStorage: { getItem: (key) => local.get(key) ?? null, setItem: (key, val) => local.set(key, val) },
    navigator: { language: 'en' }, window: {},
    location: { pathname: '/', href: 'http://localhost/', origin: 'http://localhost', search: '', hash: '' },
    history: { pushState() {}, replaceState() {} },
    URL, URLSearchParams, AbortController, Date, console, setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: (id) => timers.delete(id),
    snapshot: async () => state(), refreshOptional: () => new Promise(() => {}),
    loadEntryComparison: async () => ({ state: 'unavailable', ranked: [], unknown: [] }),
    wallet: async () => ({ circuits: 0 }),
    assetCard: () => ({ rigs: [{ id: '1', status: 'mining', fabPerDay: 1 }], fabPerDay: 1, usdPerDay: 0.25, valueUsd: 50, valueOkb: 0.5, paybackDays: 200, apr: 1.825 }),
    networkGrowth: async () => ({ measured: false, daily: 0 }), futureValue: () => 1,
    ...favoritesModule, ...paybackModule, diagnosisText,
    readPaybackContext: async () => null,
    rpc: async () => { throw new Error('UI test must not use live RPC'); }, batch: async () => [],
    deadline: (...args) => engine.deadline(...args),
    CFG: { ...engine.CFG, exampleWallet: '0x1111111111111111111111111111111111111111' },
    isAddress: (s) => /^0x[0-9a-fA-F]{40}$/.test(s), tierFor: () => { throw new Error('Missing ratio must not reach tierFor'); },
    scenario: () => ({ fabPerDay: 1, usdPerDay: 0.25, paybackDays: 200 }), paybackFor: () => 200,
    podSnapshot: async () => ({ head: 10, headTimestamp: 1_000, blockTime: 2, prices: { bemUsd: 0.1 }, network: { weight: 1, miners: 1, sealed: false }, asOf: new Date().toISOString() }),
    podRigs: async () => ({ circuits: 0, rigs: [], discovery: { complete: true }, head: 10 }),
    podRigsForIds: async () => ({ circuits: 0, rigs: [], discovery: { complete: true } }),
    podAssetCard: () => ({ rigs: [], fabPerDay: null, usdPerDay: null, valueUsd: null, valueOkb: null, apr: null, paybackDays: null }),
    POD_CFG: { exampleWallet: '0x2222222222222222222222222222222222222222' },
    BSC_ADDRESS_LOOKUP: false,
    fetchBscRigs: async () => ({ building: true, message: '索引建设中', rigs: [], progress: { complete: false } }),
    ...share,
    apiUrl: (path) => apiUrl(path, { hostname: 'localhost' }),
    fetchServerMarket: async () => null,
    applyHistory: (snap, value, check) => engine.applyHistory(snap, value, check),
    normalizeSitePath,
    isDeskEntryPath,
    ...slotDefense,
    ...crosschainYield,
    loadSlotDefense: async () => ({ state: 'ready', rows: [], rpc: { ethCall: 0, ethGetLogs: 0, maxInFlight: 0 } }),
    loadBemQuote: async () => ({ complete: false, reason: 'over-budget', method: null, priceBnb: null, perDay: null }),
    readOkxLast: async () => null,
    ECOSYSTEM_CHECKED, PROJECTS, ecosystemCards, ecosystemText, radarCounts, RADAR_BOT, RADAR_MORE, radarCards, radarFilters, radarStats, radarText, fetchRadar: async () => ({ status: 'ok', items: [] }),
    ...overrides,
  });
  vm.runInContext(source + '\nglobalThis.ui = { load, lookup, render, addFavorite, switchFavorite, setChain(next) { chain = next === "bsc" ? "bsc" : "fabx"; }, get snap() { return snap; } };', context);
  return { context, get, timers, events };
}

test('FabX feature panels are folded and favorites hydrate without opening or uploading addresses', async () => {
  const address = '0x3333333333333333333333333333333333333333';
  const reads = [];
  const h = harness({ wallet: async a => { reads.push(a); return { address: a, circuits: 1,
    head: 10, discovery: { complete: true, expected: 1 }, rigs: [
      { id: '8', chainStatus: 3, pool: null, status: 'stopped', fabPerDay: 0 },
    ] }; } }, { 'fabx-miner-desk:favorites:v1': JSON.stringify([address]) });
  await flush();
  assert.deepEqual(reads, [address]);
  assert.match(h.get('favoriteRows').innerHTML, /1 rigs|1 rig/);
  assert.match(h.get('favoriteRows').innerHTML, /1 anomal/);
  assert.equal(h.get('favorites').open, false);
  assert.equal(h.get('mineSection').open, false);
  assert.match(html, /<details[^>]*id="favorites"[^>]*>/);
  assert.doesNotMatch(html.match(/<details[^>]*id="favorites"[^>]*>/)[0], /\bopen\b/);
  assert.doesNotMatch(html.match(/<details[^>]*id="entryPayback"[^>]*>/)[0], /\bopen\b/);
  assert.doesNotMatch(html.match(/<details[^>]*id="crosschain"[^>]*>/)[0], /\bopen\b/);
});

test('dynamic asset payback stays unknown without growth and diagnoses preserve known chain reasons', async () => {
  const h = harness({ assetCard: engine.assetCard, wallet: async () => ({ circuits: 1, head: 10,
    discovery: { complete: true }, rigs: [{ id: '7', chainStatus: 2, status: 'revoked',
      fabPerDay: 0, diagnoses: [{ code: 'revoked', evidence: { status: 2 } }] }] }) });
  await flush();
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  const markup = h.get('assetCard').innerHTML;
  assert.match(markup, /Optimistic/);
  assert.match(markup, /Conservative/);
  assert.match(markup, /Cannot determine|unavailable/i);
  assert.match(markup, /Revoked|revoked/);
  assert.match(markup, /rig-diagnosis/);
});

test('saving an address during a favorite scan queues it and a failed address does not retry forever', async () => {
  const a = '0x3333333333333333333333333333333333333333', b = '0x4444444444444444444444444444444444444444';
  const first = pending(), reads = [];
  const h = harness({ wallet: async address => { reads.push(address); if (address === a) return first.promise; throw new Error('offline'); } },
    { 'fabx-miner-desk:favorites:v1': JSON.stringify([a]) });
  await flush();
  h.context.ui.addFavorite(b);
  first.resolve({ circuits: 0, head: 10, rigs: [], discovery: { complete: true, expected: 0 } });
  await flush();
  assert.deepEqual(reads, [a, b]);
  assert.match(h.get('favoriteRows').innerHTML, /Read failed; cannot determine/);
  await flush();
  assert.equal(reads.length, 2);
});

test('switching favorites cancels background reads and never publishes their late result', async () => {
  const a = '0x3333333333333333333333333333333333333333', b = '0x4444444444444444444444444444444444444444';
  const first = pending(), selected = pending(), calls = [];
  const h = harness({ wallet: async (address, _snap, _step, opts) => {
    calls.push({ address, signal: opts.signal }); return address === a ? first.promise : selected.promise;
  } }, { 'fabx-miner-desk:favorites:v1': JSON.stringify([a]) });
  await flush();
  const switched = h.context.ui.switchFavorite(b);
  await flush();
  assert.equal(calls[0].signal.aborted, true);
  first.resolve({ head: 10, circuits: 99, rigs: [] });
  await flush();
  assert.doesNotMatch(h.get('favoriteRows').innerHTML, /99 rigs/);
  selected.resolve({ head: 10, circuits: 0, rigs: [], discovery: { complete: true } });
  await switched;
  assert.match(h.get('mineOut').textContent, /No rigs|No FabX/i);
});

test('favorite storage failures remain usable and never claim persistence', async () => {
  const h = harness({ localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } } });
  await flush();
  h.context.ui.addFavorite('0x3333333333333333333333333333333333333333');
  assert.match(h.get('favoriteMessage').textContent, /only for this page session/);
  assert.match(h.get('favoritesTitle').textContent, /\(1\)/);
});

test('first screen shows current FAB and manual fallback while optional logs remain pending', async () => {
  const h = harness({}, { 'fmd.rule': JSON.stringify({ on: true, rows: [{ minRatio: 0, sell: 1 }] }), 'fmd.snap3': JSON.stringify(state('live', 999)) });
  await flush();
  assert.match(h.get('answer').innerHTML, /FAB is \$0.25 now/);
  assert.match(h.get('dataStatus').textContent, /Loading in the background/);
  assert.match(h.get('invest').textContent, /Enter a NAND price/);
  assert.equal(h.get('manualNand').hidden, false);
  assert.doesNotMatch(h.get('answerSub').innerHTML, /harvest rule|100% below/);
  h.get('manualNand').onclick();
  assert.equal(h.get('more').open, true);
  assert.equal(h.get('nand').focused, true);
});

test('degraded cache ages appear on first screen and asset card, with a 60 second retry', async () => {
  const cached = state('cached', 0.01);
  cached.availability.history.asOf = cached.availability.nand.asOf = new Date(Date.now() - 2 * 3600000).toISOString();
  const h = harness({ snapshot: async () => cached, refreshOptional: async (s) => s, wallet: async () => ({ circuits: 1, hours: 6, pendingFab: 1, networkSharePct: 1 }) });
  await flush();
  assert.match(h.get('dataStatus').textContent, /Temporarily unavailable; retrying automatically/);
  assert.match(h.get('dataStatus').textContent, /2 hours ago/);
  assert.equal([...h.timers.values()][0].ms, 60000);
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  assert.match(h.get('assetCard').innerHTML, /Using cached data from 2 hours ago/);
  assert.match(h.get('assetCard').innerHTML, /Per rig/);
  h.context.document.hidden = true; h.events.get('visibilitychange')();
  assert.equal(h.timers.size, 0);
  h.context.document.hidden = false; h.events.get('visibilitychange')();
  assert.equal([...h.timers.values()][0].ms, 60000);
  h.get('lang').onclick();
  assert.match(h.get('dataStatus').textContent, /暂时取不到，稍后自动重试/);
  assert.match(h.get('assetCard').innerHTML, /2 小时前/);
});

test('manual recalculation aborts old refresh and ignores its late updates', async () => {
  const calls = [];
  const h = harness({
    snapshot: async (opts) => {
      const s = state('pending', opts.nandOkb ?? null);
      if (opts.nandOkb) { s.availability.nand.state = 'manual'; s.decision.nandSource = 'manual'; }
      return s;
    },
    refreshOptional: (s, opts) => { const task = pending(); calls.push({ s, opts, task }); return task.promise; },
  });
  await flush();
  h.get('nand').value = '0.04';
  await h.context.ui.load();
  await flush();
  assert.equal(calls[0].opts.signal.aborted, true);
  assert.equal(calls[1].opts.nandOkb, 0.04);
  calls[0].opts.onUpdate(state('live', 99)); calls[0].task.resolve(state('live', 99));
  await flush();
  assert.equal(h.context.ui.snap.decision.nandOkb, 0.04);
  assert.match(h.get('dataStatus').textContent, /Using your manual NAND price/);
});

test('wallet ownership log errors stay local and retain the working main answer', async () => {
  let calls = 0;
  const h = harness({ wallet: async () => { calls++; throw new Error('eth_getLogs HTTP 429'); } });
  await flush();
  const lookup = h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  assert.equal(h.get('werr').hidden, true);
  await fireTimer(h, 3000);
  await lookup;
  assert.equal(calls, 2);
  assert.match(h.get('werr').textContent, /eth_getLogs HTTP 429/);
  assert.match(h.get('werr').textContent, /Other data is still usable/);
  assert.match(h.get('answer').innerHTML, /FAB is \$0.25 now/);
  assert.equal(h.get('mine').disabled, false);
  h.get('lang').onclick();
  assert.match(h.get('werr').textContent, /网络或链上数据暂不可用/);
  assert.doesNotMatch(h.get('werr').textContent, /Other data|eth_getLogs/);
});

test('terminal snapshot failure releases wallet lookup instead of waiting forever', async () => {
  const core = pending();
  let walletCalls = 0;
  const h = harness({ snapshot: () => core.promise, wallet: async () => { walletCalls++; } });
  const lookup = h.context.ui.lookup(h.context.CFG.exampleWallet);
  core.reject(new Error('eth_call unavailable'));
  await lookup;
  await flush();
  assert.equal(walletCalls, 0);
  assert.equal(h.get('mine').disabled, false);
  assert.match(h.get('answer').textContent, /eth_call unavailable/);
  assert.match(h.get('werr').textContent, /eth_call unavailable/);
});

test('automatic lookup retries a timed-out core load and ignores its late result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const core = pending();
  const cores = [], wallets = [];
  const addr = engine.CFG.exampleWallet;
  const h = harness({ CFG: { ...engine.CFG, loadTimeoutMs: 100 },
    location: { pathname: '/', search: '', hash: `#addr=${addr}`, href: `http://localhost/#addr=${addr}`, origin: 'http://localhost' },
    snapshot: options => { cores.push(options); return cores.length === 1 ? core.promise : Promise.resolve({ ...state(), head: 20 }); },
    wallet: async address => { wallets.push(address); return { circuits: 0 }; },
  });
  await flush();
  t.mock.timers.tick(100); await flush();
  assert.equal(cores[0].signal.aborted, true);
  assert.equal(h.context.ui.snap, null);
  assert.equal(h.get('werr').hidden, true, 'first timeout must not expose the terminal wallet error');
  assert.equal(h.get('mine').disabled, true);
  core.resolve(state()); await flush();
  assert.equal(h.context.ui.snap, null, 'late core success cannot replace a terminal timeout');
  await fireTimer(h, 3000);
  await flush();
  assert.equal(cores.length, 2);
  assert.deepEqual(wallets, [addr]);
  assert.equal(h.context.ui.snap.head, 20);
  assert.equal(h.get('werr').hidden, true);
  assert.equal(h.get('mine').disabled, false);
});

test('head-change remeasurement shares its attempt deadline and retry receives a fresh budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const measurements = [];
  let head = 10;
  const h = harness({ snapshot: async () => ({ ...state(), head: head++ }),
    wallet: (_address, current, onStep, opts) => {
      const task = pending();
      measurements.push({ head: current.head, onStep, signal: opts.signal, task });
      return task.promise;
    },
  });
  await flush();
  const lookup = h.context.ui.lookup(h.context.CFG.exampleWallet, 100);
  await flush();
  assert.deepEqual(measurements.map(read => read.head), [10]);

  t.mock.timers.tick(70);
  await h.context.ui.load();
  measurements[0].task.resolve({ circuits: 0 });
  await flush();
  assert.deepEqual(measurements.map(read => read.head), [10, 11]);
  assert.equal(measurements[1].signal, measurements[0].signal, 'remeasurement must retain the original operation signal');
  assert.equal(h.get('mine').disabled, true);

  t.mock.timers.tick(30);
  await flush();
  assert.equal(h.get('mine').disabled, true, 'retry keeps the lookup active');
  assert.equal(h.get('werr').hidden, true);
  assert.equal(measurements[1].signal.aborted, true);
  measurements[1].onStep('measure', { ids: ['99'], discovery: { complete: true } });
  measurements[1].task.resolve({ circuits: 0 });
  assert.equal(h.get('assetCard').hidden, true, 'late second-pass progress must remain hidden');
  await fireTimer(h, 3000);
  assert.deepEqual(measurements.map(read => read.head), [10, 11, 11]);
  assert.notEqual(measurements[2].signal, measurements[1].signal);
  t.mock.timers.tick(99); await flush();
  assert.equal(measurements[2].signal.aborted, false);
  measurements[2].task.resolve({ circuits: 0 }); await lookup;
  assert.equal(h.get('werr').hidden, true);
  assert.equal(h.get('mine').disabled, false);
});

test('optional growth falls back when the remaining wallet budget expires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness({ networkGrowth: () => new Promise(() => {}), wallet: async () => ({ circuits: 1, rigs: [] }) });
  await flush();
  h.context.CFG.walletTimeoutMs = 100;
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  t.mock.timers.tick(100); await flush();
  assert.doesNotMatch(h.get('assetCard').innerHTML, /Reading network weight/);
  assert.match(h.get('assetCard').innerHTML, /future output estimates show —/i);
  assert.doesNotMatch(h.get('assetCard').innerHTML, /future-table/);
});

test('wallet provider returning no account restores the button and offers address input', async () => {
  const h = harness({ window: { ethereum: { request: async () => [] } } });
  await flush();
  await h.get('mine').onclick();
  assert.equal(h.get('mine').textContent, 'Check my rigs');
  assert.equal(h.get('pasteRow').hidden, false);
});

test('a late wallet-provider account cannot replace a newer explicit address lookup', async () => {
  const provider = pending(), addresses = [];
  const h = harness({ window: { ethereum: { request: () => provider.promise } },
    wallet: async address => { addresses.push(address); return { circuits: 0 }; },
  });
  await flush();
  const connection = h.get('mine').onclick();
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  provider.resolve(['0x2222222222222222222222222222222222222222']);
  await connection;
  assert.deepEqual(addresses, [h.context.CFG.exampleWallet]);
});

test('optional retry refreshes the head first, preserves input, and runs one request at a time', async () => {
  const requests = [], cores = [];
  const h = harness({ snapshot: async (opts) => { const s = state('unavailable'); s.head = 10 + cores.length; cores.push(opts); return s; }, refreshOptional: (s, opts) => {
    requests.push({ s, opts });
    if (requests.length === 1) return Promise.resolve(s);
    return new Promise(() => {});
  } });
  await flush();
  h.get('nand').value = '0.07'; // An unsubmitted edit must not become a manual override during an automatic retry.
  h.get('addr').value = 'unfinished address';
  const timer = [...h.timers.values()][0];
  h.timers.clear(); timer.fn();
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].s.head, 10);
  assert.equal(requests[1].s.head, 11);
  assert.equal(h.context.ui.snap.head, 11);
  assert.equal(cores[1].nandOkb, undefined);
  assert.equal(h.get('nand').value, '0.07');
  assert.equal(h.get('addr').value, 'unfinished address');
  h.context.document.hidden = false; h.events.get('visibilitychange')();
  assert.equal(h.timers.size, 0);
  const partial = state('unavailable', 0.02); partial.availability.nand.state = 'live';
  requests[1].opts.onUpdate(partial);
  assert.equal(h.context.ui.snap.decision.nandOkb, 0.02);
  assert.match(h.get('answer').innerHTML, /200 days/);
});


test('visibility resume refreshes the core head and retains the applied manual NAND price', async () => {
  const cores = [], optionals = [];
  const h = harness({ snapshot: async (opts) => {
    const s = state('unavailable', opts.nandOkb ?? null);
    s.head = 20 + cores.length;
    if (opts.nandOkb) s.availability.nand.state = 'manual';
    cores.push(opts); return s;
  }, refreshOptional: async (s, opts) => { optionals.push({ s, opts }); return s; } });
  await flush();
  h.get('nand').value = '0.04'; await h.context.ui.load(); await flush();
  h.get('nand').value = '0.08'; // Keep an in-progress edit while retaining the already applied value.
  h.context.document.hidden = true; h.events.get('visibilitychange')();
  h.context.document.hidden = false; h.events.get('visibilitychange')();
  const timer = [...h.timers.values()][0]; h.timers.clear(); timer.fn(); await flush();
  assert.equal(cores.at(-1).nandOkb, 0.04);
  assert.equal(optionals.at(-1).s.head, 22);
  assert.equal(optionals.at(-1).s.decision.nandOkb, 0.04);
  assert.equal(h.get('nand').value, '0.08');
});


test('failed core retry labels the retained current price age in both languages and clears on recovery', async () => {
  let calls = 0;
  const h = harness({ snapshot: async () => {
    calls++;
    if (calls === 2) throw new Error('all core RPCs unavailable');
    const s = state('unavailable'); s.head = calls * 10;
    s.asOf = new Date(Date.now() - 2 * 3600000).toISOString();
    return s;
  }, refreshOptional: async (s) => s });
  await flush();
  let timer = [...h.timers.values()][0]; h.timers.clear(); timer.fn(); await flush();
  assert.equal(h.context.ui.snap.head, 10);
  assert.match(h.get('answer').innerHTML, /FAB is \$0.25 now/);
  assert.match(h.get('dataStatus').textContent, /Current prices and network data could not refresh/);
  assert.match(h.get('dataStatus').textContent, /2 hours ago/);
  h.get('lang').onclick();
  assert.match(h.get('dataStatus').textContent, /当前价格与全网数据刷新失败/);
  assert.match(h.get('dataStatus').textContent, /2 小时前/);
  timer = [...h.timers.values()][0]; h.timers.clear(); timer.fn(); await flush();
  assert.equal(h.context.ui.snap.head, 30);
  assert.doesNotMatch(h.get('dataStatus').textContent, /刷新失败/);
});

test('wallet completion refreshes a stale core before resuming optional reads and entry comparison', async () => {
  let cores = 0;
  const optionals = [], entries = [], measured = pending();
  const h = harness({ snapshot: async () => {
    cores++;
    if (cores === 2) throw new Error('all core RPCs unavailable');
    return { ...state('unavailable'), head: cores * 10 };
  }, refreshOptional: async current => {
    optionals.push(current.head);
    return optionals.length === 1 ? current : { ...state('live', 0.02), head: current.head };
  }, loadEntryComparison: async current => {
    entries.push(current.head);
    return { ...entryState(), head: current.head };
  }, wallet: () => measured.promise });
  await flush();
  await fireTimer(h, 60_000);
  assert.equal(cores, 2);
  assert.equal(h.context.ui.snap.head, 10);
  assert.match(h.get('dataStatus').textContent, /Current prices and network data could not refresh/);
  const lookup = h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  assert.ok(![...h.timers.values()].some(timer => timer.ms === 60_000));
  assert.deepEqual(optionals, [10]);
  measured.resolve({ circuits: 0 }); await lookup; await flush();
  assert.equal(cores, 3, 'resuming must recover the failed core even if optional data becomes live');
  assert.equal(h.context.ui.snap.head, 30);
  assert.deepEqual(optionals, [10, 30]);
  assert.deepEqual(entries, [10, 30]);
  assert.doesNotMatch(h.get('dataStatus').textContent, /Current prices and network data could not refresh/);
  assert.doesNotMatch(h.get('entryFreshness').textContent, /Refresh failed/);
  assert.match(h.get('entryStamp').textContent, /^Block 30/);
});

test('partial discovery labels confirmed ownership and limits totals in both languages, with same-address retry', async () => {
  const addresses = [];
  const h = harness({ wallet: async (address) => {
    addresses.push(address);
    return { circuits: 1, hours: 6, pendingFab: 1, networkSharePct: 1,
      discovery: { complete: false, expected: 76, verified: 1, source: 'scan', block: 10, errors: ['timeout'] } };
  } });
  await flush();
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  assert.match(h.get('mineOut').textContent, /Confirmed 1\/76 rigs/);
  assert.match(h.get('mineSub').innerHTML, /Summary covers confirmed rigs only/);
  assert.match(h.get('assetCard').innerHTML, /Summary covers confirmed rigs only/);
  assert.equal(h.get('assetCard').hidden, false);
  h.get('lang').onclick();
  assert.match(h.get('mineOut').textContent, /已确认 1\/76 台矿机/);
  assert.match(h.get('mineSub').innerHTML, /总览只覆盖已确认矿机/);
  assert.match(h.get('assetCard').innerHTML, /总览只覆盖已确认矿机/);
  await h.get('retryMine').onclick();
  await flush();
  assert.deepEqual(addresses, [h.context.CFG.exampleWallet, h.context.CFG.exampleWallet]);
});

test('zero confirmed rigs with incomplete discovery never claims the wallet holds no rigs', async () => {
  const h = harness({ wallet: async () => ({ circuits: 0,
    discovery: { complete: false, expected: 76, verified: 0, source: 'scan', block: 10, errors: ['timeout'] } }) });
  await flush();
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  assert.match(h.get('mineOut').textContent, /Confirmed 0\/76 rigs/);
  assert.doesNotMatch(h.get('mineOut').textContent, /holds no/);
  assert.match(h.get('mineSub').innerHTML, /Summary covers confirmed rigs only/);
  assert.equal(typeof h.get('retryMine').onclick, 'function');
  assert.equal(h.get('assetCard').hidden, true);
  h.get('lang').onclick();
  assert.match(h.get('mineOut').textContent, /已确认 0\/76 台矿机/);
  assert.doesNotMatch(h.get('mineOut').textContent, /没有/);
});

test('unknown ownership count is not represented as zero and complete legacy empty results remain compatible', async () => {
  let complete = false;
  const h = harness({ wallet: async () => complete ? { circuits: 0 } : { circuits: 0,
    discovery: { complete: false, expected: null, verified: 0, source: 'scan', block: 10, errors: ['unavailable'] } } });
  await flush();
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  assert.match(h.get('mineOut').textContent, /Confirmed 0\/— rigs/);
  complete = true;
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  assert.match(h.get('mineOut').textContent, /holds no FabX rigs/);
  assert.doesNotMatch(h.get('mineSub').innerHTML, /Summary covers confirmed rigs only/);
});

test('rig IDs render before pending reads finish, then real numbers replace placeholders', async () => {
  const measured = pending();
  let progress;
  const h = harness({
    wallet: (_address, _snap, onStep) => { progress = onStep; return measured.promise; },
    assetCard: (_snap, w) => ({ rigs: w.rigs, fabPerDay: w.loading ? null : 2,
      usdPerDay: w.loading ? null : 0.5, valueUsd: w.loading ? null : 100,
      valueOkb: w.loading ? null : 1, apr: w.loading ? null : 1.825, paybackDays: w.loading ? null : 200 }),
  });
  await flush();
  const lookup = h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  progress('measure', { ids: [7n, 19n], discovery: { complete: true, expected: 2, verified: 2 } });
  assert.equal(h.get('assetCard').hidden, false);
  assert.match(h.get('mineOut').textContent, /2 rigs/);
  assert.match(h.get('assetCard').innerHTML, /rig-number">19</);
  assert.match(h.get('assetCard').innerHTML, /Reading…/);
  assert.match(h.get('mineSub').innerHTML, /Numbers will fill in/);
  assert.doesNotMatch(h.get('assetCard').innerHTML, /Stopped|\$100|Future output value/);
  measured.resolve({ circuits: 2, hours: 6, pendingFab: 1, networkSharePct: 1,
    rigs: [{ id: '7', fabPerDay: 1, status: 'mining' }, { id: '19', fabPerDay: 1, status: 'mining' }] });
  await lookup;
  assert.match(h.get('assetCard').innerHTML, /\$100/);
  assert.doesNotMatch(h.get('assetCard').innerHTML, /Reading…|Numbers will fill in/);
});

test('superseded progress cannot replace another wallet and live NAND source/age stays visible', async () => {
  const readings = [];
  const s = state('live', 0.018);
  s.decision.nandSource = 'On-chain best ask · 100 NAND available';
  s.decision.nandQuote = { kind: 'onchain-ask', qty: 100 };
  s.availability.nand.asOf = new Date(Date.now() - 5 * 60_000).toISOString();
  const h = harness({ snapshot: async () => s, wallet: (addr, _snap, onStep) => {
    const deferred = pending(); readings.push({ addr, onStep, deferred }); return deferred.promise;
  } });
  await flush();
  const first = h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  const second = h.context.ui.lookup('0x2222222222222222222222222222222222222222');
  await flush();
  readings[0].onStep('measure', { ids: [99n], discovery: { complete: true } });
  assert.equal(h.get('assetCard').hidden, true);
  readings[1].onStep('measure', { ids: [2n], discovery: { complete: true } });
  assert.equal(h.get('assetCard').hidden, false);
  assert.match(h.get('assetCard').innerHTML, /NAND: 0.018 OKB · On-chain best ask/);
  assert.match(h.get('assetCard').innerHTML, /5 minutes ago/);
  h.get('lang').onclick();
  assert.match(h.get('assetCard').innerHTML, /NAND：0.018 OKB/);
  assert.match(h.get('assetCard').innerHTML, /5 分钟前/);
  assert.match(h.get('assetCard').innerHTML, /链上最低卖价 · 该价位 100 NAND/);
  assert.doesNotMatch(h.get('assetCard').innerHTML + h.get('net').innerHTML, /On-chain|available|at this price/);
  readings.forEach(r => r.deferred.resolve({ circuits: 0 }));
  await Promise.all([first, second]);
});

test('rig summary counts each status and puts only exceptions before the collapsed full list', async () => {
  const rigs = [
    { id: '1', status: 'mining', fabPerDay: 1 },
    { id: '2', status: 'claimed-in-window', fabPerDay: null },
    { id: '3', status: 'unread', fabPerDay: null },
    { id: '4', status: 'stopped', fabPerDay: 0 },
  ];
  const s = state('live', 0.02);
  s.network.fabPerNandDay = 0.1;
  const h = harness({ snapshot: async () => s, assetCard: engine.assetCard,
    wallet: async () => ({ circuits: 4, rigs, hours: 6, pendingFab: 1, networkSharePct: 1 }) }, { 'fmd.lang': 'zh' });
  await flush();
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  let markup = h.get('assetCard').innerHTML;
  assert.match(markup, /4 台：正常 1 · 停了 1 · 本窗口领取 1 · 读不到 1/);
  assert.match(markup, /<details id="allRigs"[^>]*>/);
  assert.doesNotMatch(markup.match(/<details id="allRigs"[^>]*>/)[0], /\bopen\b/);
  const exceptions = markup.split('<details id="allRigs"')[0];
  assert.deepEqual([...exceptions.matchAll(/<tr[^>]*><td><span class="rig-number">(\d+)<\/span>/g)].map(m => m[1]), ['4', '3', '2']);
  assert.equal((markup.split('<details id="allRigs"')[1].split('</table>')[0].match(/<tr/g) || []).length, 5);
  h.get('allRigs').open = true;
  // Rerender before the browser's queued toggle event has fired.
  h.get('lang').onclick();
  markup = h.get('assetCard').innerHTML;
  assert.match(markup, /4 rigs: 1 OK · 1 stopped · 1 claimed · 1 unread/);
  assert.match(markup, /<details id="allRigs"[^>]*\bopen\b/);
  assert.match(markup, /Hide all 4 rigs/);
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  assert.doesNotMatch(h.get('assetCard').innerHTML.match(/<details id="allRigs"[^>]*>/)[0], /\bopen\b/);
});

test('asset card explains ten-minute live rewards and retains measurement provenance in both languages', async () => {
  const h = harness({ wallet: async () => ({ circuits: 1, hours: 1 / 6,
    windowSeconds: 600, head: 73573806, previousHead: 73573206, blockTimestamp: 1792342842,
    pendingFab: 1, networkSharePct: 1 }) }, { 'fmd.lang': 'zh' });
  await flush();
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  let markup = h.get('assetCard').innerHTML;
  assert.match(markup, /近 10 分钟/);
  assert.match(markup, /pendingWithDeweb/);
  assert.match(markup, /73,573,806/);
  assert.match(markup, /读不准/);
  assert.doesNotMatch(markup, /uint256/);
  assert.doesNotMatch(markup, /可能偏低|近 0.2 小时/);
  h.get('lang').onclick();
  markup = h.get('assetCard').innerHTML;
  assert.match(markup, /10 minutes/);
  assert.match(markup, /pendingWithDeweb/);
  assert.doesNotMatch(h.get('method').innerHTML, /6 hours|understate/);
});

test('Chinese UI localizes cached/manual NAND sources and provider failures', async () => {
  const s = state('cached', 0.02);
  s.decision.nandQuote = { qty: 245, hours: 24 };
  s.decision.nandSource = 'Cached fill VWAP · 24h · 245 NAND';
  const h = harness({ snapshot: async () => s, wallet: async () => { throw new Error('Failed to fetch'); } }, { 'fmd.lang': 'zh' });
  await flush();
  assert.match(h.get('net').innerHTML, /缓存成交均价/);
  assert.doesNotMatch(h.get('net').innerHTML, /Cached|VWAP/);
  const lookup = h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  assert.equal(h.get('werr').hidden, true);
  await fireTimer(h, 3000);
  await lookup;
  assert.doesNotMatch(h.get('werr').textContent, /Failed to fetch/);
  assert.match(h.get('werr').textContent, /网络或链上数据暂不可用/);
  s.availability.nand.state = 'manual';
  s.decision.nandSource = 'manual';
  h.context.ui.render();
  assert.match(h.get('net').innerHTML, /手动/);
  assert.doesNotMatch(h.get('net').innerHTML, /manual|Cached/);
});

test('explicit /rigs address link auto-looks up without wallet extension and clears query', async () => {
  const addresses = [], paths = [];
  const addr = '0x3333333333333333333333333333333333333333';
  const h = harness({ location: { pathname: '/rigs', search: `?address=${addr}`, href: `http://localhost/rigs?address=${addr}`, origin: 'http://localhost', hash: '' },
    history: { replaceState: (_a, _b, path) => paths.push(path), pushState() {} },
    wallet: async address => { addresses.push(address); return { circuits: 0 }; },
  });
  for (let i = 0; i < 30; i++) await flush();
  assert.deepEqual(addresses, [addr]);
  assert.match(String(paths.at(-1) || ''), /addr=0x3333/i);
  assert.equal(h.get('werr').hidden, true);
});

test('root address link starts the same read-only lookup and clears the address', async () => {
  const addresses = [], paths = [];
  const addr = '0x3333333333333333333333333333333333333333';
  const h = harness({ location: { pathname: '/', search: `?address=${addr}`, href: `http://localhost/?address=${addr}`, origin: 'http://localhost', hash: '' },
    history: { replaceState: (_a, _b, path) => paths.push(path), pushState() {} },
    wallet: async address => { addresses.push(address); return { circuits: 0 }; },
  });
  for (let i = 0; i < 30; i++) await flush();
  assert.deepEqual(addresses, [addr]);
  assert.match(String(paths.at(-1) || ''), /addr=0x3333/i);
});

for (const prefix of ['?', '#']) {
  test(`${prefix}addr autoload waits for slow core with an independent wallet budget and defers optional reads`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const addr = engine.CFG.exampleWallet, core = pending(), measurement = pending();
    const reads = [];
    let optionalReads = 0, entryReads = 0;
    const startedAt = Date.now();
    const h = harness({ CFG: { ...engine.CFG, loadTimeoutMs: 100, walletTimeoutMs: 50 },
      location: { pathname: '/', search: prefix === '?' ? `?addr=${addr}&chain=fabx` : '',
        hash: prefix === '#' ? `#addr=${addr}&chain=fabx` : '', href: `http://localhost/${prefix}addr=${addr}&chain=fabx`, origin: 'http://localhost' },
      snapshot: () => core.promise,
      wallet: (address, _snap, _step, opts) => { reads.push({ address, opts, startedAt: Date.now() }); return measurement.promise; },
      refreshOptional: async s => { optionalReads++; return s; },
      loadEntryComparison: async () => { entryReads++; return { state: 'unavailable', ranked: [], unknown: [] }; },
    });
    await flush();
    t.mock.timers.tick(80); await flush();
    assert.equal(reads.length, 0);
    assert.equal(optionalReads, 0);
    assert.equal(entryReads, 0);
    core.resolve(state()); await flush();
    assert.equal(reads.length, 1);
    assert.equal(reads[0].address, addr);
    assert.equal(reads[0].startedAt - startedAt, 80);
    assert.equal(reads[0].opts.timeoutMs, 50);
    assert.equal(optionalReads, 0, 'optional reads must not compete with the wallet');
    assert.equal(entryReads, 0);
    t.mock.timers.tick(40); await flush();
    assert.equal(reads[0].opts.signal.aborted, false, 'core wait must not consume the measurement budget');
    measurement.resolve({ circuits: 1 }); await flush();
    assert.equal(h.get('werr').hidden, true);
    assert.equal(h.get('mine').disabled, false);
    assert.match(h.get('mineOut').textContent, /1 rig/);
    assert.equal(optionalReads, 1, 'optional reads resume after success');
    assert.equal(entryReads, 1);
  });
}

test('automatic address lookup hides the first timeout and publishes only the successful retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const addr = engine.CFG.exampleWallet, first = pending(), reads = [];
  const h = harness({ CFG: { ...engine.CFG, walletTimeoutMs: 100 },
    location: { pathname: '/', search: '', hash: `#addr=${addr}&chain=fabx`, href: `http://localhost/#addr=${addr}&chain=fabx`, origin: 'http://localhost' },
    wallet: (_address, _snap, onStep, opts) => {
      reads.push({ onStep, signal: opts.signal });
      return reads.length === 1 ? first.promise : Promise.resolve({ circuits: 1 });
    },
  });
  await flush();
  t.mock.timers.tick(100); await flush();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(h.get('werr').hidden, true);
  assert.equal(h.get('werr').textContent, '');
  assert.equal(h.get('mine').disabled, true);
  reads[0].onStep('measure', { ids: ['99'], discovery: { complete: true } });
  assert.equal(h.get('assetCard').hidden, true, 'timed-out progress is ignored during backoff');
  await fireTimer(h, 3000);
  assert.equal(reads.length, 2);
  assert.equal(h.get('werr').hidden, true);
  assert.equal(h.get('werr').textContent, '');
  assert.match(h.get('mineOut').textContent, /1 rig/);
  assert.equal(h.get('mine').disabled, false);
  first.resolve({ circuits: 99 }); await flush();
  t.mock.timers.tick(10_000); await flush();
  assert.equal(reads.length, 2);
  assert.match(h.get('mineOut').textContent, /1 rig/);
  assert.doesNotMatch(h.get('mineOut').textContent, /99/);
});

test('automatic address lookup shows failure only after both attempts time out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const addr = engine.CFG.exampleWallet, reads = [];
  const h = harness({ CFG: { ...engine.CFG, walletTimeoutMs: 100 },
    location: { pathname: '/', search: `?addr=${addr}`, hash: '', href: `http://localhost/?addr=${addr}`, origin: 'http://localhost' },
    wallet: (_address, _snap, onStep, opts) => { const task = pending(); reads.push({ onStep, opts, task }); return task.promise; },
  });
  await flush();
  t.mock.timers.tick(100); await flush();
  assert.equal(h.get('werr').hidden, true);
  assert.equal(h.get('mine').disabled, true);
  await fireTimer(h, 3000);
  assert.equal(reads.length, 2);
  assert.notEqual(reads[0].opts.signal, reads[1].opts.signal);
  t.mock.timers.tick(99); await flush();
  assert.equal(h.get('werr').hidden, true);
  t.mock.timers.tick(1); await flush();
  assert.equal(h.get('werr').hidden, false);
  assert.match(h.get('werr').textContent, /Couldn't read rigs.*timed out/i);
  assert.equal(h.get('mine').disabled, false);
  assert.ok(reads.every(read => read.opts.signal.aborted));
  assert.ok(![...h.timers.values()].some(timer => timer.ms === 3000), 'there is no third attempt');
  reads.forEach(read => {
    read.onStep('measure', { ids: ['99'], discovery: { complete: true } });
    read.task.resolve({ circuits: 99 });
  });
  await flush();
  assert.equal(h.get('assetCard').hidden, true);
  assert.equal(h.get('werr').hidden, false);
});

test('retryable node failures respect server cooldown while permanent failures do not retry', async () => {
  let calls = 0;
  const h = harness({ wallet: async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('RPC HTTP 429'), { retryable: true, retryAfterMs: 7000 });
    return { circuits: 0 };
  } });
  await flush();
  const lookup = h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  assert.equal(h.get('werr').hidden, true);
  assert.ok(![...h.timers.values()].some(timer => timer.ms === 3000));
  await fireTimer(h, 7000); await lookup;
  assert.equal(calls, 2);
  assert.equal(h.get('werr').hidden, true);

  let permanentCalls = 0;
  const permanent = harness({ wallet: async () => { permanentCalls++; throw Object.assign(new Error('RPC execution reverted'), { retryable: false }); } });
  await flush();
  await permanent.context.ui.lookup(permanent.context.CFG.exampleWallet);
  assert.equal(permanentCalls, 1);
  assert.equal(permanent.get('werr').hidden, false);
  assert.match(permanent.get('werr').textContent, /execution reverted/);
  assert.ok(![...permanent.timers.values()].some(timer => timer.ms === 3000));
});

test('a newer lookup cancels old backoff and keeps background reads paused until it completes', async () => {
  const later = pending(), addresses = [];
  let optionalReads = 0;
  const h = harness({ refreshOptional: () => { optionalReads++; return new Promise(() => {}); },
    wallet: async address => {
      addresses.push(address);
      if (addresses.length === 1) throw Object.assign(new Error('node down'), { retryable: true });
      return later.promise;
    },
  });
  await flush();
  const first = h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  const oldTimer = [...h.timers.values()].find(timer => timer.ms === 3000);
  assert.ok(oldTimer);
  const address = '0x2222222222222222222222222222222222222222';
  const second = h.context.ui.lookup(address);
  await flush();
  await first;
  assert.ok(![...h.timers.values()].some(timer => timer.ms === 3000));
  assert.equal(optionalReads, 1, 'superseded finally must not resume background reads');
  assert.equal(h.get('mine').disabled, true);
  oldTimer.fn(); await flush();
  assert.deepEqual(addresses, [h.context.CFG.exampleWallet, address]);
  later.resolve({ circuits: 0 }); await second; await flush();
  assert.equal(optionalReads, 2);
  assert.equal(h.get('werr').hidden, true);
  assert.equal(h.get('mine').disabled, false);
});

test('changing address during retry backoff cancels the retry and resumes optional reads', async () => {
  let calls = 0, optionalReads = 0;
  const h = harness({ refreshOptional: () => { optionalReads++; return new Promise(() => {}); },
    wallet: async (_address, _snap, onStep) => {
      calls++;
      onStep('measure', { ids: ['7'], discovery: { complete: true } });
      throw Object.assign(new Error('node down'), { retryable: true });
    },
  });
  await flush();
  const lookup = h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  assert.ok([...h.timers.values()].some(timer => timer.ms === 3000));
  h.get('other').onclick(); await lookup; await flush();
  assert.ok(![...h.timers.values()].some(timer => timer.ms === 3000));
  assert.equal(calls, 1);
  assert.equal(optionalReads, 2);
  assert.equal(h.get('mine').disabled, false);
  assert.equal(h.get('werr').hidden, true);
  assert.equal(h.get('assetCard').hidden, true);
});

test('changing address during progressive measurement restores the lookup button and ignores late completion', async () => {
  const measured = pending();
  const h = harness({ wallet: (_address, _snap, onStep) => {
    onStep('measure', { ids: ['7'], discovery: { complete: true } });
    return measured.promise;
  } });
  await flush();
  const lookup = h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  assert.equal(h.get('mine').disabled, true);
  h.get('other').onclick();
  assert.equal(h.get('mine').disabled, false);
  assert.equal(h.get('mine').textContent, 'Check my rigs');
  assert.equal(h.get('pasteRow').hidden, false);
  measured.resolve({ circuits: 1 });
  await lookup;
  assert.equal(h.get('assetCard').hidden, true);
  assert.equal(h.get('mineOut').hidden, true);
  assert.equal(h.get('mine').disabled, false);
});

const entryState = () => ({
  state: 'live', head: 73573806, blockTimestamp: 1792342842,
  asOf: '2026-10-18T17:00:42.000Z', previousHead: 73573206, windowSeconds: 600,
  totalScanned: 1334, validCount: 8,
  baseline: { nandRequired: 70.4396, okbPerFabDay: 1.32356, nandOkb: 0.01879, nandState: 'live', emissionVerified: true, emissionFabPerDay: 7128 },
  cheaper: 'build', deltaOkb: 0.37644, deltaPct: 22.1435,
  ranked: Array.from({ length: 7 }, (_, i) => ({ listingId: String(100 + i), id: String(200 + i),
    priceOkb: 1.7 + i, fabPerDay: 1, okbPerFabDay: 1.7 + i, apr: 1.25,
    url: `https://fabx.tech/en/circuits?circuit=${200 + i}` })),
  unknown: [{ listingId: '300', id: '400', priceOkb: 1, status: 'claimed-in-window' }],
});

test('entry hero compares one FAB/day, shows five ranked rows and collapses the rest in both languages', async () => {
  const h = harness({ refreshOptional: async s => s, loadEntryComparison: async () => entryState() });
  await flush();
  assert.match(h.get('entryAnswer').textContent, /Build.*less.*1\.32.*1\.7 OKB/);
  assert.match(h.get('entryTitle').textContent, /1 FAB\/day/);
  assert.match(h.get('entryValues').innerHTML, /1.3236.*1.7/s);
  assert.match(h.get('entryValues').innerHTML, /lowest measured/);
  assert.match(h.get('entryStamp').textContent, /^Block 73,573,806 · \d{2}:\d{2}$/);
  const markup = h.get('entryListings').innerHTML;
  assert.equal((markup.split('<details class="rig-list" id="entryAll"')[0].match(/class="entry-row"/g) || []).length, 5);
  assert.doesNotMatch(markup.match(/<details[^>]*>/)[0], /\bopen\b/);
  assert.match(markup, /400/);
  assert.match(h.get('entryScope').textContent, /Firsto independent listings excluded/);
  h.get('lang').onclick();
  assert.match(h.get('entryAnswer').textContent, /建新机更便宜.*1\.32.*1\.7 OKB/);
  assert.match(h.get('entryTitle').textContent, /每 1 FAB\/日的成本/);
  assert.match(h.get('entryStamp').textContent, /^区块 73,573,806 · \d{2}:\d{2}$/);
  assert.match(h.get('entryValues').innerHTML, /已测最低/);
  assert.match(h.get('entryScope').textContent, /只覆盖官方市场，未含 Firsto 独立挂单/);
  assert.match(h.get('entryCosts').textContent, /未计建机费用和 gas/);
});

test('entry answer updates both live route costs without hard-coded marketing prices', async () => {
  const result = entryState();
  Object.assign(result, { cheaper: 'listing', deltaOkb: 0.73684, deltaPct: 55.67 });
  result.ranked[0].okbPerFabDay = 0.58672;
  const h = harness({ refreshOptional: async s => s, loadEntryComparison: async () => result });
  await flush();
  assert.match(h.get('entryAnswer').textContent, /0\.59.*1\.32 OKB/);
  assert.match(h.get('entryValues').innerHTML, /1\.3236.*0\.5867/s);
  result.ranked[0].okbPerFabDay = 0.71234;
  result.baseline.okbPerFabDay = 1.54321;
  h.context.ui.render();
  assert.match(h.get('entryAnswer').textContent, /0\.71.*1\.54 OKB/);
  assert.doesNotMatch(h.get('entryAnswer').textContent, /0\.59|1\.32/);
  h.get('lang').onclick();
  assert.match(h.get('entryAnswer').textContent, /买现成更便宜.*0\.71.*1\.54 OKB/);
  assert.match(h.get('entryValues').innerHTML, /1\.5432.*0\.7123/s);
  result.cheaper = 'build';
  result.baseline.okbPerFabDay = 1.3235601;
  result.ranked[0].okbPerFabDay = 1.3235602;
  h.context.ui.render();
  assert.match(h.get('entryAnswer').textContent, /建新机更便宜/);
  const displayedCosts = h.get('entryAnswer').textContent.match(/\d+\.\d+/g);
  assert.equal(displayedCosts?.length, 2, 'both near-equal route costs remain visible');
  assert.notEqual(displayedCosts[0], displayedCosts[1], 'rounding cannot display equal prices beside a cheaper verdict');
  h.get('lang').onclick();
  const englishCosts = h.get('entryAnswer').textContent.match(/\d+\.\d+/g);
  assert.equal(englishCosts?.length, 2);
  assert.notEqual(englishCosts[0], englishCosts[1]);
});

test('quote sources, coverage, fees and observation window stay in the closed quote details', async () => {
  const details = html.match(/<details\b[^>]*id="entryDetails"[^>]*>[\s\S]*?<\/details>/)?.[0];
  assert.ok(details, 'quote details exist as a native disclosure');
  assert.doesNotMatch(details.match(/^<details[^>]*>/)[0], /\bopen\b/);
  assert.match(details, /<summary\b[^>]*id="entryDetailTitle"/);
  for (const id of ['entryScope', 'entryCosts', 'entryStatus', 'entrySources', 'entryObservation']) {
    assert.match(details, new RegExp(`id="${id}"`), `${id} remains inside quote details`);
  }
  const h = harness({ refreshOptional: async s => s, loadEntryComparison: async () => entryState() });
  await flush();
  assert.match(h.get('entryScope').textContent, /Official market only.*Firsto independent listings excluded/);
  assert.match(h.get('entryCosts').textContent, /Build fees and gas excluded/);
  assert.match(h.get('entryObservation').textContent, /official rig market.*73,573,806.*10-minute output window/s);
  assert.doesNotMatch(h.get('entryStamp').textContent, /Sources|window|2026/);
  h.get('lang').onclick();
  assert.match(h.get('entryObservation').textContent, /官方矿机市场.*73,573,806.*产出观察 10 分钟/s);
});

test('failed entry scan displays an aged frozen cache and unknown output never becomes a ranked zero', async () => {
  const frozen = { ...entryState(), state: 'cached', error: 'listing read failed', asOf: new Date(Date.now() - 7200000).toISOString() };
  const h = harness({ refreshOptional: async s => s, loadEntryComparison: async () => frozen });
  await flush();
  assert.match(h.get('entryStatus').textContent, /2 hours ago/);
  assert.match(h.get('entryStatus').textContent, /refresh failed/i);
  assert.match(h.get('entryFreshness').textContent, /refresh failed.*2 hours ago/i);
  assert.equal(h.get('entryFreshness').hidden, false);
  assert.match(h.get('entryListings').innerHTML, /Unknown.*excluded/s);
  assert.match(h.get('entryValues').innerHTML, /1.3236/);
});

test('entry failures and superseded scans cannot leave loading or publish stale data', async () => {
  const first = pending(); let calls = 0;
  const h = harness({ refreshOptional: async s => s, loadEntryComparison: async () => ++calls === 1 ? first.promise : { state: 'unavailable', ranked: [], unknown: [] } });
  await flush();
  await h.context.ui.load(); await flush();
  first.resolve(entryState()); await flush();
  assert.match(h.get('entryAnswer').textContent, /Temporarily unavailable/);
  assert.equal(h.get('entryListings').innerHTML, '');
});

test('entry historical-header failure shows unknown window and no price winner', async () => {
  const value = entryState();
  Object.assign(value, { windowSeconds: null, ranked: [], cheaper: null, deltaOkb: null, deltaPct: null });
  const h = harness({ refreshOptional: async s => s, loadEntryComparison: async () => value });
  await flush();
  assert.match(h.get('entryObservation').textContent, /—-minute/);
  assert.match(h.get('entryStamp').textContent, /^Block 73,573,806 · \d{2}:\d{2}$/);
  assert.match(h.get('entryAnswer').textContent, /cannot be compared/);
  assert.doesNotMatch(h.get('entryAnswer').textContent, /costs.*less/);
});

test('automatic core refresh failure labels the retained entry comparison as aged cache', async () => {
  let calls = 0;
  const h = harness({ snapshot: async () => {
    if (++calls === 2) throw new Error('core unavailable');
    return state('unavailable');
  }, refreshOptional: async s => s,
  loadEntryComparison: async () => ({ ...entryState(), asOf: new Date(Date.now() - 7200000).toISOString() }) });
  await flush();
  const timer = [...h.timers.values()][0]; h.timers.clear(); timer.fn(); await flush();
  assert.match(h.get('entryStatus').textContent, /Refresh failed.*2 hours ago/);
  assert.match(h.get('entryFreshness').textContent, /Refresh failed.*2 hours ago/);
  assert.equal(h.get('entryFreshness').hidden, false);
  assert.match(h.get('entryValues').innerHTML, /1.3236/);
});

test('newbie path puts risk before the only hero and payback is one native-details click away', async () => {
  const requests = [];
  const h = harness({ window: { ethereum: { request: p => requests.push(p) } } }, { 'fmd.lang': 'zh' });
  await flush();
  assert.ok(html.indexOf('id="newbieRisk"') < html.indexOf('id="entryCompare"'));
  const risk = html.match(/<aside\b[^>]*id="newbieRisk"[^>]*>[\s\S]*?<\/aside>/)[0];
  const riskDetails = risk.match(/<details\b[^>]*id="riskDetails"[^>]*>[\s\S]*?<\/details>/)?.[0];
  assert.ok(riskDetails, 'full risk explanation remains in a native disclosure');
  assert.doesNotMatch(riskDetails.match(/^<details[^>]*>/)[0], /\bopen\b/);
  assert.match(riskDetails, /<summary\b[^>]*id="riskDetailTitle"/);
  assert.match(riskDetails, /id="riskText"/);
  assert.match(riskDetails, /id="riskState"/);
  assert.match(risk.split('<details')[0], /id="riskTitle"/, 'short risk warning remains visible outside the disclosure');
  assert.equal(h.get('riskTitle').textContent, '只读，不构成建议 · 挖矿合约未封存，产出可能被稀释');
  assert.match(h.get('riskText').textContent, /可升级/);
  assert.match(h.get('riskText').textContent, /稀释/);
  assert.match(h.get('riskText').textContent, /币价/);
  assert.match(h.get('riskText').textContent, /只读.*不构成建议/);
  assert.match(h.get('todayEyebrow').textContent, /现在进场值不值.*回本/);
  for (const id of ['today', 'newbieBasics', 'firstSteps', 'entryBook', 'mineSection', 'budgetSection']) {
    const tag = html.match(new RegExp(`<details[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `${id} is native details`);
    assert.doesNotMatch(tag, /\bopen\b/);
  }
  assert.deepEqual(requests, []);
  h.get('lang').onclick();
  assert.match(h.get('riskText').textContent, /upgradeable/);
  assert.match(h.get('riskText').textContent, /dilut/);
  assert.match(h.get('riskText').textContent, /read-only.*not investment advice/);
  assert.match(h.get('riskTitle').textContent, /read-only.*unsealed.*dilut/i);
  assert.match(h.get('todayEyebrow').textContent, /payback/i);
});

test('short risk warning distinguishes pending, sealed and unknown contract states in both languages', async () => {
  const core = pending();
  const h = harness({ snapshot: () => core.promise });
  assert.match(h.get('riskTitle').textContent, /read-only.*(?:unknown|unavailable)/i);
  assert.doesNotMatch(h.get('riskTitle').textContent, /\bunsealed\b/i);
  const sealed = state(); sealed.network.sealed = true;
  core.resolve(sealed); await flush();
  assert.match(h.get('riskTitle').textContent, /read-only/i);
  assert.doesNotMatch(h.get('riskTitle').textContent, /\bunsealed\b/i);
  assert.match(h.get('riskState').textContent, /seal read: yes/);
  h.get('lang').onclick();
  assert.match(h.get('riskTitle').textContent, /只读.*不构成建议/);
  assert.doesNotMatch(h.get('riskTitle').textContent, /未封存/);
  assert.match(h.get('riskState').textContent, /封存读数：是/);
  h.context.ui.snap.network.sealed = undefined;
  h.context.ui.render();
  assert.match(h.get('riskTitle').textContent, /未知|未取得/);
  assert.doesNotMatch(h.get('riskTitle').textContent, /未封存/);
  assert.match(h.get('riskState').textContent, /当前封存状态未取得，不能视为风险已解除/);
  assert.doesNotMatch(h.get('riskState').textContent, /当前挖矿合约：未封存/);
  h.get('lang').onclick();
  assert.match(h.get('riskTitle').textContent, /unknown|unavailable/i);
  assert.doesNotMatch(h.get('riskTitle').textContent, /\bunsealed\b/i);
  assert.match(h.get('riskState').textContent, /Current seal state unavailable; this does not mean the risks are gone/);
  assert.doesNotMatch(h.get('riskState').textContent, /currently unsealed/);
});

test('newbie numbers reuse snapshot sources and times without requesting wallet or new data', async () => {
  const s = state('live', 0.02);
  s.asOf = '2026-10-18T17:00:00.000Z'; s.headTimestamp = 1792342800; s.head = 73573806;
  s.decision.nandQuote = { kind: 'onchain-ask', qty: 245 };
  s.availability.nand.asOf = s.asOf;
  const h = harness({ snapshot: async () => s }, { 'fmd.lang': 'zh' });
  await flush();
  const content = h.get('basicsNumbers').innerHTML;
  assert.match(content, /0.25/);
  assert.match(content, /0.02/);
  assert.match(content, /73,573,806/);
  assert.match(content, /2026/);
  assert.match(content, /DexScreener/);
  assert.match(content, /LATCH.*未接入/);
  assert.match(h.get('paybackSource').textContent, /OKX/);
  assert.match(h.get('paybackSource').textContent, /NAND/);
  h.get('lang').onclick();
  assert.match(h.get('basicsContent').textContent, /logic.*storage/);
  assert.match(h.get('basicsNumbers').innerHTML, /LATCH.*not available/);
});

test('newbie data gaps and cached or manual NAND are explicit, never fabricated live values', async () => {
  const h = harness({}, { 'fmd.lang': 'zh' });
  await flush();
  assert.match(h.get('basicsNumbers').innerHTML, /NAND.*—/);
  assert.match(h.get('basicsNumbers').innerHTML, /时间未知/);
  assert.doesNotMatch(h.get('basicsNumbers').innerHTML, /\$0(?:<|\s)/);
  const s = state('cached', 0.02);
  s.availability.nand.asOf = '2026-10-17T17:00:00.000Z';
  h.context.ui.snap.decision = s.decision;
  h.context.ui.snap.availability = s.availability;
  h.context.ui.render();
  assert.match(h.get('basicsNumbers').innerHTML, /缓存/);
  assert.match(h.get('basicsNumbers').innerHTML, /2026/);
  h.context.ui.snap.availability.nand.state = 'manual';
  h.context.ui.render();
  assert.match(h.get('basicsNumbers').innerHTML, /手动/);
  assert.doesNotMatch(h.get('basicsNumbers').innerHTML.split('NAND')[1], /链上最低卖价/);
});

test('first-step links are the three verified official destinations without referral parameters', () => {
  const step = html.match(/<details[^>]*id="firstSteps"[\s\S]*?<\/details>/)[0];
  const links = [...step.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(links, ['https://fabx.tech/', 'https://fabx.tech/en/circuits',
    'https://fabx.tech/en/market/0xbe6f94115d32f3ac3252bc4626573e739beeb714-0']);
  for (const link of links) {
    assert.equal(new URL(link).search, '');
    assert.equal(new URL(link).hash, '');
  }
});

test('already-own-rigs shortcut only opens the asset section and keeps wallet access optional', async () => {
  const requests = [];
  const h = harness({ window: { ethereum: { request: p => requests.push(p) } } });
  await flush();
  h.get('already').onclick();
  assert.equal(h.get('mineSection').open, true);
  assert.equal(h.get('mineSection').scrolled, true);
  assert.deepEqual(requests, []);
});

test('entry quote details retain NAND source and time, with cached and manual warnings visible', async () => {
  const result = entryState();
  Object.assign(result.baseline, { nandQuote: { kind: 'onchain-ask', qty: 245 }, nandAsOf: '2026-10-18T17:00:42.000Z' });
  result.priceAsOf = '2026-10-18T17:00:44.000Z';
  const h = harness({ refreshOptional: async s => s, loadEntryComparison: async () => result }, { 'fmd.lang': 'zh' });
  await flush();
  assert.match(h.get('entrySources').textContent, /NAND 来源：链上最低卖价/);
  assert.match(h.get('entrySources').textContent, /2026/);
  assert.match(h.get('entrySources').textContent, /245/);
  assert.equal(h.get('entryFreshness').textContent, '');
  assert.equal(h.get('entryFreshness').hidden, true);
  result.baseline.nandState = 'cached';
  h.context.ui.render();
  assert.match(h.get('entryFreshness').textContent, /缓存报价/);
  assert.equal(h.get('entryFreshness').hidden, false);
  result.baseline.nandState = 'manual';
  h.context.ui.render();
  assert.match(h.get('entryFreshness').textContent, /手动/);
  assert.equal(h.get('entryFreshness').hidden, false);
  result.baseline.nandOkb = null; result.baseline.nandQuote = null;
  h.context.ui.render();
  assert.match(h.get('entrySources').textContent, /NAND 来源：读数未取得/);
  assert.doesNotMatch(h.get('entrySources').textContent, /链上最低卖价/);
});

test('real wallet partial pending zero renders a subtotal, never a complete zero balance, in both languages', async t => {
  const head = 80_000_000, abi = (...values) => '0x' + values.map(value => BigInt(value).toString(16).padStart(64, '0')).join('');
  const s = { ...state('live', 0.02), head, headTimestamp: head * 2, blockTime: 2 };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    const reply = request => {
      const { method, params } = request;
      const result = value => ({ id: request.id, result: value });
      if (method === 'eth_getBlockByNumber') return result({ timestamp: '0x' + (Number(params[0]) * 2).toString(16) });
      assert.equal(method, 'eth_call', 'all wallet traffic is handled in memory');
      const [{ data }] = params, selector = data.slice(0, 10);
      if (selector === '0xbce38bd7') return { id: request.id, error: { code: 3, message: 'mock direct calls only' } };
      if (selector === '0x70a08231') return result(abi(2));
      if (selector === '0x61b8ce8c') return result(abi(2));
      if (selector === '0xf9f8bdb7') return result(abi(8333333));
      if (selector === '0xd8d56ffb') return result(abi(100));
      const id = Number(BigInt('0x' + data.slice(-64)));
      if (selector === '0x6352211e') return result(abi(id ? BigInt(engine.CFG.exampleWallet) : 0n));
      if (selector === '0x10eafa00') return result(abi(id));
      if (selector === '0x024b2c13') return result(id === 1 ? abi(0) : null);
      if (selector === '0xa6a20acd') return result(abi(0, 0, 7128 * 1e8, 1));
      assert.equal(selector, '0x0527edc2');
      const fields = Array(23).fill(0n);
      fields[0] = BigInt(engine.CFG.circuits); fields[1] = BigInt(id);
      fields[8] = BigInt(head * 2 - 3600); fields[9] = 1n;
      return result(abi(...fields));
    };
    return { ok: true, json: async () => Array.isArray(body) ? body.map(reply) : reply(body) };
  });
  let actual;
  const h = harness({ snapshot: async () => s, CFG: engine.CFG, assetCard: engine.assetCard,
    wallet: async (...args) => (actual = await engine.wallet(...args)) });
  await flush();
  await h.context.ui.lookup(engine.CFG.exampleWallet);
  assert.equal(actual.discovery.complete, true);
  assert.equal(actual.pendingFab, null);
  assert.equal(actual.pendingUsd, null);
  assert.equal(actual.pendingKnown, 1);
  assert.equal(actual.measured, 1);
  for (const id of ['mineSub', 'assetCard']) {
    assert.match(h.get(id).innerHTML, /Read pending subtotal: 0 FAB \(1\/2 rigs\)/);
    assert.doesNotMatch(h.get(id).innerHTML, /Total pending:|0 FAB pending/);
  }
  h.get('lang').onclick();
  for (const id of ['mineSub', 'assetCard']) {
    assert.match(h.get(id).innerHTML, /已读待领小计 0 FAB（1\/2 台）/);
    assert.doesNotMatch(h.get(id).innerHTML, /待领总额/);
  }
});

test('pending coverage is independent of measurable output and missing totals remain unknown', async () => {
  const w = { circuits: 2, discovery: { complete: true }, pendingComplete: true, pendingFab: 7,
    pendingKnown: 2, pendingTotal: 2, pendingSubtotalFab: 7, measured: 0, rigs: [
      { id: '1', status: 'unread', fabPerDay: null }, { id: '2', status: 'claimed-in-window', fabPerDay: null },
    ] };
  const h = harness({ wallet: async () => w, assetCard: engine.assetCard });
  await flush();
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  assert.match(h.get('mineSub').innerHTML, /Total pending: 7 FAB \(2\/2 rigs\)/);
  assert.match(h.get('assetCard').innerHTML, /0 of 2 rigs measurable/);
  h.get('lang').onclick();
  assert.match(h.get('mineSub').innerHTML, /待领总额 7 FAB（2\/2 台）/);
  Object.assign(w, { pendingComplete: false, pendingFab: null, pendingKnown: 0, pendingSubtotalFab: null });
  h.context.ui.render();
  assert.match(h.get('mineSub').innerHTML, /待领奖励未知（0\/2 台已读）/);
  assert.doesNotMatch(h.get('mineSub').innerHTML, /待领总额|小计 0/);
  h.get('lang').onclick();
  assert.match(h.get('mineSub').innerHTML, /Pending rewards unknown \(0\/2 rigs read\)/);
});

test('missing actual emission makes the build assumption visibly unverified and suppresses winners', async () => {
  const value = entryState();
  Object.assign(value.baseline, { emissionVerified: false, emissionFabPerDay: null, nandRequired: null, okbPerFabDay: null });
  value.cheaper = null;
  const h = harness({ refreshOptional: async s => s, loadEntryComparison: async () => value });
  await flush();
  assert.match(h.get('entryAnswer').textContent, /emission.*unavailable.*assumption is unverified/);
  assert.doesNotMatch(h.get('entryAnswer').textContent, /costs less/);
  assert.equal(h.get('entryFreshness').hidden, false);
  assert.match(h.get('entryFreshness').textContent, /unverified/);
  h.get('lang').onclick();
  assert.match(h.get('entryAnswer').textContent, /实际排放未取得.*假设未核实/);
  assert.doesNotMatch(h.get('entryAnswer').textContent, /更便宜/);
  assert.match(h.get('entryFreshness').textContent, /假设未核实/);
});

test('actual emission provenance and static scenario assumptions stay distinct in both languages', async () => {
  const value = entryState(); value.baseline.emissionFabPerDay = 3564;
  const h = harness({ refreshOptional: async s => s, loadEntryComparison: async () => value });
  await flush();
  assert.match(h.get('entrySources').textContent, /actual verified-miner emission at block 73,573,806: 3,564 FAB\/day/);
  assert.match(h.get('entryMethod').textContent, /currentRate and unverifiedBps at the same block/);
  assert.match(h.get('paybackSource').textContent, /static Genesis model.*7,128.*not a current emission read/);
  h.get('lang').onclick();
  assert.match(h.get('entrySources').textContent, /区块 73,573,806.*实际排放：3,564 FAB\/日/);
  assert.match(h.get('paybackSource').textContent, /静态模型.*7,128.*并非当前排放读数/);
});

test('example asset card keeps address, ownership disclaimer and snapshot context inside the card', async () => {
  const h = harness({ wallet: async () => ({ circuits: 1, rigs: [] }) });
  await flush();
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  assert.match(h.get('assetCard').innerHTML, /Public example address, not the author’s holdings.*historical block snapshot/);
  assert.ok(h.get('assetCard').innerHTML.includes(h.context.CFG.exampleWallet));
  h.get('lang').onclick();
  assert.match(h.get('assetCard').innerHTML, /公开示例地址、非作者持仓.*历史快照/);
  await h.context.ui.lookup('0x3333333333333333333333333333333333333333');
  assert.doesNotMatch(h.get('assetCard').innerHTML, /公开示例地址、非作者持仓/);
});

test('cheap-rig subscribe is on the page, and the address alert uses a one-time Telegram link', async () => {
  const requests = [];
  const opened = [];
  const token = 'a'.repeat(32);
  const url = `https://t.me/fabx_miner_desk_bot?start=${token}`;
  const h = harness({
    wallet: async () => ({ circuits: 1, rigs: [] }),
    window: { open(next) { opened.push(next); return null; } },
    fetch: async (requestUrl, init) => { requests.push({ url: requestUrl, init }); return { ok: true, status: 200, json: async () => ({ ok: true, url }) }; },
  });
  await flush();
  assert.equal(h.get('cheapBox').hidden, false);
  assert.match(h.get('cheapTitle').textContent, /Cheap rig alerts/);
  assert.match(h.get('cheapGo').textContent, /Subscribe with Telegram/);
  h.get('cheapThreshold').value = '0';
  await h.get('cheapGo').onclick();
  assert.match(h.get('cheapMsg').textContent, /integer from 1 to 90/);
  assert.equal(requests.length, 0);
  h.get('cheapThreshold').value = '20';
  await h.get('cheapGo').onclick();
  await flush();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].init.body), { bind: true, lang: 'en', chain: 'xlayer', threshold: 20, cheap: true });
  assert.deepEqual(opened, [url]);
  assert.equal(h.get('cheapLink').hidden, false);
  assert.equal(h.get('cheapLink').href, url);
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  assert.equal(h.get('alertBox').hidden, true, 'never offered for the public example address');
  const address = '0x3333333333333333333333333333333333333333';
  await h.context.ui.lookup(address);
  assert.equal(h.get('alertBox').hidden, false);
  assert.match(h.get('alertTitle').textContent, /Tell me when this address changes/);
  assert.match(h.get('alertBody').textContent, /Telegram.*stops.*No username.*tap Start.*never asks you to connect a wallet or sign/);
  assert.match(h.get('alertGo').textContent, /Subscribe with Telegram/);
  h.get('alertThreshold').value = '0';
  await h.get('alertGo').onclick();
  assert.match(h.get('alertMsg').textContent, /integer from 1 to 90/);
  assert.equal(requests.length, 1);
  h.get('alertThreshold').value = '25';
  await h.get('alertGo').onclick();
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, '/api/alerts');
  assert.deepEqual(JSON.parse(requests[1].init.body), { bind: true, lang: 'en', chain: 'xlayer', threshold: 25, cheap: true, address });
  assert.deepEqual(opened, [url, url]);
  assert.match(h.get('alertMsg').textContent, /Tap Start/);
  assert.equal(h.get('alertBotLink').hidden, false, 'the one-time link is shown if Telegram did not open');
  assert.match(html, /<a id="alertBotLink" href="https:\/\/t\.me\/fabx_miner_desk_bot" target="_blank" rel="noopener" hidden>/);
  assert.equal(h.get('alertBotLink').href, url);
  assert.match(h.get('alertBotLink').textContent, /Tap here to finish in Telegram/);
  h.get('lang').onclick();
  assert.equal(h.get('alertBotLink').href, url, 'the one-time link keeps the language that was stored in the token');
  assert.match(h.get('alertTitle').textContent, /这个地址有变动时提醒我/);
  assert.match(h.get('alertBody').textContent, /停了.*Telegram.*不用填用户名.*点「开始」.*不连钱包、不签名/);
  assert.match(h.get('alertMsg').textContent, /点「开始」/);
  assert.match(h.get('cheapTitle').textContent, /便宜矿机提醒/);
  assert.match(h.get('cheapBody').textContent, /下架或卖掉不再说/);
  assert.match(h.get('alertBotLink').textContent, /点这里在 Telegram 完成订阅/);
  h.get('other').onclick();
  assert.equal(h.get('alertBox').hidden, true);
  assert.equal(h.get('alertBotLink').hidden, true, 'the bot link resets with the message');
});

test('BSC hides cheap-rig alerts and an address subscribe does not turn them on', async () => {
  const requests = [];
  const address = '0x3333333333333333333333333333333333333333';
  const h = harness({
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, url: `https://t.me/fabx_miner_desk_bot?start=${'b'.repeat(32)}` }) };
    },
    podRigs: async (addr) => ({
      address: addr, circuits: 1, head: 10, discovery: { complete: true, expected: 1, verified: 1 },
      rigs: [{ id: '1', status: 'mining', fabPerDay: 1 }],
    }),
    podAssetCard: (_snap, wallet) => ({ rigs: wallet.rigs, fabPerDay: 1, usdPerDay: 1, valueUsd: 1, valueOkb: null, apr: null, paybackDays: null }),
  }, { 'fmd.chain': 'bsc', 'fmd.lang': 'zh' });
  await flush();
  assert.equal(h.get('cheapBox').hidden, true);
  await h.context.ui.lookup(address);
  await flush();
  assert.equal(h.get('alertBox').hidden, false);
  assert.equal(h.get('alertThresholdRow').hidden, true);
  await h.get('alertGo').onclick();
  await flush();
  assert.deepEqual(requests, [{ bind: true, lang: 'zh', chain: 'bsc', threshold: 20, cheap: false, address }]);
});

test('rig income alert sign-up failures stay local and readable, including mirrors without the endpoint', async () => {
  let status = 404;
  const h = harness({ wallet: async () => ({ circuits: 1, rigs: [] }),
    fetch: async () => ({ ok: status === 200, status, json: async () => status === 429 ? { ok: false, error: 'limit' } : JSON.parse('<html>') }) });
  await flush();
  await h.context.ui.lookup('0x3333333333333333333333333333333333333333');
  await h.get('alertGo').onclick();
  assert.match(h.get('alertMsg').textContent, /Could not submit/);
  assert.equal(h.get('alertGo').disabled, false);
  status = 429;
  await h.get('alertGo').onclick();
  assert.match(h.get('alertMsg').textContent, /address limit/);
  assert.match(h.get('answer').innerHTML, /FAB is \$0.25 now/);
  const noFetch = harness({ wallet: async () => ({ circuits: 1, rigs: [] }) });
  await flush();
  await noFetch.context.ui.lookup('0x3333333333333333333333333333333333333333');
  await noFetch.get('alertGo').onclick();
  assert.match(noFetch.get('alertMsg').textContent, /Could not submit/);
});

test('index loads the stats beacon as a separate module and every alert string exists in both languages', async () => {
  assert.match(html, /<script type="module" src="track\.mjs"><\/script>/);
  for (const key of ['alertTitle', 'alertBody', 'alertThresholdLabel', 'alertThresholdSuffix', 'alertGo', 'alertSending', 'alertOk', 'alertBadThreshold', 'alertLimit', 'alertFail', 'alertBotLink', 'cheapTitle', 'cheapBody', 'cheapThresholdLabel', 'cheapThresholdSuffix', 'cheapGo',
    'fbTitle', 'fbPh', 'fbGo', 'fbSending', 'fbOk', 'fbEmpty', 'fbFail']) {
    assert.equal((source.match(new RegExp(`\\b${key}: '`, 'g')) || []).length, 2, key);
  }
});

test('feedback box sends one trimmed line with language and page on click or Enter, clears on success, and survives mirrors without the endpoint', async () => {
  const requests = [];
  let status = 200;
  const h = harness({ fetch: async (url, init) => { requests.push({ url, init }); return { ok: status === 200, status, json: async () => ({ ok: status === 200 }) }; } });
  await flush();
  assert.match(h.get('fbTitle').textContent, /Feedback: what is missing or wrong, in one line \(no login\)/);
  assert.equal(h.get('fbText').placeholder, 'e.g. show TapeOut rigs on BSC too');
  await h.get('fbGo').onclick();
  assert.match(h.get('fbMsg').textContent, /Write a line first/);
  assert.equal(requests.length, 0);
  h.get('fbText').value = '  show   BSC rigs\n too ';
  await h.get('fbText').onkeydown({ key: 'Enter' });
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/feedback');
  assert.deepEqual(JSON.parse(requests[0].init.body), { text: 'show BSC rigs too', lang: 'en', page: '/' });
  assert.equal(requests[0].init.credentials, 'omit');
  assert.match(h.get('fbMsg').textContent, /Got it, thanks/);
  assert.equal(h.get('fbText').value, '', 'cleared after a stored submission');
  assert.equal(h.get('fbGo').disabled, false);
  status = 404;
  h.get('fbText').value = 'again';
  await h.get('fbGo').onclick();
  assert.match(h.get('fbMsg').textContent, /Could not send/);
  assert.equal(h.get('fbText').value, 'again', 'kept so the visitor can retry');
  h.get('lang').onclick();
  assert.match(h.get('fbTitle').textContent, /反馈：缺什么、哪里不对/);
  assert.match(h.get('fbMsg').textContent, /发送失败/);
  const noFetch = harness();
  await flush();
  noFetch.get('fbText').value = 'hello';
  await noFetch.get('fbGo').onclick();
  assert.match(noFetch.get('fbMsg').textContent, /Could not send/);
});

test('folded slot defense and cross-chain cost keep the measured and formula boundary', async () => {
  const calls = [];
  const entry = entryState();
  entry.complete = true;
  entry.ranked[0].status = 'measured';
  entry.ranked[0].priceOkb = 1.63296;
  entry.ranked[0].fabPerDay = 1.08932112;
  const snap = state('live', 0.02);
  snap.prices.okbUsd = 113.78;
  snap.prices.fabBem = '0.02234219220560771';
  const h = harness({
    snapshot: async () => snap,
    refreshOptional: async current => current,
    loadEntryComparison: async () => entry,
    loadBemQuote: async () => ({ complete: true, method: 'formula_rate', priceBnb: '0.175', perDay: '0.01296', reason: null }),
    readOkxLast: async () => '735.6',
    loadSlotDefense: async (ids, head) => {
      calls.push({ ids: ids.map(String), head });
      return {
        state: 'ready', head, rows: [{
          id: '8', role: 'leader', taskId: '99', status: 1, leaderC: '130683', ownC: '130683',
          costMismatch: false, scanComplete: true, nextC: '123930', nextIds: ['3257'],
          gap: '6753', cheaperCount: 14, keyOk: true,
          event: { kind: 'reclaim', kick: 'UNKNOWN', block: '73805212', tx: '0x56f0a019907a878b30618e42cda012d3ba611d91cc59bf8a0ba32fc7d0a1094d' },
        }], rpc: { ethCall: 1, ethGetLogs: 1, maxInFlight: 1 },
      };
    },
    wallet: async () => ({ circuits: 1, head: 20, discovery: { complete: true }, rigs: [{ id: '8', status: 'mining', fabPerDay: 1 }] }),
    assetCard: (_snap, walletRes) => ({ rigs: walletRes.rigs, fabPerDay: 1, usdPerDay: 0.25, valueUsd: 50, valueOkb: 0.5, apr: 1, paybackDays: 200 }),
  }, { 'fmd.lang': 'zh' });
  await flush();
  const cross = h.get('crosschainBody').innerHTML;
  assert.match(cross, /每天挖 1 枚 FAB/);
  assert.match(cross, /每天挖 1 枚 BEM/);
  assert.match(cross, /短窗口实测外推/);
  assert.match(cross, /公式估算/);
  assert.match(cross, /不把公式标成实测/);
  assert.match(cross, /不是买入建议/);
  assert.equal(h.get('crosschain').open, false);
  await h.context.ui.lookup(h.context.CFG.exampleWallet);
  await flush();
  const card = h.get('assetCard').innerHTML;
  assert.match(card, /不等于能夺榜/);
  assert.match(card, /UNKNOWN/);
  assert.match(card, /不是安全距离/);
  const slot = card.match(/<details class="slot-defense[^"]*"[^>]*>/)[0];
  assert.doesNotMatch(slot, /\bopen\b/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { ids: ['8'], head: 20 });
});

test('BSC rigs do not call bestSlot while the lookup stays closed', async () => {
  const calls = [];
  const h = harness({
    loadSlotDefense: async () => { calls.push('slot'); return { state: 'ready', rows: [], rpc: { ethCall: 0, ethGetLogs: 0, maxInFlight: 0 } }; },
    podRigs: async () => ({ circuits: 1, head: 5, discovery: { complete: true }, rigs: [{ id: '1', status: 'mining', fabPerDay: 1 }] }),
    podAssetCard: (_snap, walletRes) => ({ rigs: walletRes.rigs, fabPerDay: 1, usdPerDay: 1, valueUsd: 1, valueOkb: null, apr: null, paybackDays: null }),
  }, { 'fmd.lang': 'zh' });
  await flush();
  h.context.ui.setChain('bsc');
  await h.context.ui.lookup('0x2222222222222222222222222222222222222222');
  await flush();
  assert.deepEqual(calls, []);
  assert.match(h.get('assetCard').innerHTML, /BEM|1/);
});

test('BSC lookup uses podRigs and skips the holder index while the index switch is off', async () => {
  let indexed = false;
  let seen = null;
  const h = harness({
    fetchBscRigs: async () => { indexed = true; return { building: true, rigs: [], progress: { complete: false } }; },
    podRigs: async (addr) => {
      seen = addr;
      return {
        address: addr, circuits: 1, head: 10, hours: 0.1, windowSeconds: 600, blockTimestamp: 1000,
        pendingFab: 0, pendingKnown: 1, pendingTotal: 1, pendingComplete: true, pendingSubtotalFab: 0,
        networkSharePct: 1, discovery: { complete: true, expected: 1, verified: 1 },
        rigs: [{ id: 'TapeOut#11', status: 'stopped', fabPerDay: 0 }],
      };
    },
    podAssetCard: (_snap, wallet) => ({ rigs: wallet.rigs, fabPerDay: 0, usdPerDay: 0, valueUsd: null, valueOkb: null, apr: null, paybackDays: null }),
  }, { 'fmd.chain': 'bsc', 'fmd.lang': 'zh' });
  await flush();
  assert.match(h.get('chainChips').innerHTML, /data-chain="bsc"/);
  assert.match(h.get('chainChips').innerHTML, /BSC TapeOut/);
  assert.match(h.get('chainNote').textContent, /BEM/);
  await h.context.ui.lookup('0x0587e1e53be5e897432c64c08697df9a72fe95b2');
  await flush();
  assert.equal(indexed, false);
  assert.equal(seen, '0x0587e1e53be5e897432c64c08697df9a72fe95b2');
  assert.match(h.get('assetCard').innerHTML, /TapeOut#11/);
  assert.match(h.get('assetCard').innerHTML, /停了/);
});

const bscLocation = {
  pathname: '/', href: 'http://localhost/#chain=bsc', origin: 'http://localhost', search: '', hash: '#chain=bsc',
};

test('enabled BSC lookup reads indexed ids then measures only those rigs', async () => {
  const address = '0x0587e1e53be5e897432c64c08697df9a72fe95b2';
  const seen = [];
  let measured = null;
  const h = harness({
    BSC_ADDRESS_LOOKUP: true,
    location: bscLocation,
    fetchBscRigs: async (addr) => {
      seen.push(addr);
      return {
        building: false,
        rigs: [{ id: '13659', processor: '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c', label: 'TapeOut' }],
        progress: { complete: true, scannedTo: 10, head: 10, updatedAt: '2026-10-23T01:00:00.000Z' },
      };
    },
    podRigsForIds: async (addr, rigs) => {
      measured = rigs;
      return {
        address: addr, circuits: 1, head: 10, hours: 0.16, windowSeconds: 600, blockTimestamp: 1_000,
        pendingFab: 0, pendingKnown: 1, pendingTotal: 1, pendingComplete: true, pendingSubtotalFab: 0,
        networkSharePct: 1, indexUpdatedAt: '2026-10-23T01:00:00.000Z',
        discovery: { complete: true, expected: 1, verified: 1, source: 'bsc-index' },
        rigs: [{ id: 'TapeOut#13659', status: 'mining', fabPerDay: 1.5, optimal: false, verified: true }],
      };
    },
    podAssetCard: (_snap, wallet) => ({
      rigs: wallet.rigs, fabPerDay: 1.5, usdPerDay: 0.1, valueUsd: null, valueOkb: null, apr: null, paybackDays: null,
    }),
  }, { 'fmd.lang': 'zh' });
  await flush();
  assert.match(h.get('chainChips').innerHTML, /data-chain="bsc"/);
  await h.context.ui.lookup(address);
  await flush();
  assert.deepEqual(seen, [address]);
  assert.equal(measured[0].id, '13659');
  assert.equal(measured[0].processor, '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c');
  assert.match(h.get('assetCard').innerHTML, /TapeOut#13659/);
  assert.match(h.get('assetCard').innerHTML, /持有人索引更新于/);
});

test('enabled BSC lookup shows 索引建设中 and does not measure while the index is incomplete', async () => {
  let measured = false;
  const h = harness({
    BSC_ADDRESS_LOOKUP: true,
    location: bscLocation,
    fetchBscRigs: async () => ({
      building: true, message: '索引建设中', rigs: [], progress: { complete: false, updatedAt: null },
    }),
    podSnapshot: async () => { measured = true; throw new Error('snapshot must wait for ids'); },
    podRigsForIds: async () => { measured = true; throw new Error('measure must wait for ids'); },
  }, { 'fmd.lang': 'zh' });
  await flush();
  await h.context.ui.lookup('0x0587e1e53be5e897432c64c08697df9a72fe95b2');
  await flush();
  assert.equal(measured, false);
  assert.equal(h.get('werr').textContent, '索引建设中');
  assert.equal(h.get('werr').hidden, false);
});
