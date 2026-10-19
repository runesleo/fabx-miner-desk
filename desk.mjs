// FabX Miner Desk — read-only economics engine. Runs in the browser and in Node 18+.
// Never connects a wallet, never signs, never sends a transaction: only eth_call / eth_getLogs and public price APIs.

import { createRpcClient } from './rpc.mjs';
import { readNandPrice, validNandPrice } from './nand-price.mjs';
import { encodeTryAggregate, decodeTryAggregate } from './multicall.mjs';

export const CFG = {
  rpc: 'https://xlayerrpc.okx.com',
  mining: '0x4f6a2312d80753bdafd35ddb1bf4bb14c43f8265',
  circuits: '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6',
  market: '0x7f955c233fdb17e98fb26f330d778d3e30fe6ee6',
  rigMarket: '0x0bc37f95ae57bb20e995d425d46d6df9f22bd7a1',
  poolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
  poolId: '0x63556b8d29b7ada6effae8b336cb806a06caf6546b33059b1e5e8b93a98cb29d', // FAB/BEM Uniswap v4
  bemPairBsc: '0x3098D7A051045000d68eC0360753A40C8cABEa31',
  circuitsFromBlock: 72_950_000,     // circuits collection has no ownership events before this
  weightPerTransistor: 600,          // verif weight = b* x 600 on the Genesis processor (P = 6)
  fabPerDayVerified: 7200 * 0.99,    // 7,200 FAB/day, 99% to verified miners
  supplyNandEq: 1_000_000,           // ~1M transistors minted in total (estimate)
  logChunk: 100_000,
  timeoutMs: 5_000,
  loadTimeoutMs: 10_000,
  optionalTimeoutMs: 6_000,
  ownershipTimeoutMs: 10_000,
  ownershipApiTimeoutMs: 3_000,
  ownershipMaxIds: 20_000,
  entryTimeoutMs: 45_000,
  entryMaxListingIds: 50_000,
  fabxApi: 'https://api.fabx.tech',
  multicall: '0xca11bde05977b3631167028862be2a173976ca11',
  // keccak256(abi.encode(poolId, uint256(6))); v4 StateLibrary.POOLS_SLOT = 6.
  poolStateSlot: '0x9f11333b5461b9121b4bf1bc65a4c3d0eb304f2cb60281f03b3fd60de4a9bf18',
  exampleWallet: '0xe0cb3d9542a786c60605dd55efb9ef79490a3d6c', // a large public FabX rig holder, used for the demo button
};

const SEL = {
  totalVerifWeight: '0xef6aff46', minerCount: '0x6d1da431', startTime: '0x78e97925', isSealed: '0x631f9852',
  minerKey: '0x10eafa00', ownerOf: '0x6352211e', extsload: '0x1e2eaeaf',
  balanceOf: '0x70a08231', nextId: '0x61b8ce8c', tryAggregate: '0xbce38bd7',
  nextListingId: '0xaaccf1ec', listingView: '0xbeab7067', pendingWithDeweb: '0x024b2c13',
  getMiner: '0x0527edc2', dewebWeights: '0xa6a20acd',
  currentRate: '0xf9f8bdb7', unverifiedBps: '0xd8d56ffb',
};
const TOPIC = {
  swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  owner721: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
};

