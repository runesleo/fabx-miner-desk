import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../desk.mjs';

const snap = {
  head: 80_000_000,
  blockTime: 2,
  network: { weight: 600_000, fabPerNandDay: 0.5 },
  prices: { fabUsd: 2, okbUsd: 50 },
  decision: { nandOkb: 0.2 },
};
const walletRes = {
  fabPerDay: 15,
  rigs: [
    { id: '11', fabPerDay: 10, status: 'mining' },
    { id: '12', fabPerDay: 5, status: 'mining' },
    { id: '13', fabPerDay: 0, status: 'stopped' },
    { id: '14', fabPerDay: null, status: 'claimed-in-window' },
    { id: '15', fabPerDay: null, status: 'unread' },
  ],
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('assetCard prices measured output at replacement cost without inventing skipped output', () => {
  const original = JSON.stringify({ snap, walletRes });
  const card = engine.assetCard(snap, walletRes);
  assert.deepEqual(card.rigs, [
    { id: '11', fabPerDay: 10, status: 'mining', nandEq: 20, valueOkb: 4, valueUsd: 200 },
    { id: '12', fabPerDay: 5, status: 'mining', nandEq: 10, valueOkb: 2, valueUsd: 100 },
    { id: '13', fabPerDay: 0, status: 'stopped', nandEq: 0, valueOkb: 0, valueUsd: 0 },
    { id: '14', fabPerDay: null, status: 'claimed-in-window', nandEq: null, valueOkb: null, valueUsd: null },
    { id: '15', fabPerDay: null, status: 'unread', nandEq: null, valueOkb: null, valueUsd: null },
  ]);
  assert.equal(card.fabPerDay, 15);
  assert.equal(card.usdPerDay, 30);
  assert.equal(card.nandEq, 30);
  assert.equal(card.valueOkb, 6);
  assert.equal(card.valueUsd, 300);
  assert.equal(card.apr, 36.5);
  assert.equal(card.paybackDays, 10);
  assert.equal(JSON.stringify({ snap, walletRes }), original);
});

test('assetCard preserves yield and NAND equivalents when NAND price is missing', () => {
  const card = engine.assetCard({ ...snap, decision: { nandOkb: null } }, walletRes);
  assert.equal(card.fabPerDay, 15);
  assert.equal(card.usdPerDay, 30);
  assert.equal(card.nandEq, 30);
  for (const key of ['valueOkb', 'valueUsd', 'apr', 'paybackDays']) assert.equal(card[key], null);
  for (const rig of card.rigs) {
    assert.equal(rig.valueOkb, null);
    assert.equal(rig.valueUsd, null);
  }
  assert.equal(card.rigs[0].nandEq, 20);
});

test('assetCard distinguishes unknown output from a measured stopped rig or an empty wallet', () => {
  const unknown = engine.assetCard(snap, { rigs: walletRes.rigs.slice(3) });
  for (const key of ['fabPerDay', 'usdPerDay', 'nandEq', 'valueOkb', 'valueUsd', 'apr', 'paybackDays']) {
    assert.equal(unknown[key], null);
  }
  for (const rigs of [[], [walletRes.rigs[2]]]) {
    const card = engine.assetCard(snap, { rigs });
    for (const key of ['fabPerDay', 'usdPerDay', 'nandEq', 'valueOkb', 'valueUsd']) assert.equal(card[key], 0);
    assert.equal(card.apr, null);
    assert.equal(card.paybackDays, null);
  }
});

test('an incomplete discovery with zero confirmed rigs has unknown asset totals', () => {
  const card = engine.assetCard(snap, { rigs: [], discovery: { complete: false, expected: 76, verified: 0 } });
  for (const key of ['fabPerDay', 'usdPerDay', 'nandEq', 'valueOkb', 'valueUsd', 'apr', 'paybackDays']) assert.equal(card[key], null);
});

test('futureValue sums flat output and scales all FAB price scenarios', () => {
  assert.equal(engine.futureValue(snap, 10, 30), 600);
  assert.equal(engine.futureValue(snap, 10, 90, { dailyNetGrowth: 0, fabMult: 0.5 }), 900);
  assert.equal(engine.futureValue(snap, 10, 180, { dailyNetGrowth: 0, fabMult: 2 }), 7200);
  assert.equal(engine.futureValue(snap, 10, 0), 0);
  assert.equal(engine.futureValue(snap, 0, 30), 0);
});

test('futureValue applies network growth from day one, not day zero', () => {
  // At 100% daily growth, the three daily USD outputs are 10, 5, and 2.5.
  close(engine.futureValue(snap, 10, 3, { dailyNetGrowth: 1, fabMult: 1 }), 17.5);
  close(engine.futureValue(snap, 10, 3, { dailyNetGrowth: 1, fabMult: 2 }), 35);
  close(engine.futureValue(snap, 10, 1, { dailyNetGrowth: 0.25, fabMult: 1 }), 16);
});

test('futureValue returns unknown for missing yield and invalid growth or horizons', () => {
  assert.equal(engine.futureValue(snap, null, 30), null);
  assert.equal(engine.futureValue(snap, NaN, 30), null);
  assert.equal(engine.futureValue(snap, 10, -1), null);
  assert.equal(engine.futureValue(snap, 10, 1.5), null);
  assert.equal(engine.futureValue(snap, 10, 30, { dailyNetGrowth: -1, fabMult: 1 }), null);
  assert.equal(engine.futureValue({ ...snap, prices: { okbUsd: 50 } }, 10, 30), null);
});

const hex = (n) => `0x${BigInt(n).toString(16)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
function fakeRpc(t, respond, api) {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (api && String(url).startsWith(engine.CFG.fabxApi)) return { ok: true, json: async () => api };
    assert.equal(url, engine.CFG.rpc);
    const body = JSON.parse(init.body);
    const reply = (req) => ({ jsonrpc: '2.0', id: req.id, ...respond(req) });
    return { ok: true, json: async () => Array.isArray(body) ? body.map(reply) : reply(body) };
  });
}

test('networkGrowth reads the historical block and compounds its daily rate', async (t) => {
  fakeRpc(t, ({ method, params }) => {
    assert.equal(method, 'eth_call');
    assert.deepEqual(params, [{ to: engine.CFG.mining, data: '0xef6aff46' }, hex(79_697_600)]);
    return { result: hex(100_000) };
  });
  const growth = await engine.networkGrowth({ ...snap, network: { ...snap.network, weight: 200_000 } });
  assert.equal(growth.measured, true);
  close(growth.daily, 0.10408951367381234); // The seventh root of 2 minus 1.
});

test('networkGrowth reports unmeasured zero when historical state is unavailable', async (t) => {
  fakeRpc(t, () => ({ error: { code: -32000, message: 'missing trie node' } }));
  assert.deepEqual(await engine.networkGrowth(snap), { measured: false, daily: 0 });
});

test('networkGrowth does not treat empty historical state as measured zero growth', async (t) => {
  fakeRpc(t, () => ({ result: '0x0' }));
  assert.deepEqual(await engine.networkGrowth(snap), { measured: false, daily: 0 });
});

function fakeWalletRpc(t, rigs, head, options = {}) {
  fakeRpc(t, ({ method, params }) => {
    if (method === 'eth_getBlockByNumber') return { result: options.missingHistoryHeader && Number(params[0]) !== head
      ? null : { timestamp: hex(Number(params[0]) * 2) } };
    assert.equal(method, 'eth_call');
    const [{ data }, block] = params;
    assert.ok([head, head - 300].includes(Number(block)), 'wallet reads stay pinned to the current or historical block');
    const selector = data.slice(0, 10);
    if (selector === '0x70a08231') return { result: `0x${word(options.expected ?? rigs.length)}` };
    if (selector === '0x61b8ce8c') return { result: `0x${word(Math.max(0, ...rigs.map(rig => rig.id)))}` };
    if (selector === '0xbce38bd7') return { error: { code: 3, message: 'execution reverted' } };
    if (selector === '0xf9f8bdb7') return { result: options.missingEmission ? null : `0x${word(8333333)}` };
    if (selector === '0xd8d56ffb') return { result: `0x${word(100)}` };
    const id = Number(BigInt(`0x${data.slice(-64)}`));
    const rig = rigs.find((row) => row.id === id), current = Number(block) === head;
    if (selector === '0x6352211e') return { result: rig ? `0x${engine.CFG.exampleWallet.slice(2).padStart(64, '0')}` : null };
    if (selector === '0x10eafa00') return { result: rig?.missingKey ? null : `0x${word(id)}` };
    if (selector === '0x0527edc2') {
      const fields = Array(23).fill(0n);
      fields[0] = BigInt(engine.CFG.circuits); fields[1] = BigInt(id);
      fields[8] = BigInt(head * 2 - 3600); fields[9] = 1n;
      fields[21] = rig.claimed && current ? 1n : 0n;
      return { result: '0x' + fields.map(word).join('') };
    }
    if (selector === '0xa6a20acd') return { result: '0x' + [rig.zeroWeight ? 0 : 144 * 1e8, 0, 7128 * 1e8, 1].map(word).join('') };
    assert.equal(selector, '0x024b2c13');
    const amount = current ? rig?.now : rig?.before;
    return { result: current && rig.pendingSentinel ? `0x${word(2n ** 256n - 1n)}`
      : amount == null ? null : `0x${word(Math.round(amount * 1e8))}` };
  }, { account: engine.CFG.exampleWallet, items: rigs.map(({ id }) => ({ id, cpu: engine.CFG.circuits })) });
}

test('wallet exposes per-rig realtime reward status and only totals the measured ten-minute output', async (t) => {
  const head = engine.CFG.circuitsFromBlock + 100;
  fakeWalletRpc(t, [
    { id: 11, now: 10, before: 9 }, { id: 12, now: 5, before: 5, zeroWeight: true },
    { id: 13, now: 2, before: 3 }, { id: 14, now: null, before: null },
    { id: 15, missingKey: true }, { id: 16, now: 0, before: 0, zeroWeight: true },
  ], head);
  const result = await engine.wallet(engine.CFG.exampleWallet, { ...snap, head });
  assert.deepEqual(result.rigs, [
    { id: '11', fabPerDay: 144, status: 'mining' },
    { id: '12', fabPerDay: 0, status: 'stopped' },
    { id: '13', fabPerDay: null, status: 'claimed-in-window' },
    { id: '14', fabPerDay: null, status: 'unread' },
    { id: '15', fabPerDay: null, status: 'unread' },
    { id: '16', fabPerDay: 0, status: 'stopped' },
  ]);
  assert.equal(result.circuits, 6);
  assert.equal(result.measured, 3);
  assert.equal(result.unread, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.mining, 3);
  assert.equal(result.hours, 1 / 6);
  assert.equal(result.pendingFab, null);
  assert.equal(result.pendingUsd, null);
  assert.equal(result.pendingSubtotalFab, 17);
  assert.equal(result.pendingKnown, 4);
  assert.equal(result.pendingTotal, 6);
  assert.equal(result.pendingComplete, false);
  assert.equal(result.fabPerDay, 144);
  assert.equal(result.usdPerDay, 288);
  close(result.networkSharePct, 144 / 7128 * 100);
});

test('wallet excludes claims with a positive delta instead of changing its observation window', async (t) => {
  const head = engine.CFG.circuitsFromBlock + 100;
  fakeWalletRpc(t, [
    { id: 11, now: 10, before: 9, claimed: true },
    { id: 12, now: 5, before: 4, claimed: true },
    { id: 13, now: 0, before: 0, zeroWeight: true },
  ], head);
  const result = await engine.wallet(engine.CFG.exampleWallet, { ...snap, head });
  assert.deepEqual(result.rigs, [
    { id: '11', fabPerDay: null, status: 'claimed-in-window' },
    { id: '12', fabPerDay: null, status: 'claimed-in-window' },
    { id: '13', fabPerDay: 0, status: 'stopped' },
  ]);
  assert.equal(result.windowSeconds, 600);
  assert.equal(result.measured, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.pendingFab, 15);
  assert.equal(result.pendingUsd, 30);
  assert.equal(result.pendingKnown, 3);
  assert.equal(result.pendingTotal, 3);
  assert.equal(result.pendingComplete, true);
  assert.equal(result.pendingSubtotalFab, 15);
  assert.equal(result.fabPerDay, 0);
  assert.equal(result.usdPerDay, 0);
});

test('wallet does not turn a stopped zero plus unread pending into a zero total', async t => {
  const head = engine.CFG.circuitsFromBlock + 100;
  fakeWalletRpc(t, [{ id: 11, now: 0, before: 0, zeroWeight: true }, { id: 12, now: null, before: null }], head);
  const result = await engine.wallet(engine.CFG.exampleWallet, { ...snap, head });
  assert.equal(result.discovery.complete, true);
  assert.equal(result.measured, 1);
  assert.equal(result.pendingKnown, 1);
  assert.equal(result.pendingTotal, 2);
  assert.equal(result.pendingComplete, false);
  assert.equal(result.pendingSubtotalFab, 0);
  assert.equal(result.pendingFab, null);
  assert.equal(result.pendingUsd, null);
});

test('wallet preserves unknown totals and subtotal when every current pending is unread or sentinel', async t => {
  const head = engine.CFG.circuitsFromBlock + 100;
  fakeWalletRpc(t, [{ id: 11, now: null, before: null }, { id: 12, now: 1, before: 1, pendingSentinel: true }], head);
  const result = await engine.wallet(engine.CFG.exampleWallet, { ...snap, head });
  assert.equal(result.pendingKnown, 0);
  assert.equal(result.pendingTotal, 2);
  assert.equal(result.pendingComplete, false);
  for (const key of ['pendingFab', 'pendingUsd', 'pendingSubtotalFab']) assert.equal(result[key], null);
});

for (const [reason, options] of [['historical rewards', {}], ['historical header', { missingHistoryHeader: true }], ['emission', { missingEmission: true }]]) {
  test(`wallet current pending coverage is independent of unavailable ${reason}`, async t => {
    const head = engine.CFG.circuitsFromBlock + 100;
    fakeWalletRpc(t, [{ id: 11, now: 10, before: null }, { id: 12, now: 5, before: null }], head, options);
    const result = await engine.wallet(engine.CFG.exampleWallet, { ...snap, head });
    assert.equal(result.measured, 0);
    assert.equal(result.fabPerDay, null);
    assert.equal(result.pendingKnown, 2);
    assert.equal(result.pendingTotal, 2);
    assert.equal(result.pendingComplete, true);
    assert.equal(result.pendingSubtotalFab, 15);
    assert.equal(result.pendingFab, 15);
    assert.equal(result.pendingUsd, 30);
  });
}

test('wallet incomplete ownership discovery keeps even fully read found pending a subtotal', async t => {
  const head = engine.CFG.circuitsFromBlock + 100;
  fakeWalletRpc(t, [{ id: 11, now: 10, before: 9 }], head, { expected: 2 });
  const result = await engine.wallet(engine.CFG.exampleWallet, { ...snap, head });
  assert.equal(result.discovery.complete, false);
  assert.equal(result.pendingKnown, 1);
  assert.equal(result.pendingTotal, 2);
  assert.equal(result.pendingComplete, false);
  assert.equal(result.pendingSubtotalFab, 10);
  assert.equal(result.pendingFab, null);
  assert.equal(result.pendingUsd, null);
});

for (const expected of [0, 2]) {
  test(`wallet with zero discovered rigs ${expected === 0 ? 'retains verified empty zero' : 'never fabricates zero when discovery is incomplete'}`, async t => {
    const head = engine.CFG.circuitsFromBlock + 100;
    fakeWalletRpc(t, [], head, { expected });
    const result = await engine.wallet(engine.CFG.exampleWallet, { ...snap, head });
    assert.equal(result.pendingKnown, 0);
    assert.equal(result.pendingTotal, expected);
    assert.equal(result.pendingComplete, expected === 0);
    for (const key of ['pendingFab', 'pendingUsd', 'pendingSubtotalFab']) assert.equal(result[key], expected === 0 ? 0 : null);
  });
}
