// Read-only rig authenticity check: chain status + full official task vectors (where published).
import { CFG, deadline, isAddress } from './desk.mjs';
import { POD_CFG, configurePodRpc, rpc as podRpc } from './pod.mjs';
import { createRpcClient, RPC_ENDPOINTS } from './rpc.mjs';
import { apiUrl } from './api-url.mjs';

export const VERIFY_API = 'https://api.fabx.tech/v1/pod/verify';
export const VECTORS_API = 'https://api.fabx.tech/v1/pod/tasks';
// Browsers go through the site's own relay: api.fabx.tech sends no CORS headers.

export const VERIFY_RELAY = '/api/pod-verify';

export function verifyRelayUrl(loc = globalThis.location) {
  return apiUrl(VERIFY_RELAY, loc);
}

const SEL = {
  minerKey: '0x10eafa00',
  getMiner: '0x0527edc2',
  getTask: '0x57342d74',
  processorMultiplier: '0x0f03daba',
  netlist: '0x3fc4be56',
  ownerOf: '0x6352211e',
};

const pad = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hex = (n) => '0x' + BigInt(n).toString(16);

export const CHAINS = {
  fabx: {
    id: 'fabx',
    chainId: 196,
    label: { zh: 'FabX · X Layer', en: 'FabX · X Layer' },
    rpc: RPC_ENDPOINTS,
    mining: CFG.mining,
    defaultProcessor: CFG.circuits,
    processors: [
      { key: 'genesis', address: CFG.circuits, label: { zh: 'FAB-Genisis', en: 'FAB-Genisis' } },
    ],
    minerFields: 23,
    verifyChainId: 196,
  },
  bsc: {
    id: 'bsc',
    chainId: 56,
    label: { zh: 'TapeOut · BSC', en: 'TapeOut · BSC' },
    rpc: POD_CFG.rpc,
    mining: POD_CFG.mining,
    defaultProcessor: POD_CFG.processors[0].address,
    processors: POD_CFG.processors.map((p) => ({
      key: p.label.toLowerCase() === 'behemoth' ? 'behemoth' : 'tapeout',
      address: p.address,
      label: { zh: p.label, en: p.label },
    })),
    minerFields: 22,
    verifyChainId: 56,
  },
};

const PROCESSOR_ALIASES = {
  genesis: 'genesis', fab: 'genesis', genisis: 'genesis',
  'fab-genisis': 'genesis', 'fab-genesis': 'genesis',
  tapeout: 'tapeout', tap: 'tapeout',
  behemoth: 'behemoth', blonskr: 'behemoth', blonskr_no1: 'behemoth',
};

/** @returns {{ chain: object, processor: object, circuitId: string, displayId: string } | { error: string }} */
export function parseRigQuery(rig, chainId = 'fabx', processorHint) {
  const chain = CHAINS[chainId === 'tapeout' ? 'bsc' : chainId === 'xlayer' ? 'fabx' : chainId];
  if (!chain) return { error: 'unknown_chain' };
  const raw = String(rig ?? '').trim();
  if (!raw) return { error: 'missing_rig' };

  let processor = chain.processors.find((p) => p.address.toLowerCase() === chain.defaultProcessor.toLowerCase());
  let prefixedProcessor;
  let circuitPart = raw;

  const hashMatch = /^([^#]+)#(\d+)$/i.exec(raw);
  if (hashMatch) {
    const alias = PROCESSOR_ALIASES[hashMatch[1].toLowerCase().replace(/\s+/g, '')];
    const byAlias = alias && chain.processors.find((p) => p.key === alias);
    if (!alias) return { error: 'unknown_processor' };
    if (!byAlias) return { error: 'processor_mismatch' };
    processor = prefixedProcessor = byAlias;
    circuitPart = hashMatch[2];
  }
  if (processorHint) {
    const hint = String(processorHint).trim().toLowerCase();
    const alias = PROCESSOR_ALIASES[hint.replace(/\s+/g, '')];
    const selected = chain.processors.find((p) => isAddress(hint) ? p.address.toLowerCase() === hint : p.key === alias);
    if (!selected) return { error: alias || isAddress(hint) ? 'processor_mismatch' : 'unknown_processor' };
    if (prefixedProcessor && selected !== prefixedProcessor) return { error: 'processor_mismatch' };
    processor = selected;
  }
  if (!processor) return { error: 'unknown_processor' };

  if (!/^\d+$/.test(circuitPart)) return { error: 'invalid_rig_id' };
  const circuitId = circuitPart.replace(/^0+/, '') || '0';
  if (circuitId.length > 78 || BigInt(circuitId) >= 2n ** 256n) return { error: 'invalid_rig_id' };
  const displayId = `${processor.label.en}#${circuitId}`;
  return { chain, processor, circuitId, displayId };
}

export function minerWords(data, fieldCount) {
  if (!new RegExp(`^0x[0-9a-f]{${fieldCount * 64}}$`, 'i').test(data || '')) throw new Error('invalid getMiner response');
  return Array.from({ length: fieldCount }, (_, i) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64)));
}

