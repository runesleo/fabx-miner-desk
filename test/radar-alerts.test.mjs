import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1.mjs';
import { handleUpdate, runCheck } from '../alerts/worker.mjs';
import { RADAR_DAILY_CAP, alertableItems, radarAlertText, runRadarAlerts, themeIsHot } from '../alerts/radar.mjs';

const fakeSend = () => {
  const sent = [];
  return { sent, send: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length }; } };
};
const msg = (text, { id = 4242, username = 'leo_miner', lang = 'zh-hans' } = {}) =>
  ({ update_id: 1, message: { message_id: 1, chat: { id, type: 'private' }, from: { id, username, language_code: lang }, text } });
const at = (iso) => () => new Date(iso);
const item = (key, over = {}) => ({
  key, name: `Item ${key}`, method: 'launch', summary: 'Launch https://t.co/x now', summary_zh: '上线了',
  official_url: `https://x.com/TapeOutCF/status/${key}`, status: 'open', deadline: null,
  observed_at: '2026-11-01T05:00:00Z', first_seen_at: '2026-11-01T05:30:00Z', ...over,
});
const feed = (items, status = 'hot') => ({ ok: true, themes: [{ slug: 'tapeout', status }], items });

test('/tapeout and ?start=tapeout opt in with what is open now; toggling off and /stop clear it', async () => {
  const db = d1();
  const { sent, send } = fakeSend();
  const loadRadar = async () => feed([item('1')]);
  const started = await handleUpdate(msg('/start tapeout'), { DB: db }, { send, now: at('2026-11-01T06:00:00Z'), loadRadar });
  assert.equal(started.command, '/tapeout');
  assert.match(sent.at(-1).text, /TapeOut 雷达提醒已打开/);
  assert.match(sent.at(-1).text, /现在能参与的：\n• Item 1\n  https:\/\/x\.com\/TapeOutCF\/status\/1/);
  assert.equal(db.rows('alert_radar_subs')[0].enabled, 1);
  await handleUpdate(msg('/tapeout'), { DB: db }, { send, now: at('2026-11-01T06:01:00Z'), loadRadar });
  assert.match(sent.at(-1).text, /TapeOut 雷达提醒已关闭/);
  assert.equal(db.rows('alert_radar_subs')[0].enabled, 0);
  await handleUpdate(msg('/tapeout', { lang: 'en' }), { DB: db }, { send, loadRadar: async () => { throw new Error('down'); } });
  assert.match(sent.at(-1).text, /^TapeOut 雷达提醒已打开。[^\n]*$/, 'a feed outage still confirms, without the list');
  await handleUpdate(msg('/help'), { DB: db }, { send });
  assert.match(sent.at(-1).text, /\/tapeout/);
  await handleUpdate(msg('/stop'), { DB: db }, { send });
  assert.equal(db.rows('alert_radar_subs').length, 0);
});

test('radar alerts send only items first seen after subscribing, once each, capped per Beijing day', async () => {
  const db = d1();
  const sub = fakeSend();
  await handleUpdate(msg('/tapeout'), { DB: db }, { send: sub.send, now: at('2026-11-01T05:00:00Z'), loadRadar: async () => feed([]) });
  const items = [
    item('old', { first_seen_at: '2026-11-01T04:00:00Z' }),
    item('a', { observed_at: '2026-11-01T06:00:00Z', first_seen_at: '2026-11-01T06:05:00Z' }),
    item('b', { observed_at: '2026-11-01T06:10:00Z', first_seen_at: '2026-11-01T06:15:00Z' }),
    item('c', { observed_at: '2026-11-01T06:20:00Z', first_seen_at: '2026-11-01T06:25:00Z' }),
  ];
  const { sent, send } = fakeSend();
  const run = (iso, list = items, status = 'hot') => runRadarAlerts({ DB: db }, { send, now: at(iso), loadRadar: async () => feed(list, status) });
  const first = await run('2026-11-01T07:00:00Z');
  assert.equal(first.subscribers, 1);
  assert.equal(first.sent, RADAR_DAILY_CAP);
  assert.deepEqual(sent.map((s) => s.text.split('\n')[1]).sort(), ['Item b', 'Item c'], 'the newest two are picked');
  assert.ok(sent.every((s) => s.chatId === '4242'));
  assert.equal((await run('2026-11-01T07:30:00Z')).sent, 0, 'cap holds for the rest of the Beijing day');
  const nextDay = await run('2026-11-01T16:30:00Z'); // 00:30 Beijing, Nov 2
  assert.equal(nextDay.sent, 1);
  assert.equal(sent.at(-1).text.split('\n')[1], 'Item a');
  assert.equal((await run('2026-11-01T17:00:00Z')).sent, 0, 'each item once; the pre-subscription item never');
  assert.equal((await run('2026-11-02T08:00:00Z', [item('d', { observed_at: '2026-11-02T07:00:00Z', first_seen_at: '2026-11-02T07:01:00Z' })], 'cooling')).skipped, 'theme_not_hot');
});

test('a radar feed outage is an error in the summary, not a crash; runCheck carries the radar pass', async () => {
  const db = d1();
  await handleUpdate(msg('/tapeout'), { DB: db }, { send: fakeSend().send, now: at('2026-11-01T05:00:00Z'), loadRadar: async () => feed([]) });
  const out = await runRadarAlerts({ DB: db }, { send: fakeSend().send, now: at('2026-11-01T07:00:00Z'), loadRadar: async () => { throw new Error('HTTP 502'); } });
  assert.deepEqual(out.errors, ['radar feed: HTTP 502']);
  const { send } = fakeSend();
  const summary = await runCheck({ DB: db }, { send, now: at('2026-11-01T07:00:00Z'), snap: { head: 1, headTimestamp: 1, blockTime: 3 },
    skipGovernance: true, skipWeekly: true, skipMarket: true, skipBscIndex: true, skipCheap: true, skipDaily: true,
    loadRadar: async () => feed([item('z', { observed_at: '2026-11-01T06:00:00Z', first_seen_at: '2026-11-01T06:00:00Z' })]) });
  assert.equal(summary.radar.sent, 1);
});

test('alert text is plain, bilingual, and filters unsafe, ended, past-deadline and stale items', () => {
  const zh = radarAlertText(item('1', { deadline: '2026-11-03T12:00:00Z' }), 'zh');
  assert.match(zh, /^🛰 TapeOut 雷达 · 新上线\nItem 1\n上线了\n截止 11月3日\n原帖: https:\/\/x\.com\/TapeOutCF\/status\/1\n/);
  assert.match(radarAlertText(item('1'), 'en'), /Launch now\nPost: /);
  const now = Date.parse('2026-11-01T12:00:00Z');
  const rows = alertableItems({ items: [item('ok'), item('js', { official_url: 'javascript:1' }), item('end', { status: 'ended' }),
    item('past', { deadline: '2026-10-31T00:00:00Z' }), item('stale', { observed_at: '2026-10-29T00:00:00Z' })] }, now);
  assert.deepEqual(rows.map((r) => r.key), ['ok']);
  assert.equal(themeIsHot(feed([])), true);
  assert.equal(themeIsHot({ themes: [{ slug: 'tapeout', status: 'watch' }] }), false);
});
