import { buildAssetUrl, shortAddress, siteUrlFromEnv } from '../share.mjs';
import { queueDelivery, flushDeliveries } from './delivery.mjs';

const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;
const BEIJING_OFFSET_MS = 8 * MS_HOUR;

export function beijingParts(now = new Date()) {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    dow: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** ISO week key (Monday-based) in Beijing local calendar date. */
export function beijingWeekKey(now = new Date()) {
  const { year, month, day } = beijingParts(now);
  const utc = Date.UTC(year, month - 1, day);
  const d = new Date(utc);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / MS_DAY) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Start Monday 10:00 Beijing; subsequent rounds that day can retry explicit failures.
export function isWeeklyDigestSlot(now = new Date()) {
  const { dow, hour } = beijingParts(now);
  return dow === 1 && hour >= 10;
}

export function weekFabStats(walletRes, address = walletRes?.address) {
  // alertMeasure can append previously tracked rigs that have left this wallet.
  // A missing enriched owner is allowed: discovery already checked ownerOf.
  const rigs = (Array.isArray(walletRes?.rigs) ? walletRes.rigs : []).filter(r => r
    && r.measureStatus !== 'gone'
    && !(address && r.owner && r.owner.toLowerCase() !== address.toLowerCase()));
  const discovery = walletRes?.discovery;
  const holdingKnown = rigs.length;
  const holdingTotal = Number.isSafeInteger(discovery?.expected) && discovery.expected >= 0 ? discovery.expected : null;
  const holdingComplete = discovery?.complete === true && holdingTotal != null
    && discovery.verified === holdingTotal && holdingKnown === holdingTotal;
  const measured = rigs.filter(r => ['mining', 'stopped'].includes(r.measureStatus)
    && Number.isFinite(r.fabPerDay) && r.fabPerDay >= 0);
  const mining = measured.filter(r => r.measureStatus === 'mining');
  const total = measured.reduce((sum, r) => sum + r.fabPerDay, 0);
  const complete = holdingComplete && measured.length === holdingTotal && Number.isFinite(total);
  return {
    holdingKnown, holdingTotal, holdingComplete, measuredCount: measured.length, complete,
    miningCount: complete || mining.length ? mining.length : null,
    fabTotal: Number.isFinite(total) && (measured.length || complete) ? total : null,
  };
}

export function formatWeeklyDigest(lang, address, stats, { prevFab, eventCount, siteUrl }) {
  const t = lang === 'zh' ? {
    header: (a) => `📊 矿机周报 · ${a}`,
    line: (n, fab) => `${n == null ? '在挖台数未知' : `${stats.complete ? '在挖' : '已测在挖'} ${n} 台`} · ${stats.complete ? '实测日产合计' : '已测日产小计'} ${fab == null ? '未读' : `${fab} FAB`}`,
    coverage: (held, measured) => `持有覆盖 ${held} · 测产覆盖 ${measured}${stats.complete ? '' : '（数据不完整）'}`,
    delta: (pct) => `（较上周 ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%）`,
    events: (n) => `过去 7 天链上收益异动 ${n} 条（已登记提醒）`,
    link: (url) => `查看资产卡：${url}`,
  } : {
    header: (a) => `📊 Weekly rig digest · ${a}`,
    line: (n, fab) => `${n == null ? 'Mining rig count unknown' : `${stats.complete ? '' : 'Measured: '}${n} rig${n === 1 ? '' : 's'} mining`} · measured ${fab == null ? 'unknown' : `${fab} FAB/day`} ${stats.complete ? 'total' : 'subtotal'}`,
    coverage: (held, measured) => `Holding coverage ${held} · measurement coverage ${measured}${stats.complete ? '' : ' (incomplete data)'}`,
    delta: (pct) => ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs last week)`,
    events: (n) => `${n} income alert event${n === 1 ? '' : 's'} in the past 7 days`,
    link: (url) => `Asset card: ${url}`,
  };
  const lines = [t.header(shortAddress(address)), t.line(stats.miningCount, stats.fabTotal == null ? null : Math.round(stats.fabTotal * 1000) / 1000)];
  if (stats.complete && Number.isFinite(stats.fabTotal) && Number.isFinite(prevFab) && prevFab > 0) {
    const pct = ((stats.fabTotal - prevFab) / prevFab) * 100;
    if (Math.abs(pct) >= 0.05) lines[1] += t.delta(pct);
  }
  const coverage = count => `${count}/${stats.holdingTotal ?? '?'}${stats.holdingTotal > 0
    ? ` (${(count / stats.holdingTotal * 100).toFixed(1)}%)` : stats.holdingComplete ? ' (100%)' : ''}`;
  lines.push(t.coverage(coverage(stats.holdingKnown), coverage(stats.measuredCount)));
  lines.push(t.events(eventCount));
  lines.push(t.link(buildAssetUrl(siteUrl, { address, chain: 'fabx' })));
  return lines.join('\n');
}

export async function runWeeklyDigest(env, opts = {}) {
  const db = env.DB;
  const now = opts.now || (() => new Date());
  const observed = now();
  const observedAt = observed.toISOString();
  const send = opts.send;
  const measure = opts.measure;
  const siteUrl = siteUrlFromEnv(env);
  const summary = { sent: 0, failed: 0, unknown: 0, cancelled: 0, skipped: 0, errors: [] };
  if (!isWeeklyDigestSlot(observed)) return summary;
  const weekKey = beijingWeekKey(observed);
  const previousWeek = beijingWeekKey(new Date(observed.getTime() - 7 * MS_DAY));
  const weekStart = new Date(observed.getTime() - 7 * MS_DAY).toISOString();
  const scope = `weekly:${weekKey}`;
  const snap = opts.snap;
  const { results: rows } = await db.prepare(`SELECT DISTINCT s.address AS address, s.telegram AS telegram,
      COALESCE(c.lang, s.lang) AS lang, c.chat_id AS chat_id
    FROM alert_signups s
    INNER JOIN alert_chats c ON c.telegram = s.telegram
    WHERE c.chat_id IS NOT NULL AND s.chain = 'xlayer'`).all();
  for (const row of rows) {
    const address = row.address.toLowerCase();
    const key = `weekly:${address}:${weekKey}:${row.chat_id}`;
    try {
      const delivery = await db.prepare('SELECT status FROM alert_deliveries WHERE delivery_key = ?').bind(key).first();
      if (delivery) { summary.skipped++; continue; }
      let report = await db.prepare('SELECT * FROM alert_weekly_reports WHERE address = ? AND week_key = ?')
        .bind(address, weekKey).first();
      if (!report) {
        const stats = weekFabStats(await measure(address, snap, []), address);
        const prev = await db.prepare('SELECT * FROM alert_weekly_snapshots WHERE address = ?').bind(address).first();
        const prevFab = stats.complete && prev?.complete === 1 && prev.week_key === previousWeek ? prev.fab_total : null;
        const eventCount = Number(await db.prepare(`SELECT COUNT(*) AS n FROM alert_events WHERE address = ? AND created_at >= ? AND created_at <= ?`)
          .bind(address, weekStart, observedAt).first('n')) || 0;
        // Freeze once, then read back the winner if concurrent rounds race. Every
        // recipient compares the same two observations even after the baseline moves.
        await db.prepare(`INSERT OR IGNORE INTO alert_weekly_reports (address, week_key, stats_json, prev_fab, event_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(address, weekKey, JSON.stringify(stats), prevFab, eventCount, observedAt).run();
        report = await db.prepare('SELECT * FROM alert_weekly_reports WHERE address = ? AND week_key = ?')
          .bind(address, weekKey).first();
      }
      const stats = JSON.parse(report.stats_json);
      const text = formatWeeklyDigest(row.lang, address, stats, { prevFab: report.prev_fab, eventCount: report.event_count, siteUrl });
      const statements = [queueDelivery(db, { key, scope, recipient: row.chat_id, payload: text,
        createdAt: observedAt, address, subscriber: row.telegram })];
      if (stats.complete) {
        statements.push(db.prepare(`INSERT INTO alert_weekly_snapshots (address, week_key, mining_count, fab_total, updated_at, complete)
          VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(address) DO UPDATE SET week_key = excluded.week_key,
          mining_count = excluded.mining_count, fab_total = excluded.fab_total, updated_at = excluded.updated_at,
          complete = 1 WHERE alert_weekly_snapshots.week_key <= excluded.week_key`)
          .bind(address, weekKey, stats.miningCount, stats.fabTotal, report.created_at));
      }
      await db.batch(statements);
    } catch (error) {
      summary.errors.push(`${shortAddress(address)} → ${row.telegram} weekly: ${error.message}`);
    }
  }
  // One flush per run: a failure is eligible on the next round, never twice here.
  const delivery = await flushDeliveries(db, { scope, send, now });
  for (const field of ['sent', 'failed', 'unknown', 'cancelled']) summary[field] += delivery[field];
  summary.errors.push(...delivery.errors);
  return summary;
}