export function decodeAbiBytes(data) {
  if (!/^0x(?:[0-9a-f]{64}){2,}$/i.test(data || '')) throw new Error('invalid bytes response');
  const off = Number(BigInt('0x' + data.slice(2, 66)));
  if (off !== 32) throw new Error('invalid bytes offset');
  const len = Number(BigInt('0x' + data.slice(2 + off * 2, 2 + (off + 32) * 2)));
  if (!Number.isSafeInteger(len) || len <= 0 || off + 32 + len > (data.length - 2) / 2) throw new Error('invalid bytes length');
  return '0x' + data.slice(2 + (off + 32) * 2, 2 + (off + 32 + len) * 2);
}

export function rigChainStatus(miner, processorMultiplier) {
  const status = Number(miner[9]);
  const taskId = Number(miner[2]);
  const optimal = miner[15] !== 0n;
  const verified = taskId > 0 && miner[19] > 0n;
  const revoked = status === 2;
  const mining = status === 1;
  const processorOk = processorMultiplier == null ? null : processorMultiplier > 0n;
  let miningLabel;
  if (revoked) miningLabel = 'revoked';
  else if (mining) miningLabel = 'mining';
  else if (status === 3) miningLabel = 'stopped';
  else if (status === 0) miningLabel = 'idle';
  else miningLabel = 'other';
  return {
    status,
    mining,
    revoked,
    optimal,
    verified,
    taskId,
    processorOk,
    miningLabel,
    verifWeight: miner[19],
    unverWeight: miner[20],
    bonus: miner[14],
  };
}

export function summarizeVectors(result) {
  if (result.state === 'all_pass') {
    return { state: 'all_pass', passed: result.passed, total: result.total };
  }
  if (result.state === 'fail_at') {
    return { state: 'fail_at', index: result.index, passed: result.passed, total: result.total };
  }
  return { state: result.state, ...(result.reason ? { reason: result.reason } : {}) };
}

/** @param {{ chainId: number, taskId: number, netlist: string, fetchImpl?: typeof fetch, verifyUrl?: string, signal?: AbortSignal }} opts */
export async function verifyNetlistAgainstTask(opts) {
  const { chainId, taskId, netlist, fetchImpl = fetch, verifyUrl = VERIFY_API, signal } = opts;
  signal?.throwIfAborted();
  if (chainId === 56) return { state: 'undetectable', reason: 'vectors_api_unsupported' };
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return { state: 'undetectable', reason: 'no_task' };
  }
  const url = `${verifyUrl}?chainId=${chainId}`;
  let response, text;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, netlist }),
      signal,
    });
    text = await response.text();
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    return { state: 'read_failed', reason: 'verify_unreachable' };
  }
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (response.status === 404 && body?.code === 'CHAIN_NOT_SUPPORTED') {
    return { state: 'undetectable', reason: 'vectors_api_unsupported' };
  }
  if (!response.ok) return { state: 'read_failed', reason: 'verify_error' };
  const incomplete = { state: 'incomplete', reason: 'verify_incomplete' };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return incomplete;
  const { total, passed, firstFailure: failure } = body;
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(passed) || passed < 0 || passed > total) return incomplete;
  if (body.pass === true && passed === total && failure == null) {
    return { state: 'all_pass', passed, total };
  }
  if (body.pass === false && passed < total && failure && !Array.isArray(failure)
    && Number.isSafeInteger(failure.index) && failure.index >= 0 && failure.index < total && failure.index <= passed) {
    return { state: 'fail_at', index: failure.index, passed, total };
  }
  return incomplete;
}

