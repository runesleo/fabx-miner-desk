import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1.mjs';
import { handleUpdate, runCheck } from '../alerts/worker.mjs';
import { runDailyBoard } from '../alerts/daily.mjs';
import { parseBindBody, saveBindToken } from '../alerts/bind.mjs';
import { buildDailyBoardText } from '../board.mjs';

const SNAP = { head: 80_000_000, headTimestamp: 1_792_000_000, blockTime: 3 };
const VIEW = {
  fabx: { miners: 1200, weight: 12_500_000, okbPerDay: 12.5, cheaper: 'build', deltaOkb: 0.4, measuredGrowth: true, week: 0.01 },
  bsc: { miners: 80 },
};
const AFTER = '2026-10-25T01:00:00.000Z'; // 09:00 Beijing
const BEFORE = '2026-10-25T00:30:00.000Z'; // 08:30 Beijing
const LATER = '2026-10-25T03:00:00.000Z'; // 11:00 Beijing
const NEXT = '2026-10-26T01:00:00.000Z'; // next day 09:00 Beijing

const fakeSend = () => {
  const sent = [];
  return {
    sent,
    send: async (chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
  };
};
const msg = (text, { id = 4242, username = 'leo_miner', lang = 'en', type = 'private' } = {}) =>
  ({ update_id: 1, message: { message_id: 1, chat: { id, type }, from: { id, username, language_code: lang }, text } });

function at(iso) {
  return () => new Date(iso);
}

async function optIn(db, { id = 4242, username = 'leo_miner', lang = 'zh-hans', text = '/daily' } = {}) {
  const { send } = fakeSend();
  return handleUpdate(msg(text, { id, username, lang }), { DB: db }, { send });
}

test('/daily toggles in Chinese and English; /start, bind, and /stop mention or clear it', async () => {
  const db = d1();
  const { sent, send } = fakeSend();
  const env = { DB: db };
  const started = await handleUpdate(msg('/start', { lang: 'zh-hans' }), env, { send });
  assert.equal(started.lang, 'zh');
  assert.match(sent.at(-1).text, /发 \/daily 每天收一条全网看板/);
  const on = await handleUpdate(msg('/daily@fabx_miner_desk_bot'), env, { send });
  assert.equal(on.command, '/daily');
  assert.match(sent.at(-1).text, /每日看板已打开/);
  assert.equal(db.rows('alert_daily_subs')[0].enabled, 1);
  assert.equal(db.rows('alert_chats').length, 1);
  await handleUpdate(msg('/daily'), env, { send });
  assert.match(sent.at(-1).text, /每日看板已关闭/);
  assert.equal(db.rows('alert_daily_subs')[0].enabled, 0);
  assert.equal(db.rows('alert_chats').length, 1, 'turning the board off leaves other alerts alone');

  const english = d1();
  const en = fakeSend();
  await handleUpdate(msg('/start', { id: 7, username: 'miner_en', lang: 'en' }), { DB: english }, { send: en.send });
  assert.match(en.sent.at(-1).text, /Send \/daily to get one network board note each day/);
  await handleUpdate(msg('/daily', { id: 7, username: 'miner_en', lang: 'en' }), { DB: english }, { send: en.send });
  assert.match(en.sent.at(-1).text, /Daily board is on/);
  await handleUpdate(msg('/stop', { id: 7, username: 'miner_en' }), { DB: english }, { send: en.send });
  assert.equal(english.rows('alert_daily_subs').length, 0);
  assert.equal(english.rows('alert_chats').length, 0);

  const bound = d1();
  const bindSend = fakeSend();
  const saved = await saveBindToken(bound, parseBindBody({ bind: true, lang: 'zh' }), { now: new Date(AFTER) });
  await handleUpdate(msg(`/start ${saved.token}`, { lang: 'en' }), { DB: bound }, { send: bindSend.send, now: at(AFTER) });
  assert.match(bindSend.sent.at(-1).text, /订好了/);
  assert.match(bindSend.sent.at(-1).text, /发 \/daily 每天收一条全网看板/);
});

test('buildDailyBoardText rejects an empty paragraph', async () => {
  await assert.rejects(
    () => buildDailyBoardText({ loadBoard: async () => ({}), format: () => '   ' }),
    /daily board text empty/,
  );
});

test('daily board waits until 09:00 Beijing, sends once, and sends again the next day', async () => {
  const db = d1();
  await optIn(db);
  await optIn(db, { id: 99, username: 'other_miner', lang: 'en' });
  let loads = 0;
  const loadBoard = async () => { loads += 1; return VIEW; };
  const { sent, send } = fakeSend();
  const opts = { loadBoard, boardUrl: 'https://example.test/board/', send };
  const early = await runDailyBoard({ DB: db }, { ...opts, now: at(BEFORE) });
  assert.equal(early.skipped, 'before_09:00');
  assert.equal(loads, 0);
  assert.equal(sent.length, 0);

  const first = await runDailyBoard({ DB: db }, { ...opts, now: at(AFTER) });
  assert.equal(first.sent, 2);
  assert.equal(first.subscribers, 2);
  assert.equal(loads, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((row) => String(row.chatId)).sort(), ['4242', '99']);
  assert.match(sent[0].text, /1200/);
  assert.match(sent[0].text, /https:\/\/example\.test\/board\//);
  assert.equal(sent[0].text.trim().length > 0, true);

  const again = await runDailyBoard({ DB: db }, { ...opts, now: at(LATER) });
  assert.equal(again.sent, 0);
  assert.equal(loads, 1, 'a sent day does not rebuild the paragraph');
  assert.equal(sent.length, 2);
  assert.deepEqual(db.rows('alert_deliveries').map((row) => row.status).sort(), ['sent', 'sent']);

  const next = await runDailyBoard({ DB: db }, { ...opts, now: at(NEXT) });
  assert.equal(next.sent, 2);
  assert.equal(sent.length, 4);
});

test('a chat that turned /daily off gets nothing, including a failed copy still waiting', async () => {
  const db = d1();
  await optIn(db);
  const sent = [];
  const send = async (chatId, text) => {
    sent.push({ chatId, text });
    return { status: 'failed' };
  };
  await runDailyBoard({ DB: db }, { loadBoard: async () => VIEW, send, now: at(AFTER) });
  assert.equal(db.rows('alert_deliveries')[0].status, 'failed');
  await optIn(db);
  const quiet = await runDailyBoard({ DB: db }, {
    loadBoard: async () => { throw new Error('must not load'); },
    send: async () => { throw new Error('must not send'); },
    now: at(LATER),
  });
  assert.equal(quiet.sent, 0);
  assert.equal(quiet.subscribers, 0);
  assert.equal(db.rows('alert_deliveries')[0].status, 'cancelled');
  assert.equal(db.rows('alert_deliveries')[0].last_error, 'daily board off');
});

test('/stop turns the daily board off and drops a waiting send', async () => {
  const db = d1();
  await optIn(db, { lang: 'en' });
  await runDailyBoard({ DB: db }, {
    loadBoard: async () => VIEW,
    send: async () => ({ status: 'failed' }),
    now: at(AFTER),
  });
  const { sent, send } = fakeSend();
  await handleUpdate(msg('/stop'), { DB: db }, { send });
  assert.match(sent.at(-1).text, /All alerts are off/);
  assert.equal(db.rows('alert_daily_subs').length, 0);
  assert.equal(db.rows('alert_deliveries')[0].status, 'cancelled');
  const later = await runDailyBoard({ DB: db }, {
    loadBoard: async () => { throw new Error('must not load'); },
    send: async () => { throw new Error('must not send'); },
    now: at(LATER),
  });
  assert.equal(later.sent, 0);
});

test('a failed daily send retries; an unknown result is not sent again', async () => {
  const failedDb = d1();
  await optIn(failedDb);
  const failedSent = [];
  let fail = true;
  const failedSend = async (chatId, text) => {
    failedSent.push(text);
    if (fail) return { status: 'failed' };
    return { message_id: failedSent.length };
  };
  await runDailyBoard({ DB: failedDb }, { loadBoard: async () => VIEW, send: failedSend, now: at(AFTER) });
  assert.equal(failedDb.rows('alert_deliveries')[0].status, 'failed');
  fail = false;
  const retried = await runDailyBoard({ DB: failedDb }, { loadBoard: async () => VIEW, send: failedSend, now: at(LATER) });
  assert.equal(retried.sent, 1);
  assert.equal(failedSent.length, 2);
  assert.equal(failedDb.rows('alert_deliveries')[0].status, 'sent');
  await runDailyBoard({ DB: failedDb }, { loadBoard: async () => VIEW, send: failedSend, now: at('2026-10-25T04:00:00.000Z') });
  assert.equal(failedSent.length, 2);

  const unknownDb = d1();
  await optIn(unknownDb, { id: 8, username: 'miner_unknown' });
  let calls = 0;
  const unknownSend = async () => { calls += 1; return { status: 'unknown' }; };
  await runDailyBoard({ DB: unknownDb }, { loadBoard: async () => VIEW, send: unknownSend, now: at(AFTER) });
  assert.equal(unknownDb.rows('alert_deliveries')[0].status, 'unknown');
  const second = await runDailyBoard({ DB: unknownDb }, {
    loadBoard: async () => { throw new Error('must not rebuild an unknown send'); },
    send: unknownSend,
    now: at(LATER),
  });
  assert.equal(second.sent, 0);
  assert.equal(calls, 1);
  assert.equal(unknownDb.rows('alert_deliveries')[0].status, 'unknown');
});

test('generation failure does not send an empty message, and a stored failure still retries its text', async () => {
  const db = d1();
  await optIn(db);
  const first = await runDailyBoard({ DB: db }, {
    loadBoard: async () => { throw new Error('rpc down'); },
    formatDailyBoard: () => '',
    send: async () => { throw new Error('must not send'); },
    now: at(AFTER),
  });
  assert.equal(first.sent, 0);
  assert.match(first.errors.join('\n'), /rpc down/);
  assert.equal(db.rows('alert_deliveries').length, 0);

  const empty = await runDailyBoard({ DB: db }, {
    loadBoard: async () => VIEW,
    formatDailyBoard: () => '   ',
    send: async () => { throw new Error('must not send'); },
    now: at(LATER),
  });
  assert.equal(empty.sent, 0);
  assert.match(empty.errors.join('\n'), /empty/);
  assert.equal(db.rows('alert_deliveries').length, 0);

  const stored = d1();
  await optIn(stored, { id: 3, username: 'miner_three' });
  const payload = 'FabX 在挖 1200 台。看板 https://example.test/board/';
  await runDailyBoard({ DB: stored }, {
    loadBoard: async () => VIEW,
    formatDailyBoard: () => payload,
    send: async () => ({ status: 'failed' }),
    now: at(AFTER),
  });
  const retried = [];
  const again = await runDailyBoard({ DB: stored }, {
    loadBoard: async () => { throw new Error('rpc down'); },
    send: async (_chatId, text) => { retried.push(text); return { message_id: 1 }; },
    now: at(LATER),
  });
  assert.equal(again.sent, 1);
  assert.deepEqual(retried, [payload]);
  assert.equal(retried.some((text) => !String(text).trim()), false);
});

test('turning /daily back on the same day still sends if the earlier copy never went out', async () => {
  const db = d1();
  await optIn(db);
  await runDailyBoard({ DB: db }, {
    loadBoard: async () => VIEW,
    send: async () => ({ status: 'failed' }),
    now: at(AFTER),
  });
  await optIn(db);
  await optIn(db);
  const { sent, send } = fakeSend();
  const again = await runDailyBoard({ DB: db }, { loadBoard: async () => VIEW, send, now: at(LATER) });
  assert.equal(again.sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /1200/);
});

test('the alerts cron sends the daily board after 09:00 and also when the chain head is down', async () => {
  const db = d1();
  await optIn(db);
  const { sent, send } = fakeSend();
  const skips = {
    skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true, skipCheap: true,
    loadBoard: async () => VIEW,
    boardUrl: 'https://example.test/board/',
    send,
    snap: SNAP,
  };
  const early = await runCheck({ DB: db }, { ...skips, now: at(BEFORE) });
  assert.equal(early.daily.skipped, 'before_09:00');
  assert.equal(early.sent, 0);
  assert.equal(sent.length, 0);
  const opened = await runCheck({ DB: db }, { ...skips, now: at(AFTER) });
  assert.equal(opened.daily.sent, 1);
  assert.equal(opened.sent, 1);
  assert.equal(sent.length, 1);

  const down = d1();
  await optIn(down, { id: 5, username: 'miner_five' });
  const downSent = [];
  const { snap: _snap, ...withoutSnap } = skips;
  const summary = await runCheck({ DB: down }, {
    ...withoutSnap,
    send: async (chatId, text) => { downSent.push({ chatId, text }); return { message_id: 1 }; },
    chainHead: async () => { throw new Error('RPC unavailable'); },
    now: at(AFTER),
  });
  assert.equal(summary.daily.sent, 1);
  assert.equal(downSent.length, 1);
  assert.match(downSent[0].text, /example\.test\/board\//);
  assert.ok(summary.errors.some((line) => /RPC unavailable/.test(line)));
});