const pad = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hex = (n) => '0x' + BigInt(n).toString(16);
const word = (data, i) => BigInt('0x' + (data.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'));
export const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');

const client = createRpcClient();
export const rpc = (...args) => client.rpc(...args);
export const batch = (...args) => client.batch(...args);

// Bound the whole operation (including response bodies), and cancel its I/O on timeout.
// Promise.race also bounds providers that ignore AbortSignal.
export async function deadline(task, timeoutMs, parentSignal) {
  const ctl = new AbortController();
  let timer, abort;
  const stop = new Promise((_, reject) => {
    abort = () => { const e = parentSignal.reason || new Error('aborted'); ctl.abort(e); reject(e); };
    if (parentSignal?.aborted) return abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      const e = new Error(`timeout after ${timeoutMs}ms`);
      e.name = 'TimeoutError';
      ctl.abort(e); reject(e);
    }, timeoutMs);
  });
  try {
    return await Promise.race([stop, Promise.resolve().then(() => {
      ctl.signal.throwIfAborted();
      return task(ctl.signal);
    })]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
    // Stop sibling I/O on early failure and prevent late work from publishing.
    ctl.abort();
  }
}

// Halve only explicit range-limit errors. Throttling, server faults and timeouts degrade immediately.
async function logsChunked(filter, from, to, signal) {
  const all = [];
  let size = CFG.logChunk;
  for (let lo = Math.max(0, from); lo <= to;) {
    signal?.throwIfAborted();
    const hi = Math.min(lo + size - 1, to);
    try {
      const logs = await rpc('eth_getLogs', [{ ...filter, fromBlock: hex(lo), toBlock: hex(hi) }], { signal });
      if (!Array.isArray(logs)) throw new Error('invalid eth_getLogs result');
      all.push(...logs);
      lo = hi + 1;
    } catch (e) {
      if (!e.rangeLimited || e.rateLimited || size <= 1_000) {
        throw new Error(`eth_getLogs failed at blocks ${lo}-${hi}: ${e.message}`, { cause: e });
      }
      size = Math.max(1_000, Math.floor(size / 2));
    }
  }
  return all;
}

async function getJson(url, parentSignal) {
  return deadline(async signal => {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
    return r.json();
  }, CFG.timeoutMs, parentSignal);
}

// currency0 = BEM, currency1 = FAB, both 8 decimals. sqrtPrice^2 = raw FAB/raw BEM.
// Thus BEM per FAB = 1 / (sqrtPriceX96 / 2^96)^2 * 10^(8 - 8).
export function fabInBemFromSqrtPriceX96(sqrtPriceX96) {
  const value = BigInt(sqrtPriceX96);
  if (value <= 0n || value >= 2n ** 160n) throw new Error('invalid sqrtPriceX96');
  const sqrt = Number(value) / 2 ** 96;
  return 1 / (sqrt * sqrt);
}
export const fabInBemFromSwap = log => fabInBemFromSqrtPriceX96(word(log.data, 2));

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function tierFor(ratio, tiers) {
  if (!Number.isFinite(ratio) || !tiers?.length) return null;
  const sorted = [...tiers].sort((a, b) => b.minRatio - a.minRatio);
  return sorted.find((t) => ratio >= t.minRatio) || null;
}

// Seconds per block, measured from two headers ~10k blocks apart.
async function blockTime(head, signal) {
  const [a, b] = await batch([['eth_getBlockByNumber', [hex(head), false]], ['eth_getBlockByNumber', [hex(head - 10_000), false]]], 5, { signal });
  const seconds = (Number(a?.timestamp) - Number(b?.timestamp)) / 10_000;
  if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('block timestamps unavailable');
  return { seconds, headTimestamp: Number(a.timestamp) };
}

// Current best NAND ask, observed at the pinned block. No historical log dependency.
// Keep the public function name/signature for existing engine callers.
export async function nandOkbMarket(head, _bt, { signal, asOf } = {}) {
  return readNandPrice({ rpc, batch, head, market: CFG.market, multicall: CFG.multicall, signal, asOf });
}

const CACHE_KEYS = { history: 'fmd.history.v1', nand: 'fmd.nand.v1', entry: 'fmd.entry.v2' };
const positive = n => Number.isFinite(n) && n > 0;
function localStore(opts) {
  try { return opts.storage === undefined ? globalThis.localStorage : opts.storage; } catch { return null; }
}
function validValue(kind, value) {
  if (!value) return false;
  if (kind === 'nand') return validNandPrice(value)
    || (!value.kind && positive(value.okb) && positive(value.qty) && [1, 24].includes(value.hours));
  return ['medianBem', 'lowBem', 'highBem', 'lastSwapBem'].every(k => positive(value[k]))
    && value.lowBem <= value.medianBem && value.medianBem <= value.highBem
    && Number.isSafeInteger(value.swaps24h) && value.swaps24h > 0;
}
function readCached(storage, kind, head) {
  try {
    const entry = JSON.parse(storage?.getItem(CACHE_KEYS[kind]) || 'null');
    if (!entry || !Number.isFinite(Date.parse(entry.asOf)) || Date.parse(entry.asOf) > Date.now() + 30_000
        || !Number.isSafeInteger(entry.head) || entry.head > head || !validValue(kind, entry.value)) return null;
    return entry;
  } catch { return null; }
}
function saveCached(storage, kind, entry) {
  try { storage?.setItem(CACHE_KEYS[kind], JSON.stringify(entry)); } catch { /* quota/privacy mode: live data still usable */ }
}
const available = (state, asOf = null, error = null) => ({ state, asOf, error });
function applyHistory(snap, value, check = false) {
  const p = snap.prices;
  const anchorUsd = value.medianBem * p.bemUsd;
  const lowUsd = value.lowBem * p.bemUsd, highUsd = value.highBem * p.bemUsd;
  const ratio = p.fabUsd / anchorUsd;
  const relativeDifference = Math.abs(p.fabBem / value.lastSwapBem - 1);
  return {
    ...snap,
    prices: {
      ...p, anchorUsd, lowUsd, highUsd, swaps24h: value.swaps24h,
      rangePos: highUsd > lowUsd ? (p.fabUsd - lowUsd) / (highUsd - lowUsd) : 0.5,
      crossCheck: check ? { state: relativeDifference <= 1e-8 ? 'match' : 'different', relativeDifference, lastSwapBem: value.lastSwapBem } : null,
    },
    decision: { ...snap.decision, ratio, tier: tierFor(ratio, snap.rule) },
  };
}
function marketSource(value) {
  return value.kind === 'onchain-ask'
    ? `${value.source} · ${value.qty.toLocaleString('en-US')} NAND at this price`
    : `Cached fill VWAP · ${value.hours}h · ${value.qty.toLocaleString('en-US')} NAND`;
}

// First-screen data: NO log scans. Optional values start unknown or explicitly cached.
// Call refreshOptional(snap, {onUpdate}) after rendering. opts.nandOkb always wins over market/cache.
export async function snapshot(opts = {}) {
  return deadline(signal => readSnapshot({ ...opts, signal }), opts.timeoutMs ?? CFG.loadTimeoutMs, opts.signal);
}

async function readSnapshot(opts) {
  const { signal } = opts;
  const step = opts.onStep || (() => {});
  step('chain');
  const chain = async () => {
    const head = Number(await rpc('eth_blockNumber', [], { signal }));
    if (!Number.isSafeInteger(head) || head < 10_000) throw new Error('invalid block number');
    const [timing, values] = await Promise.all([blockTime(head, signal), batch([
      ['eth_call', [{ to: CFG.mining, data: SEL.totalVerifWeight }, hex(head)]],
      ['eth_call', [{ to: CFG.mining, data: SEL.minerCount }, hex(head)]],
      ['eth_call', [{ to: CFG.mining, data: SEL.startTime }, hex(head)]],
      ['eth_call', [{ to: CFG.mining, data: SEL.isSealed }, hex(head)]],
      ['eth_call', [{ to: CFG.poolManager, data: SEL.extsload + pad(CFG.poolStateSlot) }, hex(head)]],
    ], 5, { signal })]);
    if (values.some(v => !/^0x[0-9a-f]+$/i.test(v || ''))) throw new Error('network or pool state unavailable');
    return { head, bt: timing.seconds, headTimestamp: timing.headTimestamp, values };
  };
  const [{ head, bt, headTimestamp, values: [weightHex, minersHex, startHex, sealedHex, slot0] }, bemPair, okbTicker] = await Promise.all([
    chain(),
    getJson(`https://api.dexscreener.com/latest/dex/pairs/bsc/${CFG.bemPairBsc}`, signal),
    getJson('https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT', signal),
  ]);
  step('prices');
  const bemUsd = Number(bemPair.pairs?.[0]?.priceUsd), okbUsd = Number(okbTicker.data?.[0]?.last);
  if (!positive(bemUsd) || !positive(okbUsd)) throw new Error('BEM or OKB USD price unavailable');
  const fabBem = fabInBemFromSqrtPriceX96(BigInt(slot0) & ((1n << 160n) - 1n));
  const fabUsd = fabBem * bemUsd;
  const weight = Number(BigInt(weightHex)), networkNand = weight / CFG.weightPerTransistor;
  const fabPerNandDay = CFG.fabPerDayVerified / (networkNand + 1);
  let snap = {
    asOf: new Date().toISOString(), head, headTimestamp, blockTime: bt, rule: opts.rule,
    prices: { fabUsd, fabBem, bemUsd, okbUsd, source: 'slot0', crossCheck: null,
      anchorUsd: null, lowUsd: null, highUsd: null, rangePos: null, swaps24h: null },
    network: {
      weight, networkNand, miners: Number(BigInt(minersHex)), sealed: BigInt(sealedHex) !== 0n,
      startTime: Number(BigInt(startHex)), burnedPctEst: networkNand / CFG.supplyNandEq,
      fabPerNandDay, usdPerNandDay: fabPerNandDay * fabUsd,
    },
    decision: { nandOkb: null, nandSource: null, okbPerFabDay: null, paybackDays: null, ratio: null, tier: null },
    availability: { history: available('pending'), nand: available(opts.skipNand ? 'skipped' : 'pending') },
  };
  const storage = localStore(opts);
  const history = readCached(storage, 'history', head);
  if (history) {
    snap = applyHistory(snap, history.value);
    snap.availability.history = available('cached', history.asOf);
  }
  const nand = readCached(storage, 'nand', head);
  if (positive(opts.nandOkb)) {
    snap = applyNand(snap, opts.nandOkb, 'manual');
    snap.availability.nand = available('manual');
  } else if (!opts.skipNand && nand) {
    snap = applyNand(snap, nand.value.okb, marketSource(nand.value), nand.value);
    snap.availability.nand = available('cached', nand.asOf);
  }
  step('done');
  return snap;
}

// Each optional dataset settles independently and has one total deadline. Partial scans are never cached.
// Callers may abort a superseded load; late results then cannot publish or replace cached data.
export async function refreshOptional(initial, opts = {}) {
  let current = { ...initial, availability: { ...initial.availability } };
  const storage = localStore(opts);
  const timeoutMs = opts.timeoutMs ?? CFG.optionalTimeoutMs;
  const update = async (kind, read, apply) => {
    try {
      const value = await deadline(read, timeoutMs, opts.signal);
      opts.signal?.throwIfAborted();
      if (!validValue(kind, value)) throw new Error(kind === 'nand' ? 'no usable NAND quote' : 'no FAB/BEM swaps in the last 24h');
      const entry = { asOf: kind === 'nand' ? value.asOf : initial.asOf, head: initial.head, value };
      saveCached(storage, kind, entry);
      current = apply(current, value);
      current = { ...current, availability: { ...current.availability, [kind]: available('live', entry.asOf) } };
    } catch (e) {
      if (opts.signal?.aborted) return;
      const previous = current.availability[kind];
      const hasValue = kind === 'history' ? positive(current.prices.anchorUsd) : positive(current.decision.nandOkb);
      current = { ...current, availability: { ...current.availability,
        [kind]: available(hasValue ? 'cached' : 'unavailable', previous.asOf, e.message) } };
    }
    if (!opts.signal?.aborted) opts.onUpdate?.(current);
  };
  const jobs = [update('history', async signal => {
    const day = Math.round(86400 / initial.blockTime);
    const swaps = await logsChunked({ address: CFG.poolManager, topics: [TOPIC.swap, CFG.poolId] }, initial.head - day, initial.head, signal);
    swaps.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
    const series = swaps.map(fabInBemFromSwap);
    return { medianBem: median(series), lowBem: series.reduce((a, b) => Math.min(a, b), Infinity),
      highBem: series.reduce((a, b) => Math.max(a, b), -Infinity), lastSwapBem: series.at(-1), swaps24h: series.length };
  }, (snap, value) => applyHistory(snap, value, true))];
  if (!opts.skipNand && !['manual', 'skipped'].includes(current.availability.nand.state)) {
    jobs.push(update('nand', signal => nandOkbMarket(initial.head, initial.blockTime, { signal,
      asOf: Number.isSafeInteger(initial.headTimestamp) ? new Date(initial.headTimestamp * 1000).toISOString() : undefined }),
      (snap, value) => applyNand(snap, value.okb, marketSource(value), value)));
  }
  await Promise.all(jobs);
  return current;
}

const abiUint = value => {
  if (!/^0x[0-9a-f]{64}$/i.test(value || '')) throw new Error('invalid uint256 response');
  return BigInt(value);
};
const abiOwner = value => /^0x0{24}[0-9a-f]{40}$/i.test(value || '') && BigInt(value) !== 0n;

// 256 IDs per call, at most five such calls per HTTP batch (public Sentio's limit).
function ownersCall(ids) {
  return encodeTryAggregate(ids.map(id => ({ to: CFG.circuits, data: SEL.ownerOf + pad(hex(id)) })));
}
function decodeOwners(data, expected) {
  return decodeTryAggregate(data, expected).map(owner => {
    if (owner !== null && !abiOwner(owner)) throw new Error('invalid ownerOf response');
    return owner;
  });
}

// API IDs are hints only. Every accepted ID is confirmed with ownerOf at the same block as
// balanceOf. The official API currently restricts CORS, so browsers normally take the chain path.
// Returns coverage as well as IDs: a bounded/failed scan must never masquerade as an empty wallet.
export async function ownedCircuits(addr, head, opts = {}) {
  if (!isAddress(addr)) throw new Error('not an address');
  if (!Number.isSafeInteger(head) || head < 0) throw new Error('invalid block number');
  const owner = addr.toLowerCase(), block = hex(head), found = new Set(), seen = new Set(), errors = [];
  let expected = null, source = 'balanceOf', multicall = true, scanned = 0;
  const call = data => ['eth_call', [{ to: CFG.circuits, data }, block]];
  const accept = (ids, owners, signal) => {
    signal.throwIfAborted();
    ids.forEach((id, i) => {
      seen.add(id.toString()); scanned++;
      if (abiOwner(owners[i]) && owners[i].slice(-40).toLowerCase() === owner.slice(2)) found.add(id.toString());
    });
  };
  const confirm = async (ids, signal) => {
    ids = ids.filter(id => !seen.has(id.toString()));
    if (multicall && ids.length) {
      try {
        const groups = [];
        for (let i = 0; i < ids.length; i += 256) groups.push(ids.slice(i, i + 256));
        const values = await batch(groups.map(group => ['eth_call', [{ to: CFG.multicall, data: ownersCall(group) }, block]]), 5, { signal });
        const owners = values.flatMap((value, i) => decodeOwners(value, groups[i].length));
        accept(ids, owners, signal);
        return;
      } catch (e) {
        signal.throwIfAborted();
        multicall = false;
        errors.push(`Multicall unavailable; using direct ownerOf: ${e.message}`);
      }
    }
    for (let i = 0; i < ids.length; i += 5) {
      const group = ids.slice(i, i + 5);
      accept(group, await batch(group.map(id => call(SEL.ownerOf + pad(hex(id)))), 5, { signal }), signal);
      if (found.size === expected) return;
    }
  };
  try {
    await deadline(async signal => {
      // Browser origins cannot rely on the API's CORS policy. Read its two chain
      // prerequisites together; Node callers may still use verified API candidates.
      const chainOnly = opts.apiCandidates === false;
      const [balance, counter] = chainOnly
        ? await batch([call(SEL.balanceOf + pad(owner)), call(SEL.nextId)], 5, { signal })
        : [await rpc(...call(SEL.balanceOf + pad(owner)), { signal })];
      const count = abiUint(balance);
      if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('balance exceeds safe integer');
      expected = Number(count);
      if (!expected) return;
      if (!chainOnly) {
        source = 'fabx-api';
        try {
          const ids = await deadline(async apiSignal => {
            const response = await fetch(`${CFG.fabxApi}/v1/accounts/${owner}/mining`, { signal: apiSignal, credentials: 'omit' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data?.account?.toLowerCase() !== owner || !Array.isArray(data.items) || data.items.length > CFG.ownershipMaxIds) throw new Error('invalid mining account/items');
            return [...new Set(data.items.filter(item => item?.cpu?.toLowerCase() === CFG.circuits).map(item => {
              if (!(typeof item.id === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(item.id))
                  && !(Number.isSafeInteger(item.id) && item.id >= 0)) throw new Error('invalid circuit id');
              const id = BigInt(item.id);
              if (id >= 2n ** 256n) throw new Error('circuit id exceeds uint256');
              return id.toString();
            }))].map(BigInt);
          }, CFG.ownershipApiTimeoutMs, signal);
          // Keep each aggregate batch bounded, including an unexpectedly large public index response.
          for (let i = 0; i < ids.length && found.size !== expected; i += 1280) await confirm(ids.slice(i, i + 1280), signal);
          if (found.size === expected) return;
          errors.push(`API ownership coverage ${found.size}/${expected}; scanning chain`);
        } catch (e) { signal.throwIfAborted(); errors.push(`FabX API unavailable: ${e.message}`); }
      }
      source = 'chain-scan';
      let last = BigInt(CFG.ownershipMaxIds - 1);
      try { last = abiUint(chainOnly ? counter : await rpc(...call(SEL.nextId), { signal })); }
      catch (e) { signal.throwIfAborted(); errors.push(`nextId unavailable; using bounded range: ${e.message}`); }
      // Verified on this contract: nextId is the last allocated ID, so INCLUDE it. No monotonic
      // ownerOf/binary-search assumption: holes, burns or per-item errors cannot prove completeness.
      const end = Number(last < BigInt(CFG.ownershipMaxIds) ? last : BigInt(CFG.ownershipMaxIds - 1));
      for (let lo = 0; lo <= end && found.size !== expected; lo += 2560) {
        const starts = [lo, lo + 1280].filter(start => start <= end);
        await Promise.all(starts.map(start => confirm(
          Array.from({ length: Math.min(1280, end - start + 1) }, (_, i) => BigInt(start + i)), signal)));
      }
      if (found.size !== expected) errors.push(`Bounded discovery confirmed ${found.size}/${expected}; scanned through ID ${end}`);
    }, opts.timeoutMs ?? CFG.ownershipTimeoutMs, opts.signal);
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    if (expected == null) throw new Error(`ownedCircuits: balanceOf unavailable: ${e.message}`, { cause: e });
    errors.push(e.message);
  }
  const ids = [...found].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return { ids, expected, verified: ids.length, complete: ids.length === expected, source, block: head, scanned, errors };
}

// Aggregate mining reads by pinned block; malformed/unsupported aggregates fall back to
// ordinary eth_call in the public endpoint's five-item batches. Per-leaf failures stay null.
async function miningReads(calls, state) {
  if (!calls.length) return [];
  const direct = group => batch(group.map(({ data, block }) => ['eth_call', [{ to: CFG.mining, data }, block]]), 5, { signal: state.signal });
  let values;
  if (!state.multicall) values = await direct(calls);
  else {
    const byBlock = new Map();
    calls.forEach((call, index) => {
      if (!byBlock.has(call.block)) byBlock.set(call.block, []);
      byBlock.get(call.block).push({ ...call, index });
    });
    const groups = [...byBlock.values()].flatMap(rows => {
      const chunks = [];
      for (let i = 0; i < rows.length; i += 256) chunks.push(rows.slice(i, i + 256));
      return chunks;
    });
    const results = await batch(groups.map(group => ['eth_call', [{ to: CFG.multicall,
      data: encodeTryAggregate(group.map(({ data }) => ({ to: CFG.mining, data }))) }, group[0].block]]), 5, { signal: state.signal });
    values = new Array(calls.length).fill(null);
    for (let i = 0; i < groups.length; i++) {
      let decoded;
      try { decoded = decodeTryAggregate(results[i], groups[i].length); }
      catch {
        state.multicall = false;
        decoded = await direct(groups[i]);
      }
      groups[i].forEach((call, index) => { values[call.index] = decoded[index]; });
    }
  }
  // The shared production reader validates each ABI shape (uint or miner tuple).
  return values;
}

// Per-wallet yield measured on chain, with one row for every owned circuit.
// onStep('measure', {address, ids, discovery}) publishes IDs before their numbers finish.
export async function wallet(addr, snap, onStep = () => {}, opts = {}) {
  return deadline(signal => readWallet(addr, snap, onStep, signal, opts), opts.timeoutMs ?? CFG.loadTimeoutMs, opts.signal);
}

async function readWallet(addr, snap, onStep, signal, opts) {
  if (!isAddress(addr)) throw new Error('not an address');
  const head = snap.head;
  onStep('scan');
  const { ids, ...discovery } = await ownedCircuits(addr, head, { signal, apiCandidates: opts.apiCandidates });
  signal.throwIfAborted();
  onStep('measure', { address: addr, ids: ids.map(String), discovery });
  let production = { rows: [], pendingKnown: 0, pendingSubtotalFab: 0, mining: 0,
    window: { blockTimestamp: snap.headTimestamp ?? null, previousHead: null, windowSeconds: null } };
  if (ids.length) {
    const readState = { multicall: true, signal };
    production = await readRigProduction(ids.map(id => ({ id: id.toString() })), snap, signal,
      (calls, block) => miningReads(calls.map(({ data }) => ({ data, block: hex(block) })), readState));
  }
  signal.throwIfAborted();
  const rigs = production.rows.map(({ id, fabPerDay, status }) => ({ id,
    fabPerDay: status === 'stopped' ? 0 : fabPerDay, status: status === 'measured' ? 'mining' : status }));
  const known = rigs.filter(row => ['mining', 'stopped'].includes(row.status));
  const measured = known.length, unread = rigs.filter(row => row.status === 'unread').length;
  const fabPerDay = measured || (!ids.length && discovery.complete) ? known.reduce((sum, row) => sum + row.fabPerDay, 0) : null;
  const { pendingKnown, mining, window } = production;
  const pendingTotal = discovery.expected;
  const pendingComplete = discovery.complete && pendingKnown === pendingTotal;
  const pendingSubtotalFab = pendingKnown || pendingComplete ? production.pendingSubtotalFab : null;
  const pendingFab = pendingComplete ? pendingSubtotalFab : null;
  const asOf = Number.isSafeInteger(window.blockTimestamp) && window.blockTimestamp > 0
    ? new Date(window.blockTimestamp * 1000).toISOString() : null;
  return {
    address: addr, circuits: ids.length, discovery, mining, measured, unread, skipped: ids.length - measured - unread,
    head, ...window, asOf, hours: window.windowSeconds != null ? window.windowSeconds / 3600 : 0,
    pendingFab, pendingUsd: pendingFab != null ? pendingFab * snap.prices.fabUsd : null,
    pendingKnown, pendingTotal, pendingSubtotalFab, pendingComplete,
    fabPerDay, usdPerDay: fabPerDay != null ? fabPerDay * snap.prices.fabUsd : null,
    networkSharePct: fabPerDay != null ? (fabPerDay / CFG.fabPerDayVerified) * 100 : null,
    rigs,
  };
}

const nonNegative = (n) => Number.isFinite(n) && n >= 0;

// Replacement cost of measured output, not a resale quote. Unknown rigs stay unknown;
// totals cover measured rigs only (null when a nonempty wallet has no usable rows).
export function assetCard(snap, walletRes) {
  const unitOutput = snap.network.fabPerNandDay;
  const { nandOkb } = snap.decision;
  const { fabUsd, okbUsd } = snap.prices;
  const priceOutput = (fabPerDay) => {
    const nandEq = fabPerDay != null && Number.isFinite(unitOutput) && unitOutput > 0 ? fabPerDay / unitOutput : null;
    const valueOkb = nandEq != null && nonNegative(nandOkb) ? nandEq * nandOkb : null;
    const valueUsd = valueOkb != null && nonNegative(okbUsd) ? valueOkb * okbUsd : null;
    return { nandEq, valueOkb, valueUsd };
  };
  const rigs = walletRes.rigs.map((rig) => {
    const fabPerDay = ['mining', 'stopped'].includes(rig.status) && nonNegative(rig.fabPerDay) ? rig.fabPerDay : null;
    return { ...rig, fabPerDay, ...priceOutput(fabPerDay) };
  });
  const known = rigs.filter((rig) => rig.fabPerDay != null);
  const fabPerDay = known.length || (!rigs.length && walletRes.discovery?.complete !== false) ? known.reduce((sum, rig) => sum + rig.fabPerDay, 0) : null;
  const usdPerDay = fabPerDay != null && nonNegative(fabUsd) ? fabPerDay * fabUsd : null;
  const values = priceOutput(fabPerDay);
  return {
    rigs, fabPerDay, usdPerDay, ...values,
    apr: values.valueUsd > 0 && usdPerDay != null ? usdPerDay * 365 / values.valueUsd : null,
    paybackDays: values.valueUsd != null && usdPerDay > 0 ? values.valueUsd / usdPerDay : null,
  };
}

// Compare a fully enumerated official market at one block. The new-build model
// solves 1 = dailyEmission * addedNand / (networkNand + addedNand), including dilution.
// Prices are direct OKB payments: seller fees and unclaimed rewards never reduce them.
export function entryComparison(snap, listings, { complete = true, emissionRate, unverifiedBps } = {}) {
  const networkNand = snap.network.networkNand ?? snap.network.weight / CFG.weightPerTransistor;
  const emissionVerified = validEmission(emissionRate, unverifiedBps);
  const emissionFabPerDay = emissionVerified ? Number(emissionRate - emissionRate * unverifiedBps / 10000n) * 86400 / 1e8 : null;
  const nandRequired = positive(networkNand) && emissionFabPerDay > 1 ? networkNand / (emissionFabPerDay - 1) : null;
  const nandOkb = positive(snap.decision.nandOkb) ? snap.decision.nandOkb : null;
  const baseline = {
    nandRequired, nandOkb, emissionFabPerDay, emissionVerified,
    okbPerFabDay: nandRequired != null && nandOkb != null ? nandRequired * nandOkb : null,
    nandSource: snap.decision.nandSource ?? null,
    nandState: snap.availability?.nand?.state ?? 'unavailable',
    nandAsOf: snap.availability?.nand?.asOf ?? null,
    nandQuote: snap.decision.nandQuote ? { ...snap.decision.nandQuote } : null,
  };
  const fabOkb = positive(snap.prices.fabUsd) && positive(snap.prices.okbUsd) ? snap.prices.fabUsd / snap.prices.okbUsd : null;
  const priced = listings.map(row => {
    const measured = row.status === 'measured' && positive(row.fabPerDay) && positive(row.priceOkb);
    return { ...row, okbPerFabDay: measured ? row.priceOkb / row.fabPerDay : null,
      apr: measured && fabOkb != null ? 365 * row.fabPerDay * fabOkb / row.priceOkb : null };
  });
  const ranked = complete ? priced.filter(row => positive(row.okbPerFabDay)).sort((a, b) =>
    a.okbPerFabDay - b.okbPerFabDay || (BigInt(a.listingId) < BigInt(b.listingId) ? -1 : 1)) : [];
  const unknown = priced.filter(row => !positive(row.okbPerFabDay));
  const cost = ranked[0]?.okbPerFabDay, build = baseline.okbPerFabDay;
  const comparable = positive(cost) && positive(build);
  const deltaOkb = comparable ? Math.abs(cost - build) : null;
  return { complete, ranked, unknown, baseline, fabOkb,
    cheaper: comparable ? cost === build ? 'equal' : cost < build ? 'listing' : 'build' : null,
    deltaOkb, deltaPct: comparable ? deltaOkb / Math.max(cost, build) * 100 : null };
}

const UINT256_MAX = 2n ** 256n - 1n;
const validEmission = (rate, unverifiedBps) => typeof rate === 'bigint' && rate >= 0n && rate < UINT256_MAX
  && typeof unverifiedBps === 'bigint' && unverifiedBps >= 0n && unverifiedBps <= 10000n;
function entryWords(data, count) {
  if (!new RegExp(`^0x[0-9a-f]{${count * 64}}$`, 'i').test(data || '')) throw new Error('invalid entry ABI response');
  return Array.from({ length: count }, (_, i) => word(data, i));
}
const entryUrl = id => `https://fabx.tech/c/${CFG.circuits}/${id}`;

// Sequential HTTP batches reuse the transport's endpoint rotation, bounded retries and backoff.
// Enumeration is all-or-nothing. A missing mining leaf only makes that rig's output unknown.
async function entryReads(calls, block, signal, strict = false) {
  const groups = [];
  for (let i = 0; i < calls.length; i += 128) groups.push(calls.slice(i, i + 128));
  const out = [];
  for (let i = 0; i < groups.length; i += 5) {
    signal.throwIfAborted();
    const part = groups.slice(i, i + 5);
    let results;
    try {
      results = await batch(part.map(group => ['eth_call', [{ to: CFG.multicall,
        data: encodeTryAggregate(group) }, hex(block)]]), 5, { signal });
    } catch (e) {
      signal.throwIfAborted();
      if (strict) throw e;
      results = part.map(() => null);
    }
    for (let j = 0; j < part.length; j++) {
      let values;
      try { values = decodeTryAggregate(results[j], part[j].length); }
      catch (e) {
        if (strict) throw new Error(`listing enumeration failed: ${e.message}`, { cause: e });
        values = part[j].map(() => null);
      }
      if (strict && values.some(value => value == null)) throw new Error('listing enumeration failed: unread listingView');
      out.push(...values);
    }
  }
  return out;
}

async function entryWindow(snap, signal) {
  const stamp = header => {
    const value = Number(header?.timestamp);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('entry block timestamp unavailable');
    return value;
  };
  const now = Number.isSafeInteger(snap.headTimestamp) && snap.headTimestamp > 0 ? snap.headTimestamp
    : stamp(await rpc('eth_getBlockByNumber', [hex(snap.head), false], { signal }));
  if (!positive(snap.blockTime)) throw new Error('entry block time unavailable');
  let previousHead = snap.head - Math.round(600 / snap.blockTime), seconds;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!Number.isSafeInteger(previousHead) || previousHead <= 0 || previousHead >= snap.head) throw new Error('invalid entry window');
    const header = await rpc('eth_getBlockByNumber', [hex(previousHead), false], { signal });
    seconds = now - stamp(header);
    if (Math.abs(seconds - 600) <= 15) break;
    if (attempt < 2) previousHead -= Math.round((600 - seconds) / snap.blockTime);
  }
  if (!(seconds >= 480 && seconds <= 720)) throw new Error('entry window is not approximately ten minutes');
  return { previousHead, windowSeconds: seconds, blockTimestamp: now };
}

