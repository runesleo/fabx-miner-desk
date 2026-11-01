// Browser + Node: read precomputed 24h FAB stats from GET /api/market (hosted Pages).

import { apiUrl } from './api-url.mjs';

export function parseMarketResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const medianBem = Number(data.medianBem);
  const lowBem = Number(data.lowBem);
  const highBem = Number(data.highBem);
  const lastSwapBem = Number(data.lastSwapBem);
  const swaps24h = Number(data.swaps24h);
  const computedAt = data.computedAt;
  if (![medianBem, lowBem, highBem, lastSwapBem].every(n => Number.isFinite(n) && n > 0)) return null;
  if (!Number.isSafeInteger(swaps24h) || swaps24h <= 0) return null;
  if (!computedAt || !Number.isFinite(Date.parse(computedAt))) return null;
  if (lowBem > medianBem || medianBem > highBem) return null;
  return {
    asOf: computedAt,
    value: { medianBem, lowBem, highBem, lastSwapBem, swaps24h },
  };
}

export async function fetchServerMarket({ signal, location } = {}) {
  const loc = location ?? globalThis.location;
  try {
    const res = await fetch(apiUrl('/api/market', loc), { signal, credentials: 'omit', cache: 'no-store' });
    if (!res.ok) return null;
    return parseMarketResponse(await res.json());
  } catch {
    return null;
  }
}
