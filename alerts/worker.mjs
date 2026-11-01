// FabX Miner Desk — rig income alert worker (Cloudflare Worker, separate from the Pages site).
// Cron: re-measure every watched address with the same read-only engine as the site and send a
// Telegram message when a rig's income-relevant state changes (revoked, stopped, demoted, NFT
// transfer, measured output drop) or when FabX PodMining emits a governance event.
// Webhook: the Telegram bot (/start, /watch, /unwatch, /list, /feedback, /cheap, /threshold, /daily, /zh, /en, /stop, /help).
// A website button opens t.me/<bot>?start=<one-time token>; /start redeems it and binds the chat.
// /start zh|en still picks a language. Otherwise the chat's stored language is kept, and only a chat
// never seen before falls back to the Telegram client language. Every reply uses that one language.
// The same cron also scans official FabX listings with the site's buy-versus-build comparison.
// Stores: chat id + username + language, per-rig last status, per-address check time, alert events.
// Never stores IPs, names or phone numbers. Never signs or sends transactions.

import { alertMeasure, chainHead, CFG, logsChunked } from '../desk.mjs';
import { podChainHead, podRigs } from '../pod.mjs';
import { buildAssetUrl, siteUrlFromEnv } from '../share.mjs';
import { demotedKindsInRange, defaultGetLogs, governanceLogsInRange, GOVERNANCE_TOPICS } from './events.mjs';
import { runWeeklyDigest } from './weekly.mjs';
import { queueDelivery, flushDeliveries } from './delivery.mjs';
import { runMarketUpdate } from './market.mjs';
import { runBscIndex } from './bsc-index.mjs';
import { runCheapAlerts } from './cheap.mjs';
import { runDailyBoard } from './daily.mjs';
import { normalizeThreshold, redeemBindToken, BOT_USERNAME } from './bind.mjs';

export { BOT_USERNAME };
export const DROP_RATIO = 0.3;               // alert when measured output falls by 30% or more
export const MAX_ADDRESSES_PER_RUN = 40;     // oldest-checked first; the rest wait for the next cron
export const MAX_WATCH_PER_CHAT = 20;        // same cap as the website sign-up form
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TELEGRAM_API = 'https://api.telegram.org';
const MAX_UPDATE_BODY = 64 * 1024;
export const MAX_FEEDBACK_CHARS = 500;

const short = address => `${address.slice(0, 6)}…${address.slice(-4)}`;
const fmt = n => n == null ? '?' : (Math.round(n * 1000) / 1000).toString();

