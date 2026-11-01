import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1.mjs';
import { beijingWeekKey, isWeeklyDigestSlot, weekFabStats, formatWeeklyDigest, runWeeklyDigest } from '../alerts/weekly.mjs';

const ADDR = '0xe0cb3d9542a786c60605dd55efb9ef79490a3d6c';
const SNAP = { head: 1 };
const MONDAY = () => new Date('2026-10-19T02:15:00.000Z');
const completeWallet = (fab = 5) => ({ address: ADDR, discovery: { expected: 1, verified: 1, complete: true },
  rigs: [{ id: '1', owner: ADDR, measureStatus: 'mining', fabPerDay: fab }] });
async function signup(db, telegram = 'leo', chat = 1) {
  await db.prepare(`INSERT INTO alert_signups (address, telegram, lang, created_at, updated_at) VALUES (?, ?, 'zh', 't', 't')`).bind(ADDR, telegram).run();
  await db.prepare(`INSERT INTO alert_chats (telegram, chat_id, lang, created_at, updated_at) VALUES (?, ?, 'zh', 't', 't')`).bind(telegram, chat).run();
}
async function baseline(db, week = '2026-W42', complete = 1) {
  await db.prepare(`INSERT INTO alert_weekly_snapshots (address, week_key, mining_count, fab_total, updated_at, complete)
    VALUES (?, ?, 10, 10, 'previous', ?)`).bind(ADDR, week, complete).run();
}
const environment = db => ({ DB: db, SITE_URL: 'https://example.test/' });

test('weekly digest remains eligible for subsequent Monday retry rounds', () => {
  const mon = new Date('2026-10-19T02:15:00.000Z');
  assert.equal(isWeeklyDigestSlot(mon), true);
  assert.equal(isWeeklyDigestSlot(new Date('2026-10-19T03:00:00.000Z')), true);
  assert.equal(isWeeklyDigestSlot(new Date('2026-10-19T15:59:59.000Z')), true);
  assert.equal(isWeeklyDigestSlot(new Date('2026-10-19T01:59:59.000Z')), false);
  assert.equal(isWeeklyDigestSlot(new Date('2026-10-19T16:00:00.000Z')), false);
});

test('weekFabStats sums mining rigs only', () => {
  const stats = weekFabStats({ rigs: [
    { measureStatus: 'mining', fabPerDay: 10 },
    { measureStatus: 'stopped', fabPerDay: 0 },
    { measureStatus: 'mining', fabPerDay: 2.5 },
  ] });
  assert.equal(stats.miningCount, 2);
  assert.equal(stats.fabTotal, 12.5);
});

test('weekly stats expose incomplete discovery and measurement instead of a comparable total', () => {
  const stats = weekFabStats({
    discovery: { expected: 10, verified: 2, complete: false },
    rigs: [{ id: '1', measureStatus: 'mining', fabPerDay: 1 }, { id: '2', measureStatus: 'unread', fabPerDay: null }],
  });
  assert.equal(stats.holdingKnown, 2);
  assert.equal(stats.holdingTotal, 10);
  assert.equal(stats.measuredCount, 1);
  assert.equal(stats.complete, false);
  const text = formatWeeklyDigest('zh', ADDR, stats, { prevFab: 10, eventCount: 0, siteUrl: 'https://example.test/' });
  assert.match(text, /持有覆盖.*2\/10/);
  assert.match(text, /测产覆盖.*1\/10/);
  assert.doesNotMatch(text, /较上周|90\.0%/);
});

test('unknown weekly readings do not claim zero mining rigs', () => {
  const stats = weekFabStats({ discovery: { expected: 2, verified: 2, complete: true },
    rigs: [{ id: '1', measureStatus: 'unread' }, { id: '2', measureStatus: 'unread' }] });
  assert.equal(stats.miningCount, null);
  assert.equal(stats.fabTotal, null);
  assert.equal(stats.complete, false);
  const text = formatWeeklyDigest('zh', ADDR, stats, { prevFab: 10, eventCount: 0, siteUrl: 'https://example.test/' });
  assert.doesNotMatch(text, /在挖 0 台/);
  assert.match(text, /未知|未读/);
});

test('only confirmed complete empty portfolios have zero output', () => {
  const complete = weekFabStats({ discovery: { expected: 0, verified: 0, complete: true }, rigs: [] });
  assert.equal(complete.complete, true);
  assert.equal(complete.miningCount, 0);
  assert.equal(complete.fabTotal, 0);
  const unknown = weekFabStats({ rigs: [] });
  assert.equal(unknown.complete, false);
  assert.equal(unknown.miningCount, null);
  assert.equal(unknown.fabTotal, null);
});

test('weekly stats exclude transferred tracked rigs and reject malformed production', () => {
  const stats = weekFabStats({ discovery: { expected: 2, verified: 2, complete: true }, rigs: [
    { id: '1', owner: ADDR, measureStatus: 'mining', fabPerDay: 3 },
    { id: '2', owner: ADDR, measureStatus: 'mining', fabPerDay: NaN },
    { id: '3', owner: '0x1111111111111111111111111111111111111111', measureStatus: 'gone', fabPerDay: 100 },
  ] }, ADDR);
  assert.equal(stats.holdingKnown, 2);
  assert.equal(stats.measuredCount, 1);
  assert.equal(stats.fabTotal, 3);
  assert.equal(stats.complete, false);
});

