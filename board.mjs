// Daily network board: X Layer FabX and BSC TapeOut, read-only.
// Buy-versus-build uses the same entry comparison as the desk. BSC has no
// component market wired here, so those cells stay empty and the page says 暂无.

import { snapshot, networkGrowth, loadEntryComparison } from './desk.mjs';
import { podSnapshot, podNetworkGrowth } from './pod.mjs';
import { fetchServerMarket } from './market-client.mjs';
import { siteUrlFromEnv } from './share.mjs';

export function boardUrl(env = {}) {
  return new URL('board/', siteUrlFromEnv(env)).toString();
}

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

export function trimNum(n) {
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 4;
  return String(Number(n.toFixed(digits)));
}

export function compact(n) {
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${trimNum(n / 1e12)}万亿`;
  if (abs >= 1e8) return `${trimNum(n / 1e8)}亿`;
  if (abs >= 1e4) return `${trimNum(n / 1e4)}万`;
  return trimNum(n);
}

function withWeek(growth) {
  if (!growth?.measured || !Number.isFinite(growth.daily) || growth.daily <= -1) {
    return { measured: false, daily: null, week: null };
  }
  const week = (1 + growth.daily) ** 7 - 1;
  return { measured: true, daily: growth.daily, week: Number.isFinite(week) ? week : null };
}

function emptySide() {
  return {
    miners: null, weight: null, okbPerDay: null, cheaper: null, deltaOkb: null, deltaPct: null,
    week: null, daily: null, measuredGrowth: false, fabBemMedian: null,
  };
}

function fabxSide(snap, growth, entry, market) {
  const usable = entry && entry.complete === true && entry.state !== 'unavailable';
  const week = withWeek(growth);
  return {
    miners: finite(snap?.network?.miners),
    weight: finite(snap?.network?.weight),
    okbPerDay: usable ? finite(entry.baseline?.okbPerFabDay) : null,
    cheaper: usable ? entry.cheaper ?? null : null,
    deltaOkb: usable ? finite(entry.deltaOkb) : null,
    deltaPct: usable ? finite(entry.deltaPct) : null,
    week: week.week,
    daily: week.daily,
    measuredGrowth: week.measured,
    fabBemMedian: finite(market?.value?.medianBem),
  };
}

function bscSide(pod, growth) {
  const week = withWeek(growth);
  return {
    ...emptySide(),
    miners: finite(pod?.network?.miners),
    weight: finite(pod?.network?.weight),
    week: week.week,
    daily: week.daily,
    measuredGrowth: week.measured,
  };
}

export async function loadBoard(deps = {}) {
  const view = { asOf: new Date().toISOString(), fabx: emptySide(), bsc: emptySide(), errors: [] };
  const readSnap = deps.snapshot || snapshot;
  const readGrowth = deps.networkGrowth || networkGrowth;
  const readEntry = deps.loadEntryComparison || loadEntryComparison;
  const readPod = deps.podSnapshot || podSnapshot;
  const readPodGrowth = deps.podNetworkGrowth || podNetworkGrowth;
  const readMarket = deps.fetchServerMarket || fetchServerMarket;
  try {
    const snap = await readSnap();
    if (snap?.asOf) view.asOf = snap.asOf;
    let growth = { measured: false, daily: null };
    let entry = null;
    let market = null;
    try { growth = await readGrowth(snap); } catch (error) { view.errors.push(error.message); }
    try { entry = await readEntry(snap); } catch (error) { view.errors.push(error.message); }
    try { market = await readMarket(); } catch (error) { view.errors.push(error.message); }
    view.fabx = fabxSide(snap, growth, entry, market);
  } catch (error) {
    view.errors.push(error.message);
  }
  try {
    const pod = await readPod();
    let growth = { measured: false, daily: null };
    try { growth = await readPodGrowth(pod); } catch (error) { view.errors.push(error.message); }
    view.bsc = bscSide(pod, growth);
  } catch (error) {
    view.errors.push(error.message);
  }
  return view;
}

export function weekSentence(side) {
  if (!side?.measuredGrowth || !Number.isFinite(side.week)) return '近 7 天变化暂无';
  const pct = trimNum(Math.abs(side.week * 100));
  return `近 7 天全网权重${side.week >= 0 ? '涨了' : '降了'} ${pct}%`;
}

export function compareSentence(side) {
  if (!side || side.cheaper == null) return '暂无';
  if (side.cheaper === 'equal') return '买现成和自建差不多';
  if ((side.cheaper === 'listing' || side.cheaper === 'build') && Number.isFinite(side.deltaOkb)) {
    const gap = `${trimNum(side.deltaOkb)} OKB`;
    const pct = Number.isFinite(side.deltaPct) ? `（约 ${trimNum(side.deltaPct)}%）` : '';
    return side.cheaper === 'listing'
      ? `买现成更划算，每多挖 1 个币少花约 ${gap}${pct}`
      : `自建更划算，每多挖 1 个币少花约 ${gap}${pct}`;
  }
  return '暂无';
}

function countText(n) {
  return n == null ? '暂无' : `${Math.round(n)} 台`;
}

export function boardLines(view) {
  const fabx = view?.fabx || emptySide();
  const bsc = view?.bsc || emptySide();
  const price = fabx.okbPerDay == null ? '暂无' : `${trimNum(fabx.okbPerDay)} OKB`;
  const median = fabx.fabBemMedian == null ? null : `${trimNum(fabx.fabBemMedian)} BEM`;
  const fabxRows = [
    ['在挖矿机', countText(fabx.miners)],
    ['全网权重', fabx.weight == null ? '暂无' : compact(fabx.weight)],
    ['每天多挖 1 个 FAB 要花', price],
    ['买现成还是自建', compareSentence(fabx)],
    ['近 7 天', weekSentence(fabx)],
  ];
  if (median) fabxRows.push(['FAB 近 24 小时中位价', median]);
  return {
    fabx: fabxRows,
    bsc: [
      ['在挖矿机', countText(bsc.miners)],
      ['全网权重', bsc.weight == null ? '暂无' : compact(bsc.weight)],
      ['每天多挖 1 个 BEM 要花', '暂无'],
      ['买现成还是自建', '暂无'],
      ['近 7 天', weekSentence(bsc)],
    ],
  };
}

function shortCompare(side) {
  if (!side || side.cheaper == null) return '买和建还比不了。';
  if (side.cheaper === 'equal') return '买现成和自建差不多。';
  if (!Number.isFinite(side.deltaOkb)) return '买和建还比不了。';
  const gap = `${trimNum(side.deltaOkb)} OKB`;
  return side.cheaper === 'listing' ? `买现成少花约 ${gap}。` : `自建少花约 ${gap}。`;
}

/** Chinese blurb for one opted-in chat. At most 200 characters. Does not send anything. */
export function formatDailyBoard(view, { url } = {}) {
  const link = url || boardUrl();
  const fabx = view?.fabx || emptySide();
  const bsc = view?.bsc || emptySide();
  const miners = fabx.miners == null ? '暂无' : String(Math.round(fabx.miners));
  const weight = fabx.weight == null ? '暂无' : compact(fabx.weight);
  const price = fabx.okbPerDay == null ? '暂无' : `${trimNum(fabx.okbPerDay)} OKB`;
  const change = `${weekSentence(fabx)}。`;
  const bMiners = bsc.miners == null ? '暂无' : String(Math.round(bsc.miners));
  let text = `FabX 在挖 ${miners} 台，权重 ${weight}。每天多挖 1 FAB 约 ${price}。${shortCompare(fabx)}${change}BSC TapeOut 在挖 ${bMiners} 台，日产价暂无。看板 ${link}`;
  if ([...text].length <= 200) return text;
  text = `FabX 在挖 ${miners} 台，权重 ${weight}。${change}BSC ${bMiners} 台。看板 ${link}`;
  if ([...text].length <= 200) return text;
  text = `${change}看板 ${link}`;
  return [...text].length <= 200 ? text : `看板 ${link}`;
}

/** Load the board and return one paragraph. Throws when the paragraph is empty. Does not send. */
export async function buildDailyBoardText({ loadBoard: load = loadBoard, url, env, format = formatDailyBoard } = {}) {
  const view = await load();
  const text = String(format(view, { url: url || boardUrl(env) }) ?? '').trim();
  if (!text) throw new Error('daily board text empty');
  return text;
}
