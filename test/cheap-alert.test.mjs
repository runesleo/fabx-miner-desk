import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1.mjs';
import { entryComparison, CFG } from '../desk.mjs';
import { cheapSnapshot, formatCheapAlert, meetsThreshold, officialRigUrl, runCheapAlerts } from '../alerts/cheap.mjs';
import { parseBindBody, saveBindToken } from '../alerts/bind.mjs';
import { handleUpdate, runCheck } from '../alerts/worker.mjs';
import * as alerts from '../functions/api/alerts.js';

const stamp = '2026-10-25T06:00:00.000Z';
const boundary = {
  complete: true,
  state: 'live',
  baseline: { okbPerFabDay: 10 },
  ranked: [
    { listingId: '2', id: '20', priceOkb: 8, fabPerDay: 1, okbPerFabDay: 8, status: 'measured' },
    { listingId: '3', id: '21', priceOkb: 8.01, fabPerDay: 1, okbPerFabDay: 8.01, status: 'measured' },
  ],
  unknown: [{ listingId: '4', id: '22', priceOkb: 1, status: 'unread' }],
};
const buildSnap = {
  head: 1,
  network: { networkNand: 86400, weight: 86400 },
  decision: { nandOkb: 1, nandSource: 'test' },
  prices: { fabUsd: 1, okbUsd: 1 },
  availability: { nand: { state: 'live', asOf: null } },
};
const buildRows = [
  { listingId: '9', id: '42', priceOkb: 0.5, fabPerDay: 1, status: 'measured' },
  { listingId: '8', id: '41', priceOkb: 0.9, fabPerDay: 1, status: 'measured' },
  { listingId: '7', id: '40', priceOkb: 2, fabPerDay: 1, status: 'measured' },
];

const fakeSend = () => {
  const sent = [];
  return { sent, send: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length }; } };
};
const msg = (text, { id = 4242, username = 'leo_miner', lang = 'zh-hans' } = {}) =>
  ({ update_id: 1, message: { message_id: 1, chat: { id, type: 'private' }, from: { id, username, language_code: lang }, text } });