const TEXT = {
  zh: {
    start: (n) => `已连接。${n ? `你的 Telegram 用户名在网站上登记了 ${n} 个地址，` : ''}矿机收益异动（撤销、停挖、失去最优首创、NFT 转手、产出骤降）或 FabX 挖矿合约治理动作时会在这里通知你。\n\n命令：\n/watch 0x地址 — 盯一个地址\n/unwatch 0x地址 — 取消\n/list — 查看在盯的地址\n/feedback 一句话 — 提建议或报问题\n/cheap — 开关便宜矿机提醒\n/threshold 20 — 比自建便宜至少百分之几才提醒\n/daily — 每天收一条全网看板\n/stop — 关闭全部提醒\n\n从网页订阅请点「用 Telegram 订阅」。只发 /start、链接过期或已经用过，都不会订上。发 /daily 每天收一条全网看板。`,
    help: '命令：/watch 0x地址、/unwatch 0x地址、/list、/feedback 一句话、/cheap、/threshold 20、/daily、/en、/stop。网站：',
    badAddress: '地址格式不对，应为 0x 开头的 40 位十六进制。例如：/watch 0x1234…',
    watched: (a) => `已开始盯 ${a}。第一次观测只记录基线，之后有收益异动会通知你。`,
    limit: `一个账号最多盯 ${MAX_WATCH_PER_CHAT} 个地址。`,
    unwatched: (a) => `已取消 ${a}。`,
    notWatched: (a) => `没有在盯 ${a}。`,
    list: (rows) => rows.length ? `在盯 ${rows.length} 个地址：\n${rows.map(r => `• ${r}`).join('\n')}` : '还没有在盯的地址。用 /watch 0x地址 添加。',
    stopped: '已关闭全部提醒并删除你的订阅记录。随时可以再 /start。',
    lang: '已切换为中文。',
    feedbackEmpty: '请在 /feedback 后面写一句话，例如：/feedback 想看 BSC 上的矿机。',
    feedbackLong: `反馈最多 ${MAX_FEEDBACK_CHARS} 字。`,
    feedbackOk: '收到，谢谢。能修的会直接修，做好了在这里告诉你。',
    tokenMissing: '这个链接里没有可用的订阅码。请回到网页，重新点「用 Telegram 订阅」。',
    tokenStale: '这个订阅链接过期了，或者已经用过。请回到网页，重新点「用 Telegram 订阅」。',
    bindFailed: '订阅没写上。请回到网页，重新点「用 Telegram 订阅」。',
    bound: (r) => {
      const lines = [];
      if (r.cheap) lines.push(`订好了。便宜矿机提醒已打开：比自己建便宜 ${r.threshold}% 及以上，会告诉你是哪一台、多少钱、便宜多少、官方购买链接。每条挂单只说一次。`);
      else lines.push('订好了。');
      if (r.watched) lines.push(`也会盯 ${short(r.address)}：停了、被取消、转手或日产大跌时通知你。`);
      if (r.addressLimited) lines.push(`地址没订上：一个账号最多盯 ${MAX_WATCH_PER_CHAT} 个。`);
      lines.push('命令：/cheap 开关便宜矿机提醒，/threshold 20 改比例，/stop 全部退订。');
      lines.push('发 /daily 每天收一条全网看板。');
      return lines.join('\n');
    },
    cheapOn: (n) => `便宜矿机提醒已打开。比自建便宜 ${n}% 及以上会通知你。`,
    cheapOff: '便宜矿机提醒已关闭。地址停产提醒不受影响。',
    thresholdShow: (n, on) => `当前是比自建便宜 ${n}% 及以上才提醒，状态：${on ? '开' : '关'}。修改：/threshold 25`,
    thresholdNone: '还没订便宜矿机提醒。发 /cheap 打开（默认比自建便宜 20% 及以上），或 /threshold 20 自己设。',
    thresholdSet: (n, on) => `已改为比自建便宜 ${n}% 及以上才提醒。当前是${on ? '开' : '关'}。`,
    thresholdBad: '请发 /threshold 20 这样的整数，范围 1 到 90。20 表示比自建便宜两成及以上才提醒。',
    dailyOn: '每日看板已打开。每天早上 9 点后发一条全网看板。再发一次 /daily 就关掉。',
    dailyOff: '每日看板已关闭。别的提醒照旧。',
    alert: {
      revoked: (rows) => rows.map(r => `⚠️ 举证撤销 #${r.rigId}：产出永久归零，不能再开挖`).join('\n'),
      stopped: (rows) => rows.map(r => `⚠️ 停挖 #${r.rigId}：产出归零；冷静期结束后需持有人手动重开`).join('\n'),
      demoted: (rows) => rows.map(r => `📉 失去最优首创 #${r.rigId}：失去设计溢价，按当前持有人的基础权重及加成继续挖`).join('\n'),
      demoted_kick: (rows) => rows.map(r => `📉 被 kick 移出榜位 #${r.rigId}：失去设计溢价，按当前持有人的基础权重及加成继续挖`).join('\n'),
      demoted_reclaim: (rows) => rows.map(r => `📉 榜位被 reclaim 夺走 #${r.rigId}：失去设计溢价，按当前持有人的基础权重及加成继续挖`).join('\n'),
      demoted_start: (rows) => rows.map(r => `📉 被更低成本设计抢榜 #${r.rigId}：失去设计溢价，按当前持有人的基础权重及加成继续挖`).join('\n'),
      nft_out: (rows) => rows.map(r => `🔀 NFT 已转出 #${r.rigId}：矿机与未领收益归新持有人，对你产出归零`).join('\n'),
      drop: (rows) => `📉 实测产出骤降：${rows.map(r => `#${r.rigId} ${fmt(r.previousFabPerDay)}→${fmt(r.fabPerDay)} FAB/日`).join('；')}`,
      governance_paused: () => '⛔ FabX PodMining 已暂停：写操作可能 revert，规则或产出可能受影响（链上已核实 owner 可暂停）。',
      governance_processor: () => '⚙️ FabX PodMining ProcessorSet：处理器系数已改，可能影响权重与产出。',
      governance_upgraded: () => '⬆️ FabX PodMining 已升级实现：合约规则可能已变更，请关注官方说明。',
      governance_boost: () => '⚡ FabX PodMining BoostSet：质押加成合约地址已变更，工本乘数 F 可能受影响。',
    },
    address: (a) => `地址 ${a}`,
    governanceHeader: 'FabX 挖矿合约治理',
    footer: (url) => `查看资产卡：${url}`,
  },
  en: {
    start: (n) => `Connected. ${n ? `Your Telegram username has ${n} address${n > 1 ? 'es' : ''} signed up on the website; ` : ''}you will be messaged here on rig income changes (revoked, stopped, demoted, NFT transfer, sharp output drop) or FabX PodMining governance events.\n\nCommands:\n/watch 0xaddress — watch an address\n/unwatch 0xaddress — stop watching\n/list — addresses being watched\n/feedback one line — suggest or report\n/cheap — toggle cheap-rig alerts\n/threshold 20 — how much cheaper than building, in percent\n/daily — one network board note each day\n/stop — turn off all alerts\n\nTo subscribe from the website, tap “Subscribe with Telegram”. A plain /start, an expired link, or a used link does not subscribe you. Send /daily to get one network board note each day.`,
    help: 'Commands: /watch 0xaddress, /unwatch 0xaddress, /list, /feedback one line, /cheap, /threshold 20, /daily, /zh, /stop. Website: ',
    badAddress: 'That is not an address: expected 0x followed by 40 hex characters, e.g. /watch 0x1234…',
    watched: (a) => `Watching ${a}. The first observation only records a baseline; you will be notified on income-relevant changes.`,
    limit: `One account can watch at most ${MAX_WATCH_PER_CHAT} addresses.`,
    unwatched: (a) => `Stopped watching ${a}.`,
    notWatched: (a) => `${a} was not being watched.`,
    list: (rows) => rows.length ? `Watching ${rows.length} address${rows.length > 1 ? 'es' : ''}:\n${rows.map(r => `• ${r}`).join('\n')}` : 'No addresses yet. Add one with /watch 0xaddress.',
    stopped: 'All alerts are off and your subscription records are deleted. Send /start any time to come back.',
    lang: 'Switched to English.',
    feedbackEmpty: 'Write one line after /feedback, e.g. /feedback show BSC rigs too.',
    feedbackLong: `Feedback is limited to ${MAX_FEEDBACK_CHARS} characters.`,
    feedbackOk: 'Got it, thanks. Fixable things get fixed; you will hear here when it is done.',
    tokenMissing: 'This link has no usable subscribe code. Go back to the page and tap “Subscribe with Telegram” again.',
    tokenStale: 'This subscribe link has expired or was already used. Go back to the page and tap “Subscribe with Telegram” again.',
    bindFailed: 'The subscription was not saved. Go back to the page and tap “Subscribe with Telegram” again.',
    bound: (r) => {
      const lines = [];
      if (r.cheap) lines.push(`Subscribed. Cheap-rig alerts are on: when an official listing is at least ${r.threshold}% cheaper than building, you get the rig, the price, how much cheaper, and the official buy link. Each listing is sent once.`);
      else lines.push('Subscribed.');
      if (r.watched) lines.push(`Also watching ${short(r.address)} for stops, removals, transfers, and sharp output drops.`);
      if (r.addressLimited) lines.push(`That address was not added: one account can watch at most ${MAX_WATCH_PER_CHAT}.`);
      lines.push('Commands: /cheap toggles cheap-rig alerts, /threshold 20 changes the percent, /stop unsubscribes from everything.');
      lines.push('Send /daily to get one network board note each day.');
      return lines.join('\n');
    },
    cheapOn: (n) => `Cheap-rig alerts are on. You will be notified when a listing is at least ${n}% cheaper than building.`,
    cheapOff: 'Cheap-rig alerts are off. Address stop alerts are unchanged.',
    thresholdShow: (n, on) => `Current threshold: ${n}% cheaper than building. Status: ${on ? 'on' : 'off'}. Change it with /threshold 25.`,
    thresholdNone: 'Cheap-rig alerts are not on. Send /cheap to turn them on (default 20% cheaper than building), or /threshold 20 to set the percent.',
    thresholdSet: (n, on) => `Threshold is now ${n}% cheaper than building. Alerts are ${on ? 'on' : 'off'}.`,
    thresholdBad: 'Send an integer like /threshold 20, from 1 to 90. 20 means notify when a listing is at least 20% cheaper than building.',
    dailyOn: 'Daily board is on. You get one network board note after 9:00 Beijing time. Send /daily again to turn it off.',
    dailyOff: 'Daily board is off. Your other alerts stay as they are.',
    alert: {
      revoked: (rows) => rows.map(r => `⚠️ Revoked #${r.rigId}: output is permanently zero; cannot restart`).join('\n'),
      stopped: (rows) => rows.map(r => `⚠️ Stopped #${r.rigId}: output zero until the holder manually restarts after cooldown`).join('\n'),
      demoted: (rows) => rows.map(r => `📉 Demoted #${r.rigId}: design premium lost; mining continues with the current holder’s base weight and boosts`).join('\n'),
      demoted_kick: (rows) => rows.map(r => `📉 Kicked from optimal #${r.rigId}: design premium lost; mining continues with the current holder’s base weight and boosts`).join('\n'),
      demoted_reclaim: (rows) => rows.map(r => `📉 Reclaimed over #${r.rigId}: design premium lost; mining continues with the current holder’s base weight and boosts`).join('\n'),
      demoted_start: (rows) => rows.map(r => `📉 Outranked on start #${r.rigId}: design premium lost; mining continues with the current holder’s base weight and boosts`).join('\n'),
      nft_out: (rows) => rows.map(r => `🔀 NFT transferred #${r.rigId}: rig and pending rewards go to the new holder; zero for you`).join('\n'),
      drop: (rows) => `📉 Measured output drop: ${rows.map(r => `#${r.rigId} ${fmt(r.previousFabPerDay)}→${fmt(r.fabPerDay)} FAB/day`).join('; ')}`,
      governance_paused: () => '⛔ FabX PodMining paused: writes may revert; rules or output may change (verified owner can pause).',
      governance_processor: () => '⚙️ FabX PodMining ProcessorSet: processor multiplier changed; weights and output may change.',
      governance_upgraded: () => '⬆️ FabX PodMining upgraded: implementation changed; rules may have changed.',
      governance_boost: () => '⚡ FabX PodMining BoostSet: boost contract changed; b* multiplier F may change.',
    },
    address: (a) => `Address ${a}`,
    governanceHeader: 'FabX PodMining governance',
    footer: (url) => `Asset card: ${url}`,
  },
};

