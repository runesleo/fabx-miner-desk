import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1.mjs';
import worker, { planRigChanges, runCheck, runGovernanceCheck, handleUpdate, formatAlert, telegramSender, chatKey, langOf, adaptPodForAlerts, MAX_WATCH_PER_CHAT, MAX_FEEDBACK_CHARS } from '../alerts/worker.mjs';
import { TOPIC } from '../alerts/events.mjs';

const ADDR = '0xe0cb3d9542a786c60605dd55efb9ef79490a3d6c';
const OTHER = '0x1111111111111111111111111111111111111111';
const SNAP = { head: 80_000_000, headTimestamp: 1_792_000_000, blockTime: 3 };
const walletOf = (rigs, complete = true) => ({ address: ADDR, circuits: rigs.length, measured: rigs.filter(r => r.measureStatus === 'mining').length,
  discovery: { complete, expected: rigs.length }, rigs });
const rig = (id, overrides = {}) => ({
  id: String(id),
  chainStatus: 1,
  stopBlock: 0n,
  optimal: true,
  bonus: 100,
  owner: ADDR,
  measureStatus: 'mining',
  fabPerDay: 10,
  minerKey: `0x${'a'.repeat(64)}`,
  ...overrides,
});
const baselineRow = (rigId, overrides = {}) => ({
  rig_id: String(rigId),
  chain_status: 1,
  optimal: 1,
  bonus: 100,
  owner: ADDR,
  status: 'mining',
  fab_per_day: 10,
  head: 1,
  ...overrides,
});
const fakeSend = () => { const sent = []; return { sent, send: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length }; } }; };
const msg = (text, { id = 4242, username = 'leo_miner', lang = 'en', type = 'private' } = {}) =>
  ({ update_id: 1, message: { message_id: 1, chat: { id, type }, from: { id, username, language_code: lang }, text } });
