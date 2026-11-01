// Official-market "cheaper than building" alerts. Unit cost reuses entryComparison
// (OKB per 1 FAB/day, dilution included). A listing is sent once per chat; after it
// leaves a complete scan it is closed and never sent again.

import { CFG, loadEntryComparison, snapshot } from '../desk.mjs';
import { flushDeliveries } from './delivery.mjs';
import { normalizeThreshold } from './bind.mjs';

export function officialRigUrl(id) {
  return `https://fabx.tech/c/${CFG.circuits}/${id}`;
}

const money = (n) => {
  const value = Math.round(Number(n) * 10000) / 10000;
  return Number.isFinite(value) ? value.toString() : '?';
};
const percent = (n) => String(Math.round(Number(n)));

export function formatCheapAlert(lang, deal) {
  const url = officialRigUrl(deal.id);
  if (lang === 'zh') {
    return `便宜矿机：电路 #${deal.id}（挂单 #${deal.listingId}）\n价格 ${money(deal.priceOkb)} OKB\n每天 1 FAB 要花 ${money(deal.okbPerFabDay)} OKB，自建要 ${money(deal.buildOkb)} OKB，便宜 ${percent(deal.discountPct)}%\n官方购买：${url}`;
  }
  return `Cheaper than building: circuit #${deal.id} (listing #${deal.listingId})\nPrice ${money(deal.priceOkb)} OKB\n1 FAB/day costs ${money(deal.okbPerFabDay)} OKB, building costs ${money(deal.buildOkb)} OKB, ${percent(deal.discountPct)}% cheaper\nOfficial buy link: ${url}`;
}

export function meetsThreshold(discountPct, threshold) {
  const n = normalizeThreshold(threshold);
  return n != null && typeof discountPct === 'number' && Number.isFinite(discountPct) && discountPct + 1e-9 >= n;
}

function activeRow(row) {
  const listingId = String(row?.listingId ?? '');
  const id = String(row?.id ?? '');
  if (!/^[1-9][0-9]*$/.test(listingId) || !/^[0-9]+$/.test(id)) return null;
  return { listingId, circuitId: id };
}

// complete + live only. Cached or partial scans must not look like a delisting.
export function cheapSnapshot(comparison) {
  if (!comparison || comparison.complete !== true) return { ok: false, reason: 'incomplete' };
  if (comparison.state != null && comparison.state !== 'live') return { ok: false, reason: 'not-live' };
  const build = comparison.baseline?.okbPerFabDay;
  if (!(typeof build === 'number' && Number.isFinite(build) && build > 0)) return { ok: false, reason: 'no-baseline' };
  const active = [];
  const seen = new Set();
  for (const row of [...(comparison.ranked || []), ...(comparison.unknown || [])]) {
    const item = activeRow(row);
    if (!item || seen.has(item.listingId)) continue;
    seen.add(item.listingId);
    active.push(item);
  }
  const ranked = [];
  const priced = [];
  for (const row of comparison.ranked || []) {
    const item = activeRow(row);
    const cost = row.okbPerFabDay;
    if (!item || !(typeof cost === 'number' && Number.isFinite(cost) && cost > 0) || !(row.priceOkb > 0)) continue;
    const discountPct = (build - cost) / build * 100;
    if (!Number.isFinite(discountPct)) continue;
    const deal = {
      listingId: item.listingId, id: item.circuitId, priceOkb: row.priceOkb,
      okbPerFabDay: cost, buildOkb: build, discountPct,
    };
    priced.push(deal);
    if (discountPct > 0) ranked.push(deal);
  }
  return { ok: true, active, ranked, priced, build };
}

export async function loadOfficialComparison(snap, opts = {}) {
  if (opts.comparison) return opts.comparison;
  if (opts.loadComparison) return opts.loadComparison(snap, opts);
  let full = snap;
  const networkNand = full?.network?.networkNand ?? full?.network?.weight;
  if (!(typeof networkNand === 'number' && networkNand > 0)) full = await snapshot({ storage: null, signal: opts.signal });
  return loadEntryComparison(full, { storage: null, timeoutMs: opts.timeoutMs ?? 50_000, signal: opts.signal });
}

async function batchAll(db, statements) {
  for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40));
}

// Listing ids are decimal, so cheap:9:* would also match cheap:99: and cheap:90:.
function cancelClosedListing(db, listingId, stamp) {
  const prefix = `cheap:${listingId}:`;
  return db.prepare(`UPDATE alert_deliveries SET status = 'cancelled', updated_at = ?, last_error = 'listing closed'
    WHERE scope = 'cheap' AND status IN ('pending', 'failed')
      AND substr(delivery_key, 1, length(?)) = ?
      AND instr(substr(delivery_key, length(?) + 1), ':') = 0`)
    .bind(stamp, prefix, prefix, prefix);
}

