// TapeOut ecosystem radar: the homepage's first tab. Items come from /api/radar (Leo Labs radar, theme `tapeout`).

export const RADAR_MORE = 'https://leolabs.me/radar?theme=tapeout&utm_source=fabx-miner-desk';

const TEXT = {
  zh: {
    tabRadar: 'TapeOut 雷达', tabCalc: '回本计算器',
    title: 'TapeOut 生态：现在能参与什么',
    sub: 'BSC 和 X Layer 上 TapeOut 生态的新活动，取自官方账号近 7 天的帖子，只留现在还能参与的。每条附原帖，参与前先看原文。信息整理，非投资建议。',
    loading: '正在读取…',
    empty: '这几天官方没有新的可参与活动。想算挖矿回本，看「回本计算器」。',
    error: '雷达暂时读不到，可以直接去完整雷达看。',
    source: '原帖', found: (d) => `${d} 发现`, ends: (d) => `${d} 截止`,
    more: '完整雷达（含其他生态）', calcHint: '已经在挖或打算入场？用回本计算器算成本和回本时间。',
    methods: { points: '积分', quest: '任务', claim: '领取', mint: '铸造', allowlist: '白名单', competition: '活动', yield: '收益', creator: '创作者', node: '节点', launch: '新上线', other: '其他' },
  },
  en: {
    tabRadar: 'TapeOut radar', tabCalc: 'Payback calculator',
    title: 'TapeOut ecosystem: what you can join now',
    sub: 'New activity in the TapeOut ecosystem on BSC and X Layer, taken from official accounts over the last 7 days, keeping only what is still open. Each links the original post; read it before joining. Information only, not investment advice.',
    loading: 'Loading…',
    empty: 'No new open activity from the official accounts in the last few days. For mining payback, use the payback calculator.',
    error: 'The radar is unavailable right now; open the full radar instead.',
    source: 'Post', found: (d) => `found ${d}`, ends: (d) => `ends ${d}`,
    more: 'Full radar (other ecosystems too)', calcHint: 'Mining already, or about to? The payback calculator works out cost and payback time.',
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
const day = (s, lang) => {
  const t = ts(s);
  return t ? new Date(t).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric' }) : '';
};
// Post text carries t.co links and line breaks; the card shows two plain lines.
const clean = (s) => String(s ?? '').replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim();

/** Open items, newest first; ended ones and ones without a safe link drop out. */
export function radarItems(items, nowMs = Date.now()) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => safeUrl(it?.official_url) && it.status !== 'ended' && !(it.deadline && ts(it.deadline) && ts(it.deadline) < nowMs))
    .sort((a, b) => ts(b.observed_at || b.first_seen_at) - ts(a.observed_at || a.first_seen_at));
}

export function radarCards(items, lang, nowMs = Date.now()) {
  const t = radarText(lang);
  return radarItems(items, nowMs).map((it) => {
    const summary = clean((lang === 'zh' && it.summary_zh) || it.summary);
    const meta = [
      `<span class="radar-badge">${esc(t.methods[it.method] || t.methods.other)}</span>`,
      it.chain ? `<span>${esc(it.chain)}</span>` : '',
      day(it.observed_at || it.first_seen_at, lang) ? `<span>${esc(t.found(day(it.observed_at || it.first_seen_at, lang)))}</span>` : '',
      it.deadline && day(it.deadline, lang) ? `<span class="radar-ends">${esc(t.ends(day(it.deadline, lang)))}</span>` : '',
    ].filter(Boolean).join('');
    return `<article class="radar-item">`
      + `<h3>${esc(clean(it.name))}</h3>`
      + `<p class="radar-meta">${meta}</p>`
      + (summary && summary !== clean(it.name) ? `<p class="radar-summary">${esc(summary)}</p>` : '')
      + `<a class="radar-link" href="${esc(safeUrl(it.official_url))}" target="_blank" rel="noopener noreferrer">${esc(t.source)} ↗</a>`
      + `</article>`;
  }).join('');
}