export const langOf = code => (typeof code === 'string' && code.toLowerCase().startsWith('zh')) ? 'zh' : 'en';

export function chatKey(from, chat) {
  const username = typeof from?.username === 'string' ? from.username.trim().replace(/^@/, '').toLowerCase() : '';
  return /^[a-z0-9_]{5,32}$/.test(username) ? username : `chat:${chat.id}`;
}

const validFab = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const stateFields = {
  chainStatus: 'chain_status', optimal: 'optimal', bonus: 'bonus', owner: 'owner', status: 'status', fabPerDay: 'fab_per_day', premiumActive: 'premium_active',
};

function rigStateRow(rig, head, observedAt, previous = {}) {
  const chainStatus = Number.isInteger(rig.chainStatus) && rig.chainStatus >= 0 && rig.chainStatus <= 3 ? rig.chainStatus : null;
  const fab = chainStatus === 2 || chainStatus === 3 ? 0
    : ['mining', 'stopped'].includes(rig.measureStatus) && validFab(rig.fabPerDay) ? rig.fabPerDay : null;
  const fresh = {
    chainStatus,
    optimal: typeof rig.optimal === 'boolean' ? Number(rig.optimal) : null,
    bonus: validFab(rig.bonus) ? rig.bonus : null,
    owner: typeof rig.owner === 'string' && ADDRESS.test(rig.owner) ? rig.owner.toLowerCase() : null,
    status: chainStatus === 2 || chainStatus === 3 ? 'stopped'
      : ['mining', 'stopped'].includes(rig.measureStatus) && fab != null ? rig.measureStatus : null,
    fabPerDay: fab,
    premiumActive: chainStatus != null && typeof rig.optimal === 'boolean' && validFab(rig.bonus)
      ? Number(chainStatus === 1 && rig.optimal && rig.bonus > 0) : null,
  };
  let fieldObservedAt = {};
  try { fieldObservedAt = JSON.parse(previous.field_observed_at || '{}') || {}; } catch { /* legacy baseline */ }
  const row = { rigId: String(rig.id), head, observedAt, fieldObservedAt };
  previous = { ...previous, premium_active: previous.premium_active ?? (previous.optimal != null && previous.bonus != null
    ? Number(previous.chain_status === 1 && previous.optimal === 1 && previous.bonus > 0) : null) };
  for (const [property, column] of Object.entries(stateFields)) {
    row[property] = fresh[property] ?? previous[column] ?? null;
    if (fresh[property] != null) fieldObservedAt[column] = observedAt;
    else if (previous[column] != null && !fieldObservedAt[column]) fieldObservedAt[column] = previous.observed_at || null;
  }
  return { row, fresh, interrupted: Object.values(fresh).some(value => value == null) };
}

// Only fresh evidence detects a change. Each valid field has its own retained
// baseline and time; unknown readings never erase known owners or output.
export function planRigChanges(previousRows, walletRes, address, { head, observedAt, demotedByKey = new Map() }) {
  const previous = new Map(previousRows.map(row => [String(row.rig_id), row]));
  const addr = address.toLowerCase();
  const upserts = [], alerts = [], seen = new Set(), deletes = [];
  let interrupted = walletRes.discovery?.complete !== true;
  const demoteKind = rig => demotedByKey.get(rig.minerKey?.toLowerCase()) || 'demoted';
  for (const rig of walletRes.rigs || []) {
    const rigId = String(rig.id);
    seen.add(rigId);
    const prev = previous.get(rigId);
    const { row, fresh, interrupted: partial } = rigStateRow(rig, head, observedAt, prev);
    const transferred = fresh.owner && fresh.owner !== addr;
    interrupted ||= partial && !transferred;
    if (prev) {
      if (prev.chain_status != null && prev.chain_status !== 2 && fresh.chainStatus === 2) {
        alerts.push({ kind: 'revoked', rigId });
      } else if (prev.chain_status === 1 && fresh.chainStatus === 3) {
        alerts.push({ kind: 'stopped', rigId });
      } else if ((prev.premium_active ?? Number(prev.optimal === 1 && prev.bonus > 0)) === 1 && fresh.premiumActive === 0 && fresh.optimal === 0 && fresh.bonus === 0 && fresh.chainStatus === 1) {
        alerts.push({ kind: demoteKind(rig), rigId, fabPerDay: fresh.fabPerDay, previousFabPerDay: prev.fab_per_day });
      } else if (fresh.chainStatus !== 2 && fresh.chainStatus !== 3 && ['mining', 'stopped'].includes(fresh.status) && prev.fab_per_day > 0 && fresh.fabPerDay != null
        && fresh.fabPerDay <= prev.fab_per_day * (1 - DROP_RATIO)) {
        alerts.push({ kind: 'drop', rigId, fabPerDay: fresh.fabPerDay, previousFabPerDay: prev.fab_per_day });
      }
    }
    if (prev?.owner?.toLowerCase() === addr && transferred) alerts.push({ kind: 'nft_out', rigId });
    if (transferred) deletes.push(rigId);
    else upserts.push(row);
  }
  // Current-wallet coverage does not prove successful enrichment of previously
  // tracked IDs. Keep missing baselines until their owner is explicitly read.
  if ([...previous.keys()].some(rigId => !seen.has(rigId))) interrupted = true;
  return { upserts, alerts, deletes, interrupted };
}

const ALERT_KIND_ORDER = [
  'revoked', 'stopped', 'demoted_kick', 'demoted_reclaim', 'demoted_start', 'demoted',
  'nft_out', 'drop',
  'governance_paused', 'governance_processor', 'governance_upgraded', 'governance_boost',
];

