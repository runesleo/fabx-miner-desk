// Capital cost of 1 unit/day from official listings.
// FabX entry rows are short-window observed deltas. BSC formula output is formula_rate,
// never the old measured label that hid a formula fallback.
import { createRpcClient } from './rpc.mjs';
import { encodeTryAggregate, decodeTryAggregate } from './multicall.mjs';
import { minerKey } from './slot-defense.mjs';

export const BEM_CFG = {
  mining: '0x7e2e0dc66a3bd9103e69b766afa62d9f7b697b46',
  market: '0x6feebbebc07bcb90bd1ac8b0cf9baa4f0ff2b46f',
  processors: [
    '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c',
    '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c',
  ],
  multicall: '0xca11bde05977b3631167028862be2a173976ca11',
  endpoints: ['https://tapeout.net/rpc', 'https://rpc-bsc.48.club'],
  leavesPerCall: 128,
  // Full enumeration is 1+ceil(N/k). The page stops above this many listing groups
  // instead of publishing a partial minimum.
  maxListingCalls: 8,
};

const SEL = {
  nextListingId: '0xaaccf1ec',
  listingView: '0xbeab7067',
  getMiner: '0x0527edc2',
  minerKey: '0x10eafa00',
  currentRate: '0xf9f8bdb7',
  unverifiedBps: '0xd8d56ffb',
  totalVerifWeight: '0xef6aff46',
  totalUnverWeight: '0x63967742',
  getBlockNumber: '0x42cbb15c',
};
const MINER_WORDS = 22;

let bemClient = null;
function defaultBemRpc() {
  if (!bemClient) {
    bemClient = createRpcClient({
      endpoints: BEM_CFG.endpoints,
      logEndpoint: BEM_CFG.endpoints[0],
      maxConcurrent: 3,
      timeoutMs: 8000,
    });
  }
  return bemClient.rpc;
}

const pad = (value) => BigInt(value).toString(16).padStart(64, '0');
const quantity = (value) => {
  const n = BigInt(value);
  return n === 0n ? '0x0' : '0x' + n.toString(16);
};

function words(data, count) {
  if (!Number.isInteger(count) || count < 1) return null;
  if (!new RegExp(`^0x[0-9a-f]{${count * 64}}$`, 'i').test(data || '')) return null;
  return Array.from({ length: count }, (_, index) => BigInt('0x' + data.slice(2 + index * 64, 2 + (index + 1) * 64)));
}

export function decimalString(numerator, denominator, scale = 8, { trim = true } = {}) {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint' || denominator === 0n) return null;
  if (!Number.isInteger(scale) || scale < 0 || scale > 40) return null;
  const neg = (numerator < 0n) !== (denominator < 0n);
  let n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let whole = n / d;
  let rem = n % d;
  const digits = [];
  for (let i = 0; i < scale; i++) {
    rem *= 10n;
    digits.push(rem / d);
    rem %= d;
  }
  const next = (rem * 10n) / d;
  if (next >= 5n) {
    let carry = 1n;
    for (let i = digits.length - 1; i >= 0 && carry; i--) {
      const sum = digits[i] + carry;
      digits[i] = sum % 10n;
      carry = sum / 10n;
    }
    if (carry) whole += 1n;
  }
  const fracRaw = digits.map(digit => digit.toString()).join('');
  const frac = trim ? fracRaw.replace(/0+$/, '') : fracRaw;
  const body = frac ? `${whole.toString()}.${frac}` : whole.toString();
  return neg ? `-${body}` : body;
}

