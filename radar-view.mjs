// TapeOut ecosystem radar: the homepage's first tab. Items come from /api/radar (Leo Labs radar, theme `tapeout`).

export const RADAR_MORE = 'https://leolabs.me/radar?theme=tapeout&utm_source=fabx-miner-desk';
export const RADAR_BOT = 'https://t.me/fabx_miner_desk_bot?start=tapeout';

const DAY_MS = 86_400_000;

const TEXT = {
  zh: {
    back: '← 返回 TapeOut 生态站', nav: { now: '今天能参与', eco: '生态地图', tools: '工具' },
    siteName: 'TapeOut 生态站', unofficial: '非官方',
    docTitle: 'TapeOut 生态站（非官方）· 活动、项目、工具',
    live: '数据取自官方账号 · 自动更新',
    title: 'TapeOut 生态：现在能做什么',
    sub: 'BSC 和 X Layer 上 TapeOut 生态的活动、项目和工具，一处看全。由 Leo Labs 整理，非官方，非投资建议。',
    stats: { open: '可参与活动', projects: '生态项目', sources: '官方来源' },
    nowTitle: '今天能参与', nowSub: '取自官方账号近 7 天的帖子，只留现在还能参与的。参与前先看原帖。',
    toolsTitle: 'FabX 工具',
    tools: { calc: ['回本计算器', '建机还是买现成矿机，多久回本'], check: ['矿机查验', '按编号查一台矿机的真实产出'], board: ['全网看板', '全网算力、矿机数和价格'], start: ['新手入门', '从零开始挖 FAB 的步骤'] },
    all: '全部',
    loading: '正在读取…',
    empty: '这几天官方没有新的可参与活动。想算挖矿回本，看「回本计算器」。',
    error: '雷达暂时读不到，可以直接去完整雷达看。',
    source: '看原帖', isNew: '新',
    ago: (n, unit) => `${n} ${{ m: '分钟', h: '小时', d: '天' }[unit]}前`, justNow: '刚刚',
    left: (d) => (d <= 0 ? '今天截止' : `还剩 ${d} 天`),
    botTitle: 'Telegram 提醒', botBody: '有新的可参与活动时推给你，每天最多 2 条。',
    moreTitle: '完整机会雷达', moreBody: '其他生态、空投、积分活动都在这里。',
    methods: { points: '积分', quest: '任务', claim: '领取', mint: '铸造', allowlist: '白名单', competition: '活动', yield: '收益', creator: '创作者', node: '节点', launch: '新上线', other: '其他' },
  },
  en: {
    back: '← Back to TapeOut Hub', nav: { now: 'Open now', eco: 'Projects', tools: 'Tools' },
    siteName: 'TapeOut Hub', unofficial: 'Unofficial',
    docTitle: 'TapeOut Hub (unofficial) · activity, projects, tools',
    live: 'From official accounts · updated automatically',
    title: 'TapeOut ecosystem: what you can do now',
    sub: 'Activity, projects and tools across the TapeOut ecosystem on BSC and X Layer, in one place. Curated by Leo Labs; unofficial, not investment advice.',
    stats: { open: 'Open activity', projects: 'Projects', sources: 'Official sources' },
    nowTitle: 'Open now', nowSub: 'From official accounts over the last 7 days, keeping only what is still open. Read the post before joining.',
    toolsTitle: 'FabX tools',
    tools: { calc: ['Payback calculator', 'Build or buy a rig, and how long payback takes'], check: ['Rig check', 'Measured output of one rig by number'], board: ['Network board', 'Network hashpower, rig count and prices'], start: ['Getting started', 'Steps to start mining FAB from zero'] },
    all: 'All',
    loading: 'Loading…',
    empty: 'No new open activity from the official accounts in the last few days. For mining payback, use the payback calculator.',
    error: 'The radar is unavailable right now; open the full radar instead.',
    source: 'Read post', isNew: 'New',
    ago: (n, unit) => `${n}${unit} ago`, justNow: 'just now',
    left: (d) => (d <= 0 ? 'ends today' : `${d}d left`),
    botTitle: 'Telegram alerts', botBody: 'Get new open activity pushed to you, at most 2 a day.',
    moreTitle: 'Full opportunity radar', moreBody: 'Other ecosystems, airdrops and points campaigns.',
    methods: { points: 'Points', quest: 'Quest', claim: 'Claim', mint: 'Mint', allowlist: 'Allowlist', competition: 'Event', yield: 'Yield', creator: 'Creator', node: 'Node', launch: 'Launch', other: 'Other' },
  },
};

export const radarText = (lang) => TEXT[lang === 'zh' ? 'zh' : 'en'];

/** Read /api/radar; any failure is one state, `error`, so the page can point at the full radar instead. */
export async function fetchRadar(url, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(url);
    const body = res.ok ? await res.json() : null;
    return body?.ok ? { status: 'ok', items: Array.isArray(body.items) ? body.items : [] } : { status: 'error', items: [] };
  } catch {
    return { status: 'error', items: [] };
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
const ts = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : 0; };
const seenAt = (it) => ts(it.observed_at) || ts(it.first_seen_at);
// Post text carries t.co links and line breaks; the card shows two plain lines.
const clean = (s) => String(s ?? '').replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim();
const methodKey = (m, t) => (t.methods[m] ? m : 'other');
const CJK = /[\u3400-\u9fff]/;

