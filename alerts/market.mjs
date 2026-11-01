// Server-side FAB/BEM 24h median and range from incremental swap logs (alerts worker + GET /api/market).

import { CFG, fabInBemFromSwap, logsChunked, median } from '../desk.mjs';

export const MARKET_LOG_HEAD_KEY = 'market_log_head';
export const MAX_BLOCKS_PER_RUN = 15_000;
const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';

export function swapLogFilter() {
  return { address: CFG.poolManager, topics: [SWAP_TOPIC, CFG.poolId] };
}

export function estimateBlockTimestamp(blockNumber, head, headTimestamp, blockTime) {
  if (!Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(head) || !Number.isFinite(headTimestamp) || !(blockTime > 0)) return null;
  const ts = headTimestamp - (head - blockNumber) * blockTime;
  return Number.isFinite(ts) ? Math.round(ts) : null;
}

export function statsFromBemSeries(series) {
  if (!series.length) return null;
  const lowBem = series.reduce((a, b) => Math.min(a, b), Infinity);
  const highBem = series.reduce((a, b) => Math.max(a, b), -Infinity);
  const medianBem = median(series);
  if (medianBem == null || !(lowBem <= medianBem && medianBem <= highBem)) return null;
  return {
    medianBem,
    lowBem,
    highBem,
    lastSwapBem: series.at(-1),
    swaps24h: series.length,
  };
}

export function rowToMarketApi(row) {
  if (!row) return null;
  const medianBem = Number(row.median_bem);
  const lowBem = Number(row.low_bem);
  const highBem = Number(row.high_bem);
  const lastSwapBem = Number(row.last_swap_bem);
  const swaps24h = Number(row.swaps_24h);
  const head = Number(row.head);
  const computedAt = row.computed_at;
  if (![medianBem, lowBem, highBem, lastSwapBem].every(n => Number.isFinite(n) && n > 0)) return null;
  if (!Number.isSafeInteger(swaps24h) || swaps24h <= 0) return null;
  if (!Number.isSafeInteger(head) || head <= 0) return null;
  if (!computedAt || !Number.isFinite(Date.parse(computedAt))) return null;
  if (lowBem > medianBem || medianBem > highBem) return null;
  return { medianBem, lowBem, highBem, lastSwapBem, swaps24h, head, computedAt };
}

/** Incremental log scan, rolling 24h window, snapshot row id=1 in market_fab_24h. */
export async function runMarketUpdate(db, snap, opts = {}) {
  const readLogs = opts.logsChunked || logsChunked;
  const now = opts.now || (() => new Date());
  const computedAt = now().toISOString();
  const dayBlocks = Math.round(86400 / snap.blockTime);
  const windowStartTs = snap.headTimestamp - 86400;

  const headRow = await db.prepare("SELECT value FROM alert_worker_state WHERE key = ?").bind(MARKET_LOG_HEAD_KEY).first('value');
  let fromBlock = headRow != null ? Number(headRow) + 1 : Math.max(0, snap.head - dayBlocks);
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) fromBlock = Math.max(0, snap.head - dayBlocks);

  // Workers allow ~50 subrequests per invocation and log reads go 1,000 blocks at a time, so a cold
  // 24h backfill (~87 chunks) is spread over several cron runs; the head below records progress.
  const toBlock = Math.min(snap.head, fromBlock + (opts.maxBlocksPerRun ?? MAX_BLOCKS_PER_RUN) - 1);
  const statements = [];
  if (fromBlock <= toBlock) {
    const logs = await readLogs(swapLogFilter(), fromBlock, toBlock, opts.signal);
    logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
    for (const log of logs) {
      const blockNumber = Number(log.blockNumber);
      const logIndex = Number(log.logIndex);
      if (!Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(logIndex)) continue;
      const blockTs = estimateBlockTimestamp(blockNumber, snap.head, snap.headTimestamp, snap.blockTime);
      if (blockTs == null) continue;
      const bemPerFab = fabInBemFromSwap(log);
      if (!(bemPerFab > 0) || !Number.isFinite(bemPerFab)) continue;
      statements.push(db.prepare(`INSERT INTO market_swap_samples (block_number, log_index, bem_per_fab, block_ts)
        VALUES (?, ?, ?, ?) ON CONFLICT(block_number, log_index) DO NOTHING`)
        .bind(blockNumber, logIndex, bemPerFab, blockTs));
    }
  }

  statements.push(db.prepare('DELETE FROM market_swap_samples WHERE block_ts < ?').bind(windowStartTs));

  if (statements.length) await db.batch(statements);

  const { results: sampleRows } = await db.prepare(
    'SELECT bem_per_fab FROM market_swap_samples WHERE block_ts >= ? ORDER BY block_number ASC, log_index ASC',
  ).bind(windowStartTs).all();

  const series = (sampleRows || []).map(row => Number(row.bem_per_fab)).filter(n => Number.isFinite(n) && n > 0);
  const stats = statsFromBemSeries(series);

  // A half-finished backfill covers only part of the 24h window; publish nothing until it catches up.
  if (stats && toBlock >= snap.head) {
    await db.prepare(`INSERT INTO market_fab_24h (id, median_bem, low_bem, high_bem, last_swap_bem, swaps_24h, head, computed_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET median_bem = excluded.median_bem, low_bem = excluded.low_bem, high_bem = excluded.high_bem,
      last_swap_bem = excluded.last_swap_bem, swaps_24h = excluded.swaps_24h, head = excluded.head, computed_at = excluded.computed_at`)
      .bind(stats.medianBem, stats.lowBem, stats.highBem, stats.lastSwapBem, stats.swaps24h, snap.head, computedAt).run();
  }

  await db.prepare(`INSERT INTO alert_worker_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(alert_worker_state.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`)
    .bind(MARKET_LOG_HEAD_KEY, String(toBlock)).run();

  const backfilling = toBlock < snap.head;
  return stats ? { ...stats, head: toBlock, backfilling, computedAt } : { swaps24h: 0, head: toBlock, backfilling, computedAt };
}
