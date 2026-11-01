// TapeOut radar alerts for chats that turned on /tapeout.
// Reads the Leo Labs opportunity radar (theme pack `tapeout`). Only posts the radar first saw after the chat
// subscribed are sent, at most RADAR_DAILY_CAP per chat per Beijing day, each item once per chat.
// Nothing is sent while the theme is not `hot`. Delivery goes through alert_deliveries (scope 'radar').

import { flushDeliveries, queueDelivery } from './delivery.mjs';
import { beijingDayKey } from './daily.mjs';

export const RADAR_FEED = 'https://leolabs.me/api/radar-activities?theme=tapeout&days=3&limit=50';
export const RADAR_DAILY_CAP = 2;
const MAX_AGE_MS = 48 * 3_600_000;

const METHODS = {
  zh: { points: '积分', quest: '任务', claim: '领取', mint: '铸造', allowlist: '白名单', competition: '活动', yield: '收益', creator: '创作者', node: '节点', launch: '新上线', other: '其他' },
  en: { points: 'Points', quest: 'Quest', claim: 'Claim', mint: 'Mint', allowlist: 'Allowlist', competition: 'Event', yield: 'Yield', creator: 'Creator', node: 'Node', launch: 'Launch', other: 'Other' },
};

const ts = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : 0; };
const clean = (s) => String(s ?? '').replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Open items with a safe link, posted within maxAgeMs (48 hours by default), newest first. */
export function alertableItems(body, nowMs, maxAgeMs = MAX_AGE_MS) {
  const items = Array.isArray(body?.items) ? body.items : [];
  return items
    .filter((it) => it && typeof it.key === 'string' && /^https:\/\//.test(it.official_url || '') && it.status !== 'ended')
    .filter((it) => !(it.deadline && ts(it.deadline) && ts(it.deadline) < nowMs))
    .filter((it) => nowMs - (ts(it.observed_at) || ts(it.first_seen_at)) < maxAgeMs)
    .sort((a, b) => (ts(b.observed_at) || ts(b.first_seen_at)) - (ts(a.observed_at) || ts(a.first_seen_at)));
}

export function themeIsHot(body) {
  return (Array.isArray(body?.themes) ? body.themes : []).some((t) => t?.slug === 'tapeout' && t.status === 'hot');
}

export function radarAlertText(item, lang) {
  const zh = lang === 'zh';
  const method = (METHODS[zh ? 'zh' : 'en'])[item.method] || (zh ? '其他' : 'Other');
  const title = clean(item.name);
  const summary = clean((zh && item.summary_zh) || item.summary);
  const deadline = ts(item.deadline)
    ? new Date(ts(item.deadline)).toLocaleDateString(zh ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric', timeZone: 'Asia/Shanghai' })
    : '';
  return [
    `🛰 ${zh ? 'TapeOut 雷达' : 'TapeOut radar'} · ${method}`,
    cut(title, 140),
    summary && summary !== title ? cut(summary, 280) : '',
    deadline ? (zh ? `截止 ${deadline}` : `Ends ${deadline}`) : '',
    `${zh ? '原帖' : 'Post'}: ${item.official_url}`,
    zh ? '参与前先看原帖，非投资建议。发 /tapeout 关闭。' : 'Read the post before joining; not investment advice. Send /tapeout to turn off.',
  ].filter(Boolean).join('\n');
}

/** Short list for the /tapeout confirmation reply: what is open right now. */
export function radarNowText(body, lang, nowMs, limit = 3) {
  const zh = lang === 'zh';
  const rows = alertableItems(body, nowMs, 7 * 86_400_000).slice(0, limit);
  if (!rows.length) return '';
  return `${zh ? '现在能参与的：' : 'Open right now:'}\n${rows.map((it) => `• ${cut(clean(it.name), 80)}\n  ${it.official_url}`).join('\n')}`;
}

export async function loadRadarFeed(opts = {}) {
  if (opts.loadRadar) return opts.loadRadar();
  const res = await (opts.fetch || fetch)(RADAR_FEED, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`radar feed HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.ok) throw new Error('radar feed not ok');
  return body;
}

// Beijing midnight of the given instant, as an ISO string, for the per-day cap.
function beijingDayStart(now) {
  const [y, m, d] = beijingDayKey(now).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 8 * 3_600_000).toISOString();
}

export async function runRadarAlerts(env, opts = {}) {
  const db = env.DB;
  const now = opts.now || (() => new Date());
  const observed = now();
  const nowMs = observed.getTime();
  const stamp = observed.toISOString();
  const summary = { subscribers: 0, queued: 0, sent: 0, errors: [] };
  const { results: subs } = await db.prepare(`SELECT s.telegram AS telegram, s.lang AS lang, s.updated_at AS since, c.chat_id AS chat_id
    FROM alert_radar_subs s JOIN alert_chats c ON c.telegram = s.telegram WHERE s.enabled = 1`).all();
  const chats = subs.filter((row) => Number.isSafeInteger(Number(row.chat_id)));
  summary.subscribers = chats.length;
  if (chats.length) {
    let body = null;
    try { body = await loadRadarFeed(opts); } catch (error) { summary.errors.push(`radar feed: ${error.message}`); }
    if (body && !themeIsHot(body)) summary.skipped = 'theme_not_hot';
    else if (body) {
      const items = alertableItems(body, nowMs);
      const dayStart = beijingDayStart(observed);
      const statements = [];
      for (const row of chats) {
        const chatId = Number(row.chat_id);
        const counted = await db.prepare(`SELECT COUNT(*) AS n FROM alert_deliveries
          WHERE scope = 'radar' AND recipient = ? AND created_at >= ? AND status != 'cancelled'`).bind(String(chatId), dayStart).first();
        let room = RADAR_DAILY_CAP - (Number(counted?.n) || 0);
        // Only items the radar first saw after this chat (re)subscribed; a fresh subscriber is not flooded with backlog.
        const fresh = items.filter((it) => ts(it.first_seen_at) >= ts(row.since));
        for (const it of fresh) {
          if (room <= 0) break;
          const key = `radar:${chatId}:${it.key}`;
          const seen = await db.prepare('SELECT 1 FROM alert_deliveries WHERE delivery_key = ?').bind(key).first();
          if (seen) continue;
          statements.push(queueDelivery(db, {
            key, scope: 'radar', recipient: chatId, subscriber: row.telegram,
            payload: radarAlertText(it, row.lang === 'zh' ? 'zh' : 'en'), createdAt: stamp,
          }));
          room--;
        }
      }
      for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40));
      summary.queued = statements.length;
    }
  }
  if (opts.send) {
    const flushed = await flushDeliveries(db, { scope: 'radar', send: opts.send, now: () => observed });
    summary.sent += flushed.sent;
    summary.errors.push(...flushed.errors);
  }
  return summary;
}
