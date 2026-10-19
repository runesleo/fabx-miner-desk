// Explicit LIVE read-only check. Not part of node --test; never signs or broadcasts.
import { snapshot, refreshOptional, wallet, assetCard, CFG } from '../desk.mjs';
// Exercise the real chain fallback without relying on Node (which does not enforce browser CORS).
// Only the optional API failure is simulated; all RPC and price reads remain live.
const chainOnly = process.argv.includes('--chain-only');
const fetchLive = globalThis.fetch;
const requests = { http: 0, rpcCalls: 0, ethCalls: 0, multicalls: 0, logCalls: 0 };
globalThis.fetch = async (url, init = {}) => {
  if (chainOnly && String(url).startsWith(CFG.fabxApi + '/')) throw new TypeError('FabX API disabled for explicit chain-fallback check');
  requests.http++;
  if (init.body) {
    const body = JSON.parse(init.body), rows = Array.isArray(body) ? body : [body];
    requests.rpcCalls += rows.length;
    requests.ethCalls += rows.filter(row => row.method === 'eth_call').length;
    requests.multicalls += rows.filter(row => row.method === 'eth_call' && row.params[0].data.startsWith('0xbce38bd7')).length;
    requests.logCalls += rows.filter(row => row.method === 'eth_getLogs').length;
  }
  return fetchLive(url, init);
};
const receipt = { startedAt: new Date().toISOString(), exampleWallet: CFG.exampleWallet, mode: chainOnly ? 'live-chain-with-api-disabled' : 'live-default' };
async function measure(fn) {
  const start = performance.now();
  try { const value = await fn(); return { ms: Math.round(performance.now() - start), value }; }
  catch (error) { return { ms: Math.round(performance.now() - start), error: error.message }; }
}
const cardSummary = ({ rigs, ...card }) => card;
const base = await measure(() => snapshot({ storage: null }));
receipt.snapshot = base;
if (base.value) {
  const s = base.value;
  const start = performance.now();
  let latest = s, nandReadyMs = null, rigListMs = null;
  const [walletRead, optional] = await Promise.all([
    measure(async () => {
      const w = await wallet(CFG.exampleWallet, s, (step) => {
        if (step === 'measure') rigListMs = Math.round(performance.now() - start);
      });
      return { wallet: w, assetCard: cardSummary(assetCard(latest, w)) };
    }),
    measure(() => refreshOptional(s, { storage: null, onUpdate(next) {
      latest = next;
      if (nandReadyMs == null && next.decision.nandOkb > 0) nandReadyMs = Math.round(performance.now() - start);
    } })),
  ]);
  receipt.walletAndAssetCard = walletRead;
  receipt.optional = optional;
  if (walletRead.value) {
    const { rigs, ...w } = walletRead.value.wallet;
    walletRead.value.wallet = { ...w, statuses: rigs.reduce((counts, rig) => {
      counts[rig.status] = (counts[rig.status] || 0) + 1; return counts;
    }, {}) };
    receipt.assetCardWithOptional = cardSummary(assetCard(latest, { ...w, rigs }));
    const ready = receipt.assetCardWithOptional.valueUsd != null && w.discovery.complete;
    receipt.timing = { rigListMs, nandReadyMs, walletAndAssetCardMs: walletRead.ms,
      fullCardAfterSnapshotMs: ready ? Math.max(walletRead.ms, nandReadyMs ?? 0) : null,
      coldFullCardMs: ready ? base.ms + Math.max(walletRead.ms, nandReadyMs ?? 0) : null };
    receipt.timing.under8Seconds = ready && receipt.timing.coldFullCardMs < 8000;
  }
}
receipt.finishedAt = new Date().toISOString();
receipt.requests = requests;
console.log(JSON.stringify(receipt, null, 2));
if (base.error || receipt.walletAndAssetCard?.error || receipt.assetCardWithOptional?.valueUsd == null) process.exitCode = 1;