function makeRpc(chain, overrides = {}) {
  if (overrides.rpc) return overrides.rpc;
  const endpoints = overrides.endpoints ?? chain.rpc;
  const clients = endpoints.map((endpoint) => createRpcClient({ endpoints: [endpoint], timeoutMs: overrides.rpcTimeoutMs ?? 8_000, fetchImpl: overrides.fetchImpl }));
  let active = 0;
  return async (...args) => {
    const start = active;
    for (let i = 0; i < clients.length; i++) {
      const index = (start + i) % clients.length;
      try { return await clients[index].rpc(...args); }
      catch (error) {
        const nodeFailure = error.retryable || [403, 408, 429].includes(error.status)
          || /timeout|timed out|missing trie|historical state|header not found|temporarily unavailable|internal (?:error|server error)/i.test(error.message);
        if (error.name === 'AbortError' || !nodeFailure || i === clients.length - 1) throw error;
        if (active === index) active = (index + 1) % clients.length;
      }
    }
  };
}

export async function checkRig(query, opts = {}) {
  const parsed = parseRigQuery(query.rig, query.chain, query.processor);
  if (parsed.error) return { ok: false, error: parsed.error };
  const { chain, processor, circuitId, displayId } = parsed;
  const signal = opts.signal;
  if (chain.id === 'bsc' && (opts.endpoints || opts.fetchImpl || opts.logEndpoint)) {
    configurePodRpc({
      endpoints: opts.endpoints,
      fetchImpl: opts.fetchImpl,
      logEndpoint: opts.logEndpoint,
      timeoutMs: opts.timeoutMs,
    });
  }
  const rpc = opts.rpc ?? (chain.id === 'bsc'
    ? (method, params, o) => podRpc(method, params, o)
    : makeRpc(chain, opts));
  const proc = processor.address.toLowerCase();
  const idHex = hex(BigInt(circuitId));
  const unsupported = { state: 'undetectable', reason: 'vectors_api_unsupported' };
  let latest = {
    ok: true, chain: chain.id, chainId: chain.chainId, processor: proc,
    processorLabel: processor.label, circuitId, displayId, block: null,
    owner: null, ownerState: 'pending', processorMultiplier: null, chainStatus: null,
    readState: 'pending', readErrors: [],
    vectors: chain.id === 'bsc' ? unsupported : { state: 'pending' },
  };
  const publish = (result) => {
    signal?.throwIfAborted();
    latest = result;
    opts.onProgress?.(result);
    return result;
  };
  publish(latest);
  const invalid = (message) => Object.assign(new Error(message), { incomplete: true });
  const wordValue = (value) => {
    if (!/^0x[0-9a-f]{64}$/i.test(value || '')) throw invalid('invalid ABI word');
    return BigInt(value);
  };

  try {
    return await deadline(async (active) => {
      active.throwIfAborted();
      const blockHex = await rpc('eth_blockNumber', [], { signal: active });
      active.throwIfAborted();
      if (!/^0x[0-9a-f]+$/i.test(blockHex || '') || !Number.isSafeInteger(Number(blockHex))) throw invalid('invalid block number');
      const readErrors = [];
      // Keep successful fields even when another independent read fails.
      const read = async (field, to, data, decode) => {
        try {
          active.throwIfAborted();
          const raw = await rpc('eth_call', [{ to, data }, blockHex], { signal: active });
          active.throwIfAborted();
          try { return { state: 'complete', value: decode(raw) }; }
          catch (error) { throw invalid(error.message); }
        } catch (error) {
          active.throwIfAborted();
          if (field === 'owner' && !error.retryable && !error.rateLimited && !(error.status >= 400)
            && /ERC721NonexistentToken|owner query for nonexistent token|invalid token ID|nonexistent token/i.test(error.message)) {
            return { state: 'not_found', value: null };
          }
          const state = error.incomplete ? 'incomplete' : 'read_failed';
          readErrors.push({ field, state, message: error.message, status: error.status ?? null, retryable: true });
          return { state, value: null };
        }
      };
      const [multiplier, ownerRead, key] = await Promise.all([
        read('processor', chain.mining, SEL.processorMultiplier + pad(proc), wordValue),
        read('owner', proc, SEL.ownerOf + pad(idHex), (raw) => {
          wordValue(raw);
          if (!/^0x0{24}[0-9a-f]{40}$/i.test(raw) || BigInt(raw) === 0n) throw invalid('invalid owner address');
          return `0x${raw.slice(-40).toLowerCase()}`;
        }),
        read('miner_key', chain.mining, SEL.minerKey + pad(proc) + pad(idHex), wordValue),
      ]);
      let chainStatus = null;
      if (key.state === 'complete' && key.value !== 0n) {
        const record = await read('miner', chain.mining, SEL.getMiner + pad(hex(key.value)), (raw) => minerWords(raw, chain.minerFields));
        if (record.state === 'complete') chainStatus = rigChainStatus(record.value, multiplier.value);
      }
      active.throwIfAborted();
      const ownerState = ownerRead.state === 'complete' ? 'found' : ownerRead.state;
      const readState = ownerState === 'not_found' ? 'not_found'
        : readErrors.some((error) => error.state === 'read_failed') ? 'read_failed'
          : readErrors.length ? 'incomplete' : 'complete';
      let vectors;
      if (chain.id === 'bsc') vectors = unsupported;
      else if (ownerState === 'not_found') vectors = { state: 'undetectable', reason: 'circuit_not_found' };
      else if (readState !== 'complete') vectors = { state: readState, reason: 'chain_unreadable' };
      else if (!chainStatus) vectors = { state: 'undetectable', reason: 'no_miner_record' };
      else if (chainStatus.taskId <= 0) vectors = { state: 'undetectable', reason: 'no_task' };
      else vectors = { state: 'pending' };
      const chainResult = publish({
        ...latest, block: Number(blockHex), owner: ownerRead.value, ownerState,
        processorMultiplier: multiplier.value?.toString() ?? null, chainStatus,
        readState, readErrors, vectors,
      });
      if (vectors.state === 'pending') {
        try {
          const netlistRaw = await rpc('eth_call', [{ to: proc, data: SEL.netlist + pad(idHex) }, blockHex], { signal: active });
          let netlist;
          try { netlist = decodeAbiBytes(netlistRaw); }
          catch (error) { throw invalid(error.message); }
          vectors = await verifyNetlistAgainstTask({
            chainId: chain.verifyChainId, taskId: chainStatus.taskId, netlist,
            fetchImpl: opts.fetchImpl, verifyUrl: opts.verifyUrl, signal: active,
          });
        } catch (error) {
          active.throwIfAborted();
          vectors = { state: error.incomplete ? 'incomplete' : 'read_failed', reason: 'netlist_unreadable' };
        }
      }
      active.throwIfAborted();
      return publish({ ...chainResult, vectors: summarizeVectors(vectors), vectorsDetail: vectors });
    }, opts.timeoutMs ?? 25_000, signal);
  } catch (error) {
    signal?.throwIfAborted();
    const readState = latest.readState === 'pending' ? (error.incomplete ? 'incomplete' : 'read_failed') : latest.readState;
    const vectors = latest.vectors.state !== 'pending' ? latest.vectors
      : latest.readState === 'pending' ? { state: readState, reason: 'chain_unreadable' }
        : { state: 'read_failed', reason: 'verify_unreachable' };
    return publish({
      ...latest, readState, vectors,
      readErrors: latest.readState === 'pending' ? [{ field: 'chain', state: readState, message: error.message, retryable: true }] : latest.readErrors,
    });
  }
}

export function configureRigCheckPod(overrides) {
  configurePodRpc(overrides);
}