const BSC_PLAIN = {
  zh: {
    revoked: (row) => `⚠️ #${row.rigId} 被取消了：这台不再产出 BEM`,
    stopped: (row) => `⚠️ #${row.rigId} 停了：这台不再产出 BEM`,
    drop: (rows) => `📉 实测日产大跌：${rows.map(row => `#${row.rigId} ${fmt(row.previousFabPerDay)}→${fmt(row.fabPerDay)} BEM/天`).join('；')}`,
  },
  en: {
    revoked: (row) => `⚠️ #${row.rigId} removed: this rig no longer earns BEM`,
    stopped: (row) => `⚠️ #${row.rigId} stopped: this rig no longer earns BEM`,
    drop: (rows) => `📉 Measured daily output dropped: ${rows.map(row => `#${row.rigId} ${fmt(row.previousFabPerDay)}→${fmt(row.fabPerDay)} BEM/day`).join('; ')}`,
  },
};

const BSC_DEMOTION = {
  zh: {
    demoted: r => `📉 失去最优首创 #${r.rigId}：设计溢价归零，权重降到 b*·P，基础挖矿继续`,
    demoted_kick: r => `📉 被 kick 移出榜位 #${r.rigId}：只失去最优首创溢价，基础挖矿继续`,
    demoted_reclaim: r => `📉 榜位被 reclaim 夺走 #${r.rigId}：设计溢价归零，按 b*·P 继续挖`,
    demoted_start: r => `📉 被更低成本设计抢榜 #${r.rigId}：设计溢价归零，按 b*·P 继续挖`,
  },
  en: {
    demoted: r => `📉 Demoted #${r.rigId}: design bonus removed; weight is now b*·P, base mining continues`,
    demoted_kick: r => `📉 Kicked from optimal #${r.rigId}: bonus removed, base mining continues`,
    demoted_reclaim: r => `📉 Reclaimed over #${r.rigId}: bonus removed, mining continues at b*·P`,
    demoted_start: r => `📉 Outranked on start #${r.rigId}: bonus removed, mining continues at b*·P`,
  },
};

export function formatAlert(lang, address, alerts, siteUrl, { global: isGlobal = false, chain = 'fabx' } = {}) {
  const t = TEXT[lang] || TEXT.en;
  const base = siteUrlFromEnv({ SITE_URL: siteUrl });
  const lines = isGlobal ? [t.governanceHeader] : [t.address(short(address))];
  for (const kind of ALERT_KIND_ORDER) {
    const rows = alerts.filter(a => a.kind === kind);
    if (!rows.length) continue;
    const fn = t.alert[kind];
    if (fn) {
      let line = fn(rows);
      if (chain === 'bsc' && kind.startsWith('demoted')) {
        line = rows.map((BSC_DEMOTION[lang] || BSC_DEMOTION.en)[kind]).join('\n');
      }
      if (chain === 'bsc' && BSC_PLAIN[lang]?.[kind]) {
        const say = BSC_PLAIN[lang][kind];
        line = kind === 'drop' ? say(rows) : rows.map(say).join('\n');
      }
      lines.push(line);
    }
  }
  const rigIds = [...new Set(alerts.map(a => a.rigId).filter(Boolean))];
  const linkChain = chain === 'bsc' ? 'bsc' : 'fabx';
  const link = isGlobal ? base : buildAssetUrl(base, { address, chain: linkChain, rigId: rigIds.length === 1 ? rigIds[0] : undefined });
  lines.push(t.footer(link));
  return lines.join('\n');
}

export function telegramSender(token, fetchImpl = (...args) => globalThis.fetch(...args), { timeoutMs = 10_000 } = {}) {
  if (!token) throw new Error('FABX_DESK_BOT_TOKEN is not configured');
  return async (chatId, text) => {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Telegram sendMessage timed out; delivery outcome unknown'));
        controller.abort();
      }, timeoutMs);
    });
    const request = async () => {
      const res = await fetchImpl(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      const body = await res.json().catch(() => null);
      if (body?.ok === false) {
        const error = new Error(`Telegram sendMessage ${res.status}: ${body.description || 'rejected'}`);
        error.deliveryStatus = 'failed'; // API explicitly confirms it did not accept the message.
        throw error;
      }
      if (!res.ok || body?.ok !== true || !Number.isSafeInteger(body?.result?.message_id) || body.result.message_id <= 0) {
        throw new Error(`Telegram sendMessage ${res.status}: acknowledgement incomplete`);
      }
      return body.result;
    };
    try { return await Promise.race([request(), timedOut]); }
    finally { clearTimeout(timer); }
  };
}

async function measureAddress(address, snap, trackIds) {
  return alertMeasure(address, snap, { trackIds });
}

export function watchStateAddress(chain, address) {
  const addr = String(address || '').toLowerCase();
  return chain === 'bsc' ? `bsc:${addr}` : addr;
}

// podRigs rows use status/fabPerDay. planRigChanges keeps its X Layer field names.
export function adaptPodForAlerts(walletRes, address) {
  const addr = String(address || '').toLowerCase();
  const rigs = (walletRes?.rigs || []).map((rig) => {
    const status = rig.status;
    let chainStatus = null;
    let measureStatus = 'unread';
    let fabPerDay = null;
    if (status === 'revoked') {
      chainStatus = 2; measureStatus = 'stopped'; fabPerDay = 0;
    } else if (status === 'stopped') {
      chainStatus = 3; measureStatus = 'stopped'; fabPerDay = 0;
    } else if (status === 'mining' && validFab(rig.fabPerDay)) {
      chainStatus = 1; measureStatus = 'mining'; fabPerDay = rig.fabPerDay;
    }
    const optimal = typeof rig.optimal === 'boolean' ? rig.optimal : null;
    const bonus = chainStatus === 1 && optimal === true ? 1 : chainStatus === 1 && optimal === false ? 0 : null;
    return {
      id: String(rig.id),
      chainStatus,
      optimal,
      bonus,
      owner: chainStatus != null && ADDRESS.test(addr) ? addr : null,
      measureStatus,
      fabPerDay,
      minerKey: null,
    };
  });
  return { ...walletRes, address: addr, rigs };
}

function ensureAlertWallet(walletRes, address) {
  const rigs = walletRes?.rigs || [];
  if (rigs.some(rig => rig.measureStatus != null || Number.isInteger(rig.chainStatus))) return walletRes;
  return adaptPodForAlerts(walletRes || {}, address);
}

async function readPodForAlerts(address, snap, trackIds, opts) {
  const raw = opts.measureBsc
    ? await opts.measureBsc(address, snap, trackIds)
    : await podRigs(address, snap, () => {}, { timeoutMs: 60_000 });
  return ensureAlertWallet(raw, address);
}