// Endpoint rewards use 8 decimal FAB. Subtract integer base units before converting
// to Number, so large accumulated pending balances do not erase a small time delta.
function measuredEntry(row, values, window, emission) {
  const unknown = status => ({ ...row, fabPerDay: null, status });
  try {
    const [now, before] = [abiUint(values[0]), abiUint(values[1])];
    const [miner, oldMiner, weights] = [entryWords(values[2], 23), entryWords(values[3], 23), entryWords(values[4], 4)];
    if (now === UINT256_MAX || before === UINT256_MAX) return unknown('unread');
    // getMiner.debt changes when rewards are settled. This also conservatively excludes
    // other in-window miner updates: a positive net pending delta alone cannot rule out a claim.
    if (now < before || miner[21] !== oldMiner[21]) return unknown('claimed-in-window');
    if ([8, 9, 18, 19, 20, 22].some(index => miner[index] !== oldMiner[index])) return unknown('changed-in-window');
    if (miner[0] !== BigInt(CFG.circuits) || miner[1] !== BigInt(row.id)
        || oldMiner[0] !== miner[0] || oldMiner[1] !== miner[1]
        || miner[8] > BigInt(window.blockTimestamp - window.windowSeconds)
        || miner[8] !== oldMiner[8] || miner[9] !== 1n || oldMiner[9] !== 1n
        || miner[18] !== 0n || oldMiner[18] !== 0n) return unknown('unread');
    if ((weights[0] > 0n && weights[2] === 0n) || (weights[1] > 0n && weights[3] === 0n)) return unknown('unread');
    const unverEmission = emission.rate * emission.unverifiedBps / 10000n;
    const rateAtoms = (weights[2] > 0n ? weights[0] * (emission.rate - unverEmission) / weights[2] : 0n)
      + (weights[3] > 0n ? weights[1] * unverEmission / weights[3] : 0n);
    const currentRate = Number(rateAtoms) * 86400 / 1e8;
    // Equal rewards only establish a measured zero when the independent rate
    // confirms zero emission; stale pending with a positive rate remains unknown.
    if (now === before) return unknown(rateAtoms === 0n ? 'stopped' : 'rate-mismatch');
    if (before === 0n) return unknown('unread');
    const fabPerDay = Number(now - before) / 1e8 * 86400 / window.windowSeconds;
    // One percent permits minor network changes; include each pool's one atom/second
    // integer-rate truncation and one pending-delta base-unit rounding error.
    const tolerance = currentRate * 0.01 + 2 * 86400 / 1e8 + 86400 / window.windowSeconds / 1e8;
    if (!positive(currentRate) || !positive(fabPerDay) || Math.abs(fabPerDay - currentRate) > tolerance) return unknown('rate-mismatch');
    return { ...row, fabPerDay, status: 'measured', currentRate };
  } catch { return unknown('unread'); }
}