/** Card title and summary. In Chinese, an English post title gives way to the first clause of the Chinese summary. */
export function cardText(it, lang) {
  const name = clean(it.name);
  const zh = clean(it.summary_zh);
  if (lang !== 'zh' || !zh || CJK.test(name)) return { title: name, summary: clean((lang === 'zh' && zh) || it.summary) };
  const m = /^(.{4,48}?)(?:[。！？!?：:]| - )\s*(.+)$/.exec(zh);
  return m ? { title: m[1].trim(), summary: m[2].trim() } : { title: zh.length > 40 ? `${zh.slice(0, 39)}…` : zh, summary: zh.length > 40 ? zh : '' };
}

/** `@handle` of an x.com / twitter.com post link, else the link's host. */
export function sourceOf(url) {
  const safe = safeUrl(url);
  if (!safe) return '';
  try {
    const u = new URL(safe);
    const handle = /^\/([A-Za-z0-9_]{1,15})\/status\//.exec(u.pathname)?.[1];
    return /(^|\.)(x|twitter)\.com$/.test(u.hostname) && handle ? `@${handle}` : u.hostname.replace(/^www\./, '');
  } catch { return ''; }
}

function ago(ms, nowMs, t) {
  const diff = Math.max(0, nowMs - ms);
  if (diff < 60_000) return t.justNow;
  if (diff < 3_600_000) return t.ago(Math.floor(diff / 60_000), 'm');
  if (diff < DAY_MS) return t.ago(Math.floor(diff / 3_600_000), 'h');
  return t.ago(Math.floor(diff / DAY_MS), 'd');
}

/** Open items, newest first; ended ones and ones without a safe link drop out. */
export function radarItems(items, nowMs = Date.now()) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => safeUrl(it?.official_url) && it.status !== 'ended' && !(it.deadline && ts(it.deadline) && ts(it.deadline) < nowMs))
    .sort((a, b) => seenAt(b) - seenAt(a));
}

/** Header numbers: open items, how many were posted in the last 24 hours, distinct sources. */
export function radarStats(items, nowMs = Date.now()) {
  const rows = radarItems(items, nowMs);
  return {
    open: rows.length,
    fresh: rows.filter((it) => seenAt(it) && nowMs - seenAt(it) < DAY_MS).length,
    sources: new Set(rows.map((it) => sourceOf(it.official_url)).filter(Boolean)).size,
  };
}

/** Method filter chips with counts; empty when every open item has the same method. */
export function radarFilters(items, lang, selected = 'all', nowMs = Date.now()) {
  const t = radarText(lang);
  const rows = radarItems(items, nowMs);
  const counts = new Map();
  for (const it of rows) { const k = methodKey(it.method, t); counts.set(k, (counts.get(k) || 0) + 1); }
  if (counts.size < 2) return '';
  const chip = (key, label, n) => `<button type="button" class="radar-chip" data-method="${esc(key)}" aria-pressed="${selected === key}">${esc(label)} <span>${n}</span></button>`;
  return chip('all', t.all, rows.length)
    + [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => chip(k, t.methods[k], n)).join('');
}

export function radarCards(items, lang, nowMs = Date.now(), method = 'all') {
  const t = radarText(lang);
  return radarItems(items, nowMs)
    .filter((it) => method === 'all' || methodKey(it.method, t) === method)
    .map((it) => {
      const key = methodKey(it.method, t);
      const { title, summary } = cardText(it, lang);
      // `first_seen_at` is when the radar ingested the post (a backfill makes it today); freshness follows the post time.
      const fresh = seenAt(it) && nowMs - seenAt(it) < DAY_MS;
      const daysLeft = it.deadline && ts(it.deadline) ? Math.floor((ts(it.deadline) - nowMs) / DAY_MS) : null;
      const source = sourceOf(it.official_url);
      const top = [
        `<span class="radar-badge m-${esc(key)}">${esc(t.methods[key])}</span>`,
        fresh ? `<span class="radar-new">${esc(t.isNew)}</span>` : '',
        it.chain ? `<span class="radar-chain">${esc(it.chain)}</span>` : '',
        seenAt(it) ? `<span class="radar-ago">${esc(ago(seenAt(it), nowMs, t))}</span>` : '',
      ].filter(Boolean).join('');
      const foot = [
        source ? `<span class="radar-source">${esc(source)}</span>` : '',
        daysLeft != null ? `<span class="radar-ends">${esc(t.left(daysLeft))}</span>` : '',
      ].filter(Boolean).join('');
      return `<article class="radar-item m-${esc(key)}">`
        + `<p class="radar-top">${top}</p>`
        + `<h3>${esc(title)}</h3>`
        + (summary && summary !== title ? `<p class="radar-summary">${esc(summary)}</p>` : '')
        + `<p class="radar-foot">${foot}<a class="radar-link" href="${esc(safeUrl(it.official_url))}" target="_blank" rel="noopener noreferrer">${esc(t.source)} ↗</a></p>`
        + `</article>`;
    }).join('');
}
