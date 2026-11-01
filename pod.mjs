// TapeOut PoD mining on BSC — read-only rig discovery and ten-minute BEM output measurement.
import { createRpcClient } from './rpc.mjs';
import { deadline, isAddress } from './desk.mjs';
import { encodeTryAggregate, decodeTryAggregate } from './multicall.mjs';

export const POD_CFG = {
  rpc: ['https://tapeout.net/rpc', 'https://rpc-bsc.48.club', 'https://bsc-rpc.publicnode.com'],
  logRpc: 'https://tapeout.net/rpc',
  logRpcFallback: 'https://bsc-rpc.publicnode.com',
  mining: '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',
  processors: [
    { address: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', label: 'TapeOut' },
    { address: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C', label: 'Behemoth' },
  ],
  bemPairBsc: '0x3098D7A051045000d68eC0360753A40C8cABEa31',
  bemPerDayVerified: 7200 * 0.99,
  transferFromBlock: 117_000_000,
  logChunk: 20_000,
  logConcurrency: 3,
  ownershipMaxIds: 30_000,
  timeoutMs: 5_000,
  loadTimeoutMs: 10_000,
  ownershipTimeoutMs: 45_000,
  multicall: '0xca11bde05977b3631167028862be2a173976ca11',
  // Public holder cited in mechanism evidence (claimMany on TapeOut #13659, SSOT §3 C3).
  exampleWallet: '0x0587e1e53be5e897432c64c08697df9a72fe95b2',
};

const SEL = {
  totalVerifWeight: '0xef6aff46', totalUnverWeight: '0x63967742', minerCount: '0x6d1da431',
  isSealed: '0x631f9852', minerKey: '0x10eafa00', ownerOf: '0x6352211e', balanceOf: '0x70a08231',
  supportsInterface: '0x01ffc9a7', tokenOfOwnerByIndex: '0x2f745c59', nextId: '0x61b8ce8c',
  pending: '0x1808eeb8', getMiner: '0x0527edc2', currentRate: '0xf9f8bdb7', unverifiedBps: '0xd8d56ffb',
};
const IERC721_ENUMERABLE = '0x780e9d63';
const TOPIC = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
};

const pad = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hex = (n) => '0x' + BigInt(n).toString(16);
const word = (data, i) => BigInt('0x' + (data.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'));
const UINT256_MAX = 2n ** 256n - 1n;
const MINER_FIELDS = 22;
const positive = (n) => Number.isFinite(n) && n > 0;
const INDEX_WINDOW_ATTEMPTS = 3;

function rpcRetryable(error) {
  return !!(error?.retryable || /temporarily unavailable|retry in \d+s/i.test(error?.message || ''));
}

function pause(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

let client = createRpcClient({
  endpoints: POD_CFG.rpc,
  logEndpoint: POD_CFG.logRpc,
  timeoutMs: POD_CFG.timeoutMs,
});
let logClients = [client];

const logRangeCache = new Map();

function rebuildClients(overrides = {}) {
  const endpoints = overrides.endpoints ?? POD_CFG.rpc;
  const timeoutMs = overrides.timeoutMs ?? POD_CFG.timeoutMs;
  const fetchImpl = overrides.fetchImpl;
  const logUrls = [overrides.logEndpoint ?? POD_CFG.logRpc, POD_CFG.logRpcFallback].filter(Boolean);
  const uniqueLogs = [...new Set(logUrls)];
  client = createRpcClient({ endpoints, logEndpoint: uniqueLogs[0], fetchImpl, timeoutMs });
  logClients = uniqueLogs.map((logEndpoint) => createRpcClient({ endpoints, logEndpoint, fetchImpl, timeoutMs }));
}

rebuildClients();

export function configurePodRpc(overrides = {}) {
  if (Array.isArray(overrides.endpoints)) POD_CFG.rpc = overrides.endpoints;
  if (typeof overrides.logEndpoint === 'string') POD_CFG.logRpc = overrides.logEndpoint;
  if (typeof overrides.logRpcFallback === 'string') POD_CFG.logRpcFallback = overrides.logRpcFallback;
  if (Number.isSafeInteger(overrides.transferFromBlock)) POD_CFG.transferFromBlock = overrides.transferFromBlock;
  if (Number.isSafeInteger(overrides.loadTimeoutMs)) POD_CFG.loadTimeoutMs = overrides.loadTimeoutMs;
  if (Number.isSafeInteger(overrides.ownershipTimeoutMs)) POD_CFG.ownershipTimeoutMs = overrides.ownershipTimeoutMs;
  rebuildClients(overrides);
}

export const rpc = (...args) => client.rpc(...args);
export const batch = (...args) => client.batch(...args);

async function rpcGetLogs(params, signal) {
  let lastError;
  for (const logClient of logClients) {
    try {
      const logs = await logClient.rpc('eth_getLogs', params, { signal });
      if (!Array.isArray(logs)) throw new Error('invalid eth_getLogs result');
      return logs;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    }
  }
  throw lastError;
}

function logCacheKey(filter, lo, hi) {
  return JSON.stringify({
    address: filter.address?.toLowerCase(),
    topics: filter.topics,
    lo,
    hi,
  });
}

async function logsChunkedRange(filter, lo, hi, signal) {
  const key = logCacheKey(filter, lo, hi);
  if (logRangeCache.has(key)) return logRangeCache.get(key);
  let size = POD_CFG.logChunk;
  const all = [];
  for (let start = lo; start <= hi;) {
    signal?.throwIfAborted();
    const end = Math.min(start + size - 1, hi);
    try {
      const logs = await rpcGetLogs([{ ...filter, fromBlock: hex(start), toBlock: hex(end) }], signal);
      all.push(...logs);
      start = end + 1;
    } catch (e) {
      if (!e.rangeLimited || e.rateLimited || size <= 2_000) {
        throw new Error(`eth_getLogs failed at blocks ${start}-${end}: ${e.message}`, { cause: e });
      }
      size = Math.max(2_000, Math.floor(size / 2));
    }
  }
  logRangeCache.set(key, all);
  return all;
}

async function logsChunked(filter, from, to, signal) {
  const lo = Math.max(0, from);
  const ranges = [];
  let size = POD_CFG.logChunk;
  for (let start = lo; start <= to; start += size) ranges.push([start, Math.min(start + size - 1, to)]);
  const concurrency = Math.max(1, POD_CFG.logConcurrency || 1);
  const all = [];
  for (let i = 0; i < ranges.length; i += concurrency) {
    const parts = await Promise.all(ranges.slice(i, i + concurrency)
      .map(([rangeLo, rangeHi]) => logsChunkedRange(filter, rangeLo, rangeHi, signal)));
    all.push(...parts.flat());
  }
  return all;
}

async function blockTime(head, signal) {
  const [a, b] = await batch([['eth_getBlockByNumber', [hex(head), false]], ['eth_getBlockByNumber', [hex(head - 10_000), false]]], 5, { signal });
  const seconds = (Number(a?.timestamp) - Number(b?.timestamp)) / 10_000;
  if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('block timestamps unavailable');
  return { seconds, headTimestamp: Number(a.timestamp) };
}

async function getJson(url, parentSignal) {
  return deadline(async (signal) => {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
    return r.json();
  }, POD_CFG.timeoutMs, parentSignal);
}

const abiUint = (value) => {
  if (!/^0x[0-9a-f]+$/i.test(value || '')) throw new Error('invalid uint256 response');
  return BigInt(value);
};
const abiOwner = (value) => /^0x0{24}[0-9a-f]{40}$/i.test(value || '') && BigInt(value) !== 0n;
const validEmission = (rate, unverifiedBps) => typeof rate === 'bigint' && rate >= 0n && rate < UINT256_MAX
  && typeof unverifiedBps === 'bigint' && unverifiedBps >= 0n && unverifiedBps <= 10000n;

function minerWords(data) {
  if (!new RegExp(`^0x[0-9a-f]{${MINER_FIELDS * 64}}$`, 'i').test(data || '')) throw new Error('invalid getMiner response');
  return Array.from({ length: MINER_FIELDS }, (_, i) => word(data, i));
}

function rigId(processor, circuitId) {
  const label = POD_CFG.processors.find((p) => p.address.toLowerCase() === processor.toLowerCase())?.label || processor.slice(0, 8);
  return `${label}#${circuitId}`;
}

function ownersCall(ids, processor) {
  return encodeTryAggregate(ids.map((id) => ({ to: processor, data: SEL.ownerOf + pad(hex(id)) })));
}
function decodeOwners(data, expected) {
  return decodeTryAggregate(data, expected).map((owner) => {
    if (owner !== null && !abiOwner(owner)) throw new Error('invalid ownerOf response');
    return owner;
  });
}

async function supportsEnumerable(processor, head, signal) {
  try {
    const value = await rpc('eth_call', [{ to: processor, data: SEL.supportsInterface + pad(IERC721_ENUMERABLE) }, hex(head)], { signal });
    return BigInt(value) !== 0n;
  } catch {
    return false;
  }
}

async function ownedViaEnumerable(processor, owner, head, need, signal) {
  const rows = [];
  for (let index = 0; index < need; index++) {
    signal.throwIfAborted();
    const id = abiUint(await rpc('eth_call', [{
      to: processor,
      data: SEL.tokenOfOwnerByIndex + pad(owner) + pad(hex(index)),
    }, hex(head)], { signal }));
    rows.push({ processor: processor.toLowerCase(), id: id.toString() });
  }
  return rows;
}

function replayTransferOwnership(processor, owner, logs) {
  const key = processor.toLowerCase();
  const balances = new Map();
  for (const log of logs) {
    const from = ('0x' + log.topics[1].slice(-40)).toLowerCase();
    const to = ('0x' + log.topics[2].slice(-40)).toLowerCase();
    const id = BigInt(log.topics[3]).toString();
    const mapKey = `${key}:${id}`;
    if (from === owner) balances.delete(mapKey);
    if (to === owner) balances.set(mapKey, { processor: key, id });
  }
  return [...balances.values()];
}

async function ownedViaTransferLogs(processor, owner, head, signal) {
  const ownerTopic = '0x' + owner.slice(2).padStart(64, '0');
  const [incoming, outgoing] = await Promise.all([
    logsChunked({ address: processor, topics: [TOPIC.transfer, null, ownerTopic] }, POD_CFG.transferFromBlock, head, signal),
    logsChunked({ address: processor, topics: [TOPIC.transfer, ownerTopic] }, POD_CFG.transferFromBlock, head, signal),
  ]);
  const logs = [...incoming, ...outgoing].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber)
    || Number(a.logIndex) - Number(b.logIndex));
  return { rows: replayTransferOwnership(processor, owner, logs), scanned: incoming.length + outgoing.length };
}

async function confirmOwnerOf(processor, owner, ids, head, signal) {
  const found = new Set();
  let multicall = true;
  const block = hex(head);
  const accept = (group, owners) => {
    group.forEach((id, index) => {
      const data = owners[index];
      if (abiOwner(data) && data.slice(-40).toLowerCase() === owner.slice(2)) found.add(id.toString());
    });
  };
  for (let i = 0; i < ids.length; i += 256) {
    signal.throwIfAborted();
    const group = ids.slice(i, i + 256);
    if (multicall) {
      try {
        const value = await rpc('eth_call', [{ to: POD_CFG.multicall,
          data: ownersCall(group, processor) }, block], { signal });
        accept(group, decodeOwners(value, group.length));
        continue;
      } catch (e) {
        signal.throwIfAborted();
        multicall = false;
      }
    }
    const owners = await batch(group.map((id) => ['eth_call', [{ to: processor, data: SEL.ownerOf + pad(hex(id)) }, block]]), 5, { signal });
    accept(group, owners);
  }
  return [...found].map((id) => ({ processor: processor.toLowerCase(), id }));
}

async function ownedViaOwnerScan(processor, owner, head, need, signal) {
  let lastId = BigInt(POD_CFG.ownershipMaxIds - 1);
  try {
    lastId = abiUint(await rpc('eth_call', [{ to: processor, data: SEL.nextId }, hex(head)], { signal }));
  } catch (e) {
    signal.throwIfAborted();
    throw new Error(`nextId unavailable for ${processor}: ${e.message}`, { cause: e });
  }
  const end = Number(lastId < BigInt(POD_CFG.ownershipMaxIds) ? lastId : BigInt(POD_CFG.ownershipMaxIds - 1));
  const found = [];
  const seen = new Set();
  let scanned = 0;
  for (let lo = 0; lo <= end && found.length < need; lo += 2560) {
    signal.throwIfAborted();
    const starts = [lo, lo + 1280].filter((start) => start <= end);
    const parts = await Promise.all(starts.map((start) => {
      const ids = Array.from({ length: Math.min(1280, end - start + 1) }, (_, index) => BigInt(start + index));
      scanned += ids.length;
      return confirmOwnerOf(processor, owner, ids, head, signal);
    }));
    for (const rows of parts) {
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        found.push(row);
        if (found.length >= need) break;
      }
    }
  }
  return { rows: found, scanned };
}

async function discoverProcessorCircuits(processor, owner, head, need, signal) {
  if (!need) return { rows: [], source: 'balanceOf', complete: true, scanned: 0 };
  if (await supportsEnumerable(processor, head, signal)) {
    try {
      const rows = await ownedViaEnumerable(processor, owner, head, need, signal);
      if (rows.length === need) return { rows, source: 'enumerable', complete: true, scanned: need };
    } catch (e) {
      signal.throwIfAborted();
    }
  }
  try {
    const transfer = await ownedViaTransferLogs(processor, owner, head, signal);
    if (transfer.rows.length === need) {
      return { rows: transfer.rows, source: 'transfer-logs', complete: true, scanned: transfer.scanned };
    }
  } catch (e) {
    signal.throwIfAborted();
  }
  const scan = await ownedViaOwnerScan(processor, owner, head, need, signal);
  return {
    rows: scan.rows,
    source: 'chain-scan',
    complete: scan.rows.length === need,
    scanned: scan.scanned,
  };
}

async function ownedViaTransfers(addr, head, signal) {
  const owner = addr.toLowerCase();
  const expected = new Map();
  const errors = [];
  for (const { address: processor } of POD_CFG.processors) {
    signal.throwIfAborted();
    try {
      const balanceHex = await rpc('eth_call', [{ to: processor, data: SEL.balanceOf + pad(owner) }, hex(head)], { signal });
      expected.set(processor.toLowerCase(), Number(abiUint(balanceHex)));
    } catch (e) {
      expected.set(processor.toLowerCase(), null);
      errors.push(`balanceOf failed for ${processor}: ${e.message}`);
    }
  }
  const totalExpected = [...expected.values()].reduce((sum, n) => sum + (Number.isSafeInteger(n) ? n : 0), 0);
  if (!totalExpected) {
    return { rows: [], expected: 0, verified: 0, complete: true, source: 'balanceOf', block: head, scanned: 0, errors };
  }
  const rows = [];
  let scanned = 0;
  const sources = new Set();
  for (const { address: processor } of POD_CFG.processors) {
    const proc = processor.toLowerCase();
    const need = expected.get(proc);
    if (!need) continue;
    try {
      const result = await discoverProcessorCircuits(processor, owner, head, need, signal);
      rows.push(...result.rows);
      scanned += result.scanned;
      sources.add(result.source);
      if (!result.complete) errors.push(`Discovery ${result.rows.length}/${need} for ${processor} (${result.source})`);
    } catch (e) {
      signal.throwIfAborted();
      errors.push(`Discovery failed for ${processor}: ${e.message}`);
    }
  }
  const list = rows.sort((a, b) => a.processor.localeCompare(b.processor) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const complete = list.length === totalExpected && [...expected.entries()].every(([proc, count]) => {
    if (!count) return true;
    return list.filter((row) => row.processor === proc).length === count;
  });
  const source = sources.size === 1 ? [...sources][0] : 'mixed';
  return {
    rows: list,
    expected: totalExpected,
    verified: list.length,
    complete,
    source,
    block: head,
    scanned,
    errors,
  };
}

async function miningReads(calls, state) {
  if (!calls.length) return [];
  // One batch on one node. If that node fails, the client retries the whole batch on the next node.
  if (state.coherent) {
    return batch(calls.map(({ data, block }) => ['eth_call', [{ to: POD_CFG.mining, data }, block]]), 5, {
      signal: state.signal, coherent: true,
    });
  }
  const direct = (group) => batch(group.map(({ data, block }) => ['eth_call', [{ to: POD_CFG.mining, data }, block]]), 5, { signal: state.signal });
  let values;
  if (!state.multicall) values = await direct(calls);
  else {
    const byBlock = new Map();
    calls.forEach((call, index) => {
      if (!byBlock.has(call.block)) byBlock.set(call.block, []);
      byBlock.get(call.block).push({ ...call, index });
    });
    const groups = [...byBlock.values()].flatMap((rows) => {
      const chunks = [];
      for (let i = 0; i < rows.length; i += 256) chunks.push(rows.slice(i, i + 256));
      return chunks;
    });
    values = new Array(calls.length).fill(null);
    for (const group of groups) {
      let decoded;
      try {
        const result = await batch([['eth_call', [{ to: POD_CFG.multicall,
          data: encodeTryAggregate(group.map(({ data }) => ({ to: POD_CFG.mining, data }))) }, group[0].block]]], 5, { signal: state.signal });
        decoded = decodeTryAggregate(result[0], group.length);
      } catch {
        state.multicall = false;
        decoded = await direct(group);
      }
      group.forEach((call, index) => { values[call.index] = decoded[index]; });
    }
  }
  return values;
}

export async function podEntryWindow(snap, signal) {
  const stamp = (header) => {
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

function measuredEntry(row, values, window, emission, totals) {
  const unknown = (status) => ({ ...row, fabPerDay: null, status });
  try {
    const [now, before] = [abiUint(values[0]), abiUint(values[1])];
    const [miner, oldMiner] = [minerWords(values[2]), minerWords(values[3])];
    if (now === UINT256_MAX || before === UINT256_MAX) return unknown('unread');
    if (now < before || miner[21] !== oldMiner[21]) return unknown('claimed-in-window');
    if ([8, 9, 15, 19, 20].some((index) => miner[index] !== oldMiner[index])) return unknown('changed-in-window');
    const processor = row.processor.toLowerCase();
    const circuitId = row.circuitId ?? row.id;
    if (miner[0] !== BigInt(processor) || miner[1] !== BigInt(circuitId)
        || oldMiner[0] !== miner[0] || oldMiner[1] !== miner[1]
        || miner[8] > BigInt(window.blockTimestamp - window.windowSeconds)
        || miner[8] !== oldMiner[8] || miner[9] !== 1n || oldMiner[9] !== 1n
        || miner[18] !== 0n || oldMiner[18] !== 0n) return unknown('unread');
    const weights = [miner[19], miner[20], totals.verif, totals.unver];
    if ((weights[0] > 0n && weights[2] === 0n) || (weights[1] > 0n && weights[3] === 0n)) return unknown('unread');
    const unverEmission = emission.rate * emission.unverifiedBps / 10000n;
    const rateAtoms = (weights[2] > 0n ? weights[0] * (emission.rate - unverEmission) / weights[2] : 0n)
      + (weights[3] > 0n ? weights[1] * unverEmission / weights[3] : 0n);
    const currentRate = Number(rateAtoms) * 86400 / 1e8;
    if (now === before) {
      if (rateAtoms === 0n) return unknown('stopped');
      const fabPerDay = Number(rateAtoms) * 86400 / 1e8;
      if (!positive(fabPerDay)) return unknown('rate-mismatch');
      return { ...row, fabPerDay, status: 'measured', currentRate: fabPerDay };
    }
    if (before === 0n) return unknown('unread');
    const fabPerDay = Number(now - before) / 1e8 * 86400 / window.windowSeconds;
    const tolerance = currentRate * 0.01 + 2 * 86400 / 1e8 + 86400 / window.windowSeconds / 1e8;
    if (!positive(currentRate) || !positive(fabPerDay)) return unknown('rate-mismatch');
    if (Math.abs(fabPerDay - currentRate) > tolerance) {
      return positive(currentRate) ? { ...row, fabPerDay: currentRate, status: 'measured', currentRate } : unknown('rate-mismatch');
    }
    return { ...row, fabPerDay, status: 'measured', currentRate };
  } catch {
    return unknown('unread');
  }
}

function chainStatusRow(row, miner) {
  const status = Number(miner[9]);
  const optimal = miner[15] !== 0n;
  const verified = miner[2] > 0n && miner[19] > 0n;
  if (status === 2) return { ...row, fabPerDay: 0, status: 'revoked', optimal, verified };
  if (status === 3) return { ...row, fabPerDay: 0, status: 'stopped', optimal, verified };
  if (status === 0) return { ...row, fabPerDay: 0, status: 'stopped', optimal, verified };
  return { ...row, optimal, verified };
}

async function readCoherentWindow(selectors, headBlock, previousHead, signal) {
  const headHex = hex(headBlock);
  const prevHex = hex(previousHead);
  const paired = [
    ...selectors.map(({ data }) => ({ data, block: headHex })),
    ...selectors.map(({ data }) => ({ data, block: prevHex })),
  ];
  for (let attempt = 0; attempt < INDEX_WINDOW_ATTEMPTS; attempt++) {
    try {
      const values = await miningReads(paired, { signal, coherent: true, multicall: false });
      if (values.length === paired.length && values.every((value) => value != null)) {
        const half = selectors.length;
        return { current: values.slice(0, half), previous: values.slice(half) };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!rpcRetryable(error)) break;
    }
    if (attempt + 1 < INDEX_WINDOW_ATTEMPTS) await pause(Math.min(2_000, 400 * 2 ** attempt), signal);
  }
  return null;
}

async function readRigProduction(rows, snap, signal, read, readState = null) {
  let window = { blockTimestamp: snap.headTimestamp ?? null, previousHead: null, windowSeconds: null };
  let measured = rows.map((row) => ({ ...row, fabPerDay: null, status: 'unread', optimal: false, verified: false }));
  let pendingAtoms = 0n, pendingKnown = 0, mining = 0, emission = null, totals = { verif: 0n, unver: 0n };
  const unavailable = (error) => { signal?.throwIfAborted(); window.error ??= error.message; };
  const safeRead = async (calls, block) => {
    try { return await read(calls, block); }
    catch (error) { unavailable(error); return calls.map(() => null); }
  };
  try {
    let timing = null;
    try {
      timing = await podEntryWindow(snap, signal);
      window = { ...window, ...timing };
    } catch (error) {
      unavailable(error);
    }
    const raw = await safeRead([{ data: SEL.currentRate }, { data: SEL.unverifiedBps }, { data: SEL.totalVerifWeight }, { data: SEL.totalUnverWeight },
      ...rows.map((row) => ({ data: SEL.minerKey + pad(row.processor) + pad(hex(row.circuitId ?? row.id)) }))], snap.head);
    const [rate, unverifiedBps, verifHex, unverHex, ...rawKeys] = raw;
    try {
      totals = { verif: abiUint(verifHex), unver: abiUint(unverHex) };
      const parsed = { rate: abiUint(rate), unverifiedBps: abiUint(unverifiedBps) };
      if (!validEmission(parsed.rate, parsed.unverifiedBps)) throw new Error('invalid emission rate');
      emission = parsed;
    } catch (error) { unavailable(error); }
    const keys = rawKeys.map((value) => {
      try { const key = abiUint(value); return key !== 0n && key !== UINT256_MAX ? value : null; } catch { return null; }
    });
    const valid = keys.flatMap((key, index) => key ? [{ key, index }] : []);
    const selectorCalls = (pending, miner) => valid.flatMap(({ key }) => ([
      { data: pending + pad(key) },
      { data: miner + pad(key) },
    ]));
    const selectors = selectorCalls(SEL.pending, SEL.getMiner);
    let current;
    let previous;
    if (readState?.coherentWindow && timing && selectors.length) {
      current = await safeRead(selectors, snap.head);
      previous = new Array(selectors.length).fill(null);
      const paired = await readCoherentWindow(selectors, snap.head, window.previousHead, signal);
      if (paired) {
        current = paired.current;
        previous = paired.previous;
      } else {
        window.error ??= 'entry window read failed';
      }
    } else {
      [current, previous] = await Promise.all([
        safeRead(selectors, snap.head),
        timing ? safeRead(selectors, window.previousHead) : [],
      ]);
    }
    valid.forEach(({ index }, i) => {
      const minerNow = current[i * 2 + 1];
      try {
        const miner = minerWords(minerNow);
        const base = chainStatusRow(rows[index], miner);
        measured[index] = { ...measured[index], ...base };
        if (base.status === 'revoked' || base.status === 'stopped') return;
        const windowReady = !readState?.coherentWindow || (previous[i * 2] != null && previous[i * 2 + 1] != null);
        if (timing && emission && windowReady) {
          measured[index] = measuredEntry(rows[index],
            [current[i * 2], previous[i * 2], current[i * 2 + 1], previous[i * 2 + 1]], window, emission, totals);
          measured[index] = { ...measured[index], optimal: base.optimal, verified: base.verified };
        }
      } catch { /* keep unread */ }
      try {
        const pending = abiUint(current[i * 2]);
        if (pending !== UINT256_MAX) { pendingAtoms += pending; pendingKnown++; if (pending > 0n) mining++; }
      } catch { /* unknown pending */ }
    });
  } catch (e) {
    unavailable(e);
  }
  signal.throwIfAborted();
  return {
    rows: measured,
    window,
    pendingKnown,
    pendingSubtotalFab: pendingKnown || !rows.length ? Number(pendingAtoms) / 1e8 : null,
    mining,
    emission,
  };
}

// About seven days of verified-pool weight, same idea as desk.networkGrowth.
// Unknown when the historical read is missing; a failed read is not zero growth.
export async function podNetworkGrowth(snap, { signal } = {}) {
  const unknown = { measured: false, daily: null };
  const head = snap?.head;
  const bt = snap?.blockTime;
  const weight = snap?.network?.weight;
  if (!Number.isSafeInteger(head) || !Number.isFinite(bt) || bt <= 0 || !Number.isFinite(weight) || weight <= 0) return unknown;
  const span = Math.round(7 * 86400 / bt);
  if (span <= 0 || head - span < 0) return unknown;
  try {
    const result = await rpc('eth_call', [{ to: POD_CFG.mining, data: SEL.totalVerifWeight }, hex(head - span)], { signal });
    if (!/^0x[0-9a-f]+$/i.test(result || '')) return unknown;
    const before = Number(BigInt(result));
    if (!(before > 0) || !Number.isFinite(before)) return unknown;
    const days = span * bt / 86400;
    const daily = (weight / before) ** (1 / days) - 1;
    return Number.isFinite(daily) && daily > -1 ? { measured: true, daily } : unknown;
  } catch {
    return unknown;
  }
}

export async function podChainHead(opts = {}) {
  return deadline(async (signal) => {
    const head = Number(await rpc('eth_blockNumber', [], { signal }));
    if (!Number.isSafeInteger(head) || head < 10_000) throw new Error('invalid block number');
    const { seconds, headTimestamp } = await blockTime(head, signal);
    return { head, headTimestamp, blockTime: seconds, asOf: new Date().toISOString() };
  }, opts.timeoutMs ?? POD_CFG.timeoutMs, opts.signal);
}

export async function podSnapshot(opts = {}) {
  return deadline(async (signal) => {
    const head = Number(await rpc('eth_blockNumber', [], { signal }));
    if (!Number.isSafeInteger(head) || head < 10_000) throw new Error('invalid block number');
    const [timing, values, bemPair] = await Promise.all([
      blockTime(head, signal),
      batch([
        ['eth_call', [{ to: POD_CFG.mining, data: SEL.totalVerifWeight }, hex(head)]],
        ['eth_call', [{ to: POD_CFG.mining, data: SEL.minerCount }, hex(head)]],
        ['eth_call', [{ to: POD_CFG.mining, data: SEL.isSealed }, hex(head)]],
      ], 5, { signal }),
      getJson(`https://api.dexscreener.com/latest/dex/pairs/bsc/${POD_CFG.bemPairBsc}`, signal),
    ]);
    const bemUsd = Number(bemPair.pairs?.[0]?.priceUsd);
    if (!positive(bemUsd)) throw new Error('BEM USD price unavailable');
    const weight = Number(BigInt(values[0]));
    const miners = Number(BigInt(values[1]));
    const sealed = BigInt(values[2]) !== 0n;
    return {
      asOf: new Date().toISOString(),
      head,
      headTimestamp: timing.headTimestamp,
      blockTime: timing.seconds,
      prices: { bemUsd },
      network: { weight, miners, sealed, bemPerDayVerified: POD_CFG.bemPerDayVerified },
    };
  }, opts.timeoutMs ?? POD_CFG.loadTimeoutMs, opts.signal);
}

export async function podRigs(addr, snap, onStep = () => {}, opts = {}) {
  return deadline((signal) => readPodRigs(addr, snap, onStep, signal, opts), opts.timeoutMs ?? POD_CFG.loadTimeoutMs, opts.signal);
}

const nonNegative = (n) => Number.isFinite(n) && n >= 0;

/** BEM asset card — same rig rows as FabX wallet, without NAND replacement valuation. */
export function podAssetCard(snap, walletRes) {
  const bemUsd = snap.prices?.bemUsd;
  const rigs = walletRes.rigs.map((rig) => {
    const bemPerDay = ['mining', 'stopped'].includes(rig.status) && nonNegative(rig.fabPerDay) ? rig.fabPerDay : null;
    const usdPerDay = bemPerDay != null && nonNegative(bemUsd) ? bemPerDay * bemUsd : null;
    return { ...rig, fabPerDay: bemPerDay, valueUsd: null, valueOkb: null, usdPerDay };
  });
  const known = rigs.filter((rig) => rig.fabPerDay != null);
  const fabPerDay = known.length || (!rigs.length && walletRes.discovery?.complete !== false)
    ? known.reduce((sum, rig) => sum + rig.fabPerDay, 0) : null;
  const usdPerDay = fabPerDay != null && nonNegative(bemUsd) ? fabPerDay * bemUsd : null;
  return { rigs, fabPerDay, usdPerDay, valueUsd: null, valueOkb: null, nandEq: null, apr: null, paybackDays: null };
}

async function readPodRigs(addr, snap, onStep, signal, opts) {
  if (!isAddress(addr)) throw new Error('not an address');
  const head = snap.head;
  onStep('scan');
  const discovery = await ownedViaTransfers(addr, head, signal);
  signal.throwIfAborted();
  const rows = discovery.rows.map((row) => ({
    id: rigId(row.processor, row.id),
    processor: row.processor,
    circuitId: row.id,
  }));
  onStep('measure', { address: addr, ids: rows.map((row) => row.id), discovery });
  let production = { rows: [], pendingKnown: 0, pendingSubtotalFab: 0, mining: 0,
    window: { blockTimestamp: snap.headTimestamp ?? null, previousHead: null, windowSeconds: null } };
  if (rows.length) {
    const readState = { multicall: opts.multicall !== false, signal };
    production = await readRigProduction(rows, snap, signal,
      (calls, block) => miningReads(calls.map(({ data }) => ({ data, block: hex(block) })), readState));
  }
  signal.throwIfAborted();
  return finishPodWallet(addr, rows, discovery, production, snap, head);
}

function normalizeHoldings(holdings) {
  const rows = [];
  const seen = new Set();
  for (const item of holdings || []) {
    const processor = String(item?.processor || '').toLowerCase();
    const circuitId = String(item?.id ?? '');
    if (!/^0x[0-9a-f]{40}$/.test(processor) || !/^\d+$/.test(circuitId)) continue;
    const key = `${processor}:${circuitId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: rigId(processor, circuitId), processor, circuitId });
  }
  rows.sort((a, b) => a.processor.localeCompare(b.processor) || (BigInt(a.circuitId) < BigInt(b.circuitId) ? -1 : 1));
  return rows;
}

function finishPodWallet(addr, rows, discovery, production, snap, head) {
  const rigs = production.rows.map(({ id, fabPerDay, status, optimal, verified }) => ({
    id,
    fabPerDay: ['revoked', 'stopped'].includes(status) ? 0 : fabPerDay,
    status: status === 'measured' ? 'mining' : status,
    optimal,
    verified,
  }));
  const known = rigs.filter((row) => ['mining', 'stopped', 'revoked'].includes(row.status));
  const measured = known.length;
  const unread = rigs.filter((row) => row.status === 'unread').length;
  const fabPerDay = measured || (!rows.length && discovery.complete)
    ? known.reduce((sum, row) => sum + (row.fabPerDay ?? 0), 0) : null;
  const { pendingKnown, mining, window } = production;
  const pendingTotal = discovery.expected;
  const pendingComplete = discovery.complete && pendingKnown === pendingTotal;
  const pendingSubtotalFab = pendingKnown || pendingComplete ? production.pendingSubtotalFab : null;
  const pendingFab = pendingComplete ? pendingSubtotalFab : null;
  const bemUsd = positive(snap.prices?.bemUsd) ? snap.prices.bemUsd : null;
  const asOf = Number.isSafeInteger(window.blockTimestamp) && window.blockTimestamp > 0
    ? new Date(window.blockTimestamp * 1000).toISOString() : null;
  return {
    address: addr,
    circuits: rows.length,
    discovery,
    mining,
    measured,
    unread,
    skipped: rows.length - measured - unread,
    head,
    ...window,
    asOf,
    hours: window.windowSeconds != null ? window.windowSeconds / 3600 : 0,
    pendingFab,
    pendingUsd: pendingFab != null && bemUsd != null ? pendingFab * bemUsd : null,
    pendingKnown,
    pendingTotal,
    pendingSubtotalFab,
    pendingComplete,
    fabPerDay,
    usdPerDay: fabPerDay != null && bemUsd != null ? fabPerDay * bemUsd : null,
    networkSharePct: fabPerDay != null ? (fabPerDay / POD_CFG.bemPerDayVerified) * 100 : null,
    rigs,
  };
}

/** Measure indexed circuit ids only. Does not scan Transfer logs. */
export async function podRigsForIds(addr, holdings, snap, onStep = () => {}, opts = {}) {
  return deadline((signal) => readPodRigsFromIds(addr, holdings, snap, onStep, signal, opts), opts.timeoutMs ?? POD_CFG.loadTimeoutMs, opts.signal);
}

async function readPodRigsFromIds(addr, holdings, snap, onStep, signal, opts) {
  if (!isAddress(addr)) throw new Error('not an address');
  const head = snap.head;
  const rows = normalizeHoldings(holdings);
  const discovery = {
    expected: rows.length,
    verified: rows.length,
    complete: true,
    source: 'bsc-index',
    block: head,
    scanned: 0,
    errors: [],
  };
  onStep('measure', { address: addr, ids: rows.map((row) => row.id), discovery });
  let production = {
    rows: [], pendingKnown: 0, pendingSubtotalFab: 0, mining: 0,
    window: { blockTimestamp: snap.headTimestamp ?? null, previousHead: null, windowSeconds: null },
  };
  if (rows.length) {
    const readState = { multicall: false, signal, coherentWindow: true };
    production = await readRigProduction(rows, snap, signal,
      (calls, block) => miningReads(calls.map(({ data }) => ({ data, block: hex(block) })), readState),
      readState);
  }
  signal.throwIfAborted();
  const wallet = finishPodWallet(addr, rows, discovery, production, snap, head);
  if (typeof opts.indexUpdatedAt === 'string' && Number.isFinite(Date.parse(opts.indexUpdatedAt))) {
    wallet.indexUpdatedAt = opts.indexUpdatedAt;
  }
  return wallet;
}