// Wallet assets and listed rigs share the exact timestamp window, reward ABI and
// claim/rate checks. Only the transport differs: wallet reads retain direct-call fallback.
async function readRigProduction(rows, snap, signal, read) {
  let window = { blockTimestamp: snap.headTimestamp ?? null, previousHead: null, windowSeconds: null };
  let measured = rows.map(row => ({ ...row, fabPerDay: null, status: 'unread' }));
  let pendingAtoms = 0n, pendingKnown = 0, mining = 0, emission = null;
  const unavailable = error => { signal.throwIfAborted(); window.error ??= error.message; };
  const safeRead = async (calls, block) => {
    try { return await read(calls, block); }
    catch (error) { unavailable(error); return calls.map(() => null); }
  };
  try {
    const [timing, raw] = await Promise.all([
      entryWindow(snap, signal).catch(error => { unavailable(error); return null; }),
      safeRead([{ to: CFG.mining, data: SEL.currentRate }, { to: CFG.mining, data: SEL.unverifiedBps },
        ...rows.map(row => ({ to: CFG.mining, data: SEL.minerKey + pad(CFG.circuits) + pad(hex(row.id)) }))], snap.head),
    ]);
    if (timing) window = { ...window, ...timing };
    const [rate, unverifiedBps, ...rawKeys] = raw;
    try {
      const parsed = { rate: abiUint(rate), unverifiedBps: abiUint(unverifiedBps) };
      if (!validEmission(parsed.rate, parsed.unverifiedBps)) throw new Error('invalid emission rate');
      emission = parsed;
    } catch (error) { unavailable(error); }
    const keys = rawKeys.map(value => {
      try { const key = abiUint(value); return key !== 0n && key !== UINT256_MAX ? value : null; } catch { return null; }
    });
    const valid = keys.flatMap((key, index) => key ? [{ key, index }] : []);
    const calls = selectors => valid.flatMap(({ key }) => selectors.map(selector => ({ to: CFG.mining, data: selector + pad(key) })));
    const [current, previous] = await Promise.all([
      safeRead(calls([SEL.pendingWithDeweb, SEL.getMiner, SEL.dewebWeights]), snap.head),
      timing ? safeRead(calls([SEL.pendingWithDeweb, SEL.getMiner]), window.previousHead) : [],
    ]);
    valid.forEach(({ index }, i) => {
      if (timing && emission) measured[index] = measuredEntry(rows[index],
        [current[i * 3], previous[i * 2], current[i * 3 + 1], previous[i * 2 + 1], current[i * 3 + 2]], window, emission);
      try {
        const pending = abiUint(current[i * 3]);
        if (pending !== UINT256_MAX) { pendingAtoms += pending; pendingKnown++; if (pending > 0n) mining++; }
      } catch { /* Unknown current rewards never become a fabricated balance. */ }
    });
  } catch (e) {
    unavailable(e);
  }
  signal.throwIfAborted();
  return { rows: measured, window, pendingKnown, pendingSubtotalFab: pendingKnown || !rows.length ? Number(pendingAtoms) / 1e8 : null,
    mining, emission };
}