function queueCheapDelivery(db, { key, recipient, subscriber, payload, createdAt }) {
  // sent and unknown stay put. failed is rewritten: the next complete scan may have a new price.
  return db.prepare(`INSERT INTO alert_deliveries
      (delivery_key, scope, recipient, payload, status, created_at, updated_at, address, subscriber)
    VALUES (?, 'cheap', ?, ?, 'pending', ?, ?, NULL, ?)
    ON CONFLICT(delivery_key) DO UPDATE SET
      payload = excluded.payload,
      recipient = excluded.recipient,
      updated_at = excluded.updated_at,
      status = 'pending',
      attempts = 0,
      last_error = NULL
    WHERE alert_deliveries.status IN ('pending', 'cancelled', 'failed')`)
    .bind(key, String(recipient), payload, createdAt, createdAt, subscriber);
}

function cancelBelowThreshold(db, key, stamp) {
  return db.prepare(`UPDATE alert_deliveries SET status = 'cancelled', updated_at = ?, last_error = 'below threshold'
    WHERE delivery_key = ? AND scope = 'cheap' AND status IN ('pending', 'failed')`)
    .bind(stamp, key);
}

async function cancelDisabledCheap(db, stamp) {
  await db.prepare(`UPDATE alert_deliveries SET status = 'cancelled', updated_at = ?, last_error = 'cheap alerts off'
    WHERE scope = 'cheap' AND status IN ('pending', 'failed')
    AND NOT EXISTS (
      SELECT 1 FROM alert_cheap_subs s WHERE s.telegram = alert_deliveries.subscriber AND s.enabled = 1
    )`).bind(stamp).run();
}

export async function runCheapAlerts(env, opts = {}) {
  const db = env.DB;
  const now = opts.now || (() => new Date());
  const stamp = now().toISOString();
  const summary = { subscribers: 0, deals: 0, queued: 0, sent: 0, closed: 0, errors: [] };
  await cancelDisabledCheap(db, stamp);
  if (!opts.skipScan) {
    const { results: subs } = await db.prepare(`SELECT s.telegram AS telegram, s.threshold_pct AS threshold_pct, s.lang AS sub_lang,
      c.chat_id AS chat_id, c.lang AS chat_lang
      FROM alert_cheap_subs s JOIN alert_chats c ON c.telegram = s.telegram WHERE s.enabled = 1`).all();
    summary.subscribers = subs.length;
    if (subs.length) {
      let comparison = null;
      try { comparison = await loadOfficialComparison(opts.snap, opts); }
      catch (error) { summary.errors.push(`cheap scan: ${error.message}`); }
      const shot = comparison ? cheapSnapshot(comparison) : { ok: false, reason: 'unread' };
      if (comparison && !shot.ok) summary.errors.push(`cheap scan: ${shot.reason}`);
      if (shot.ok) {
        const { results: openRows } = await db.prepare('SELECT listing_id FROM alert_cheap_open').all();
        const { results: closedRows } = await db.prepare('SELECT listing_id FROM alert_cheap_closed').all();
        const open = new Set(openRows.map((row) => String(row.listing_id)));
        const closed = new Set(closedRows.map((row) => String(row.listing_id)));
        const active = new Map(shot.active.filter((row) => !closed.has(row.listingId)).map((row) => [row.listingId, row]));
        const closing = [...open].filter((id) => !active.has(id));
        const statements = [];
        for (const id of closing) {
          statements.push(db.prepare(`INSERT INTO alert_cheap_closed (listing_id, closed_at) VALUES (?, ?) ON CONFLICT(listing_id) DO NOTHING`).bind(id, stamp));
          statements.push(db.prepare('DELETE FROM alert_cheap_open WHERE listing_id = ?').bind(id));
          if (/^[1-9][0-9]*$/.test(id)) statements.push(cancelClosedListing(db, id, stamp));
        }
        for (const [id, row] of active) {
          if (open.has(id)) continue;
          statements.push(db.prepare(`INSERT INTO alert_cheap_open (listing_id, circuit_id, seen_at) VALUES (?, ?, ?)
            ON CONFLICT(listing_id) DO NOTHING`).bind(id, row.circuitId, stamp));
        }
        const wanted = new Set();
        let queued = 0;
        for (const chat of subs) {
          if (!Number.isSafeInteger(Number(chat.chat_id))) continue;
          for (const deal of shot.priced) {
            if (closed.has(deal.listingId)) continue;
            const key = `cheap:${deal.listingId}:${chat.chat_id}`;
            if (!meetsThreshold(deal.discountPct, chat.threshold_pct)) {
              statements.push(cancelBelowThreshold(db, key, stamp));
              continue;
            }
            wanted.add(deal.listingId);
            queued += 1;
            statements.push(queueCheapDelivery(db, {
              key,
              recipient: chat.chat_id,
              subscriber: chat.telegram,
              payload: formatCheapAlert(chat.chat_lang || chat.sub_lang, deal),
              createdAt: stamp,
            }));
          }
        }
        summary.deals = wanted.size;
        summary.queued = queued;
        summary.closed = closing.length;
        if (statements.length) await batchAll(db, statements);
      }
    }
  }
  if (opts.send) {
    const flushed = await flushDeliveries(db, { scope: 'cheap', send: opts.send, now });
    summary.sent += flushed.sent;
    summary.errors.push(...flushed.errors);
  }
  return summary;
}
