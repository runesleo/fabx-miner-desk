// Incremental BSC circuit-NFT holder index for the alerts worker and GET /api/bsc-rigs.
// Reads Transfer logs in chunks of at most 1000 blocks, at most 15 chunks per cron run
// (Cloudflare allows about 50 subrequests per invocation). Cold start takes many runs.
// Read-only on chain: eth_blockNumber and eth_getLogs. Never signs or sends transactions.

import { POD_CFG } from '../pod.mjs';

export const BSC_INDEX_CHUNK_BLOCKS = 1000;
export const BSC_INDEX_MAX_CHUNKS = 15;
export const BSC_INDEX_BUILDING = '索引建设中';
export const BSC_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const hexBlock = (n) => `0x${Number(n).toString(16)}`;

export function bscTransferFilter() {
  return {
    address: POD_CFG.processors.map((processor) => processor.address),
    topics: [BSC_TRANSFER_TOPIC],
  };
}

export function bscLogEndpoints() {
  return [...new Set([POD_CFG.logRpc, POD_CFG.logRpcFallback, ...POD_CFG.rpc].filter(Boolean))];
}

function processorLabel(processor) {
  return POD_CFG.processors.find((item) => item.address.toLowerCase() === processor)?.label || processor.slice(0, 8);
}

export function parseTransferLog(log) {
  const topics = log?.topics;
  if (!Array.isArray(topics) || topics.length < 4) return null;
  if (String(topics[0]).toLowerCase() !== BSC_TRANSFER_TOPIC) return null;
  const processor = String(log.address || '').toLowerCase();
  if (!ADDRESS.test(processor)) return null;
  if (!POD_CFG.processors.some((item) => item.address.toLowerCase() === processor)) return null;
  const owner = `0x${String(topics[2]).slice(-40).toLowerCase()}`;
  if (!ADDRESS.test(owner)) return null;
  let tokenId;
  let blockNumber;
  let logIndex;
  try {
    tokenId = BigInt(topics[3]).toString(10);
    blockNumber = Number(log.blockNumber);
    logIndex = Number(log.logIndex);
  } catch {
    return null;
  }
  if (!/^\d+$/.test(tokenId) || !Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(logIndex) || logIndex < 0) return null;
  return { processor, tokenId, owner, blockNumber, logIndex };
}

/** Last Transfer in (block, log index) order wins for each circuit. */
export function finalHolders(logs, { fromBlock = 0, toBlock = Number.MAX_SAFE_INTEGER } = {}) {
  const rows = [];
  for (const log of logs || []) {
    const row = parseTransferLog(log);
    if (!row || row.blockNumber < fromBlock || row.blockNumber > toBlock) continue;
    rows.push(row);
  }
  rows.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex || a.processor.localeCompare(b.processor) || (a.tokenId < b.tokenId ? -1 : 1));
  const holders = new Map();
  for (const row of rows) holders.set(`${row.processor}:${row.tokenId}`, row);
  return [...holders.values()];
}

function holderStatement(db, row, updatedAt) {
  return db.prepare(`INSERT INTO bsc_nft_holders (processor, token_id, owner, block_number, log_index, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(processor, token_id) DO UPDATE SET
      owner = excluded.owner,
      block_number = excluded.block_number,
      log_index = excluded.log_index,
      updated_at = excluded.updated_at
    WHERE excluded.block_number > bsc_nft_holders.block_number
      OR (excluded.block_number = bsc_nft_holders.block_number AND excluded.log_index >= bsc_nft_holders.log_index)`)
    .bind(row.processor, row.tokenId, row.owner, row.blockNumber, row.logIndex, updatedAt);
}

function stateStatement(db, scannedTo, head, complete, updatedAt) {
  return db.prepare(`INSERT INTO bsc_index_state (id, scanned_to, head, complete, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      scanned_to = excluded.scanned_to,
      head = excluded.head,
      complete = excluded.complete,
      updated_at = excluded.updated_at
    WHERE excluded.scanned_to >= bsc_index_state.scanned_to`)
    .bind(scannedTo, head, complete ? 1 : 0, updatedAt);
}

async function rpcCall(method, params, { fetchImpl, signal, endpoints }) {
  const urls = endpoints?.length ? endpoints : bscLogEndpoints();
  let lastError;
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal,
      });
      const data = await response.json();
      if (!response.ok || data?.error) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      if (data?.result === undefined || data?.result === null) throw new Error('empty rpc result');
      return data.result;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    }
  }
  throw lastError || new Error('no bsc rpc endpoint');
}

export async function defaultBscHead(signal, deps = {}) {
  const result = await rpcCall('eth_blockNumber', [], { fetchImpl: deps.fetchImpl || globalThis.fetch, signal, endpoints: deps.endpoints });
  const head = Number(result);
  if (!Number.isSafeInteger(head) || head < 0) throw new Error('invalid block number');
  return head;
}

export async function defaultBscGetLogs(filter, fromBlock, toBlock, signal, deps = {}) {
  const span = toBlock - fromBlock + 1;
  if (!Number.isSafeInteger(span) || span < 1 || span > BSC_INDEX_CHUNK_BLOCKS) {
    throw new Error(`log chunk ${fromBlock}-${toBlock} exceeds ${BSC_INDEX_CHUNK_BLOCKS} blocks`);
  }
  const result = await rpcCall('eth_getLogs', [{
    address: filter.address,
    topics: filter.topics,
    fromBlock: hexBlock(fromBlock),
    toBlock: hexBlock(toBlock),
  }], { fetchImpl: deps.fetchImpl || globalThis.fetch, signal, endpoints: deps.endpoints });
  if (!Array.isArray(result)) throw new Error('invalid eth_getLogs result');
  return result;
}