function cachedEntry(storage, head) {
  try {
    const entry = JSON.parse(storage?.getItem(CACHE_KEYS.entry) || 'null');
    if (!entry || entry.state !== 'live' || entry.complete !== true || !Number.isSafeInteger(entry.head) || entry.head > head
        || !Number.isFinite(Date.parse(entry.asOf)) || Date.parse(entry.asOf) > Date.now() + 30_000
        || !Number.isSafeInteger(entry.blockTimestamp) || !Number.isSafeInteger(entry.totalScanned)
        || !Array.isArray(entry.ranked) || !Array.isArray(entry.unknown)
        || entry.validCount !== entry.ranked.length + entry.unknown.length || entry.totalScanned < entry.validCount
        || !entry.baseline || ![null, 'build', 'listing', 'equal'].includes(entry.cheaper)) return null;
    if ([...entry.ranked, ...entry.unknown].some(row => !/^[0-9]+$/.test(row.id) || !/^[1-9][0-9]*$/.test(row.listingId)
      || !positive(row.priceOkb) || row.url !== entryUrl(row.id))) return null;
    if (entry.ranked.some(row => row.status !== 'measured' || !positive(row.fabPerDay) || !positive(row.okbPerFabDay))) return null;
    return entry;
  } catch { return null; }
}