const signup = (db, address, telegram, lang = 'en') => db.prepare('INSERT INTO alert_signups (address, telegram, lang, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
  .bind(address, telegram, lang, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z').run();

test('planRigChanges: first observation is baseline; then revoked, stopped, demoted, nft and ≥30% drops alert', () => {
  const stamp = { head: 1, observedAt: '2026-10-21T08:00:00.000Z' };
  const first = planRigChanges([], walletOf([rig('1'), rig('2', { chainStatus: 3, stopBlock: 1n, measureStatus: 'stopped', fabPerDay: 0 })]), ADDR, stamp);
  assert.deepEqual(first.alerts, []);
  assert.equal(first.upserts.length, 2);
  const previous = [baselineRow('1'), baselineRow('2', { chain_status: 3, fab_per_day: 0, status: 'stopped' }), baselineRow('5')];
  const next = planRigChanges(previous, walletOf([
    rig('1', { chainStatus: 2, measureStatus: 'stopped', fabPerDay: 0 }),
    rig('2', { chainStatus: 1, measureStatus: 'mining', fabPerDay: 4 }),
  ]), ADDR, stamp);
  assert.deepEqual(next.alerts, [{ kind: 'revoked', rigId: '1' }]);
  const stopped = planRigChanges([baselineRow('1')], walletOf([rig('1', { chainStatus: 3, stopBlock: 99n, measureStatus: 'stopped', fabPerDay: 0 })]), ADDR, stamp);
  assert.deepEqual(stopped.alerts, [{ kind: 'stopped', rigId: '1' }]);
  const demoted = planRigChanges([baselineRow('1')], walletOf([rig('1', { optimal: false, bonus: 0 })]), ADDR, stamp);
  assert.deepEqual(demoted.alerts.map(a => a.kind), ['demoted']);
  const nft = planRigChanges([baselineRow('1')], walletOf([rig('1', { owner: OTHER })]), ADDR, stamp);
  assert.deepEqual(nft.alerts, [{ kind: 'nft_out', rigId: '1' }]);
  const drop = planRigChanges([baselineRow('1')], walletOf([rig('1', { fabPerDay: 7 })]), ADDR, stamp);
  assert.deepEqual(drop.alerts, [{ kind: 'drop', rigId: '1', fabPerDay: 7, previousFabPerDay: 10 }]);
  const minor = planRigChanges([baselineRow('1')], walletOf([rig('1', { fabPerDay: 7.5 })]), ADDR, stamp);
  assert.deepEqual(minor.alerts, []);
  const unread = planRigChanges(previous, walletOf([rig('1'), rig('5', { chainStatus: null })], true), ADDR, stamp);
  assert.deepEqual(unread.deletes, [], 'missing tracked rigs keep their baseline until their owner can be checked');
});

test('planRigChanges: absent tracked rigs retain baseline until ownership is explicitly confirmed', () => {
  const previous = [baselineRow('9')];
  const stamp = { head: 1, observedAt: 'now' };
  assert.deepEqual(planRigChanges(previous, walletOf([rig('1')], true), ADDR, stamp).deletes, []);
  assert.deepEqual(planRigChanges(previous, walletOf([rig('1')], false), ADDR, stamp).deletes, []);
  const confirmed = planRigChanges(previous, walletOf([rig('9', { owner: OTHER, measureStatus: 'gone', fabPerDay: null })]), ADDR, stamp);
  assert.deepEqual(confirmed.deletes, ['9']);
  assert.equal(confirmed.interrupted, false);
});

test('runCheck: baseline run sends nothing; a later stop notifies linked chats only and records the event', async () => {
  const db = d1();
  await signup(db, ADDR, 'leo_miner', 'zh');
  await signup(db, ADDR, 'nobody_yet', 'en');
  await handleUpdate(msg('/start', { username: 'Leo_Miner', lang: 'zh-hans' }), { DB: db }, { send: fakeSend().send });
  const { sent, send } = fakeSend();
  const measurements = [
    walletOf([rig('1', { fabPerDay: 10 }), rig('2', { fabPerDay: 5 })]),
    walletOf([rig('1', { chainStatus: 3, stopBlock: 1n, measureStatus: 'stopped', fabPerDay: 0 }), rig('2', { fabPerDay: 5 })]),
  ];
  const measure = async (address) => { assert.equal(address, ADDR); return measurements.shift(); };
  const clock = ['2026-10-21T08:00:00.000Z', '2026-10-21T08:30:00.000Z'];
  const now = () => new Date(clock.length > 1 ? clock.shift() : clock[0]);
  const first = await runCheck({ DB: db }, { measure, send, snap: SNAP, now, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true });
  assert.deepEqual(first, { addresses: 1, alerts: 0, sent: 0, undeliverable: 0, errors: [], weekly: null, market: null, cheap: { subscribers: 0, deals: 0, queued: 0, sent: 0, closed: 0, errors: [] }, daily: { day: '2026-10-21', subscribers: 0, queued: 0, sent: 0, errors: [] } });
  assert.equal(sent.length, 0);
  const second = await runCheck({ DB: db }, { measure, send, snap: SNAP, now, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true });
  assert.deepEqual(second, { addresses: 1, alerts: 1, sent: 1, undeliverable: 1, errors: [], weekly: null, market: null, cheap: { subscribers: 0, deals: 0, queued: 0, sent: 0, closed: 0, errors: [] }, daily: { day: '2026-10-21', subscribers: 0, queued: 0, sent: 0, errors: [] } });
  assert.match(sent[0].text, /停挖/);
  assert.match(sent[0].text, /#1/);
  assert.deepEqual(db.rows('alert_events').map(e => [e.rig_id, e.kind, e.recipients]), [['1', 'stopped', 1]]);
  const third = await runCheck({ DB: db }, {
    measure: async () => walletOf([rig('1', { chainStatus: 3, stopBlock: 1n, measureStatus: 'stopped', fabPerDay: 0 }), rig('2', { fabPerDay: 5 })]),
    send, snap: SNAP, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true,
  });
  assert.equal(third.alerts, 0, 'still stopped: no repeat alert');
});

test('runGovernanceCheck: new governance logs broadcast to every linked chat once', async () => {
  const db = d1();
  await handleUpdate(msg('/start'), { DB: db }, { send: fakeSend().send });
  const { sent, send } = fakeSend();
  const logs = [{
    topics: [TOPIC.Paused],
    transactionHash: '0xabc',
    logIndex: '0x1',
    blockNumber: '0x64',
  }];
  const summary = await runGovernanceCheck({ DB: db }, {
    send,
    snap: { head: 100 },
    governanceGetLogs: async () => logs,
  });
  assert.equal(summary.events, 1);
  assert.equal(summary.sent, 1);
  assert.match(sent[0].text, /PodMining/);
  assert.equal(db.rows('alert_governance_seen').length, 1);
  const again = await runGovernanceCheck({ DB: db }, { send, snap: { head: 101 }, governanceGetLogs: async () => logs });
  assert.equal(again.events, 0);
});

test('runCheck: a failed measurement is recorded per address and does not stop the other addresses', async () => {
  const db = d1();
  await signup(db, ADDR, 'leo_miner');
  await signup(db, OTHER, 'leo_miner');
  const measure = async (address) => { if (address === ADDR) throw new Error('RPC: rate limited'); return walletOf([rig('7', { owner: OTHER })]); };
  const summary = await runCheck({ DB: db }, { measure, send: fakeSend().send, snap: SNAP, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true });
  assert.equal(summary.addresses, 2);
  assert.deepEqual(summary.errors, ['0xe0cb…3d6c: RPC: rate limited']);
  assert.equal(db.rows('alert_rig_state', `address = '${OTHER}'`).length, 1);
});

test('runCheck: nothing to do without sign-ups (no chain read, no token needed)', async () => {
  const summary = await runCheck({ DB: d1() }, { send: fakeSend().send, measure: async () => { throw new Error('must not measure'); }, snap: SNAP, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true });
  assert.equal(summary.addresses, 0);
  assert.equal(summary.alerts, 0);
  assert.equal(summary.sent, 0);
  assert.equal(summary.undeliverable, 0);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.weekly, null);
  assert.equal(summary.market, null);
  assert.deepEqual(summary.cheap, { subscribers: 0, deals: 0, queued: 0, sent: 0, closed: 0, errors: [] });
  assert.equal(summary.daily.subscribers, 0);
  assert.equal(summary.daily.queued, 0);
  assert.equal(summary.daily.sent, 0);
});

test('bot: /start links the username to the chat and reports existing website sign-ups', async () => {
  const db = d1();
  await signup(db, ADDR, 'leo_miner');
  const { sent, send } = fakeSend();
  const result = await handleUpdate(msg('/start', { username: '@Leo_Miner' }), { DB: db }, { send });
  assert.deepEqual(result, { handled: true, command: '/start', lang: 'en' });
  assert.match(sent[0].text, /rig income changes/);
});

test('bot: /watch validates, caps, upserts and links the chat; /list, /unwatch and /stop round-trip', async () => {
  const db = d1();
  const { sent, send } = fakeSend();
  const env = { DB: db };
  assert.equal((await handleUpdate(msg('/watch 0x123'), env, { send })).error, 'bad_address');
  await handleUpdate(msg(`/watch ${ADDR}`), env, { send });
  assert.equal(db.rows('alert_signups').length, 1);
  await handleUpdate(msg('/stop'), env, { send });
  assert.equal(db.rows('alert_signups').length, 0);
  assert.match(sent.at(-1).text, /All alerts are off/);
});

test('bot: accounts without a username get a chat-scoped key; groups and non-text updates are ignored; unknown text gets help', async () => {
  const db = d1();
  const { sent, send } = fakeSend();
  assert.deepEqual(chatKey({ username: undefined }, { id: 77 }), 'chat:77');
  assert.deepEqual(await handleUpdate(msg('/start', { type: 'supergroup' }), { DB: db }, { send }), { handled: false });
  const help = await handleUpdate(msg('hello there'), { DB: db, SITE_URL: 'https://example.test/' }, { send });
  assert.equal(help.command, '/help');
  assert.match(sent.at(-1).text, /\/watch 0xaddress.*https:\/\/example\.test\//s);
});

test('formatAlert groups kinds into one message per language', () => {
  const alerts = [
    { kind: 'stopped', rigId: '1' },
    { kind: 'drop', rigId: '3', fabPerDay: 1.2345, previousFabPerDay: 3 },
    { kind: 'revoked', rigId: '2' },
  ];
  const zh = formatAlert('zh', ADDR, alerts, 'https://example.test/');
  assert.match(zh, /停挖 #1/);
  assert.match(zh, /example\.test\/#addr=/);
  assert.match(zh, /举证撤销 #2/);
  assert.match(zh, /产出骤降/);
});

test('telegramSender posts to the bot API without link previews and surfaces API errors', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), { status: 200 }); };
  const send = telegramSender('123:abc', fetchImpl);
  assert.deepEqual(await send(42, 'hi'), { message_id: 5 });
  assert.throws(() => telegramSender(''), /FABX_DESK_BOT_TOKEN/);
});

test('fetch handler: webhook needs the secret header, rejects bad bodies, always answers 200 to valid updates; /health works', async () => {
  const db = d1();
  const env = { DB: db, TELEGRAM_WEBHOOK_SECRET: 's3cret', FABX_DESK_BOT_TOKEN: '123:abc' };
  const post = (body, headers = {}) => new Request('https://alerts.example/telegram', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
  assert.equal((await worker.fetch(post('{}'), env)).status, 403);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  try {
    const res = await worker.fetch(post(JSON.stringify(msg('/start')), { 'x-telegram-bot-api-secret-token': 's3cret' }), env);
    assert.equal(res.status, 200);
    assert.equal(db.rows('alert_chats').length, 1);
  } finally { globalThis.fetch = original; }
  assert.equal((await worker.fetch(new Request('https://alerts.example/health'), env)).status, 200);
});

test('bot: language is chosen once (/start zh, /zh, /en) and every later reply keeps it regardless of the client language', async () => {
  const db = d1();
  const { sent, send } = fakeSend();
  const env = { DB: db };
  assert.equal((await handleUpdate(msg('/start zh', { lang: 'en' }), env, { send })).lang, 'zh');
  assert.match(sent.at(-1).text, /已连接/);
  await handleUpdate(msg('/en'), env, { send });
  assert.match(sent.at(-1).text, /Switched to English/);
});

test('bot: /feedback stores one line with the chat key, rejects empty or oversize text, and help lists it', async () => {
  const db = d1();
  const { sent, send } = fakeSend();
  const env = { DB: db, SITE_URL: 'https://example.test/' };
  assert.equal((await handleUpdate(msg('/feedback'), env, { send })).error, 'empty');
  await handleUpdate(msg('/feedback show BSC'), env, { send });
  assert.equal(db.rows('feedback').length, 1);
});

test('partial reads retain valid field baselines and their observation times', () => {
  const previous = [baselineRow('1', { observed_at: '2026-10-21T08:00:00.000Z' })];
  const partial = planRigChanges(previous, walletOf([rig('1', { owner: null, optimal: null, bonus: null,
    fabPerDay: null, measureStatus: 'unknown' })]), ADDR,
  { head: 2, observedAt: '2026-10-21T08:30:00.000Z' });
  assert.equal(partial.upserts[0].fabPerDay, 10);
  assert.equal(partial.upserts[0].owner, ADDR);
  assert.equal(partial.upserts[0].optimal, 1);
  assert.equal(partial.upserts[0].fieldObservedAt.fab_per_day, previous[0].observed_at);
  assert.equal(partial.upserts[0].fieldObservedAt.chain_status, '2026-10-21T08:30:00.000Z');
  assert.equal(partial.interrupted, true);
});

test('failed recipient retries once on a later run while other recipients continue', async () => {
  const db = d1();
  await signup(db, ADDR, 'miner_one');
  await signup(db, ADDR, 'miner_two');
  await handleUpdate(msg('/start', { id: 1, username: 'miner_one' }), { DB: db }, { send: fakeSend().send });
  await handleUpdate(msg('/start', { id: 2, username: 'miner_two' }), { DB: db }, { send: fakeSend().send });
  const attempts = [];
  const send = async (chatId) => {
    attempts.push(Number(chatId));
    return attempts.length === 1 ? { status: 'failed', error: 'rejected' } : { message_id: attempts.length };
  };
  const opts = { snap: SNAP, send, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true, demotedGetLogs: async () => [] };
  await runCheck({ DB: db }, { ...opts, measure: async () => walletOf([rig('1')]) });
  const measure = async () => walletOf([rig('1', { chainStatus: 3, stopBlock: 1n, measureStatus: 'stopped', fabPerDay: 0 })]);
  await runCheck({ DB: db }, { ...opts, measure });
  await runCheck({ DB: db }, { ...opts, measure });
  await runCheck({ DB: db }, { ...opts, measure });
  assert.deepEqual(attempts, [1, 2, 1]);
  assert.equal(db.rows('alert_events').length, 1);
  assert.deepEqual(db.rows('alert_deliveries').map(r => r.status), ['sent', 'sent']);
});

test('monitoring interruption preserves field history, then detects stop and transfer on recovery', async () => {
  const db = d1();
  await signup(db, ADDR, 'leo_miner', 'zh');
  await handleUpdate(msg('/start', { lang: 'zh' }), { DB: db }, { send: fakeSend().send });
  const { send, sent } = fakeSend();
  const opts = { snap: SNAP, send, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true, demotedGetLogs: async () => [] };
  await runCheck({ DB: db }, { ...opts, now: () => new Date('2026-10-21T08:00:00Z'), measure: async () => walletOf([rig('1'), rig('2')]) });
  await runCheck({ DB: db }, { ...opts, now: () => new Date('2026-10-21T08:30:00Z'), measure: async () => walletOf([
    rig('1', { owner: null, fabPerDay: null, measureStatus: 'unknown' }),
    rig('2', { owner: null, chainStatus: null, fabPerDay: null, measureStatus: 'unknown' }),
  ], false) });
  assert.equal(db.rows('alert_rig_state')[0].fab_per_day, 10);
  assert.equal(JSON.parse(db.rows('alert_rig_state')[0].field_observed_at).fab_per_day, '2026-10-21T08:00:00.000Z');
  await handleUpdate(msg('/list'), { DB: db }, { send });
  assert.match(sent.at(-1).text, /监测中断.*最后检查/s);
  await runCheck({ DB: db }, { ...opts, measure: async () => walletOf([
    rig('1', { chainStatus: 3, stopBlock: 1n, measureStatus: 'stopped', fabPerDay: 0 }), rig('2', { owner: OTHER }),
  ]) });
  assert.deepEqual(db.rows('alert_events').map(r => r.kind), ['stopped', 'nft_out']);
});

test('stored rig sends retry even when the current chain head cannot be read', async () => {
  const db = d1();
  await signup(db, ADDR, 'leo_miner');
  await handleUpdate(msg('/start'), { DB: db }, { send: fakeSend().send });
  const opts = { snap: SNAP, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true, demotedGetLogs: async () => [] };
  await runCheck({ DB: db }, { ...opts, send: fakeSend().send, measure: async () => walletOf([rig('1')]) });
  await runCheck({ DB: db }, { ...opts, send: async () => ({ status: 'failed' }),
    measure: async () => walletOf([rig('1', { chainStatus: 2 })]) });
  const { sent, send } = fakeSend();
  const result = await runCheck({ DB: db }, { send, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true, chainHead: async () => { throw new Error('RPC unavailable'); } });
  assert.equal(sent.length, 1);
  assert.equal(result.sent, 1);
  assert.equal(db.rows('alert_deliveries')[0].status, 'sent');
  assert.equal(db.rows('alert_address_state')[0].last_error, 'RPC unavailable');
});

test('governance rejected recipients retry independently after cursor advance, including a log outage', async () => {
  const db = d1();
  await handleUpdate(msg('/start', { id: 1, username: 'miner_one' }), { DB: db }, { send: fakeSend().send });
  await handleUpdate(msg('/start', { id: 2, username: 'miner_two' }), { DB: db }, { send: fakeSend().send });
  const attempts = [];
  const send = async id => { attempts.push(id); return attempts.length === 1 ? { status: 'failed' } : { message_id: attempts.length }; };
  const logs = [{ topics: [TOPIC.Paused], transactionHash: '0xabc', logIndex: '0x1', blockNumber: '0x64' }];
  await runGovernanceCheck({ DB: db }, { snap: { head: 100 }, send, governanceGetLogs: async () => logs });
  await runGovernanceCheck({ DB: db }, { snap: { head: 101 }, send, governanceGetLogs: async () => { throw new Error('RPC failure'); } });
  await runGovernanceCheck({ DB: db }, { snap: { head: 102 }, send, governanceGetLogs: async () => [] });
  assert.deepEqual(attempts, ['1', '2', '1']);
  assert.equal(db.rows('alert_governance_seen').length, 1);
});

test('telegram timeout and invalid response are unknown; explicit rejection is retryable', async () => {
  const timeout = telegramSender('offline', async () => new Promise(() => {}), { timeoutMs: 5 });
  await assert.rejects(timeout(1, 'test'), error => /timed out/.test(error.message) && error.deliveryStatus !== 'failed');
  const rejected = telegramSender('offline', async () => new Response(JSON.stringify({ ok: false, description: 'rate limited' }), { status: 429 }));
  await assert.rejects(rejected(1, 'test'), error => error.deliveryStatus === 'failed');
  const malformed = telegramSender('offline', async () => new Response('{}'));
  await assert.rejects(malformed(1, 'test'), error => error.deliveryStatus !== 'failed');
});

test('FabX demotion includes current holder boosts while BSC retains its existing copy', () => {
  for (const kind of ['demoted', 'demoted_kick', 'demoted_reclaim', 'demoted_start']) {
    const text = formatAlert('zh', ADDR, [{ kind, rigId: '7' }], 'https://example.test');
    assert.match(text, /失去设计溢价，按当前持有人的基础权重及加成继续挖/);
    assert.doesNotMatch(text, /b\*·P/);
  }
  assert.match(formatAlert('zh', ADDR, [{ kind: 'demoted', rigId: '7' }], 'https://example.test', { chain: 'bsc' }), /设计溢价归零，权重降到 b\*·P，基础挖矿继续/);
});

test('staggered premium reads retain the coherent baseline until demotion can be confirmed', async () => {
  const db = d1();
  await signup(db, ADDR, 'leo_miner');
  const opts = { snap: SNAP, send: fakeSend().send, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true, demotedGetLogs: async () => [] };
  for (const overrides of [{}, { optimal: false, bonus: null, chainStatus: null }, { optimal: null, bonus: 0, chainStatus: null }, { optimal: false, bonus: 0 }]) {
    await runCheck({ DB: db }, { ...opts, measure: async () => walletOf([rig('1', overrides)]) });
  }
  assert.deepEqual(db.rows('alert_events').map(e => e.kind), ['demoted']);
  assert.equal(db.rows('alert_rig_state')[0].premium_active, 0);
});

test('known measured zero updates the output baseline even when chain mining status is active', () => {
  const plan = planRigChanges([baselineRow('1')], walletOf([rig('1', { measureStatus: 'stopped', fabPerDay: 0 })]), ADDR, { head: 2, observedAt: 'now' });
  assert.equal(plan.upserts[0].fabPerDay, 0);
  assert.equal(plan.interrupted, false);
  assert.deepEqual(plan.alerts, [{ kind: 'drop', rigId: '1', fabPerDay: 0, previousFabPerDay: 10 }]);
});

test('missing tracked rig survives partial enrichment, then sends transfer even alongside a stop', async () => {
  const db = d1();
  await signup(db, ADDR, 'leo_miner');
  const opts = { snap: SNAP, send: fakeSend().send, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true, demotedGetLogs: async () => [] };
  await runCheck({ DB: db }, { ...opts, measure: async () => walletOf([rig('1')]) });
  await runCheck({ DB: db }, { ...opts, measure: async () => walletOf([]) });
  assert.equal(db.rows('alert_rig_state').length, 1);
  assert.equal(db.rows('alert_address_state')[0].last_error, 'partial_read');
  await runCheck({ DB: db }, { ...opts, measure: async (_address, _snap, tracked) => {
    assert.deepEqual(tracked, ['1']);
    return walletOf([rig('1', { owner: OTHER, chainStatus: 3, measureStatus: 'gone', fabPerDay: null })]);
  } });
  assert.deepEqual(db.rows('alert_events').map(e => e.kind), ['stopped', 'nft_out']);
  assert.equal(db.rows('alert_rig_state').length, 0);
});

test('concurrent stale observation cannot duplicate an event or overwrite a newer head', async () => {
  const db = d1();
  await signup(db, ADDR, 'leo_miner');
  await handleUpdate(msg('/start'), { DB: db }, { send: fakeSend().send });
  const { sent, send } = fakeSend();
  const opts = { send, skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true, demotedGetLogs: async () => [] };
  await runCheck({ DB: db }, { ...opts, snap: { ...SNAP, head: 1 }, measure: async () => walletOf([rig('1')]) });
  let releaseOld, enteredOld;
  const entered = new Promise(resolve => { enteredOld = resolve; });
  const old = runCheck({ DB: db }, { ...opts, snap: { ...SNAP, head: 2 }, measure: async () => {
    enteredOld();
    await new Promise(resolve => { releaseOld = resolve; });
    return walletOf([rig('1', { chainStatus: 3 })]);
  } });
  await entered;
  await runCheck({ DB: db }, { ...opts, snap: { ...SNAP, head: 3 }, measure: async () => walletOf([rig('1', { chainStatus: 3 })]) });
  releaseOld();
  await old;
  assert.equal(sent.length, 1);
  assert.equal(db.rows('alert_events').length, 1);
  assert.equal(db.rows('alert_rig_state')[0].head, 3);
  assert.equal(db.rows('alert_address_state')[0].head, 3);
  await runCheck({ DB: db }, { ...opts, snap: { ...SNAP, head: 2 }, measure: async () => { assert.fail('stale head must be skipped'); } });
  assert.equal(db.rows('alert_rig_state')[0].head, 3);
});

test('overlapping governance reads do not duplicate the ledger or regress the cursor', async () => {
  const db = d1();
  await handleUpdate(msg('/start'), { DB: db }, { send: fakeSend().send });
  const { sent, send } = fakeSend();
  const logs = [{ topics: [TOPIC.Paused], transactionHash: '0xabc', logIndex: '0x1', blockNumber: '0x64' }];
  let enteredOld, releaseOld;
  const entered = new Promise(resolve => { enteredOld = resolve; });
  const old = runGovernanceCheck({ DB: db }, { snap: { head: 100 }, send, governanceGetLogs: async () => {
    enteredOld(); await new Promise(resolve => { releaseOld = resolve; }); return logs;
  } });
  await entered;
  await runGovernanceCheck({ DB: db }, { snap: { head: 101 }, send, governanceGetLogs: async () => logs });
  releaseOld(); await old;
  assert.equal(sent.length, 1);
  assert.equal(db.rows('alert_events').length, 1);
  assert.equal(db.rows('alert_worker_state').find(r => r.key === 'governance_head').value, '101');
});

test('/list identifies stale monitoring and distinguishes a never-checked address', async () => {
  const db = d1();
  await signup(db, ADDR, 'leo_miner', 'zh');
  await signup(db, OTHER, 'leo_miner', 'zh');
  await handleUpdate(msg('/start', { lang: 'zh' }), { DB: db }, { send: fakeSend().send });
  await db.prepare('INSERT INTO alert_address_state (address, last_checked_at) VALUES (?, ?)').bind(ADDR, '2026-10-21T08:00:00Z').run();
  const { sent, send } = fakeSend();
  await handleUpdate(msg('/list'), { DB: db }, { send, now: () => new Date('2026-10-21T10:00:00Z') });
  assert.match(sent[0].text, /监测中断/);
  assert.match(sent[0].text, /尚未检查/);
  assert.match(sent[0].text, /X Layer/);
});

test('runCheck: a BSC stop uses the pod shape, skips the X Layer measure, and says BEM in plain language', async () => {
  const db = d1();
  await db.prepare('INSERT INTO alert_signups (address, telegram, lang, chain, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ADDR, 'leo_miner', 'zh', 'bsc', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z').run();
  await handleUpdate(msg('/start', { username: 'Leo_Miner', lang: 'zh-hans' }), { DB: db }, { send: fakeSend().send });
  const podSnap = { head: 40_000_000, headTimestamp: 1_700_000_000, blockTime: 0.5 };
  const mining = { circuits: 1, measured: 1, discovery: { complete: true }, rigs: [{ id: 'TapeOut#11', status: 'mining', fabPerDay: 12, optimal: true }] };
  const stopped = { circuits: 1, measured: 1, discovery: { complete: true }, rigs: [{ id: 'TapeOut#11', status: 'stopped', fabPerDay: 0, optimal: false }] };
  const adapted = adaptPodForAlerts(stopped, ADDR);
  assert.equal(adapted.rigs[0].chainStatus, 3);
  assert.equal(adapted.rigs[0].measureStatus, 'stopped');
  assert.equal(adapted.rigs[0].fabPerDay, 0);
  const readings = [mining, stopped];
  let xlayer = 0;
  const measure = async () => { xlayer += 1; throw new Error('xlayer measure must not run'); };
  const measureBsc = async (address) => { assert.equal(address, ADDR); return readings.shift(); };
  const { sent, send } = fakeSend();
  const opts = {
    measure, measureBsc, send, snap: SNAP, podSnap,
    skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true,
  };
  const first = await runCheck({ DB: db, SITE_URL: 'https://example.test/' }, { ...opts, now: () => new Date('2026-10-25T04:00:00.000Z') });
  assert.equal(xlayer, 0);
  assert.equal(first.alerts, 0);
  assert.equal(first.errors.length, 0);
  assert.equal(db.rows('alert_address_state').find(row => row.address === `bsc:${ADDR}`).rigs, 1);
  const second = await runCheck({ DB: db, SITE_URL: 'https://example.test/' }, { ...opts, now: () => new Date('2026-10-25T05:00:00.000Z') });
  assert.equal(xlayer, 0);
  assert.equal(second.alerts, 1);
  assert.equal(second.sent, 1);
  assert.match(sent[0].text, /停了/);
  assert.match(sent[0].text, /BEM/);
  assert.match(sent[0].text, /chain=bsc/);
  assert.doesNotMatch(sent[0].text, /getMiner|bestSlot/);
  assert.equal(db.rows('alert_events')[0].kind, 'stopped');
  assert.equal(db.rows('alert_rig_state')[0].address, `bsc:${ADDR}`);
});