function progressFromRow(row) {
  if (!row) {
    return { scannedTo: null, head: null, complete: false, updatedAt: null, fromBlock: POD_CFG.transferFromBlock };
  }
  const scannedTo = Number(row.scanned_to);
  const head = row.head == null ? null : Number(row.head);
  return {
    scannedTo: Number.isSafeInteger(scannedTo) ? scannedTo : null,
    head: Number.isSafeInteger(head) ? head : null,
    complete: Number(row.complete) === 1,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    fromBlock: POD_CFG.transferFromBlock,
  };
}

/**
 * Scan the next <=15 Transfer-log chunks and advance bsc_index_state.
 * A failed chunk does not move the cursor past it. complete stays 0 until scanned_to >= head.
 */
export async function runBscIndex(db, opts = {}) {
  const chunkBlocks = Math.min(opts.chunkBlocks ?? BSC_INDEX_CHUNK_BLOCKS, BSC_INDEX_CHUNK_BLOCKS);
  const maxChunks = Math.min(opts.maxChunks ?? BSC_INDEX_MAX_CHUNKS, BSC_INDEX_MAX_CHUNKS);
  if (!Number.isSafeInteger(chunkBlocks) || chunkBlocks < 1) throw new Error('invalid bsc index chunk');
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) throw new Error('invalid bsc index chunk cap');
  const origin = Number.isSafeInteger(opts.fromBlock) ? opts.fromBlock : POD_CFG.transferFromBlock;
  const now = opts.now || (() => new Date());
  const updatedAt = now().toISOString();
  const signal = opts.signal;
  const getLogs = opts.getLogs || ((filter, fromBlock, toBlock, logSignal) => defaultBscGetLogs(filter, fromBlock, toBlock, logSignal, opts));
  const head = Number.isSafeInteger(opts.head) ? opts.head : await (opts.blockNumber || ((logSignal) => defaultBscHead(logSignal, opts)))(signal);
  if (!Number.isSafeInteger(head) || head < 0) throw new Error('invalid bsc head');

  const stored = await db.prepare('SELECT scanned_to, head, complete, updated_at FROM bsc_index_state WHERE id = 1').first();
  let scannedTo = stored ? Number(stored.scanned_to) : origin - 1;
  if (!Number.isSafeInteger(scannedTo)) scannedTo = origin - 1;
  // Once a backfill has been published, a later partial catch-up must not hide holders.
  const alreadyComplete = Number(stored?.complete) === 1;
  const start = scannedTo + 1;
  if (start > head) {
    if (scannedTo < origin) {
      return { scannedTo, head, complete: false, chunks: 0, backfilling: true, updatedAt, error: 'bsc head is before the index origin' };
    }
    await db.batch([stateStatement(db, scannedTo, head, true, updatedAt)]);
    return { scannedTo, head, complete: true, chunks: 0, backfilling: false, updatedAt };
  }

  const filter = opts.filter || bscTransferFilter();
  let chunks = 0;
  let error = null;
  for (let offset = 0; offset < maxChunks; offset++) {
    signal?.throwIfAborted();
    const lo = start + offset * chunkBlocks;
    if (lo > head) break;
    const hi = Math.min(lo + chunkBlocks - 1, head);
    let logs;
    try {
      logs = await getLogs(filter, lo, hi, signal);
      if (!Array.isArray(logs)) throw new Error('invalid eth_getLogs result');
    } catch (err) {
      error = err?.message || String(err);
      break;
    }
    const holders = finalHolders(logs, { fromBlock: lo, toBlock: hi });
    const caughtUp = hi >= head;
    await db.batch([
      ...holders.map((row) => holderStatement(db, row, updatedAt)),
      stateStatement(db, hi, head, caughtUp || alreadyComplete, updatedAt),
    ]);
    scannedTo = hi;
    chunks++;
    if (caughtUp) break;
  }
  const complete = scannedTo >= head;
  return { scannedTo, head, complete, chunks, backfilling: !complete, updatedAt, error };
}

export async function bscRigsForAddress(db, address) {
  const owner = String(address || '').toLowerCase();
  const row = await db.prepare('SELECT scanned_to, head, complete, updated_at FROM bsc_index_state WHERE id = 1').first();
  const progress = progressFromRow(row);
  if (!progress.complete) {
    return { building: true, message: BSC_INDEX_BUILDING, address: owner, rigs: [], progress };
  }
  const { results } = await db.prepare(
    'SELECT processor, token_id FROM bsc_nft_holders WHERE owner = ? AND owner != ?',
  ).bind(owner, ZERO_ADDRESS).all();
  const rigs = (results || []).map((item) => ({
    id: String(item.token_id),
    processor: String(item.processor).toLowerCase(),
    label: processorLabel(String(item.processor).toLowerCase()),
  })).filter((item) => ADDRESS.test(item.processor) && /^\d+$/.test(item.id));
  rigs.sort((a, b) => a.processor.localeCompare(b.processor) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return { building: false, message: null, address: owner, rigs, progress };
}