// The cache stores the ENTIRE complete comparison, including its price snapshot and NAND
// provenance. A failed new scan must not combine old listings with a new build benchmark.
export async function loadEntryComparison(snap, opts = {}) {
  const storage = localStore(opts);
  try {
    const result = await deadline(signal => readEntryComparison(snap, signal), opts.timeoutMs ?? CFG.entryTimeoutMs, opts.signal);
    opts.signal?.throwIfAborted();
    saveCached(storage, 'entry', result);
    return result;
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const cached = cachedEntry(storage, snap.head);
    if (cached) return { ...cached, state: 'cached', error: e.message };
    return { ...entryComparison(snap, [], { complete: false }), state: 'unavailable', error: e.message,
      head: snap.head, asOf: null, blockTimestamp: snap.headTimestamp ?? null, previousHead: null,
      windowSeconds: null, totalScanned: null, validCount: null, prices: { ...snap.prices } };
  }
}

async function readEntryComparison(snap, signal) {
  if (!Number.isSafeInteger(snap.head) || snap.head <= 0) throw new Error('invalid entry block');
  const last = abiUint(await rpc('eth_call', [{ to: CFG.rigMarket, data: SEL.nextListingId }, hex(snap.head)], { signal }));
  if (last > BigInt(CFG.entryMaxListingIds)) throw new Error('listing enumeration exceeds bounded scan');
  const totalScanned = Number(last), listings = [];
  // This contract's counter is the highest assigned ID, so include it (1 through N).
  for (let start = 1; start <= totalScanned; start += 640) {
    const ids = Array.from({ length: Math.min(640, totalScanned - start + 1) }, (_, i) => start + i);
    const values = await entryReads(ids.map(id => ({ to: CFG.rigMarket, data: SEL.listingView + pad(hex(id)) })), snap.head, signal, true);
    values.forEach((value, i) => {
      const fields = entryWords(value, 6);
      if (fields[0] >= 2n ** 160n || fields[1] >= 2n ** 160n || fields[4] > 10000n || fields[5] > 1n) throw new Error('invalid listingView fields');
      if (fields[5] !== 1n || fields[0] === 0n || fields[1] !== BigInt(CFG.circuits) || fields[3] === 0n) return;
      const id = fields[2].toString(), priceOkb = Number(fields[3]) / 1e18;
      if (!positive(priceOkb)) throw new Error('invalid listing price');
      listings.push({ listingId: String(ids[i]), id, priceOkb, url: entryUrl(id) });
    });
  }
  const { rows: measured, window, emission } = await readRigProduction(listings, snap, signal,
    (calls, block) => entryReads(calls, block, signal));
  signal.throwIfAborted();
  const asOf = Number.isSafeInteger(window.blockTimestamp) && window.blockTimestamp > 0
    ? new Date(window.blockTimestamp * 1000).toISOString() : null;
  return { ...entryComparison(snap, measured, { emissionRate: emission?.rate, unverifiedBps: emission?.unverifiedBps }), state: 'live', head: snap.head, asOf,
    ...window, totalScanned, validCount: listings.length, rateTolerancePct: 1,
    prices: { fabUsd: snap.prices.fabUsd, okbUsd: snap.prices.okbUsd }, priceAsOf: snap.asOf ?? null, error: window.error ?? null };
}

