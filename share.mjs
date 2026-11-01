// Deep links and read-only share card helpers (browser + worker).
import { normalizeSitePath } from './site-path.mjs';

export const DEFAULT_SITE_URL = 'https://r1-dc945fd3aee9829a3c9065459e82aa503572da5f-deweb.fabx.tech/';

export function siteUrlFromEnv(env = {}) {
  const raw = env.SITE_URL || DEFAULT_SITE_URL;
  return raw.endsWith('/') ? raw : `${raw}/`;
}

export function shortAddress(address) {
  if (!address || address.length < 10) return address || '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** @param {string} base trailing-slash site root */
export function buildAssetUrl(base, { address, chain = 'fabx', rigId } = {}) {
  const root = base.replace(/\/$/, '');
  const url = new URL(`${root}/`);
  const params = new URLSearchParams();
  if (address) params.set('addr', address.toLowerCase());
  if (chain && chain !== 'fabx') params.set('chain', chain);
  if (rigId != null && String(rigId) !== '') params.set('rig', String(rigId));
  const qs = params.toString();
  if (qs) url.hash = qs;
  return url.toString();
}

function deepLinkParams(url) {
  const fromQuery = url.searchParams;
  if (fromQuery.get('addr') || fromQuery.get('address')) return fromQuery;
  const hash = url.hash?.startsWith('#') ? url.hash.slice(1) : '';
  if (!hash) return fromQuery;
  if (/^rig-/.test(hash)) return fromQuery;
  return new URLSearchParams(hash);
}

export function parseDeepLink(href = '') {
  const url = new URL(href, DEFAULT_SITE_URL);
  const sp = deepLinkParams(url);
  const address = sp.get('addr') || sp.get('address') || '';
  const chainRaw = sp.get('chain');
  const chain = chainRaw === 'bsc' ? 'bsc' : 'fabx';
  const rigFromHash = sp.get('rig');
  const rigLegacy = url.hash.match(/^#rig-(.+)$/);
  const rigId = rigFromHash ?? rigLegacy?.[1] ?? null;
  return { address, chain, rigId };
}

export { normalizeSitePath, isDeskEntryPath } from './site-path.mjs';

export function shareCardSpec({ shortAddr, miningCount, fabPerDay, valueUsd, tokenLabel, lang }) {
  const zh = lang === 'zh';
  return {
    title: zh ? 'FabX Miner Desk' : 'FabX Miner Desk',
    subtitle: zh ? '只读资产快照' : 'Read-only snapshot',
    address: shortAddr,
    mining: zh ? `在挖 ${miningCount} 台` : `${miningCount} rig${miningCount === 1 ? '' : 's'} mining`,
    output: fabPerDay == null ? (zh ? '日产：未测' : 'Daily output: unknown')
      : (zh ? `实测日产合计 ${fabPerDay} ${tokenLabel}` : `Measured ${fabPerDay} ${tokenLabel}/day`),
    value: valueUsd == null ? '' : (zh ? `估值约 $${valueUsd}` : `Est. value ~$${valueUsd}`),
    footer: zh ? '非投资建议 · 链上只读' : 'Not investment advice · read-only',
  };
}

export function drawShareCard(canvas, spec) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return;
  const w = 390;
  const h = 220;
  canvas.width = w;
  canvas.height = h;
  ctx.fillStyle = '#0f1419';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#e8eef2';
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.fillText(spec.title, 20, 36);
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillStyle = '#8b9aab';
  ctx.fillText(spec.subtitle, 20, 58);
  ctx.fillStyle = '#e8eef2';
  ctx.font = '15px ui-monospace, monospace';
  ctx.fillText(spec.address, 20, 92);
  ctx.font = '14px system-ui, sans-serif';
  let y = 118;
  for (const line of [spec.mining, spec.output, spec.value, spec.footer].filter(Boolean)) {
    ctx.fillText(line, 20, y);
    y += 22;
  }
}
