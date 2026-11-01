// Durable per-recipient outbox. Enqueue together with detection/baseline writes
// in D1.batch(); sending is a separate operation, never part of event detection.
export function queueDelivery(db, { key, scope, recipient, payload, createdAt, address = null, subscriber = null, guard = null }) {
  return db.prepare(`INSERT INTO alert_deliveries
    (delivery_key, scope, recipient, payload, status, created_at, updated_at, address, subscriber)
    SELECT ?, ?, ?, ?, 'pending', ?, ?, ?, ?
    WHERE ${guard ? 'COALESCE((SELECT revision FROM alert_address_state WHERE address = ?), 0) = ?' : '1'}
    ON CONFLICT(delivery_key) DO NOTHING`)
    .bind(key, scope, String(recipient), payload, createdAt, createdAt, address, subscriber,
      ...(guard ? [guard.address, guard.revision] : []));
}

function outcome(result) {
  if (result?.status === 'failed') return { status: 'failed', error: result.error || 'send rejected' };
  if (result?.status === 'unknown') return { status: 'unknown', error: result.error || 'send outcome unknown' };
  if (result?.status === 'sent') return { status: 'sent', receipt: result.receipt ?? null };
  if (Number.isSafeInteger(result?.message_id) && result.message_id > 0) return { status: 'sent', receipt: result };
  return { status: 'unknown', error: 'missing delivery acknowledgement' };
}

export async function flushDeliveries(db, { scope, send, now = () => new Date(), keys } = {}) {
  const summary = { sent: 0, failed: 0, unknown: 0, cancelled: 0, errors: [] };
  const { results } = await db.prepare(`SELECT * FROM alert_deliveries
    WHERE scope = ? AND status IN ('pending', 'failed') ORDER BY created_at, delivery_key`).bind(scope).all();
  const allowed = keys ? new Set(keys) : null;
  for (const row of results) {
    if (allowed && !allowed.has(row.delivery_key)) continue;
    const stamp = now().toISOString();
    if (row.subscriber) {
      const active = await db.prepare(`SELECT 1 FROM alert_chats c WHERE c.telegram = ? AND CAST(c.chat_id AS TEXT) = ?
        AND (? IS NULL OR EXISTS (SELECT 1 FROM alert_signups s WHERE s.telegram = c.telegram AND s.address = ?))`)
        .bind(row.subscriber, row.recipient, row.address, row.address).first();
      if (!active) {
        await db.prepare("UPDATE alert_deliveries SET status = 'cancelled', updated_at = ?, last_error = 'subscription or chat changed' WHERE delivery_key = ? AND status IN ('pending', 'failed')")
          .bind(stamp, row.delivery_key).run();
        summary.cancelled++;
        continue;
      }
    }
    // Claim as unknown BEFORE network I/O. A crash after claim or after an actual
    // send leaves an explicit unknown, which must be reconciled, never replayed.
    const claim = await db.prepare(`UPDATE alert_deliveries SET status = 'unknown', attempts = attempts + 1,
      updated_at = ?, last_error = 'send started; acknowledgement pending'
      WHERE delivery_key = ? AND status IN ('pending', 'failed') AND attempts = ?`).bind(stamp, row.delivery_key, row.attempts).run();
    if (!claim.meta?.changes) continue;
    let result;
    try { result = outcome(await send(row.recipient, row.payload)); }
    catch (error) {
      result = { status: error?.deliveryStatus === 'failed' ? 'failed' : 'unknown', error: String(error?.message || error) };
    }
    try {
      await db.prepare('UPDATE alert_deliveries SET status = ?, updated_at = ?, receipt = ?, last_error = ? WHERE delivery_key = ?')
        .bind(result.status, stamp, result.receipt == null ? null : JSON.stringify(result.receipt), result.error || null, row.delivery_key).run();
    } catch (error) {
      // The persisted claim remains unknown if receipt persistence fails.
      result = { status: 'unknown', error: `delivery receipt not saved: ${error.message}` };
    }
    summary[result.status]++;
    if (result.error) summary.errors.push(`${scope} → ${row.recipient} [${result.status}]: ${result.error}`);
  }
  return summary;
}