// USD value of output at a fixed FAB price scenario and compounded daily network growth.
// W0 cancels in W0 / (W0 * (1 + g)^t); dilution starts on day 1.
export function futureValue(snap, fabPerDay, days, { dailyNetGrowth = 0, fabMult = 1 } = {}) {
  if (!nonNegative(fabPerDay) || !nonNegative(snap.prices.fabUsd) || !nonNegative(fabMult)
      || !Number.isSafeInteger(days) || days < 0 || !Number.isFinite(dailyNetGrowth) || dailyNetGrowth <= -1) return null;
  let usd = 0;
  for (let t = 1; t <= days; t++) usd += fabPerDay / (1 + dailyNetGrowth) ** t * snap.prices.fabUsd * fabMult;
  return Number.isFinite(usd) ? usd : null;
}

// Geometric daily growth from an approximately seven-day historical weight read.
// A non-archive RPC or an unavailable/zero historical weight cannot establish a rate.
export async function networkGrowth(snap, { signal } = {}) {
  const unknown = { measured: false, daily: 0 };
  const { head, blockTime: bt, network: { weight } } = snap;
  if (!Number.isSafeInteger(head) || !Number.isFinite(bt) || bt <= 0 || !Number.isFinite(weight) || weight <= 0) return unknown;
  const span = Math.round(7 * 86400 / bt);
  if (span <= 0 || head - span < 0) return unknown;
  try {
    const result = await rpc('eth_call', [{ to: CFG.mining, data: SEL.totalVerifWeight }, hex(head - span)], { signal });
    if (!/^0x[0-9a-f]+$/i.test(result)) return unknown;
    const before = Number(BigInt(result));
    if (!(before > 0) || !Number.isFinite(before)) return unknown;
    const days = span * bt / 86400;
    const daily = (weight / before) ** (1 / days) - 1;
    return Number.isFinite(daily) && daily > -1 ? { measured: true, daily } : unknown;
  } catch { return unknown; }
}

