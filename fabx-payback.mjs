// FabX-only, read-only payback model. D4: each pool dilutes by its own total weight.
// D5 verifies HALVING_PERIOD and the official halving description, but not the exact
// contract schedule/rounding. The startTime schedule below is an explicit assumption.
const DAY = 86400;
const MINING = '0x4f6a2312d80753bdafd35ddb1bf4bb14c43f8265';
const SEL = Object.freeze({ verified: '0xef6aff46', unverified: '0x63967742',
  startTime: '0x78e97925', period: '0x3adde9c1', currentRate: '0xf9f8bdb7', unverifiedBps: '0xd8d56ffb' });
const POOLS = ['verified', 'unverified'];
const SCENARIOS = ['optimistic', 'neutral', 'conservative'];
export const PAYBACK_METHODOLOGY = '按同一区块头回溯近 7 日、近 3 日的两池总权重，以区块实际时间计算日复合增速；乐观 / 中性 / 保守分别取所用池实测增速的最小值 / 均值 / 最大值。假设币价、单机权重及当前各池收益占比基准不变，各池收益按对应增速稀释，权重下降时单机收益最高只能达到该池全部发行量；按链上 HALVING_PERIOD，并假设从 startTime 起每周期减半（时间模型，非已核实的合约位移实现）。不含转售、费用、加成到期或治理变更；读不到历史、收益拆分、减半参数或负增速所需的全池发行上限时显示 —。';
const hex = n => `0x${BigInt(n).toString(16)}`;
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
function uint(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) return null;
  const n = BigInt(value);
  return n < (1n << 256n) - 1n ? n : null;
}
function safeNumber(value) {
  const n = Number(value);
  return value != null && Number.isSafeInteger(n) && n > 0 ? n : null;
}
function aborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Payback read aborted'), { name: 'AbortError' });
}