test('runWeeklyDigest sends once per week per address and recipient', async () => {
  const db = d1();
  const weekKey = beijingWeekKey(new Date('2026-10-19T02:15:00.000Z'));
  await signup(db);
  await signup(db, 'alice', 2);
  await baseline(db);
  const sent = [];
  let measures = 0;
  const measure = async () => { measures++; return completeWallet(); };
  const now = () => new Date('2026-10-19T02:15:00.000Z');
  const env = { DB: db, SITE_URL: 'https://example.test/' };
  const first = await runWeeklyDigest(env, { measure, send: async (id, text) => { sent.push({ id, text }); return { status: 'sent' }; }, snap: SNAP, now });
  assert.equal(first.sent, 2);
  assert.match(sent[0].text, /周报/);
  assert.match(sent[0].text, /example\.test\/#addr=/);
  assert.match(sent[0].text, /-50\.0%/);
  assert.equal(sent[0].text, sent[1].text);
  assert.equal(measures, 1);
  const second = await runWeeklyDigest(env, { measure, send: async () => { sent.push({}); }, snap: SNAP, now });
  assert.equal(second.skipped, 2);
  assert.equal(sent.length, 2);
  assert.equal(measures, 1);
  assert.ok(weekKey);
});

test('partial weekly data never overwrites the last complete baseline or claims a decrease', async () => {
  const db = d1();
  await signup(db);
  await baseline(db);
  const sent = [];
  const measure = async () => ({ discovery: { expected: 10, verified: 2, complete: false }, rigs: [
    { id: '1', measureStatus: 'mining', fabPerDay: 1 }, { id: '2', measureStatus: 'unread', fabPerDay: null },
  ] });
  await runWeeklyDigest(environment(db), { measure, send: async (_, text) => { sent.push(text); return { status: 'sent' }; }, snap: SNAP, now: MONDAY });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /持有覆盖.*2\/10/);
  assert.match(sent[0], /测产覆盖.*1\/10/);
  assert.doesNotMatch(sent[0], /较上周|90\.0%/);
  const prev = db.rows('alert_weekly_snapshots')[0];
  assert.equal(prev.fab_total, 10);
  assert.equal(prev.week_key, '2026-W42');
  assert.equal(prev.updated_at, 'previous');
});

test('weekly confirmed failed sends retry that Monday without remeasuring or duplicating other recipients', async () => {
  const db = d1();
  await signup(db);
  await signup(db, 'alice', 2);
  let measures = 0;
  const attempts = [];
  const measure = async () => { measures++; return completeWallet(); };
  const send = async (recipient, text) => {
    attempts.push({ recipient: String(recipient), text });
    return String(recipient) === '1' && attempts.filter(a => a.recipient === '1').length === 1
      ? { status: 'failed', error: 'Telegram 429: request rejected' } : { status: 'sent', receipt: { message_id: attempts.length } };
  };
  const first = await runWeeklyDigest(environment(db), { measure, send, snap: SNAP, now: MONDAY });
  assert.equal(first.sent, 1);
  assert.equal(first.failed, 1);
  const second = await runWeeklyDigest(environment(db), { measure: async () => { throw new Error('must reuse report'); }, send,
    snap: SNAP, now: () => new Date('2026-10-19T05:00:00.000Z') });
  assert.equal(second.sent, 1);
  const third = await runWeeklyDigest(environment(db), { measure, send, snap: SNAP, now: MONDAY });
  assert.equal(third.sent, 0);
  assert.deepEqual(attempts.map(a => a.recipient).sort(), ['1', '1', '2']);
  assert.equal(attempts[0].text, attempts[2].text);
  assert.equal(measures, 1);
  assert.deepEqual(db.rows('alert_deliveries').map(r => r.status), ['sent', 'sent']);
});

test('weekly ambiguous delivery stays unknown and is never blindly retried', async () => {
  const db = d1();
  await signup(db);
  let calls = 0;
  const send = async () => { calls++; throw new Error('network response lost'); };
  await runWeeklyDigest(environment(db), { measure: async () => completeWallet(), send, snap: SNAP, now: MONDAY });
  await runWeeklyDigest(environment(db), { measure: async () => completeWallet(), send, snap: SNAP, now: MONDAY });
  assert.equal(calls, 1);
  assert.equal(db.rows('alert_deliveries')[0].status, 'unknown');
});

test('new subscriber receives the frozen weekly comparison after the baseline has advanced', async () => {
  const db = d1();
  await signup(db);
  await baseline(db);
  const messages = [];
  const send = async (recipient, text) => { messages.push({ recipient, text }); return { status: 'sent' }; };
  await runWeeklyDigest(environment(db), { measure: async () => completeWallet(), send, snap: SNAP, now: MONDAY });
  await signup(db, 'alice', 2);
  await runWeeklyDigest(environment(db), { measure: async () => { throw new Error('already frozen'); }, send, snap: SNAP, now: MONDAY });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, messages[1].text);
  assert.match(messages[1].text, /-50\.0%/);
  assert.equal(db.rows('alert_weekly_snapshots')[0].fab_total, 5);
});

for (const [label, week, complete] of [['older complete', '2026-W41', 1], ['legacy unverified', '2026-W42', 0]]) {
  test(`weekly ${label} baseline is never labelled as last week`, async () => {
    const db = d1();
    await signup(db);
    await baseline(db, week, complete);
    let message;
    await runWeeklyDigest(environment(db), { measure: async () => completeWallet(),
      send: async (_, text) => { message = text; return { status: 'sent' }; }, snap: SNAP, now: MONDAY });
    assert.doesNotMatch(message, /较上周/);
  });
}