async function measureSignupRows(db, rows, { chain, snap, now, send, siteUrl, measure, summary, opts }) {
  for (const watch of rows) {
    const address = String(watch.address).toLowerCase();
    const stateAddress = watchStateAddress(chain, address);
    summary.addresses++;
    const observedAt = now().toISOString();
    const addressState = await db.prepare('SELECT revision, head FROM alert_address_state WHERE address = ?').bind(stateAddress).first();
    if (addressState?.head > snap.head) continue;
    const revision = Number(addressState?.revision || 0);
    const guardSql = 'COALESCE((SELECT revision FROM alert_address_state WHERE address = ?), 0) = ?';
    const guardValues = [stateAddress, revision];
    const { results: previousRows } = await db.prepare('SELECT * FROM alert_rig_state WHERE address = ?').bind(stateAddress).all();
    const lastHead = previousRows.reduce((max, row) => Math.max(max, Number(row.head) || 0), 0);
    let walletRes;
    try { walletRes = await measure(address, snap, previousRows.map(row => row.rig_id)); }
    catch (error) {
      summary.errors.push(`${short(address)}: ${error.message}`);
      await db.prepare(`INSERT INTO alert_address_state (address, last_checked_at, last_error, head, revision)
        SELECT ?, ?, ?, ?, 1 WHERE ${guardSql}
        ON CONFLICT(address) DO UPDATE SET last_checked_at = excluded.last_checked_at, last_error = excluded.last_error,
        head = excluded.head, revision = alert_address_state.revision + 1`)
        .bind(stateAddress, observedAt, String(error.message).slice(0, 500), snap.head, ...guardValues).run();
      continue;
    }
    const keys = (walletRes.rigs || []).map(row => row.minerKey).filter(Boolean);
    let demotedByKey = new Map();
    if (chain !== 'bsc' && lastHead > 0 && keys.length) {
      try {
        const getLogs = opts.demotedGetLogs || ((from, to) => defaultGetLogs(from, to));
        demotedByKey = await demotedKindsInRange(lastHead + 1, snap.head, keys, { fetchImpl: opts.fetch, getLogs });
      } catch (error) { summary.errors.push(`${short(address)} demoted logs: ${error.message}`); }
    }
    const plan = planRigChanges(previousRows, walletRes, address, { head: snap.head, observedAt, demotedByKey });
    const statements = plan.upserts.map(row => db.prepare(`INSERT INTO alert_rig_state
        (address, rig_id, chain_status, optimal, bonus, owner, status, fab_per_day, head, observed_at, field_observed_at, premium_active)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guardSql}
        ON CONFLICT(address, rig_id) DO UPDATE SET chain_status = excluded.chain_status, optimal = excluded.optimal,
        bonus = excluded.bonus, owner = excluded.owner, status = excluded.status, fab_per_day = excluded.fab_per_day,
        head = excluded.head, observed_at = excluded.observed_at, field_observed_at = excluded.field_observed_at, premium_active = excluded.premium_active`)
      .bind(stateAddress, row.rigId, row.chainStatus, row.optimal, row.bonus, row.owner, row.status, row.fabPerDay, row.head, row.observedAt,
        JSON.stringify(row.fieldObservedAt), row.premiumActive, ...guardValues));
    for (const rigId of plan.deletes) statements.push(db.prepare(`DELETE FROM alert_rig_state WHERE address = ? AND rig_id = ? AND ${guardSql}`).bind(stateAddress, rigId, ...guardValues));
    const deliveryKeys = [];
    let undeliverable = 0;
    if (plan.alerts.length) {
      const { results: recipients } = await db.prepare(`SELECT s.telegram AS telegram, s.lang AS signup_lang, c.chat_id AS chat_id, c.lang AS chat_lang
          FROM alert_signups s LEFT JOIN alert_chats c ON c.telegram = s.telegram WHERE s.address = ? AND s.chain = ?`).bind(address, chain).all();
      for (const recipient of recipients) {
        if (recipient.chat_id == null) { undeliverable++; continue; }
        const key = chain === 'bsc'
          ? `rig:bsc:${address}:${snap.head}:${JSON.stringify(plan.alerts)}:${recipient.chat_id}`
          : `rig:${address}:${snap.head}:${JSON.stringify(plan.alerts)}:${recipient.chat_id}`;
        deliveryKeys.push(key);
        statements.push(queueDelivery(db, { key, scope: 'rig', recipient: recipient.chat_id, address, subscriber: recipient.telegram, guard: { address: stateAddress, revision },
          payload: formatAlert(recipient.chat_lang || recipient.signup_lang, address, plan.alerts, siteUrl, { chain: chain === 'bsc' ? 'bsc' : 'fabx' }), createdAt: observedAt }));
      }
      statements.push(...plan.alerts.map(alert => db.prepare(`INSERT INTO alert_events (address, rig_id, kind, fab_per_day, previous_fab_per_day, recipients, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guardSql}`).bind(address, alert.rigId, alert.kind, alert.fabPerDay ?? null, alert.previousFabPerDay ?? null,
        recipients.filter(row => row.chat_id != null).length, observedAt, ...guardValues)));
    }
    statements.push(db.prepare(`INSERT INTO alert_address_state (address, last_checked_at, last_error, rigs, measured, head, revision)
      SELECT ?, ?, ?, ?, ?, ?, 1 WHERE ${guardSql}
      ON CONFLICT(address) DO UPDATE SET last_checked_at = excluded.last_checked_at, last_error = excluded.last_error, rigs = excluded.rigs,
      measured = excluded.measured, head = excluded.head, revision = alert_address_state.revision + 1`)
      .bind(stateAddress, observedAt, plan.interrupted ? 'partial_read' : null, walletRes.circuits, walletRes.measured, snap.head, ...guardValues));
    const saved = await db.batch(statements);
    if (!saved.at(-1)?.meta?.changes) continue;
    summary.alerts += plan.alerts.length;
    summary.undeliverable += undeliverable;
    const delivered = await flushDeliveries(db, { scope: 'rig', send, now: () => new Date(observedAt), keys: deliveryKeys });
    summary.sent += delivered.sent; summary.errors.push(...delivered.errors);
  }
}

async function measureBscSignups(db, { limit, now, send, siteUrl, summary, opts }) {
  const { results: rows } = await db.prepare(`SELECT address FROM alert_signups WHERE chain = 'bsc'
      GROUP BY address ORDER BY address LIMIT ?`).bind(limit).all();
  if (!rows.length) return;
  let podSnap = opts.podSnap || null;
  if (!podSnap) {
    try { podSnap = await (opts.podChainHead || podChainHead)(); }
    catch (error) {
      summary.errors.push(`bsc head: ${error.message}`);
      const observedAt = now().toISOString();
      for (const row of rows) {
        const stateAddress = watchStateAddress('bsc', row.address);
        await db.prepare(`INSERT INTO alert_address_state (address, last_checked_at, last_error, revision)
          VALUES (?, ?, ?, 1)
          ON CONFLICT(address) DO UPDATE SET last_checked_at = excluded.last_checked_at, last_error = excluded.last_error,
          revision = alert_address_state.revision + 1`)
          .bind(stateAddress, observedAt, String(error.message).slice(0, 500)).run();
      }
      return;
    }
  }
  await measureSignupRows(db, rows, {
    chain: 'bsc', snap: podSnap, now, send, siteUrl, summary, opts,
    measure: (address, snap, trackIds) => readPodForAlerts(address, snap, trackIds, opts),
  });
}

