import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, weekStartUtc, weekEndUtc, aggregateHits, mergeWeeklyCounts,
  buildWeeklyMetrics, formatMarkdownTable, parseWranglerJson,
} from '../scripts/weekly-metrics.mjs';

test('weekly-metrics: UTC week boundaries and hit aggregation', () => {
  assert.deepEqual(parseArgs(['--db', 'x', '--json-only']), { db: 'x', jsonOnly: true });
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.equal(weekStartUtc('2026-10-15'), '2026-10-12'); // Thu -> Mon
  assert.equal(weekEndUtc('2026-10-13'), '2026-10-19');
  const weeks = aggregateHits([
    { day: '2026-10-13', cid: 'a' },
    { day: '2026-10-13', cid: 'b' },
    { day: '2026-10-14', cid: 'a' },
    { day: '2026-10-20', cid: 'c' },
  ]);
  assert.equal(weeks.length, 2);
  const w1 = weeks.find(w => w.weekStart === '2026-10-12');
  assert.equal(w1.visits, 3);
  assert.equal(w1.uniqueVisitors, 2);
  assert.equal(w1.returnVisitors, 1, 'cid a visited two days');
  const w2 = weeks.find(w => w.weekStart === '2026-10-19');
  assert.equal(w2.visits, 1);
  assert.equal(w2.returnVisitors, 0);
});

test('weekly-metrics: merges signup, chat and feedback counts by week', () => {
  const report = buildWeeklyMetrics({
    hits: [{ day: '2026-10-14', cid: 'x' }],
    alertSignups: [{ created_at: '2026-10-15T12:00:00.000Z' }],
    alertChats: [{ created_at: '2026-10-16T01:00:00.000Z' }],
    feedback: [{ created_at: '2026-10-21T08:00:00.000Z' }],
  });
  assert.equal(report.weeks.length, 2);
  const oct12 = report.weeks.find(w => w.weekStart === '2026-10-12');
  assert.equal(oct12.alertSignups, 1);
  assert.equal(oct12.alertChats, 1);
  assert.equal(oct12.feedback, 0);
  const oct19 = report.weeks.find(w => w.weekStart === '2026-10-19');
  assert.equal(oct19.feedback, 1);
  assert.match(formatMarkdownTable(report), /提醒订阅/);
});

test('weekly-metrics: wrangler JSON envelope', () => {
  const rows = parseWranglerJson(JSON.stringify([{ results: [{ day: '2026-10-01', cid: 'z' }] }]));
  assert.deepEqual(rows, [{ day: '2026-10-01', cid: 'z' }]);
  assert.throws(() => parseWranglerJson('[]'), /missing results/);
  const merged = mergeWeeklyCounts([], [{ created_at: '2026-10-01' }], 'feedback');
  assert.equal(merged[0].feedback, 1);
});