const post = (body) => new Request('https://desk.example/api/alerts', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function subscribe(db, { telegram = 'leo_miner', chat = 4242, threshold = 20, lang = 'zh' } = {}) {
  await db.prepare(`INSERT INTO alert_chats (telegram, chat_id, lang, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(telegram, chat, lang, stamp, stamp).run();
  await db.prepare(`INSERT INTO alert_cheap_subs (telegram, threshold_pct, enabled, lang, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)`)
    .bind(telegram, threshold, lang, stamp, stamp).run();
}

test('cheap alerts reuse entryComparison unit cost against the build baseline', () => {
  const comparison = { ...entryComparison(buildSnap, buildRows, { emissionRate: 100_000_000n, unverifiedBps: 0n }), state: 'live' };
  const shot = cheapSnapshot(comparison);
  assert.equal(shot.ok, true);
  assert.equal(shot.build, comparison.baseline.okbPerFabDay);
  const picked = shot.ranked.filter((row) => meetsThreshold(row.discountPct, 20));
  assert.deepEqual(picked.map((row) => row.listingId), ['9']);
  const cost = comparison.ranked.find((row) => row.listingId === '9').okbPerFabDay;
  assert.equal(picked[0].okbPerFabDay, cost);
  assert.equal(picked[0].discountPct, (shot.build - cost) / shot.build * 100);
  assert.equal(officialRigUrl('42'), `https://fabx.tech/c/${CFG.circuits}/42`);
  assert.match(formatCheapAlert('zh', picked[0]), new RegExp(`官方购买：${officialRigUrl('42')}`));
  assert.match(formatCheapAlert('zh', picked[0]), /便宜 \d+%/);
  assert.match(formatCheapAlert('en', picked[0]), /Official buy link/);
});

test('a listing at least 20% cheaper is sent once; a smaller gap, a repeat, and a relisting are not', async () => {
  const db = d1();
  await subscribe(db);
  const { sent, send } = fakeSend();
  const opts = { comparison: boundary, send, loadComparison: async () => { throw new Error('must not scan live'); } };
  const first = await runCheapAlerts({ DB: db }, opts);
  assert.equal(first.deals, 1);
  assert.equal(first.sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /电路 #20/);
  assert.match(sent[0].text, /挂单 #2/);
  assert.match(sent[0].text, /价格 8 OKB/);
  assert.match(sent[0].text, /每天 1 FAB 要花 8 OKB，自建要 10 OKB，便宜 20%/);
  assert.match(sent[0].text, new RegExp(officialRigUrl('20')));
  assert.doesNotMatch(sent[0].text, /#21/);
  const second = await runCheapAlerts({ DB: db }, opts);
  assert.equal(second.sent, 0);
  assert.equal(sent.length, 1, 'the same listing is not sent again');
  const gone = { ...boundary, ranked: boundary.ranked.filter((row) => row.listingId !== '2') };
  const closed = await runCheapAlerts({ DB: db }, { ...opts, comparison: gone });
  assert.equal(closed.closed, 1);
  assert.equal(db.rows('alert_cheap_closed').map((row) => row.listing_id).join(), '2');
  const back = await runCheapAlerts({ DB: db }, opts);
  assert.equal(back.sent, 0);
  assert.equal(sent.length, 1, 'a delisted listing is not sent when it comes back');
});

test('an incomplete or cached scan does not close listings or send', async () => {
  const db = d1();
  await subscribe(db);
  const { sent, send } = fakeSend();
  await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(sent.length, 1);
  const openBefore = db.rows('alert_cheap_open').map((row) => row.listing_id).sort();
  const incomplete = await runCheapAlerts({ DB: db }, {
    comparison: { ...boundary, complete: false, ranked: [], unknown: [] }, send,
  });
  assert.match(incomplete.errors.join('\n'), /incomplete/);
  assert.deepEqual(db.rows('alert_cheap_open').map((row) => row.listing_id).sort(), openBefore);
  assert.equal(db.rows('alert_cheap_closed').length, 0);
  const cached = await runCheapAlerts({ DB: db }, {
    comparison: { ...boundary, state: 'cached', ranked: [], unknown: [] }, send,
  });
  assert.match(cached.errors.join('\n'), /not-live/);
  assert.equal(db.rows('alert_cheap_closed').length, 0);
  assert.equal(sent.length, 1);
});

test('a pending cheap alert is cancelled when the listing leaves a complete scan, and not sent', async () => {
  const db = d1();
  await subscribe(db);
  await db.prepare(`INSERT INTO alert_cheap_open (listing_id, circuit_id, seen_at) VALUES ('5', '50', ?)`).bind(stamp).run();
  await db.prepare(`INSERT INTO alert_deliveries
    (delivery_key, scope, recipient, payload, status, attempts, created_at, updated_at, address, subscriber)
    VALUES ('cheap:5:4242', 'cheap', '4242', 'stale', 'pending', 0, ?, ?, NULL, 'leo_miner')`).bind(stamp, stamp).run();
  await db.prepare(`INSERT INTO alert_deliveries
    (delivery_key, scope, recipient, payload, status, attempts, created_at, updated_at, address, subscriber)
    VALUES ('cheap:5:5252', 'cheap', '5252', 'stale-failed', 'failed', 1, ?, ?, NULL, 'leo_miner')`).bind(stamp, stamp).run();
  const calls = [];
  const summary = await runCheapAlerts({ DB: db }, {
    comparison: { complete: true, state: 'live', baseline: { okbPerFabDay: 10 }, ranked: [], unknown: [] },
    send: async () => { calls.push('sent'); return { message_id: 1 }; },
  });
  assert.equal(summary.closed, 1);
  assert.equal(calls.length, 0);
  const byKey = Object.fromEntries(db.rows('alert_deliveries').map((row) => [row.delivery_key, row.status]));
  assert.equal(byKey['cheap:5:4242'], 'cancelled');
  assert.equal(byKey['cheap:5:5252'], 'cancelled');
  assert.equal(db.rows('alert_deliveries').every((row) => row.last_error === 'listing closed'), true);
});

test('closing listing 9 cancels only that delivery, including a negative chat id', async () => {
  const db = d1();
  await subscribe(db);
  for (const id of ['9', '99', '90']) {
    await db.prepare(`INSERT INTO alert_cheap_open (listing_id, circuit_id, seen_at) VALUES (?, '1', ?)`).bind(id, stamp).run();
  }
  for (const key of ['cheap:9:4242', 'cheap:9:-1001', 'cheap:99:4242', 'cheap:90:4242']) {
    await db.prepare(`INSERT INTO alert_deliveries
      (delivery_key, scope, recipient, payload, status, attempts, created_at, updated_at, address, subscriber)
      VALUES (?, 'cheap', '4242', 'stale', 'pending', 0, ?, ?, NULL, 'leo_miner')`).bind(key, stamp, stamp).run();
  }
  const summary = await runCheapAlerts({ DB: db }, {
    comparison: {
      complete: true, state: 'live', baseline: { okbPerFabDay: 10 }, ranked: [],
      unknown: [{ listingId: '99', id: '1', priceOkb: 1, status: 'unread' }, { listingId: '90', id: '2', priceOkb: 1, status: 'unread' }],
    },
  });
  assert.equal(summary.queued, 0);
  assert.equal(summary.closed, 1);
  const status = Object.fromEntries(db.rows('alert_deliveries').map((row) => [row.delivery_key, row.status]));
  assert.equal(status['cheap:9:4242'], 'cancelled');
  assert.equal(status['cheap:9:-1001'], 'cancelled');
  assert.equal(status['cheap:99:4242'], 'pending');
  assert.equal(status['cheap:90:4242'], 'pending');
});

test('each subscriber is told once, and a higher threshold stays quiet', async () => {
  const db = d1();
  await subscribe(db, { telegram: 'leo_miner', chat: 4242, threshold: 20 });
  await subscribe(db, { telegram: 'other_miner', chat: 5252, threshold: 50 });
  const { sent, send } = fakeSend();
  const first = await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(first.sent, 1);
  assert.deepEqual(sent.map((row) => row.chatId), ['4242']);
  const second = await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(second.sent, 0);
  assert.equal(sent.length, 1);
});

test('a failed send is dropped when the next complete scan is below the threshold', async () => {
  const db = d1();
  await subscribe(db);
  const sent = [];
  let fail = true;
  const send = async (chatId, text) => {
    sent.push(text);
    if (fail) return { status: 'failed' };
    return { message_id: sent.length };
  };
  await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(db.rows('alert_deliveries')[0].status, 'failed');
  fail = false;
  const dearer = {
    ...boundary,
    ranked: [{ listingId: '2', id: '20', priceOkb: 9.5, fabPerDay: 1, okbPerFabDay: 9.5, status: 'measured' }],
    unknown: boundary.unknown,
  };
  const next = await runCheapAlerts({ DB: db }, { comparison: dearer, send });
  assert.equal(next.sent, 0);
  assert.equal(sent.length, 1);
  assert.equal(db.rows('alert_deliveries').find((row) => row.delivery_key === 'cheap:2:4242').status, 'cancelled');
  assert.equal(db.rows('alert_deliveries').find((row) => row.delivery_key === 'cheap:2:4242').last_error, 'below threshold');
});

test('a failed send is retried with the new price when the listing still qualifies', async () => {
  const db = d1();
  await subscribe(db);
  const sent = [];
  let fail = true;
  const send = async (chatId, text) => {
    sent.push(text);
    if (fail) return { status: 'failed' };
    return { message_id: sent.length };
  };
  await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  fail = false;
  const cheaper = {
    ...boundary,
    ranked: [
      { listingId: '2', id: '20', priceOkb: 7, fabPerDay: 1, okbPerFabDay: 7, status: 'measured' },
      boundary.ranked[1],
    ],
  };
  const next = await runCheapAlerts({ DB: db }, { comparison: cheaper, send });
  assert.equal(next.sent, 1);
  assert.match(sent.at(-1), /价格 7 OKB/);
  assert.match(sent.at(-1), /便宜 30%/);
  assert.doesNotMatch(sent.at(-1), /价格 8 OKB/);
});

test('a sent listing stays sent when cheap alerts are turned off and on', async () => {
  const db = d1();
  await subscribe(db);
  const { sent, send } = fakeSend();
  await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(sent.length, 1);
  assert.equal(db.rows('alert_deliveries')[0].status, 'sent');
  await db.prepare('UPDATE alert_cheap_subs SET enabled = 0 WHERE telegram = ?').bind('leo_miner').run();
  await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  await db.prepare('UPDATE alert_cheap_subs SET enabled = 1 WHERE telegram = ?').bind('leo_miner').run();
  await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(sent.length, 1);
  assert.equal(db.rows('alert_deliveries')[0].status, 'sent');
});

test('raising /threshold drops an undelivered alert before a head-read failure can retry it', async () => {
  const db = d1();
  await subscribe(db, { threshold: 10 });
  const sent = [];
  const send = async (chatId, text) => {
    sent.push(text);
    return { status: 'failed' };
  };
  await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.ok(db.rows('alert_deliveries').length >= 1);
  assert.ok(db.rows('alert_deliveries').every((row) => row.status === 'failed'));
  const raised = await handleUpdate(msg('/threshold 15'), { DB: db }, { send });
  assert.equal(raised.lang, 'zh');
  assert.equal(db.rows('alert_cheap_subs')[0].threshold_pct, 15);
  assert.ok(db.rows('alert_deliveries').every((row) => row.status === 'cancelled'));
  const before = sent.length;
  const skipped = await runCheapAlerts({ DB: db }, { skipScan: true, comparison: boundary, send: async () => { sent.push('retried'); return { message_id: 1 }; } });
  assert.equal(skipped.sent, 0);
  assert.equal(sent.length, before);
  const refreshed = {
    ...boundary,
    ranked: [{ listingId: '2', id: '20', priceOkb: 7, fabPerDay: 1, okbPerFabDay: 7, status: 'measured' }],
  };
  const again = await runCheapAlerts({ DB: db }, { comparison: refreshed, send: async (chatId, text) => { sent.push(text); return { message_id: 2 }; } });
  assert.equal(again.sent, 1);
  assert.match(sent.at(-1), /价格 7 OKB/);
  assert.match(sent.at(-1), /便宜 30%/);
});

test('a higher threshold on a new bind link drops undelivered cheap alerts', async () => {
  const db = d1();
  await subscribe(db, { threshold: 10 });
  const sent = [];
  await runCheapAlerts({ DB: db }, {
    comparison: boundary,
    send: async (_chatId, text) => { sent.push(text); return { status: 'failed' }; },
  });
  assert.ok(db.rows('alert_deliveries').length >= 1);
  assert.ok(db.rows('alert_deliveries').every((row) => row.status === 'failed'));
  const saved = await saveBindToken(db, parseBindBody({ bind: true, lang: 'zh', threshold: 25 }), { now: new Date(stamp) });
  await handleUpdate(msg(`/start ${saved.token}`), { DB: db }, { send: async () => ({ message_id: 1 }), now: () => new Date(stamp) });
  assert.equal(db.rows('alert_cheap_subs')[0].threshold_pct, 25);
  assert.ok(db.rows('alert_deliveries').every((row) => row.status === 'cancelled' && row.last_error === 'threshold raised'));
  const skipped = await runCheapAlerts({ DB: db }, {
    skipScan: true,
    send: async () => { sent.push('retried'); return { message_id: 2 }; },
  });
  assert.equal(skipped.sent, 0);
  assert.equal(sent.length, db.rows('alert_deliveries').length);
});

test('English chats get English bind errors and cheap commands', async () => {
  const db = d1();
  const { sent, send } = fakeSend();
  const env = { DB: db };
  const en = (text) => msg(text, { id: 777, username: 'miner_en', lang: 'en' });
  const missing = await handleUpdate(en('/start nope'), env, { send });
  assert.equal(missing.error, 'missing');
  assert.match(sent.at(-1).text, /no usable subscribe code/);
  const expired = await saveBindToken(db, parseBindBody({ bind: true, lang: 'en', threshold: 20 }), {
    now: new Date('2026-10-25T00:00:00.000Z'), ttlMs: 1000,
  });
  const late = await handleUpdate(en(`/start ${expired.token}`), env, { send, now: () => new Date('2026-10-25T00:02:00.000Z') });
  assert.equal(late.error, 'expired');
  assert.match(sent.at(-1).text, /expired or was already used/);
  await handleUpdate(en('/cheap'), env, { send });
  assert.match(sent.at(-1).text, /Cheap-rig alerts are on/);
  await handleUpdate(en('/threshold'), env, { send });
  assert.match(sent.at(-1).text, /Current threshold/);
  await handleUpdate(en('/threshold 15'), env, { send });
  assert.match(sent.at(-1).text, /Threshold is now 15%/);
  await handleUpdate(en('/stop'), env, { send });
  assert.match(sent.at(-1).text, /All alerts are off/);
  assert.equal(db.rows('alert_cheap_subs').length, 0);
});

test('turning cheap alerts off drops a pending send; turning them back on sends the listing once', async () => {
  const db = d1();
  await subscribe(db);
  const sent = [];
  let fail = true;
  const send = async (chatId, text) => {
    sent.push(text);
    if (fail) return { status: 'failed' };
    return { message_id: sent.length };
  };
  await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(db.rows('alert_deliveries')[0].status, 'failed');
  await db.prepare('UPDATE alert_cheap_subs SET enabled = 0 WHERE telegram = ?').bind('leo_miner').run();
  fail = false;
  await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(db.rows('alert_deliveries')[0].status, 'cancelled');
  assert.equal(sent.length, 1, 'the failed attempt is not retried while alerts are off');
  await db.prepare('UPDATE alert_cheap_subs SET enabled = 1 WHERE telegram = ?').bind('leo_miner').run();
  const again = await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(again.sent, 1);
  assert.equal(sent.length, 2);
  await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(sent.length, 2);
});

test('a stricter threshold waits until the subscriber lowers it', async () => {
  const db = d1();
  await subscribe(db, { threshold: 40 });
  const { sent, send } = fakeSend();
  const quiet = await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(quiet.sent, 0);
  assert.equal(sent.length, 0);
  await db.prepare('UPDATE alert_cheap_subs SET threshold_pct = 20 WHERE telegram = ?').bind('leo_miner').run();
  const next = await runCheapAlerts({ DB: db }, { comparison: boundary, send });
  assert.equal(next.sent, 1);
  assert.match(sent[0].text, /便宜 20%/);
});

test('the cron sends cheap alerts through the same delivery retry, including after a chain-head failure', async () => {
  const db = d1();
  await subscribe(db);
  const sent = [];
  let fail = true;
  const send = async (chatId, text) => {
    sent.push(text);
    if (fail) return { status: 'failed' };
    return { message_id: sent.length };
  };
  const skips = { skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true };
  const snap = { head: 80_000_000, headTimestamp: 1_792_000_000, blockTime: 3 };
  const live = async () => { throw new Error('must not scan live'); };
  const first = await runCheck({ DB: db }, { ...skips, comparison: boundary, loadComparison: live, send, snap, measure: async () => { throw new Error('must not measure'); } });
  assert.equal(first.cheap.sent, 0);
  assert.equal(db.rows('alert_deliveries')[0].status, 'failed');
  fail = false;
  const second = await runCheck({ DB: db }, {
    ...skips, send, loadComparison: live, chainHead: async () => { throw new Error('RPC unavailable'); },
  });
  assert.equal(second.cheap.sent, 1);
  assert.match(sent.at(-1), /便宜矿机/);
  assert.equal(db.rows('alert_deliveries')[0].status, 'sent');
});

test('website bind tokens are one-time, expire, and reject a missing code in Chinese', async () => {
  const db = d1();
  const bad = await alerts.onRequest({ request: post({ bind: true, threshold: 0, lang: 'zh' }), env: { DB: db } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_threshold');
  const created = await alerts.onRequest({
    request: post({ bind: true, lang: 'zh', threshold: 25, address: '0x3333333333333333333333333333333333333333', chain: 'xlayer' }),
    env: { DB: db },
  });
  assert.equal(created.status, 200);
  const body = await created.json();
  assert.match(body.url, /^https:\/\/t\.me\/fabx_miner_desk_bot\?start=[0-9a-f]{32}$/);
  const token = body.url.slice(body.url.indexOf('start=') + 6);
  const { sent, send } = fakeSend();
  const ok = await handleUpdate(msg(`/start ${token}`, { lang: 'en' }), { DB: db }, { send });
  assert.equal(ok.lang, 'zh');
  assert.match(sent[0].text, /订好了/);
  assert.match(sent[0].text, /25%/);
  assert.match(sent[0].text, /0x3333…3333/);
  assert.equal(db.rows('alert_cheap_subs')[0].threshold_pct, 25);
  assert.equal(db.rows('alert_signups')[0].address, '0x3333333333333333333333333333333333333333');
  const used = await handleUpdate(msg(`/start ${token}`), { DB: db }, { send });
  assert.equal(used.error, 'used');
  assert.match(sent.at(-1).text, /过期了，或者已经用过/);
  const missing = await handleUpdate(msg('/start nope'), { DB: db }, { send });
  assert.equal(missing.error, 'missing');
  assert.match(sent.at(-1).text, /没有可用的订阅码/);
  const parsed = parseBindBody({ bind: true, lang: 'zh', threshold: 20 });
  const expired = await saveBindToken(db, parsed, { now: new Date('2026-10-25T00:00:00.000Z'), ttlMs: 1000 });
  const late = await handleUpdate(msg(`/start ${expired.token}`), { DB: db }, { send, now: () => new Date('2026-10-25T00:02:00.000Z') });
  assert.equal(late.error, 'expired');
  assert.match(sent.at(-1).text, /过期了，或者已经用过/);
});

test('bot /cheap, /threshold and /stop control the cheap-rig subscription', async () => {
  const db = d1();
  const { sent, send } = fakeSend();
  const env = { DB: db };
  await handleUpdate(msg('/threshold'), env, { send });
  assert.match(sent.at(-1).text, /还没订便宜矿机提醒/);
  await handleUpdate(msg('/threshold 20.5'), env, { send });
  assert.match(sent.at(-1).text, /1 到 90/);
  await handleUpdate(msg('/cheap'), env, { send });
  assert.match(sent.at(-1).text, /已打开/);
  assert.equal(db.rows('alert_cheap_subs')[0].threshold_pct, 20);
  await handleUpdate(msg('/threshold 30'), env, { send });
  assert.equal(db.rows('alert_cheap_subs')[0].threshold_pct, 30);
  assert.match(sent.at(-1).text, /30%/);
  await handleUpdate(msg('/cheap'), env, { send });
  assert.equal(db.rows('alert_cheap_subs')[0].enabled, 0);
  assert.match(sent.at(-1).text, /已关闭/);
  await handleUpdate(msg('/stop'), env, { send });
  assert.equal(db.rows('alert_cheap_subs').length, 0);
  assert.equal(db.rows('alert_chats').length, 0);
  assert.match(sent.at(-1).text, /已关闭全部提醒/);
});

test('an account already watching 20 addresses still gets cheap alerts, without a 21st address', async () => {
  const db = d1();
  for (let i = 0; i < 20; i += 1) {
    const address = `0x${String(i).padStart(40, '0')}`;
    await db.prepare(`INSERT INTO alert_signups (address, telegram, lang, chain, created_at, updated_at) VALUES (?, 'leo_miner', 'zh', 'xlayer', ?, ?)`)
      .bind(address, stamp, stamp).run();
  }
  const saved = await saveBindToken(db, parseBindBody({
    bind: true, lang: 'zh', threshold: 20, address: `0x${'b'.repeat(40)}`,
  }), { now: new Date(stamp) });
  const { sent, send } = fakeSend();
  await handleUpdate(msg(`/start ${saved.token}`), { DB: db }, { send, now: () => new Date(stamp) });
  assert.match(sent[0].text, /地址没订上/);
  assert.match(sent[0].text, /便宜矿机提醒已打开/);
  assert.equal(db.rows('alert_signups').length, 20);
  assert.equal(db.rows('alert_cheap_subs').length, 1);
});
