// TapeOut ecosystem map: the homepage's project directory (unofficial).
// Every link was checked against the project's own X profile on 2026-11-01 (website and Telegram from the
// profile, page answering 200). Contract addresses are left to the official sites on purpose.

export const ECOSYSTEM_CHECKED = '2026-11-01';

export const PROJECTS = [
  {
    id: 'tapeout', name: 'TapeOut', chain: 'BSC', role: 'protocol', x: 'TapeOutWorld',
    site: 'https://tapeout.net/', tg: 'https://t.me/TapeOutnet',
    zh: '协议本体：处理器、晶体管、电路市场、$BEM 挖矿，BEM 可 1:1 跨到 X Layer。',
    en: 'The protocol: processors, transistors, circuit market and $BEM mining; BEM bridges 1:1 to X Layer.',
  },
  {
    id: 'fabx', name: 'Fab X', chain: 'X Layer', role: 'protocol', x: 'Fabx_global',
    site: 'https://fabx.tech/', tg: 'https://t.me/fabx_tech',
    zh: 'X Layer 上的 TapeOut：用 NAND、LATCH 设计电路挖 FAB，电路可在官方市场买卖。',
    en: 'TapeOut on X Layer: design circuits from NAND and LATCH to mine FAB; circuits trade on the official market.',
  },
  {
    id: 'tapeoutcf', name: 'TapeOut Community Foundation', chain: '', role: 'community', x: 'TapeOutCF',
    zh: '社区基金会，和 X Layer 一起办开发者加速计划，发生态公告。',
    en: 'Community foundation; runs the developer accelerator with X Layer and posts ecosystem news.',
  },
  {
    id: 'ignix', name: 'Ignix', chain: 'X Layer', role: 'app', x: 'Ignixbot',
    site: 'https://ignix.bot/', tg: 'https://t.me/IGNIXOfficial',
    zh: 'X Layer 发射台：公平发币，另有 FAB 挖矿金库和矿机份额化（FABS）。',
    en: 'X Layer launchpad: fair launches, plus a FAB mining vault and miner fractionalization (FABS).',
  },
  {
    id: 'tapeup', name: 'TapeUP', chain: 'DeWEB', role: 'app', x: 'tapeupio',
    site: 'https://tapeup.io/', tg: 'https://t.me/tapeupio',
    zh: '基于 DeWEB 的全链账本：跨链读取身份、页面和消息，本地核验后合成一个视图；代币 $UP。',
    en: 'A fully on-chain ledger on DeWEB: reads identities, pages and messages across chains and verifies them locally; token $UP.',
  },
  {
    id: 'tapeai', name: 'TapeAI', chain: '', role: 'app', x: 'TapeAIAgent',
    site: 'https://tapeai.net/',
    zh: '电路做灵魂、容器做身体的智能体，按 Skill 调用协作和计酬。',
    en: 'Agents with circuits as their core and containers as their body, paid per Skill call.',
  },
  {
    id: 'tapelaunch', name: 'TapeLaunch', chain: 'DeWEB', role: 'app', x: 'tapelaunch',
    site: 'https://tapelaunch.ai/', tg: 'https://t.me/TapeLaunch',
    zh: '从想法到 DeWEB 网站再到发行；另有 Telegram Agent，可流片、交易矿机。',
    en: 'Idea to DeWEB site to launch, plus a Telegram agent that can tape out circuits and trade rigs.',
  },
  {
    id: 'tapefoundry', name: 'TapeFoundry', chain: 'BSC', role: 'app', x: 'FoundryTape',
    site: 'https://tapefoundry.xyz/',
    zh: 'TapeOut 上的设计工作室：图纸免费，零件出售，卡牌稀有度看实际烧掉的门数。',
    en: 'A design house on TapeOut: drawings are free, parts are sold, rarity is the number of gates actually burned.',
  },
];

const TEXT = {
  zh: {
    title: '生态地图', sub: (d) => `非官方整理，链接取自各项目官方 X 主页，${d} 核对。合约地址以官网为准。`,
    roles: { protocol: '协议', community: '社区', app: '应用' },
    site: '官网', tg: 'TG', recent: (n) => `雷达里近期 ${n} 条`,
  },
  en: {
    title: 'Ecosystem map', sub: (d) => `Unofficial. Links come from each project's own X profile, checked ${d}. Use the official sites for contract addresses.`,
    roles: { protocol: 'Protocol', community: 'Community', app: 'App' },
    site: 'Site', tg: 'TG', recent: (n) => `${n} recent on the radar`,
  },
};

export const ecosystemText = (lang) => TEXT[lang === 'zh' ? 'zh' : 'en'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Radar items per project, matched on the posting account (x.com/<handle>/status/…). */
export function radarCounts(items, projects = PROJECTS) {
  const byHandle = new Map(projects.map((p) => [p.x.toLowerCase(), p.id]));
  const counts = {};
  for (const it of Array.isArray(items) ? items : []) {
    const handle = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\//.exec(it?.official_url || '')?.[1]?.toLowerCase();
    const id = handle && byHandle.get(handle);
    if (id) counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

export function ecosystemCards(lang, counts = {}, projects = PROJECTS) {
  const t = ecosystemText(lang);
  return projects.map((p) => {
    const links = [
      p.site ? `<a href="${esc(p.site)}" target="_blank" rel="noopener noreferrer">${esc(t.site)}</a>` : '',
      `<a href="https://x.com/${esc(p.x)}" target="_blank" rel="noopener noreferrer">@${esc(p.x)}</a>`,
      p.tg ? `<a href="${esc(p.tg)}" target="_blank" rel="noopener noreferrer">${esc(t.tg)}</a>` : '',
    ].filter(Boolean).join('');
    const tags = [
      `<span class="eco-role r-${esc(p.role)}">${esc(t.roles[p.role] || p.role)}</span>`,
      p.chain ? `<span class="eco-chain">${esc(p.chain)}</span>` : '',
      counts[p.id] ? `<span class="eco-recent">${esc(t.recent(counts[p.id]))}</span>` : '',
    ].filter(Boolean).join('');
    return `<article class="eco-card" data-project="${esc(p.id)}">`
      + `<p class="eco-tags">${tags}</p>`
      + `<h3>${esc(p.name)}</h3>`
      + `<p class="eco-desc">${esc(lang === 'zh' ? p.zh : p.en)}</p>`
      + `<p class="eco-links">${links}</p>`
      + `</article>`;
  }).join('');
}
