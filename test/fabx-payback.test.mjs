import test from 'node:test';
import assert from 'node:assert/strict';
import { readPaybackContext, paybackScenarios } from '../fabx-payback.mjs';

const DAY = 86400;
const hex = n => `0x${BigInt(n).toString(16)}`;
const word = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const head = 2_000_000;
const timestamp = 1_800_000_000;
const period = 126_000_000;
const start = timestamp - DAY * 10;
const context = (verified = [0, 0], unverified = [0, 0], nextDays = 1000) => ({
  head, headTimestamp: timestamp,
  windows: [7, 3].map((days, i) => ({ days, elapsedDays: days, pools: {
    verified: verified[i] == null ? null : { dailyGrowth: verified[i] },
    unverified: unverified[i] == null ? null : { dailyGrowth: unverified[i] },
  } })),
  halving: { periodSeconds: period, startTime: timestamp + nextDays * DAY - period,
    nextTimestamp: timestamp + nextDays * DAY, assumption: true },
});
const simulate = (ctx, args = {}) => paybackScenarios({ cost: 100, dailyRevenue: 10,
  poolShares: { verified: 1, unverified: 0 }, context: ctx, ...args });
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

function fixture({ seconds = 1, failHistory = false, invalidPeriod = false, headWeight = 2000, priorWeight = 1000, emissionRate = 8333333n, unverifiedBps = 100n } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'eth_getBlockByNumber') return { number: params[0], timestamp: hex(timestamp - (head - Number(params[0])) * seconds) };
    const [{ data }, block] = params;
    assert.notEqual(block, 'latest');
    if (data === '0x3adde9c1') return invalidPeriod ? null : word(period);
    if (data === '0x78e97925') return word(start);
    if (data === '0xf9f8bdb7') return emissionRate == null ? null : word(emissionRate);
    if (data === '0xd8d56ffb') return unverifiedBps == null ? null : word(unverifiedBps);
    if (failHistory && Number(block) < head) return null;
    const elapsedDays = (head - Number(block)) * seconds / DAY;
    if (data === '0xef6aff46') return word(Number(block) === head ? headWeight : priorWeight);
    if (data === '0x63967742') return word(Math.round(1000 / (1.02 ** elapsedDays)));
    throw new Error(`unexpected selector ${data}`);
  };
  const batch = async requests => Promise.all(requests.map(([method, params]) => rpc(method, params)));
  return { rpc, batch, calls };
}

test('reads both pool histories at pinned blocks and derives compound growth from actual timestamps', async () => {
  const f = fixture();
  const result = await readPaybackContext({ head, blockTime: 1 }, f);
  assert.equal(result.headTimestamp, timestamp);
  assert.equal(result.windows.length, 2);
  for (const window of result.windows) {
    close(window.elapsedDays, window.days);
    close(window.pools.verified.dailyGrowth, 2 ** (1 / window.days) - 1);
    assert.equal(window.toTimestamp, timestamp);
    assert.equal(window.fromTimestamp, timestamp - window.days * DAY);
    assert.ok(window.pools.unverified.dailyGrowth > 0.019);
  }
  assert.equal(result.halving.periodSeconds, period);
  assert.equal(result.halving.nextTimestamp, start + period);
  assert.equal(result.halving.assumption, true);
  close(result.emissionFabPerDay.verified, 8333333 * DAY / 1e8 * 0.99);
  close(result.emissionFabPerDay.unverified, 8333333 * DAY / 1e8 * 0.01);
  assert.ok(f.calls.every(([, params]) => params[1] !== 'latest'));
});

test('historical timestamp correction does not mistake an estimated 3.5-day span for seven days', async () => {
  const f = fixture({ seconds: 2 });
  const result = await readPaybackContext({ head, blockTime: 4 }, f);
  for (const window of result.windows) {
    close(window.elapsedDays, window.days);
    close(window.pools.verified.dailyGrowth, 2 ** (1 / window.days) - 1);
  }
});

test('missing archive values, zero historic pool, or missing halving reads never become zero growth', async () => {
  for (const options of [{ failHistory: true }, { priorWeight: 0 }, { invalidPeriod: true }]) {
    const f = fixture(options);
    const result = await readPaybackContext({ head, blockTime: 1 }, f);
    const values = simulate(result);
    assert.equal(values.status, 'unknown');
    for (const scenario of Object.values(values.scenarios)) {
      assert.equal(scenario.days, null);
      assert.equal(scenario.status, 'unknown');
    }
  }
});

test('three scenarios use min, mean and max measured compound growth and are ordered by payback', () => {
  const result = simulate(context([0.01, 0.03]));
  close(result.scenarios.optimistic.growthByPool.verified, 0.01);
  close(result.scenarios.neutral.growthByPool.verified, 0.02);
  close(result.scenarios.conservative.growthByPool.verified, 0.03);
  assert.ok(result.scenarios.optimistic.days < result.scenarios.neutral.days);
  assert.ok(result.scenarios.neutral.days < result.scenarios.conservative.days);
  assert.ok(result.scenarios.optimistic.days > 10);
});

