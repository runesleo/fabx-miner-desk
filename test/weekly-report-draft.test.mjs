import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildReportMarkdown, buildWeeklyReportDraft } from '../scripts/weekly-report-draft.mjs';

const snap = {
  asOf: '2026-10-21T10:00:00.000Z',
  head: 73_900_000,
  headTimestamp: 1_760_000_000,
  blockTime: 2,
  prices: { fabUsd: 0.12, okbUsd: 180, fabBem: 0.01, bemUsd: 12 },
  network: { weight: 4_000_000, miners: 6100, networkNand: 6666, fabPerNandDay: 1.05, usdPerNandDay: 0.126 },
  decision: { nandOkb: 0.5, okbPerFabDay: 0.48, paybackDays: 714, nandSource: 'test' },
  availability: { nand: { state: 'live', asOf: '2026-10-21T09:55:00.000Z' } },
};

const entry = {
  complete: true,
  state: 'live',
  head: 73_900_000,
  asOf: '2026-10-21T10:00:00.000Z',
  totalScanned: 12,
  ranked: [{ listingId: '3', id: '101', fabPerDay: 8, priceOkb: 2, okbPerFabDay: 0.25, status: 'measured' }],
  baseline: { okbPerFabDay: 0.48, nandAsOf: '2026-10-21T09:55:00.000Z' },
  cheaper: 'listing',
  deltaPct: 47.9,
};

test('weekly-report-draft: markdown cites block numbers and verified mechanism bullets', () => {
  assert.deepEqual(parseArgs([]), { out: null });
  const md = buildReportMarkdown({
    snap, entry, growth: { measured: true, daily: 0.01 }, generatedAt: '2026-10-21T10:05:00.000Z',
  });
  assert.match(md, /73900000/);
  assert.match(md, /6,100/);
  assert.match(md, /0\.25 OKB/);
  assert.match(md, /99%/);
  assert.match(md, /pendingWithDeweb/);
  assert.doesNotMatch(md, /推断/);
});

test('weekly-report-draft: injectable loaders for offline draft', async () => {
  const md = await buildWeeklyReportDraft({
    snapshot: async () => snap,
    refreshOptional: async s => s,
    networkGrowth: async () => ({ measured: false, daily: 0 }),
    loadEntryComparison: async () => entry,
  });
  assert.match(md, /未能从 RPC 读出历史状态/);
  assert.match(md, /买机更便宜/);
});