async function governanceGetLogs(fromBlock, toBlock) {
  return logsChunked({ address: CFG.mining, topics: [GOVERNANCE_TOPICS] }, fromBlock, toBlock);
}

export async function runGovernanceCheck(env, opts = {}) {
  const db = env.DB;
  const send = opts.send || telegramSender(env.FABX_DESK_BOT_TOKEN, opts.fetch);
  const now = opts.now || (() => new Date());
  const siteUrl = siteUrlFromEnv(env);
  const summary = { events: 0, sent: 0, errors: [] };
  // Stored payloads do not depend on fresh node access. Retry them first.
  const retried = await flushDeliveries(db, { scope: 'governance', send, now });
  summary.sent += retried.sent; summary.errors.push(...retried.errors);
  let snap;
  try { snap = opts.snap || await (opts.chainHead || chainHead)(); }
  catch (error) { summary.errors.push(`governance head: ${error.message}`); return summary; }
  const row = await db.prepare("SELECT value FROM alert_worker_state WHERE key = 'governance_head'").first('value');
  const from = row ? Number(row) + 1 : Math.max(0, snap.head - 5_000);
  const getLogs = opts.governanceGetLogs || ((lo, hi) => governanceGetLogs(lo, hi));
  let events;
  try { events = await governanceLogsInRange(from, snap.head, getLogs); }
  catch (error) { summary.errors.push(`governance logs: ${error.message}`); return summary; }
  const fresh = [];
  for (const event of events) {
    const seen = await db.prepare('SELECT 1 FROM alert_governance_seen WHERE tx_hash = ? AND log_index = ?')
      .bind(event.txHash, event.logIndex).first();
    if (!seen) fresh.push(event);
  }
  const { results: chats } = await db.prepare('SELECT telegram, chat_id, lang FROM alert_chats').all();
  const observedAt = now().toISOString();
  const statements = [
    ...fresh.map(event => db.prepare(`INSERT INTO alert_events (address, rig_id, kind, fab_per_day, previous_fab_per_day, recipients, created_at)
      SELECT 'global', '0', ?, NULL, NULL, ?, ? WHERE NOT EXISTS
      (SELECT 1 FROM alert_governance_seen WHERE tx_hash = ? AND log_index = ?)`)
      .bind(event.kind, chats.length, observedAt, event.txHash, event.logIndex)),
    ...fresh.map(event => db.prepare('INSERT INTO alert_governance_seen (tx_hash, log_index, kind, block_number, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tx_hash, log_index) DO NOTHING')
      .bind(event.txHash, event.logIndex, event.kind, event.blockNumber, observedAt)),
    db.prepare("INSERT INTO alert_worker_state (key, value) VALUES ('governance_head', ?) ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(alert_worker_state.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)")
      .bind(String(snap.head)),
  ];
  const keys = [];
  // One event key per recipient also survives overlapping governance reads.
  for (const event of fresh) for (const chat of chats) {
    if (chat.chat_id == null) continue;
    const key = `governance:${event.txHash}:${event.logIndex}:${chat.chat_id}`;
    keys.push(key);
    statements.push(queueDelivery(db, { key, scope: 'governance', recipient: chat.chat_id, subscriber: chat.telegram,
      payload: formatAlert(chat.lang, '', [{ kind: event.kind }], siteUrl, { global: true }), createdAt: observedAt }));
  }
  const saved = await db.batch(statements);
  summary.events = saved.slice(0, fresh.length).reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
  const delivered = await flushDeliveries(db, { scope: 'governance', send, now: () => new Date(observedAt), keys });
  summary.sent += delivered.sent; summary.errors.push(...delivered.errors);
  return summary;
}

async function updateBscIndex(db, opts, summary) {
  if (opts.skipBscIndex) return;
  try { summary.bscIndex = await runBscIndex(db, opts); }
  catch (error) { summary.errors.push(`bsc index: ${error.message}`); }
}

async function runCheapPass(env, opts, summary, scan) {
  if (opts.skipCheap) return;
  try {
    const cheap = await runCheapAlerts(env, { ...opts, skipScan: !scan });
    summary.cheap = cheap;
    summary.sent += cheap.sent || 0;
    summary.errors.push(...(cheap.errors || []));
  } catch (error) {
    summary.errors.push(`cheap: ${error.message}`);
  }
}

async function runDailyPass(env, opts, summary) {
  if (opts.skipDaily) return;
  try {
    const daily = await runDailyBoard(env, opts);
    summary.daily = daily;
    summary.sent += daily.sent || 0;
    summary.errors.push(...(daily.errors || []));
  } catch (error) {
    summary.errors.push(`daily: ${error.message}`);
  }
}

export async function runCheck(env, opts = {}) {
  const db = env.DB;
  const now = opts.now || (() => new Date());
  const send = opts.send || telegramSender(env.FABX_DESK_BOT_TOKEN, opts.fetch);
  const measure = opts.measure || measureAddress;
  const siteUrl = siteUrlFromEnv(env);
  const limit = opts.limit || MAX_ADDRESSES_PER_RUN;
  const summary = { addresses: 0, alerts: 0, sent: 0, undeliverable: 0, errors: [], weekly: null, market: null, cheap: null, daily: null };
  const retry = await flushDeliveries(db, { scope: 'rig', send, now });
  summary.sent += retry.sent; summary.errors.push(...retry.errors);
  let snap;
  try { snap = opts.snap || await (opts.chainHead || chainHead)(); }
  catch (error) {
    summary.errors.push(`chain head: ${error.message}`);
    // Mark addresses as interrupted even when the entire head read fails.
    await db.prepare(`INSERT INTO alert_address_state (address, last_checked_at, last_error)
      SELECT DISTINCT address, ?, ? FROM alert_signups WHERE chain = 'xlayer'
      ON CONFLICT(address) DO UPDATE SET last_checked_at = excluded.last_checked_at, last_error = excluded.last_error,
      revision = alert_address_state.revision + 1`)
      .bind(now().toISOString(), String(error.message).slice(0, 500)).run();
    if (!opts.skipGovernance) {
      const govRetry = await flushDeliveries(db, { scope: 'governance', send, now });
      summary.errors.push(...govRetry.errors);
    }
    // Weekly sends use stored reports and handle unavailable fresh measurements.
    if (!opts.skipWeekly) {
      try { summary.weekly = await runWeeklyDigest(env, { ...opts, send, now, measure: async () => { throw error; } }); }
      catch (weeklyError) { summary.errors.push(`weekly: ${weeklyError.message}`); }
    }
    try {
      await measureBscSignups(db, { limit, now, send, siteUrl, summary, opts });
    } catch (bscError) {
      summary.errors.push(`bsc: ${bscError.message}`);
    }
    await runCheapPass(env, { ...opts, send, now }, summary, false);
    await updateBscIndex(db, opts, summary);
    await runDailyPass(env, { ...opts, send, now }, summary);
    return summary;
  }
  if (!opts.skipWeekly) {
    try {
      summary.weekly = await runWeeklyDigest(env, { ...opts, snap, send, measure, now });
      summary.errors.push(...(summary.weekly.errors || []));
    } catch (error) { summary.errors.push(`weekly: ${error.message}`); }
  }
  if (!opts.skipGovernance) {
    const gov = await runGovernanceCheck(env, { ...opts, snap, send });
    summary.errors.push(...gov.errors);
  }
  if (!opts.skipMarket) {
    try { summary.market = await runMarketUpdate(db, snap, opts); }
    catch (error) { summary.errors.push(`market: ${error.message}`); }
  }
  const { results: pending } = await db.prepare(`SELECT s.address AS address, s.chain AS chain FROM alert_signups s
      LEFT JOIN alert_address_state a ON a.address = CASE WHEN s.chain = 'bsc' THEN 'bsc:' || s.address ELSE s.address END
      GROUP BY s.address, s.chain ORDER BY MIN(COALESCE(a.last_checked_at, '')) ASC LIMIT ?`).bind(limit).all();
  const shared = { now, send, siteUrl, summary, opts };
  await measureSignupRows(db, pending.filter(row => row.chain !== 'bsc'), { ...shared, chain: 'xlayer', snap, measure });
  const bscRows = pending.filter(row => row.chain === 'bsc');
  if (bscRows.length) {
    let podSnap = opts.podSnap || null;
    if (!podSnap) {
      try { podSnap = await (opts.podChainHead || podChainHead)(); }
      catch (error) {
        summary.errors.push(`bsc head: ${error.message}`);
        const observedAt = now().toISOString();
        for (const row of bscRows) {
          await db.prepare(`INSERT INTO alert_address_state (address, last_checked_at, last_error, revision) VALUES (?, ?, ?, 1)
            ON CONFLICT(address) DO UPDATE SET last_checked_at = excluded.last_checked_at, last_error = excluded.last_error,
            revision = alert_address_state.revision + 1`)
            .bind(watchStateAddress('bsc', row.address), observedAt, String(error.message).slice(0, 500)).run();
        }
        podSnap = null;
      }
    }
    if (podSnap) {
      await measureSignupRows(db, bscRows, {
        ...shared, chain: 'bsc', snap: podSnap,
        measure: (address, podHead, trackIds) => readPodForAlerts(address, podHead, trackIds, opts),
      });
    }
  }
  await runCheapPass(env, { ...opts, send, now }, summary, true);
  await updateBscIndex(db, opts, summary);
  await runDailyPass(env, { ...opts, send, now }, summary);
  return summary;
}

