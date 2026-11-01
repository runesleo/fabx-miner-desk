// Daily network board for chats that turned on /daily.
// The Beijing day opens at 09:00. One delivery per chat per Beijing date.
// Failed rows retry through alert_deliveries; status unknown is never replayed.

import { boardUrl, buildDailyBoardText } from '../board.mjs';
import { flushDeliveries } from './delivery.mjs';
import { beijingParts } from './weekly.mjs';

export function beijingDayKey(now = new Date()) {
  const { year, month, day } = beijingParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isDailyBoardSlot(now = new Date()) {
  return beijingParts(now).hour >= 9;
}

function queueDailyDelivery(db, { key, recipient, subscriber, payload, createdAt }) {
  // sent and unknown stay put. cancelled and failed can be rewritten with today's text.
  return db.prepare(`INSERT INTO alert_deliveries
      (delivery_key, scope, recipient, payload, status, created_at, updated_at, address, subscriber)
    VALUES (?, 'daily', ?, ?, 'pending', ?, ?, NULL, ?)
    ON CONFLICT(delivery_key) DO UPDATE SET
      payload = excluded.payload,
      recipient = excluded.recipient,
      subscriber = excluded.subscriber,
      updated_at = excluded.updated_at,
      status = 'pending',
      attempts = 0,
      last_error = NULL
    WHERE alert_deliveries.status IN ('pending', 'cancelled', 'failed')`)
    .bind(key, String(recipient), payload, createdAt, createdAt, subscriber);
}

async function batchAll(db, statements) {
  for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40));
}

export async function runDailyBoard(env, opts = {}) {
  const db = env.DB;
  const now = opts.now || (() => new Date());
  const observed = now();
  const day = beijingDayKey(observed);
  const summary = { day, subscribers: 0, queued: 0, sent: 0, errors: [] };
  if (!isDailyBoardSlot(observed)) {
    summary.skipped = 'before_09:00';
    return summary;
  }
  const stamp = observed.toISOString();
  const prefix = `daily:${day}:`;
  await db.prepare(`UPDATE alert_deliveries SET status = 'cancelled', updated_at = ?, last_error = 'daily board day passed'
    WHERE scope = 'daily' AND status IN ('pending', 'failed') AND substr(delivery_key, 1, ?) != ?`)
    .bind(stamp, prefix.length, prefix).run();
  await db.prepare(`UPDATE alert_deliveries SET status = 'cancelled', updated_at = ?, last_error = 'daily board off'
    WHERE scope = 'daily' AND status IN ('pending', 'failed')
    AND NOT EXISTS (
      SELECT 1 FROM alert_daily_subs s
      JOIN alert_chats c ON c.telegram = s.telegram
      WHERE s.telegram = alert_deliveries.subscriber AND s.enabled = 1
        AND CAST(c.chat_id AS TEXT) = alert_deliveries.recipient
    )`).bind(stamp).run();

  const { results: subs } = await db.prepare(`SELECT s.telegram AS telegram, c.chat_id AS chat_id
    FROM alert_daily_subs s
    JOIN alert_chats c ON c.telegram = s.telegram
    WHERE s.enabled = 1`).all();
  const chats = subs.filter((row) => Number.isSafeInteger(Number(row.chat_id)));
  summary.subscribers = chats.length;
  const { results: existing } = await db.prepare(`SELECT delivery_key, status FROM alert_deliveries
    WHERE scope = 'daily' AND substr(delivery_key, 1, ?) = ?`).bind(prefix.length, prefix).all();
  const settled = new Set(existing
    .filter((row) => row.status === 'sent' || row.status === 'unknown')
    .map((row) => row.delivery_key));
  const needsText = chats.filter((row) => !settled.has(`${prefix}${Number(row.chat_id)}`));
  if (needsText.length) {
    let text = '';
    try {
      text = await buildDailyBoardText({
        loadBoard: opts.loadBoard,
        format: opts.formatDailyBoard,
        url: opts.boardUrl || boardUrl(env),
        env,
      });
    } catch (error) {
      summary.errors.push(`daily text: ${error.message}`);
      text = '';
    }
    if (String(text).trim()) {
      const statements = needsText.map((row) => queueDailyDelivery(db, {
        key: `${prefix}${Number(row.chat_id)}`,
        recipient: Number(row.chat_id),
        subscriber: row.telegram,
        payload: text,
        createdAt: stamp,
      }));
      summary.queued = statements.length;
      await batchAll(db, statements);
    }
  }
  if (opts.send) {
    const { results: pending } = await db.prepare(`SELECT delivery_key FROM alert_deliveries
      WHERE scope = 'daily' AND status IN ('pending', 'failed') AND substr(delivery_key, 1, ?) = ?`)
      .bind(prefix.length, prefix).all();
    const keys = pending.map((row) => row.delivery_key);
    if (keys.length) {
      const flushed = await flushDeliveries(db, { scope: 'daily', send: opts.send, now: () => observed, keys });
      summary.sent += flushed.sent;
      summary.errors.push(...flushed.errors);
    }
  }
  return summary;
}