// Recompute the NAND-dependent numbers of a snapshot (used when the NAND price arrives after the first render).
export function applyNand(snap, nandOkb, source, quote = null) {
  const { fabPerNandDay, usdPerNandDay } = snap.network;
  return {
    ...snap,
    decision: {
      ...snap.decision, nandOkb, nandSource: nandOkb ? source : null,
      nandQuote: nandOkb && quote ? { kind: quote.kind, qty: quote.qty, hours: quote.hours } : null,
      okbPerFabDay: nandOkb ? nandOkb / fabPerNandDay : null,
      paybackDays: nandOkb ? (nandOkb * snap.prices.okbUsd) / usdPerNandDay : null,
    },
  };
}

// What-if for burning `qty` NAND now: cost, added output, payback today and under stress (FAB price drop, network growth).
// Static: excludes tape-out fees, gas and price impact.
export function scenario(snap, qty, { fabDrop = 0.3, netGrowth = 2 } = {}) {
  const { nandOkb } = snap.decision;
  if (!nandOkb || !(qty > 0)) return null;
  const W = snap.network.weight, add = qty * CFG.weightPerTransistor;
  const fabPerDay = (w) => CFG.fabPerDayVerified * add / (w + add);
  const costOkb = qty * nandOkb, costUsd = costOkb * snap.prices.okbUsd;
  const payback = (fabUsd, w) => costUsd / (fabPerDay(w) * fabUsd);
  return {
    qty, costOkb, costUsd,
    fabPerDay: fabPerDay(W), usdPerDay: fabPerDay(W) * snap.prices.fabUsd,
    sharePct: add / (W + add) * 100,
    paybackDays: payback(snap.prices.fabUsd, W),
    paybackFabDrop: payback(snap.prices.fabUsd * (1 - fabDrop), W),
    paybackNetGrowth: payback(snap.prices.fabUsd, W * netGrowth),
    paybackBoth: payback(snap.prices.fabUsd * (1 - fabDrop), W * netGrowth),
    fabDrop, netGrowth,
  };
}

// Payback days for `qty` NAND if the FAB price is multiplied by `fabMult` and network weight by `netMult`.
export function paybackFor(snap, qty, fabMult = 1, netMult = 1) {
  const { nandOkb } = snap.decision;
  if (!nandOkb || !(qty > 0)) return null;
  const W = snap.network.weight * netMult, add = qty * CFG.weightPerTransistor;
  const usdPerDay = CFG.fabPerDayVerified * add / (W + add) * snap.prices.fabUsd * fabMult;
  return (qty * nandOkb * snap.prices.okbUsd) / usdPerDay;
}