async function readUpdate(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPDATE_BODY) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_UPDATE_BODY) return null;
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export async function handleUpdate(update, env, opts = {}) {
  const db = env.DB;
  const now = opts.now || (() => new Date());
  const send = opts.send || telegramSender(env.FABX_DESK_BOT_TOKEN, opts.fetch);
  const siteUrl = siteUrlFromEnv(env);
  const message = update?.message || update?.edited_message;
  if (!message?.chat || message.chat.type !== 'private' || typeof message.text !== 'string') return { handled: false };
  const chat = message.chat, key = chatKey(message.from, chat);
  const text = message.text.trim();
  const [command = '', arg = ''] = text.split(/\s+/);
  const cmd = command.toLowerCase().replace(/@.*$/, '');
  const stamp = now().toISOString();
  const stored = await db.prepare('SELECT lang FROM alert_chats WHERE telegram = ?').bind(key).first('lang');
  const chosen = cmd === '/zh' ? 'zh' : cmd === '/en' ? 'en' : (cmd === '/start' && /^(zh|en)$/i.test(arg)) ? arg.toLowerCase() : null;
  const lang = chosen || (stored === 'zh' || stored === 'en' ? stored : langOf(message.from?.language_code));
  const t = TEXT[lang];
  const reply = text => send(chat.id, text);
  const linkChat = () => db.prepare(`INSERT INTO alert_chats (telegram, chat_id, lang, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(telegram) DO UPDATE SET chat_id = excluded.chat_id, lang = excluded.lang, updated_at = excluded.updated_at`)
    .bind(key, chat.id, lang, stamp, stamp);
  if (cmd === '/start') {
    if (arg && !/^(zh|en)$/i.test(arg)) {
      let result;
      try {
        result = await redeemBindToken(db, arg, {
          telegram: key, chatId: chat.id, now: new Date(stamp), maxAddresses: MAX_WATCH_PER_CHAT,
        });
      } catch {
        await reply(t.bindFailed);
        return { handled: true, command: cmd, lang, error: 'bind_failed' };
      }
      if (result.error) {
        await linkChat().run();
        const replyLang = result.lang === 'zh' || result.lang === 'en' ? result.lang : lang;
        const copy = TEXT[replyLang] || TEXT.en;
        await reply(result.error === 'missing' ? copy.tokenMissing : copy.tokenStale);
        return { handled: true, command: cmd, lang: replyLang, error: result.error };
      }
      const replyLang = result.lang === 'zh' ? 'zh' : 'en';
      await reply((TEXT[replyLang] || TEXT.en).bound(result));
      return { handled: true, command: cmd, lang: replyLang };
    }
    await linkChat().run();
    const row = await db.prepare('SELECT COUNT(*) AS n FROM alert_signups WHERE telegram = ?').bind(key).first();
    await reply(t.start(Number(row?.n) || 0));
    return { handled: true, command: cmd, lang };
  }
  if (cmd === '/zh' || cmd === '/en') {
    await linkChat().run();
    await reply(t.lang);
    return { handled: true, command: cmd, lang };
  }
  if (cmd === '/watch' || cmd === '/unwatch') {
    if (!ADDRESS.test(arg)) { await reply(t.badAddress); return { handled: true, command: cmd, lang, error: 'bad_address' }; }
    const address = arg.toLowerCase();
    if (cmd === '/unwatch') {
      const { meta } = await db.prepare('DELETE FROM alert_signups WHERE address = ? AND telegram = ?').bind(address, key).run();
      await reply(meta?.changes ? t.unwatched(short(address)) : t.notWatched(short(address)));
      return { handled: true, command: cmd, lang };
    }
    const existing = await db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN address = ? AND chain = 'xlayer' THEN 1 ELSE 0 END) AS same FROM alert_signups WHERE telegram = ?`)
      .bind(address, key).first();
    if (!Number(existing?.same) && Number(existing?.n) >= MAX_WATCH_PER_CHAT) { await reply(t.limit); return { handled: true, command: cmd, lang, error: 'limit' }; }
    await db.batch([
      linkChat(),
      db.prepare(`INSERT INTO alert_signups (address, telegram, lang, chain, created_at, updated_at) VALUES (?, ?, ?, 'xlayer', ?, ?)
        ON CONFLICT(address, telegram, chain) DO UPDATE SET lang = excluded.lang, updated_at = excluded.updated_at`).bind(address, key, lang, stamp, stamp),
    ]);
    await reply(t.watched(short(address)));
    return { handled: true, command: cmd, lang };
  }
  if (cmd === '/list') {
    const { results } = await db.prepare(`SELECT s.address, s.chain, a.last_checked_at, a.last_error FROM alert_signups s
      LEFT JOIN alert_address_state a ON a.address = CASE WHEN s.chain = 'bsc' THEN 'bsc:' || s.address ELSE s.address END
      WHERE s.telegram = ? ORDER BY s.created_at`).bind(key).all();
    const chainName = (code) => code === 'bsc' ? 'BSC TapeOut' : 'X Layer';
    await reply(t.list(results.map(row => `${row.address} · ${chainName(row.chain)} — ${row.last_error || (row.last_checked_at &&
      (!Number.isFinite(Date.parse(row.last_checked_at)) || Date.parse(stamp) - Date.parse(row.last_checked_at) > 90 * 60_000))
      ? (lang === 'zh' ? '监测中断' : 'Monitoring interrupted')
      : row.last_checked_at ? (lang === 'zh' ? '监测正常' : 'Monitoring active') : (lang === 'zh' ? '尚未检查' : 'Not checked yet')}
${row.last_checked_at ? `${lang === 'zh' ? '最后检查' : 'Last check'}: ${row.last_checked_at}` : ''}`.trim())));
    return { handled: true, command: cmd, lang };
  }
  if (cmd === '/feedback') {
    const body = text.slice(command.length).trim();
    if (!body) { await reply(t.feedbackEmpty); return { handled: true, command: cmd, lang, error: 'empty' }; }
    if (body.length > MAX_FEEDBACK_CHARS) { await reply(t.feedbackLong); return { handled: true, command: cmd, lang, error: 'too_long' }; }
    await db.prepare('INSERT INTO feedback (text, lang, source, page, telegram, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
      .bind(body, lang, 'bot', key, stamp).run();
    await reply(t.feedbackOk);
    return { handled: true, command: cmd, lang };
  }
  if (cmd === '/cheap') {
    const row = await db.prepare('SELECT threshold_pct, enabled FROM alert_cheap_subs WHERE telegram = ?').bind(key).first();
    const enabled = row ? (Number(row.enabled) ? 0 : 1) : 1;
    const threshold = Number(row?.threshold_pct) || 20;
    const statements = [
      linkChat(),
      db.prepare(`INSERT INTO alert_cheap_subs (telegram, threshold_pct, enabled, lang, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(telegram) DO UPDATE SET enabled = excluded.enabled, lang = excluded.lang, updated_at = excluded.updated_at`)
        .bind(key, threshold, enabled, lang, stamp, stamp),
    ];
    if (!enabled) {
      statements.push(db.prepare(`UPDATE alert_deliveries SET status = 'cancelled', updated_at = ?, last_error = 'cheap alerts off'
        WHERE scope = 'cheap' AND subscriber = ? AND status IN ('pending', 'failed')`).bind(stamp, key));
    }
    await db.batch(statements);
    await reply(enabled ? t.cheapOn(threshold) : t.cheapOff);
    return { handled: true, command: cmd, lang };
  }
  if (cmd === '/threshold') {
    if (!arg) {
      const row = await db.prepare('SELECT threshold_pct, enabled FROM alert_cheap_subs WHERE telegram = ?').bind(key).first();
      await reply(row ? t.thresholdShow(Number(row.threshold_pct), Number(row.enabled) === 1) : t.thresholdNone);
      return { handled: true, command: cmd, lang };
    }
    const next = normalizeThreshold(arg);
    if (next == null) { await reply(t.thresholdBad); return { handled: true, command: cmd, lang, error: 'bad_threshold' }; }
    const row = await db.prepare('SELECT threshold_pct, enabled FROM alert_cheap_subs WHERE telegram = ?').bind(key).first();
    const enabled = row ? Number(row.enabled) : 1;
    const previous = row ? Number(row.threshold_pct) : null;
    const statements = [
      linkChat(),
      db.prepare(`INSERT INTO alert_cheap_subs (telegram, threshold_pct, enabled, lang, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(telegram) DO UPDATE SET threshold_pct = excluded.threshold_pct, lang = excluded.lang, updated_at = excluded.updated_at`)
        .bind(key, next, enabled, lang, stamp, stamp),
    ];
    // A higher bar must drop undelivered copy before a head-read failure retries it.
    if (previous != null && next > previous) {
      statements.push(db.prepare(`UPDATE alert_deliveries SET status = 'cancelled', updated_at = ?, last_error = 'threshold raised'
        WHERE scope = 'cheap' AND subscriber = ? AND status IN ('pending', 'failed')`).bind(stamp, key));
    }
    await db.batch(statements);
    await reply(t.thresholdSet(next, enabled === 1));
    return { handled: true, command: cmd, lang };
  }
  if (cmd === '/daily') {
    const row = await db.prepare('SELECT enabled FROM alert_daily_subs WHERE telegram = ?').bind(key).first();
    const enabled = row ? (Number(row.enabled) ? 0 : 1) : 1;
    const statements = [
      linkChat(),
      db.prepare(`INSERT INTO alert_daily_subs (telegram, enabled, lang, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(telegram) DO UPDATE SET enabled = excluded.enabled, lang = excluded.lang, updated_at = excluded.updated_at`)
        .bind(key, enabled, lang, stamp, stamp),
    ];
    if (!enabled) {
      statements.push(db.prepare(`UPDATE alert_deliveries SET status = 'cancelled', updated_at = ?, last_error = 'daily board off'
        WHERE scope = 'daily' AND subscriber = ? AND status IN ('pending', 'failed')`).bind(stamp, key));
    }
    await db.batch(statements);
    await reply(enabled ? t.dailyOn : t.dailyOff);
    return { handled: true, command: cmd, lang };
  }
  if (cmd === '/stop') {
    await db.batch([
      db.prepare('DELETE FROM alert_signups WHERE telegram = ?').bind(key),
      db.prepare('DELETE FROM alert_cheap_subs WHERE telegram = ?').bind(key),
      db.prepare('DELETE FROM alert_daily_subs WHERE telegram = ?').bind(key),
      db.prepare(`UPDATE alert_deliveries SET status = 'cancelled', updated_at = ?, last_error = 'unsubscribed'
        WHERE subscriber = ? AND status IN ('pending', 'failed')`).bind(stamp, key),
      db.prepare('DELETE FROM alert_chats WHERE telegram = ?').bind(key),
    ]);
    await reply(t.stopped);
    return { handled: true, command: cmd, lang };
  }
  await reply(t.help + siteUrl);
  return { handled: true, command: '/help', lang };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/telegram' && request.method === 'POST') {
      const secret = env.TELEGRAM_WEBHOOK_SECRET;
      if (!secret || request.headers.get('x-telegram-bot-api-secret-token') !== secret) return new Response(null, { status: 403 });
      const update = await readUpdate(request);
      if (!update) return new Response(null, { status: 400 });
      try { await handleUpdate(update, env); } catch (error) { console.error('telegram update failed', error); }
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/health') return new Response('ok', { headers: { 'cache-control': 'no-store' } });
    return new Response(null, { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCheck(env).then(summary => console.log('alert check', JSON.stringify(summary)), error => console.error('alert check failed', error)));
  },
};