test('a known flat measured network stays flat and a halving inside the payback window is integrated', () => {
  close(simulate(context()).scenarios.neutral.days, 10);
  close(simulate(context([0, 0], [0, 0], 5)).scenarios.neutral.days, 15);
});

test('head already past a halving applies only the next future halving to current daily revenue', () => {
  const ctx = context();
  ctx.halving.startTime = timestamp - period - 10 * DAY;
  ctx.halving.nextTimestamp = ctx.halving.startTime + 2 * period;
  close(simulate(ctx).scenarios.neutral.days, 10);
});

test('mixed pool revenue uses each pool growth independently, and unknown required shares are rejected', () => {
  const ctx = context([0, 0], [0.1, 0.1]);
  const result = simulate(ctx, { poolShares: { verified: 0.5, unverified: 0.5 } });
  assert.ok(result.scenarios.neutral.days > 10);
  assert.ok(result.scenarios.neutral.days < 20);
  for (const poolShares of [undefined, null, {}, { verified: 1 }, { verified: 1, unverified: 1 }, { verified: NaN, unverified: 0 }]) {
    assert.equal(simulate(ctx, { poolShares }).status, 'unknown');
  }
});

test('incomplete active-pool windows fail closed while an irrelevant empty pool does not block', () => {
  assert.equal(simulate(context([0.01, null])).status, 'unknown');
  assert.equal(simulate(context([0, 0], [null, null])).status, 'measured');
  assert.equal(simulate(context([0, 0], [null, null]), { poolShares: { verified: 0.5, unverified: 0.5 } }).status, 'unknown');
});

test('no payback within horizon differs from unknown data, and extreme growth never leaks NaN or Infinity', () => {
  for (const growth of [1, 1e300]) {
    const result = simulate(context([growth, growth]), { horizonDays: 100 });
    assert.equal(result.scenarios.neutral.status, 'beyond-horizon');
    assert.equal(result.scenarios.neutral.days, null);
    assert.equal(result.status, 'measured');
  }
  assert.equal(simulate(context(), { cost: Infinity }).status, 'unknown');
  assert.equal(simulate(context(), { dailyRevenue: null }).status, 'unknown');
  const shrinking = simulate(context([-0.999, -0.999]), { cost: 1e300, poolDailyRevenue: { verified: 1000 } });
  assert.equal(shrinking.scenarios.neutral.status, 'beyond-horizon');
  assert.equal(shrinking.scenarios.neutral.days, null);
});

test('abort propagates instead of producing a misleading available history', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture();
  await assert.rejects(readPaybackContext({ head, blockTime: 1 }, { ...f, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
});


test('negative growth cannot raise a full-pool holder above pool emission, including after halving', () => {
  const args = { poolDailyRevenue: { verified: 10 } };
  close(simulate(context([-0.1, -0.1]), args).scenarios.neutral.days, 10);
  close(simulate(context([-0.1, -0.1], [0, 0], 5), args).scenarios.neutral.days, 15);
  const result = simulate(context([-0.1, -0.1]), { ...args, cost: 1001, horizonDays: 100 });
  assert.equal(result.scenarios.optimistic.status, 'beyond-horizon');
});

test('negative growth raises a partial-pool holder only until it saturates the full pool', () => {
  const k = -Math.log(0.9), saturatedAt = Math.log(2) / k;
  const earningsUntilSaturation = 10 / k;
  const expected = saturatedAt + (200 - earningsUntilSaturation) / 20;
  close(simulate(context([-0.1, -0.1]), { cost: 200, poolDailyRevenue: { verified: 20 } }).scenarios.neutral.days, expected);
});

test('negative growth without an active-pool cap is unknown and impossible current income is rejected', () => {
  for (const poolDailyRevenue of [undefined, {}, { verified: null }, { verified: NaN }, { verified: 0 }]) {
    const result = simulate(context([-0.1, 0.1]), { poolDailyRevenue });
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'missing-pool-cap');
  }
  for (const growth of [-0.1, 0, 0.1]) {
    assert.equal(simulate(context([growth, growth]), { poolDailyRevenue: { verified: 9 } }).status, 'unknown');
  }
  const mixed = simulate(context([-0.1, -0.1], [-0.2, -0.2]), {
    poolShares: { verified: 0.5, unverified: 0.5 }, poolDailyRevenue: { verified: 5, unverified: 5 },
  });
  close(mixed.scenarios.neutral.days, 10);
});

test('missing or invalid live emissions remain unknown, and a measured zero emission is preserved', async () => {
  for (const options of [{ emissionRate: null }, { unverifiedBps: null }, { unverifiedBps: 10001n }]) {
    const result = await readPaybackContext({ head, blockTime: 1 }, fixture(options));
    assert.equal(result.emissionFabPerDay, null);
    assert.ok(result.halving);
    assert.ok(result.windows[0].pools.verified);
  }
  const result = await readPaybackContext({ head, blockTime: 1 }, fixture({ emissionRate: 0n }));
  assert.deepEqual(result.emissionFabPerDay, { verified: 0, unverified: 0 });
});