/** Historical RPC capabilities are injected; this module never creates a transport. */
export async function readPaybackContext(snap, { rpc, batch, signal } = {}) {
  aborted(signal);
  const result = { head: snap?.head ?? null, headTimestamp: null,
    windows: [7, 3].map(days => ({ days, elapsedDays: null, fromBlock: null,
      fromTimestamp: null, toTimestamp: null, pools: { verified: null, unverified: null } })), halving: null, emissionFabPerDay: null };
  const head = snap?.head;
  if (!Number.isSafeInteger(head) || head <= 0 || typeof rpc !== 'function') return result;
  const safe = async fn => {
    aborted(signal);
    try { const value = await fn(); aborted(signal); return value; }
    catch (error) { if (signal?.aborted || error?.name === 'AbortError') throw error; return null; }
  };
  const header = async number => {
    const value = await safe(() => rpc('eth_getBlockByNumber', [hex(number), false], { signal }));
    if (value?.number != null && Number(value.number) !== number) return null;
    return safeNumber(value?.timestamp);
  };
  const read = async (block, selectors) => {
    const calls = selectors.map(data => ['eth_call', [{ to: MINING, data }, hex(block)]]);
    const values = typeof batch === 'function'
      ? await safe(() => batch(calls, 5, { signal }))
      : await Promise.all(calls.map(([method, params]) => safe(() => rpc(method, params, { signal }))));
    return selectors.map((_, i) => uint(values?.[i]));
  };
  const [headTimestamp, current] = await Promise.all([header(head), read(head,
    [SEL.verified, SEL.unverified, SEL.startTime, SEL.period, SEL.currentRate, SEL.unverifiedBps])]);
  if (headTimestamp == null) return result;
  result.headTimestamp = headTimestamp;
  const [emissionRate, unverifiedBps] = current.slice(4);
  if (emissionRate != null && unverifiedBps != null && unverifiedBps <= 10000n) {
    const emission = Number(emissionRate) / 1e8 * DAY;
    const unverified = emission * Number(unverifiedBps) / 10000;
    if (Number.isFinite(emission) && Number.isFinite(unverified)) {
      result.emissionFabPerDay = { verified: emission - unverified, unverified };
    }
  }
  const startTime = safeNumber(current[2]), periodSeconds = safeNumber(current[3]);
  if (startTime != null && periodSeconds != null && startTime <= headTimestamp) {
    const era = Math.floor((headTimestamp - startTime) / periodSeconds);
    const nextTimestamp = startTime + (era + 1) * periodSeconds;
    if (Number.isSafeInteger(nextTimestamp)) result.halving = { startTime, periodSeconds, nextTimestamp, assumption: true };
  }
  const bt = snap?.blockTime;
  if (!positive(bt)) return result;
  // Correct the initial block-time estimate using real headers. A window is accepted
  // only if it covers the requested duration and overshoots by at most a minute/two
  // recent block intervals. Unavailable or distant historical data stays unknown.
  const locate = async days => {
    const target = headTimestamp - days * DAY;
    let number = Math.max(0, Math.floor(head - days * DAY / bt));
    const seen = new Set();
    for (let attempt = 0; attempt < 8 && number < head && !seen.has(number); attempt++) {
      seen.add(number);
      const timestamp = await header(number);
      if (timestamp == null || timestamp >= headTimestamp) return null;
      const lag = target - timestamp;
      if (lag >= 0 && lag <= Math.max(60, 2 * bt)) return { number, timestamp };
      const measuredSeconds = (headTimestamp - timestamp) / (head - number);
      const move = Math.floor(lag / measuredSeconds);
      number = Math.max(0, Math.min(head - 1, number + (move || (lag < 0 ? -1 : 1))));
    }
    return null;
  };
  await Promise.all(result.windows.map(async window => {
    window.toTimestamp = headTimestamp;
    const from = await locate(window.days);
    if (!from) return;
    const elapsedDays = (headTimestamp - from.timestamp) / DAY;
    Object.assign(window, { elapsedDays, fromBlock: from.number, fromTimestamp: from.timestamp });
    const before = await read(from.number, [SEL.verified, SEL.unverified]);
    for (let i = 0; i < POOLS.length; i++) {
      if (before[i] == null || before[i] <= 0n || current[i] == null || current[i] <= 0n) continue;
      // uint256 fits Number's exponent range. Log differences avoid ratio overflow.
      const dailyGrowth = Math.expm1((Math.log(Number(current[i])) - Math.log(Number(before[i]))) / elapsedDays);
      if (Number.isFinite(dailyGrowth) && dailyGrowth > -1) window.pools[POOLS[i]] = {
        dailyGrowth, beforeWeight: before[i].toString(), afterWeight: current[i].toString(),
      };
    }
  }));
  return result;
}

function unknown(reason, horizonDays) {
  return { status: 'unknown', reason, horizonDays, methodology: PAYBACK_METHODOLOGY,
    scenarios: Object.fromEntries(SCENARIOS.map(name => [name, { days: null, status: 'unknown', growthByPool: null }])) };
}

/** cost, dailyRevenue and poolDailyRevenue use the same currency; poolShares are
 * REVENUE shares. Active shrinking pools require a full-pool daily emission cap. */