function scaled(value, scale = 18) {
  if (typeof value === 'bigint') return value >= 0n ? { n: value, scale: 0 } : null;
  const text = typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
    : value;
  if (typeof text !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  if (whole === '0' && /^0*$/.test(frac)) return null;
  const digits = (frac + '0'.repeat(scale)).slice(0, scale);
  return { n: BigInt(whole) * 10n ** BigInt(scale) + BigInt(digits || '0'), scale };
}

export function listingBudget(listingCount, leavesPerCall = BEM_CFG.leavesPerCall) {
  if (!Number.isSafeInteger(listingCount) || listingCount < 0) throw new Error('invalid listing count');
  return 1 + (listingCount === 0 ? 0 : Math.ceil(listingCount / leavesPerCall));
}

export function formulaAtomsPerSecond({ rate, unverifiedBps, verifWeight, unverWeight, totalVerif, totalUnver }) {
  const values = [rate, unverifiedBps, verifWeight, unverWeight, totalVerif, totalUnver];
  if (values.some(value => typeof value !== 'bigint' || value < 0n)) return null;
  if (unverifiedBps > 10000n) return null;
  if (verifWeight > 0n && totalVerif === 0n) return null;
  if (unverWeight > 0n && totalUnver === 0n) return null;
  const unverified = rate * unverifiedBps / 10000n;
  const verified = rate - unverified;
  const verifiedAtoms = totalVerif > 0n ? verifWeight * verified / totalVerif : 0n;
  const unverifiedAtoms = totalUnver > 0n ? unverWeight * unverified / totalUnver : 0n;
  return verifiedAtoms + unverifiedAtoms;
}

export function formulaPerDay(atoms) {
  if (typeof atoms !== 'bigint' || atoms < 0n) return null;
  if (atoms === 0n) return null;
  return decimalString(atoms * 86400n, 100000000n, 8);
}

// Old BSC measuredEntry kept status measured when it substituted the formula.
// Callers must keep that case on formula_rate.
export function labelYield({ pendingEqual = false, stateChanged = false, debtChanged = false, formulaFallback = false, settledSeconds = null, windowSeconds = null } = {}) {
  if (formulaFallback) return { method: 'formula_rate', measured: false };
  if (settledSeconds != null && windowSeconds != null && settledSeconds !== windowSeconds) {
    return { method: 'settled_interval', measured: false };
  }
  if (!pendingEqual && !stateChanged && !debtChanged) return { method: 'observed_delta', measured: true };
  return { method: null, measured: false };
}

export function fabLegFromEntry(entry) {
  if (!entry || entry.complete !== true || !['live', 'cached'].includes(entry.state)) {
    return { complete: false, method: null, priceOkb: null, perDay: null, reason: 'fab-scan-incomplete' };
  }
  const best = entry.ranked?.[0];
  if (!best || best.status !== 'measured' || !(Number(best.priceOkb) > 0) || !(Number(best.fabPerDay) > 0)) {
    return { complete: true, method: null, priceOkb: null, perDay: null, reason: 'no-measured-listing' };
  }
  return {
    complete: true,
    method: 'observed_delta',
    priceOkb: best.priceOkb,
    perDay: best.fabPerDay,
    listingId: best.listingId ?? null,
    tokenId: best.id ?? null,
    windowSeconds: entry.windowSeconds ?? null,
    reason: null,
  };
}

export function crosschainView({ fab = null, bem = null, prices = null } = {}) {
  const okbUsdt = prices?.okbUsdt ?? null;
  const bnbUsdt = prices?.bnbUsdt ?? null;
  const bemPerFab = prices?.bemPerFab ?? null;
  const fabReady = fab?.complete === true && fab.method === 'observed_delta';
  const bemReady = bem?.complete === true && bem.method === 'formula_rate';
  const fabUnit = fabReady ? divide(fraction(fab.priceOkb), fraction(fab.perDay)) : null;
  const fabBnbUnit = multiply(fabUnit, divide(fraction(okbUsdt), fraction(bnbUsdt)));
  const fabOkb = show(fabUnit, 11);
  const fabBnb = show(fabBnbUnit, 8);
  const bemEq = show(divide(fabBnbUnit, fraction(bemPerFab)), 8);
  const bemBnb = bemReady ? show(divide(fraction(bem.priceBnb), fraction(bem.perDay)), 8) : null;
  return {
    fabOkb, fabBnb, bemEq, bemBnb,
    fabMethod: fabReady ? 'observed_delta' : null,
    bemMethod: bemReady ? 'formula_rate' : null,
    fabReason: fab?.reason ?? (fabReady ? null : 'unread'),
    bemReason: bem?.reason ?? (bemReady ? null : 'unread'),
    windowSeconds: fab?.windowSeconds ?? null,
  };
}

function fraction(value) {
  const part = scaled(value);
  if (!part) return null;
  return { n: part.n, d: 10n ** BigInt(part.scale) };
}

function multiply(left, right) {
  if (!left || !right) return null;
  return { n: left.n * right.n, d: left.d * right.d };
}

function divide(left, right) {
  if (!left || !right || right.n === 0n) return null;
  return { n: left.n * right.d, d: left.d * right.n };
}

function show(frac, scale = 8) {
  return frac ? decimalString(frac.n, frac.d, scale, { trim: false }) : null;
}

function line(zh, lang) {
  return lang === 'en' ? zh.en : zh.zh;
}

export function crosschainTitle(lang) {
  return line({ zh: '跨链日产能价', en: 'Cross-chain daily output cost' }, lang);
}

export function crosschainLines(view, lang) {
  const dash = '—';
  const fabOkb = view?.fabOkb ?? dash;
  const fabBnb = view?.fabBnb ?? dash;
  const bemBnb = view?.bemBnb ?? dash;
  const lines = [
    line({
      zh: `每天挖 1 枚 FAB：${fabOkb} OKB，折合 ${fabBnb} BNB。`,
      en: `Mining 1 FAB per day: ${fabOkb} OKB, or ${fabBnb} BNB.`,
    }, lang),
    line({
      zh: `每天挖 1 枚 BEM：${bemBnb} BNB。`,
      en: `Mining 1 BEM per day: ${bemBnb} BNB.`,
    }, lang),
  ];
  if (view?.fabMethod === 'observed_delta') {
    const minutes = view.windowSeconds == null ? null : Math.round(view.windowSeconds / 60);
    lines.push(line({
      zh: `FAB 这边是短窗口实测外推${minutes == null ? '' : `（约 ${minutes} 分钟的 pending 差值）`}，不是昨天实际挖到的数量。挂牌取官方市场完整扫描后、已测单位成本最低的一台。`,
      en: `The FAB figure extrapolates a short observed window${minutes == null ? '' : ` (about ${minutes} minutes of pending difference)`}. It is not what was mined yesterday. The listing is the lowest measured unit cost after a complete official-market scan.`,
    }, lang));
  } else {
    lines.push(line({
      zh: 'FAB 的官方挂牌或短窗口日产没有完整读到，OKB 和折合 BNB 显示 —。',
      en: 'The official FAB listing or short-window output was not fully read, so OKB and the BNB conversion are —.',
    }, lang));
  }
  if (view?.bemMethod === 'formula_rate') {
    lines.push(line({
      zh: 'BEM 这边是公式估算（按当前权重和排放速率），不是短窗口实测。BSC 旧读数会在 pending 相等或偏差过大时退回公式仍标 measured；这里不把公式标成实测。',
      en: 'The BEM figure is a formula estimate from current weights and the emission rate, not a short-window observation. Older BSC reads substituted that formula and still marked it measured; this page does not call the formula measured.',
    }, lang));
  } else if (view?.bemReason === 'over-budget') {
    lines.push(line({
      zh: 'BSC 官方挂牌没有在本页预算内完整枚举，每天挖 1 枚 BEM 显示 —。不用未读完的挂牌凑一个最低价。公式结果也不会被标成实测。',
      en: 'The official BSC listings were not fully enumerated within this page’s call budget, so BEM per day is —. An unfinished book is not turned into a minimum. A formula result is not labeled as measured.',
    }, lang));
  } else {
    lines.push(line({
      zh: 'BEM 的官方挂牌或公式日产读不到，显示 —。公式结果不会被标成实测。',
      en: 'The official BEM listing or formula output could not be read; showing —. A formula result is not labeled as measured.',
    }, lang));
  }
  if (view?.bemEq) {
    lines.push(line({
      zh: `若按 BEM/FAB 把 FAB 产能换成等值，约为 ${view.bemEq} BNB/（BEM 等值/日）。两枚币不等值，这只是快照换算，不是可成交的跨链价。`,
      en: `Converting the FAB output by BEM/FAB is about ${view.bemEq} BNB per BEM-equivalent per day. The two coins are not the same asset. This is a snapshot conversion, not an executable cross-chain price.`,
    }, lang));
  } else {
    lines.push(line({
      zh: '两枚币不等值。FAB 折合的 BNB 是 OKB 买价换成 BNB，单位仍是每天 1 枚 FAB；BEM 那一列是每天 1 枚 BEM。两个 BNB 数不能直接比成谁更划算。',
      en: 'The two coins are not the same asset. The FAB conversion turns the OKB price into BNB for 1 FAB/day; the BEM column is 1 BEM/day. The two BNB figures are not a direct which-is-cheaper comparison.',
    }, lang));
  }
  lines.push(line({
    zh: '币价：OKB/USDT 与 BNB/USDT 用 OKX ticker 的 last，BEM/FAB 用 X Layer 池 slot0。缺的项是 —。USDT 只作稳定币近似。不是买入建议，也不是全市场未来最低价。',
    en: 'Prices: OKB/USDT and BNB/USDT use the OKX ticker last, and BEM/FAB uses the X Layer pool slot0. Missing items are —. USDT is only a stablecoin approximation. This is not a buy recommendation or a future market minimum.',
  }, lang));
  return lines;
}

export async function readOkxLast(instId, fetchImpl = globalThis.fetch, signal) {
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(instId || '')) return null;
  const response = await fetchImpl(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`, {
    signal, headers: { accept: 'application/json' },
  });
  if (!response?.ok) return null;
  const body = await response.json();
  const last = body?.data?.[0]?.last;
  if (typeof last !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(last) || Number(last) <= 0) return null;
  return last;
}

function quoteBase(extra) {
  return {
    complete: false,
    method: null,
    priceBnb: null,
    perDay: null,
    listingId: null,
    tokenId: null,
    reason: 'unread',
    ethCall: 0,
    ...extra,
  };
}

async function call(rpc, counts, to, data, block, signal) {
  if (signal?.aborted) {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }
  counts.ethCall += 1;
  counts.inFlight += 1;
  counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight);
  try {
    return await rpc('eth_call', [{ to, data }, block], { signal });
  } finally {
    counts.inFlight -= 1;
  }
}

async function aggregate(rpc, counts, items, block, signal, leaves, multicall) {
  const values = [];
  let ok = true;
  for (let i = 0; i < items.length; i += leaves) {
    const group = items.slice(i, i + leaves);
    try {
      const raw = await call(rpc, counts, multicall, encodeTryAggregate(group), block, signal);
      const decoded = decodeTryAggregate(raw, group.length);
      if (decoded.some(value => value == null)) ok = false;
      values.push(...decoded);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      ok = false;
      values.push(...group.map(() => null));
    }
  }
  return { values, ok };
}

export async function loadBemQuote({ rpc, signal, cfg = BEM_CFG, maxListingCalls = BEM_CFG.maxListingCalls } = {}) {
  const counts = { ethCall: 0, inFlight: 0, maxInFlight: 0 };
  const transport = rpc || defaultBemRpc();
  const finish = (extra) => ({ ...quoteBase(extra), ethCall: counts.ethCall, maxInFlight: counts.maxInFlight });
  try {
    const headRaw = await call(transport, counts, cfg.multicall, SEL.getBlockNumber, 'latest', signal);
    const headFields = words(headRaw, 1);
    const head = headFields ? Number(headFields[0]) : NaN;
    if (!Number.isSafeInteger(head) || head <= 0) return finish({ reason: 'unread', head: null });
    const block = quantity(head);
    const nextRaw = await call(transport, counts, cfg.market, SEL.nextListingId, block, signal);
    const nextFields = words(nextRaw, 1);
    const next = nextFields ? Number(nextFields[0]) : NaN;
    if (!Number.isSafeInteger(next) || next < 0) return finish({ reason: 'unread', head });
    const groups = next === 0 ? 0 : Math.ceil(next / cfg.leavesPerCall);
    if (groups > maxListingCalls) {
      return finish({ reason: 'over-budget', head, listingCount: next, requiredCalls: listingBudget(next, cfg.leavesPerCall) });
    }
    const ids = Array.from({ length: next }, (_, index) => index + 1);
    const listed = ids.length
      ? await aggregate(transport, counts, ids.map(id => ({ to: cfg.market, data: SEL.listingView + pad(id) })), block, signal, cfg.leavesPerCall, cfg.multicall)
      : { values: [], ok: true };
    if (!listed.ok) return finish({ reason: 'incomplete-read', head, listingCount: next });
    const processors = new Set(cfg.processors.map(item => item.toLowerCase()));
    const candidates = [];
    for (let i = 0; i < ids.length; i++) {
      const fields = words(listed.values[i], 6);
      if (!fields) return finish({ reason: 'incomplete-read', head, listingCount: next });
      const seller = fields[0];
      const circuits = '0x' + fields[1].toString(16).padStart(40, '0');
      const tokenId = fields[2];
      const price = fields[3];
      const valid = fields[5];
      if (seller >= 2n ** 160n || fields[1] >= 2n ** 160n || fields[4] > 10000n || valid > 1n) {
        return finish({ reason: 'incomplete-read', head, listingCount: next });
      }
      if (valid !== 1n || price === 0n || !processors.has(circuits)) continue;
      candidates.push({ listingId: String(ids[i]), circuits, tokenId, price });
    }
    if (!candidates.length) return finish({ complete: true, reason: 'no-valid-listing', head, listingCount: next, method: null });
    let keyOk = false;
    try {
      const local = minerKey(candidates[0].circuits, candidates[0].tokenId);
      const onchain = await call(transport, counts, cfg.mining, SEL.minerKey + pad(candidates[0].circuits) + pad(candidates[0].tokenId), block, signal);
      keyOk = typeof onchain === 'string' && onchain.toLowerCase() === local;
    } catch { keyOk = false; }
    const keyed = [];
    if (keyOk) {
      for (const row of candidates) keyed.push({ ...row, key: minerKey(row.circuits, row.tokenId) });
    } else {
      const keyRead = await aggregate(transport, counts, candidates.map(row => ({
        to: cfg.mining, data: SEL.minerKey + pad(row.circuits) + pad(row.tokenId),
      })), block, signal, cfg.leavesPerCall, cfg.multicall);
      if (!keyRead.ok) return finish({ reason: 'incomplete-read', head, listingCount: next });
      candidates.forEach((row, index) => {
        const value = keyRead.values[index];
        if (words(value, 1)) keyed.push({ ...row, key: value.toLowerCase() });
      });
      if (keyed.length !== candidates.length) return finish({ reason: 'incomplete-read', head, listingCount: next });
    }
    const emission = await aggregate(transport, counts, [
      { to: cfg.mining, data: SEL.currentRate },
      { to: cfg.mining, data: SEL.unverifiedBps },
      { to: cfg.mining, data: SEL.totalVerifWeight },
      { to: cfg.mining, data: SEL.totalUnverWeight },
    ], block, signal, cfg.leavesPerCall, cfg.multicall);
    const rate = words(emission.values[0], 1)?.[0];
    const bps = words(emission.values[1], 1)?.[0];
    const totalVerif = words(emission.values[2], 1)?.[0];
    const totalUnver = words(emission.values[3], 1)?.[0];
    if (rate == null || bps == null || totalVerif == null || totalUnver == null) {
      return finish({ reason: 'unread', head, listingCount: next });
    }
    const miners = await aggregate(transport, counts, keyed.map(row => ({ to: cfg.mining, data: SEL.getMiner + pad(row.key) })), block, signal, cfg.leavesPerCall, cfg.multicall);
    if (!miners.ok) return finish({ reason: 'incomplete-read', head, listingCount: next });
    let best = null;
    for (let i = 0; i < keyed.length; i++) {
      const fields = words(miners.values[i], MINER_WORDS);
      if (!fields) return finish({ reason: 'incomplete-read', head, listingCount: next });
      const circuits = '0x' + fields[0].toString(16).padStart(40, '0');
      if (fields[1] !== keyed[i].tokenId || circuits !== keyed[i].circuits || fields[9] !== 1n) continue;
      const atoms = formulaAtomsPerSecond({
        rate, unverifiedBps: bps, verifWeight: fields[19], unverWeight: fields[20], totalVerif, totalUnver,
      });
      if (atoms == null) return finish({ reason: 'yield-unknown', head, listingCount: next });
      if (atoms === 0n) continue;
      if (!best || keyed[i].price * best.atoms < best.price * atoms) {
        best = { ...keyed[i], atoms };
      }
    }
    if (!best) return finish({ complete: true, reason: 'no-positive-yield', head, listingCount: next });
    const priceBnb = decimalString(best.price, 10n ** 18n, 8);
    const perDay = formulaPerDay(best.atoms);
    if (!priceBnb || !perDay) return finish({ reason: 'unread', head, listingCount: next });
    return finish({
      complete: true,
      method: 'formula_rate',
      reason: null,
      head,
      listingCount: next,
      listingId: best.listingId,
      tokenId: best.tokenId.toString(),
      priceBnb,
      perDay,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return finish({ reason: 'unread' });
  }
}
