import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1.mjs';
import { queueDelivery, flushDeliveries } from '../alerts/delivery.mjs';

const now = () => new Date('2026-10-22T10:00:00Z');
const queued = (db, recipient, extra = {}) => queueDelivery(db, {
  key: `rig:1:${recipient}`, scope: 'rig', recipient, payload: 'Stopped #1', createdAt: now().toISOString(), ...extra,
});

test('outbox retries explicit rejection per recipient and never resends acknowledged sends', async () => {
  const db = d1();
  await db.batch([queued(db, 1), queued(db, 2)]);
  const attempts = [];
  const send = async recipient => {
    attempts.push(recipient);
    return attempts.length === 1 ? { status: 'failed', error: 'rejected' } : { message_id: attempts.length };
  };
  assert.equal((await flushDeliveries(db, { scope: 'rig', send, now })).sent, 1);
  assert.equal((await flushDeliveries(db, { scope: 'rig', send, now })).sent, 1);
  await flushDeliveries(db, { scope: 'rig', send, now });
  assert.deepEqual(attempts, ['1', '2', '1']);
  assert.deepEqual(db.rows('alert_deliveries').map(r => [r.status, r.attempts]), [['sent', 2], ['sent', 1]]);
});

test('timeouts, malformed acknowledgements and interrupted claims stay unknown without blind resend', async () => {
  const db = d1();
  await db.batch([queued(db, 1), queued(db, 2), queued(db, 3)]);
  await db.prepare("UPDATE alert_deliveries SET status = 'unknown' WHERE recipient = '3'").run();
  let attempts = 0;
  const send = async recipient => { attempts++; if (recipient === '1') throw new Error('timeout'); return {}; };
  assert.equal((await flushDeliveries(db, { scope: 'rig', send, now })).unknown, 2);
  await flushDeliveries(db, { scope: 'rig', send, now });
  assert.equal(attempts, 2);
  assert.ok(db.rows('alert_deliveries').every(r => r.status === 'unknown'));
});

test('delivery enqueue failure rolls state and event writes back atomically', async () => {
  const db = d1();
  const writeState = db.prepare("INSERT INTO alert_worker_state (key,value) VALUES ('baseline','advanced')");
  const invalidQueue = queued(db, 1, { scope: null });
  await assert.rejects(db.batch([writeState, invalidQueue]));
  assert.equal(db.rows('alert_worker_state').length, 0);
});

test('outbox cancels stale subscription and changed chat recipients before send', async () => {
  const db = d1();
  await db.batch([queued(db, 1, { subscriber: 'removed', address: '0x1' })]);
  const result = await flushDeliveries(db, { scope: 'rig', send: async () => { throw new Error('must not send'); }, now });
  assert.equal(result.cancelled, 1);
  assert.equal(db.rows('alert_deliveries')[0].status, 'cancelled');
});

test('receipt persistence failure stays unknown and does not prevent the next recipient', async () => {
  const db = d1();
  await db.batch([queued(db, 1), queued(db, 2)]);
  const original = db.prepare;
  let failReceipt = true;
  db.prepare = sql => {
    if (sql.startsWith('UPDATE alert_deliveries SET status = ?,') && failReceipt) {
      failReceipt = false;
      return { bind() { return { async run() { throw new Error('receipt storage unavailable'); } }; } };
    }
    return original(sql);
  };
  const result = await flushDeliveries(db, { scope: 'rig', send: async () => ({ message_id: 1 }), now });
  assert.equal(result.unknown, 1);
  assert.equal(result.sent, 1);
  assert.deepEqual(db.rows('alert_deliveries').map(r => r.status), ['unknown', 'sent']);
});

test('concurrent flushes claim each recipient once even when the first send is rejected', async () => {
  const db = d1();
  await db.batch([queued(db, 1), queued(db, 2)]);
  const attempts = [];
  const send = async recipient => { attempts.push(recipient); return recipient === '1' ? { status: 'failed' } : { message_id: 2 }; };
  await Promise.all([flushDeliveries(db, { scope: 'rig', send, now }), flushDeliveries(db, { scope: 'rig', send, now })]);
  assert.deepEqual(attempts.sort(), ['1', '2']);
  assert.deepEqual(db.rows('alert_deliveries').map(r => r.attempts), [1, 1]);
});

test('a thrown non-Error is unknown and does not prevent the next recipient', async () => {
  const db = d1();
  await db.batch([queued(db, 1), queued(db, 2)]);
  const result = await flushDeliveries(db, { scope: 'rig', now, send: async recipient => {
    if (recipient === '1') throw null;
    return { message_id: 2 };
  } });
  assert.equal(result.unknown, 1);
  assert.equal(result.sent, 1);
});