export function paybackScenarios({ cost, dailyRevenue, poolShares, poolDailyRevenue, context, horizonDays = 3650 } = {}) {
  if (!positive(cost) || !positive(dailyRevenue) || !positive(horizonDays) || horizonDays > 36500) return unknown('missing-input', horizonDays);
  if (!poolShares || POOLS.some(pool => typeof poolShares[pool] !== 'number'
      || !Number.isFinite(poolShares[pool]) || poolShares[pool] < 0 || poolShares[pool] > 1)
      || Math.abs(poolShares.verified + poolShares.unverified - 1) > 1e-8) return unknown('missing-pool-shares', horizonDays);
  const halving = context?.halving, headTimestamp = context?.headTimestamp;
  if (!positive(headTimestamp) || !Number.isSafeInteger(headTimestamp) || !halving
      || !positive(halving.periodSeconds) || !Number.isSafeInteger(halving.periodSeconds)
      || !positive(halving.startTime) || !Number.isSafeInteger(halving.startTime)
      || halving.startTime > headTimestamp) return unknown('missing-halving', horizonDays);
  const periodDays = halving.periodSeconds / DAY;
  if (horizonDays / periodDays > 512) return unknown('unsupported-halving-horizon', horizonDays);
  const era = Math.floor((headTimestamp - halving.startTime) / halving.periodSeconds);
  const nextDays = (halving.startTime + (era + 1) * halving.periodSeconds - headTimestamp) / DAY;
  const rates = {};
  for (const pool of POOLS) {
    if (poolShares[pool] === 0) continue;
    const windows = [7, 3].map(days => context.windows?.find(window => window.days === days)?.pools?.[pool]?.dailyGrowth);
    if (windows.some(rate => typeof rate !== 'number' || !Number.isFinite(rate) || rate <= -1)) return unknown('missing-growth', horizonDays);
    const [a, b] = windows;
    rates[pool] = [Math.min(a, b), a / 2 + b / 2, Math.max(a, b)];
    const cap = poolDailyRevenue?.[pool];
    if (Math.min(a, b) < 0 && !positive(cap)) return unknown('missing-pool-cap', horizonDays);
    if (cap != null && (!positive(cap) || dailyRevenue * poolShares[pool] > cap)) return unknown('invalid-pool-cap', horizonDays);
  }
  const logCost = Math.log(cost), logRevenue = Math.log(dailyRevenue);
  const integral = (growth, baseLogRevenue, from, to, halvings) => {
    const duration = to - from;
    if (!(duration > 0)) return 0;
    const k = -Math.log1p(growth);
    let logIntegral;
    if (k === 0) logIntegral = Math.log(duration);
    else if (k > 0) {
      const x = k * duration;
      logIntegral = k * from + (x > 50 ? x + Math.log1p(-Math.exp(-x)) : Math.log(Math.expm1(x))) - Math.log(k);
    } else logIntegral = k * from + Math.log(-Math.expm1(k * duration)) - Math.log(-k);
    const amount = baseLogRevenue + logIntegral - halvings * Math.LN2;
    return amount >= logCost ? cost : Math.exp(amount);
  };
  const contribution = (growth, pool, from, to, halvings) => {
    const incomeLog = logRevenue + Math.log(poolShares[pool]);
    if (growth >= 0) return integral(growth, incomeLog, from, to, halvings);
    const capLog = Math.log(poolDailyRevenue[pool]);
    const saturatedAt = Math.max(0, (capLog - incomeLog) / -Math.log1p(growth));
    const growing = integral(growth, incomeLog, from, Math.min(to, saturatedAt), halvings);
    const capped = integral(0, capLog, Math.max(from, saturatedAt), to, halvings);
    return Math.min(cost, growing + capped);
  };
  const scenarios = Object.fromEntries(SCENARIOS.map((name, index) => {
    const growthByPool = Object.fromEntries(POOLS.map(pool => [pool, rates[pool]?.[index] ?? null]));
    const total = days => {
      let from = 0, end = Math.min(days, nextDays), halvings = 0, earned = 0;
      while (from < days) {
        for (const pool of POOLS) if (poolShares[pool] > 0) {
          earned = Math.min(cost, earned + contribution(growthByPool[pool], pool, from, end, halvings));
          if (earned >= cost) return cost;
        }
        from = end;
        end = Math.min(days, nextDays + (++halvings) * periodDays);
      }
      return earned;
    };
    if (total(horizonDays) < cost) return [name, { days: null, status: 'beyond-horizon', growthByPool }];
    let lo = 0, hi = horizonDays;
    for (let n = 0; n < 64; n++) {
      const middle = (lo + hi) / 2;
      if (total(middle) >= cost) hi = middle; else lo = middle;
    }
    return [name, { days: hi, status: 'recouped', growthByPool }];
  }));
  return { status: 'measured', reason: null, horizonDays, scenarios, methodology: PAYBACK_METHODOLOGY };
}
