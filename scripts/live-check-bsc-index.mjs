// LIVE read-only check. Not part of node --test. Never signs or broadcasts.
// New flow: GET /api/bsc-rigs for holder ids, then getMiner plus one same-node
// ten-minute window. Passes only when the example address yields 9 rigs within 20s.
// Exit 2 while the server index is still building or the route is not deployed.
import { performance } from 'node:perf_hooks';
import { configurePodRpc, podSnapshot, podRigsForIds, POD_CFG } from '../pod.mjs';
import { fetchBscRigs } from '../bsc-rigs-client.mjs';

const BUDGET_MS = 20_000;
const address = POD_CFG.exampleWallet;
const started = performance.now();
const signal = AbortSignal.timeout(BUDGET_MS);

configurePodRpc({
  endpoints: ['https://tapeout.net/rpc', 'https://rpc-bsc.48.club', 'https://bsc-dataseed.bnbchain.org'],
  logEndpoint: 'https://tapeout.net/rpc',
  logRpcFallback: 'https://bsc-rpc.publicnode.com',
  timeoutMs: 8_000,
  loadTimeoutMs: 18_000,
});

const receipt = { startedAt: new Date().toISOString(), address, chain: 'bsc-index', budgetMs: BUDGET_MS };

function remain() {
  return Math.max(1_000, BUDGET_MS - (performance.now() - started));
}

try {
  const indexed = await fetchBscRigs(address, { signal, location: { hostname: 'live-check.invalid' } });
  receipt.index = {
    building: indexed.building,
    message: indexed.message,
    rigs: indexed.rigs.length,
    progress: indexed.progress,
  };
  if (indexed.building || indexed.progress?.complete !== true) {
    receipt.ok = false;
    receipt.reason = 'index-building';
    receipt.elapsedMs = Math.round(performance.now() - started);
    console.log(JSON.stringify(receipt, null, 2));
    process.exit(2);
  }
  const snap = await podSnapshot({ signal, timeoutMs: remain() });
  const wallet = await podRigsForIds(address, indexed.rigs, snap, () => {}, {
    signal,
    timeoutMs: remain(),
    indexUpdatedAt: indexed.progress?.updatedAt,
  });
  receipt.elapsedMs = Math.round(performance.now() - started);
  receipt.circuits = wallet.circuits;
  receipt.unread = wallet.unread;
  receipt.ids = wallet.rigs.map((rig) => rig.id);
  receipt.head = wallet.head;
  receipt.windowSeconds = wallet.windowSeconds;
  receipt.ok = wallet.circuits === 9 && receipt.elapsedMs <= BUDGET_MS;
  receipt.reason = receipt.ok ? 'ok' : wallet.circuits === 9 ? 'over-budget' : 'rig-count';
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(receipt.ok ? 0 : 1);
} catch (error) {
  receipt.ok = false;
  receipt.elapsedMs = Math.round(performance.now() - started);
  const htmlFallback = error?.status === 200 && /html/i.test(error?.contentType || '');
  const missing = error?.status === 404 || htmlFallback;
  receipt.reason = missing ? 'api-missing' : 'error';
  receipt.error = error?.message || String(error);
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(missing ? 2 : 1);
}
