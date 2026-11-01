#!/usr/bin/env node
// Weekly usage metrics from D1 (read-only SELECT via wrangler). No fabricated numbers on failure.
// Usage: node scripts/weekly-metrics.mjs [--db <name>] [--json-only]
// Prints JSON, then a blank line, then a Chinese Markdown table (unless --json-only).

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB = 'fabx-miner-desk';
const WRANGLER = process.env.WRANGLER_BIN || 'wrangler';

export const QUERIES = {
  hits: 'SELECT day, cid FROM hits',
  alertSignups: 'SELECT created_at FROM alert_signups',
  alertChats: 'SELECT created_at FROM alert_chats',
  feedback: 'SELECT created_at FROM feedback',
};

export function parseArgs(argv) {
  const out = { db: DEFAULT_DB, jsonOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json-only') out.jsonOnly = true;
    else if (argv[i] === '--db') out.db = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out.db) throw new Error('--db needs a value');
  return out;
}

/** UTC Monday (YYYY-MM-DD) for an ISO day or datetime string. */
export function weekStartUtc(iso) {
  const day = String(iso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid day ${iso}`);
  const d = new Date(`${day}T00:00:00.000Z`);
  const diff = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

export function weekEndUtc(weekStart) {
  const d = new Date(`${weekStart}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

function dayFromTimestamp(iso) {
  const s = String(iso);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`invalid timestamp ${iso}`);
  return new Date(t).toISOString().slice(0, 10);
}

export function aggregateHits(rows) {
  const visits = new Map();
  const cidDays = new Map(); // weekStart -> Map(cid -> Set(day))
  for (const row of rows) {
    const week = weekStartUtc(row.day);
    visits.set(week, (visits.get(week) || 0) + 1);
    if (!cidDays.has(week)) cidDays.set(week, new Map());
    const perCid = cidDays.get(week);
    if (!perCid.has(row.cid)) perCid.set(row.cid, new Set());
    perCid.get(row.cid).add(row.day);
  }
  const weeks = new Set([...visits.keys(), ...cidDays.keys()]);
  const out = [];
  for (const weekStart of [...weeks].sort()) {
    const dayMap = cidDays.get(weekStart) || new Map();
    const uniqueVisitors = dayMap.size;
    let returnVisitors = 0;
    for (const days of dayMap.values()) if (days.size >= 2) returnVisitors++;
    out.push({
      weekStart,
      weekEnd: weekEndUtc(weekStart),
      visits: visits.get(weekStart) || 0,
      uniqueVisitors,
      returnVisitors,
      alertSignups: 0,
      alertChats: 0,
      feedback: 0,
    });
  }
  return out;
}

export function mergeWeeklyCounts(weeks, rows, field, dayKey = 'created_at') {
  const index = new Map(weeks.map((w, i) => [w.weekStart, i]));
  const list = [...weeks];
  for (const row of rows) {
    const week = weekStartUtc(dayFromTimestamp(row[dayKey]));
    if (!index.has(week)) {
      index.set(week, list.length);
      list.push({
        weekStart: week,
        weekEnd: weekEndUtc(week),
        visits: 0,
        uniqueVisitors: 0,
        returnVisitors: 0,
        alertSignups: 0,
        alertChats: 0,
        feedback: 0,
      });
    }
    list[index.get(week)][field]++;
  }
  return list.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export function buildWeeklyMetrics({ hits = [], alertSignups = [], alertChats = [], feedback = [] }) {
  let weeks = aggregateHits(hits);
  weeks = mergeWeeklyCounts(weeks, alertSignups, 'alertSignups');
  weeks = mergeWeeklyCounts(weeks, alertChats, 'alertChats');
  weeks = mergeWeeklyCounts(weeks, feedback, 'feedback');
  return { generatedAt: new Date().toISOString(), weeks };
}

export function formatMarkdownTable(report) {
  const lines = [
    '## FabX Miner Desk 每周指标',
    '',
    `生成时间（UTC）：${report.generatedAt}`,
    '',
    '| 周（UTC 周一至周日） | 访问次数 | 独立访客 | 回访人数 | 提醒订阅 | Bot 已连聊 | 反馈 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const w of report.weeks) {
    lines.push(`| ${w.weekStart} ~ ${w.weekEnd} | ${w.visits} | ${w.uniqueVisitors} | ${w.returnVisitors} | ${w.alertSignups} | ${w.alertChats} | ${w.feedback} |`);
  }
  if (!report.weeks.length) lines.push('| （暂无数据） | 0 | 0 | 0 | 0 | 0 | 0 |');
  lines.push('', '说明：回访人数 = 该周内同一浏览器 ID 在 **2 个及以上不同 UTC 日** 有访问记录的去重人数。');
  return lines.join('\n');
}

export function parseWranglerJson(stdout) {
  const payload = JSON.parse(stdout);
  const first = payload[0];
  if (!first?.results) throw new Error('wrangler JSON missing results');
  return first.results;
}

export function d1Query(db, sql, { wrangler = WRANGLER, cwd = REPO } = {}) {
  const res = spawnSync(wrangler, ['d1', 'execute', db, '--remote', '--json', '--command', sql], {
    cwd, encoding: 'utf8', timeout: 120_000,
  });
  if (res.status !== 0) {
    throw new Error(`wrangler d1 execute failed: ${(res.stderr || res.stdout || '').trim().slice(-500)}`);
  }
  return parseWranglerJson(res.stdout);
}

export function fetchAllTables(db, deps = {}) {
  const q = deps.d1Query || ((sql) => d1Query(db, sql, deps));
  return {
    hits: q(QUERIES.hits),
    alertSignups: q(QUERIES.alertSignups),
    alertChats: q(QUERIES.alertChats),
    feedback: q(QUERIES.feedback),
  };
}

export function runWeeklyMetrics(db, deps = {}) {
  const tables = fetchAllTables(db, deps);
  return buildWeeklyMetrics(tables);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = runWeeklyMetrics(args.db);
    const json = JSON.stringify(report, null, 2);
    if (args.jsonOnly) console.log(json);
    else console.log(`${json}\n\n${formatMarkdownTable(report)}`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
