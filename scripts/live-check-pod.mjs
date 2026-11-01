// LIVE read-only BSC TapeOut PoD check — not part of node --test; never signs or broadcasts.
import { configurePodRpc, podSnapshot, podRigs, podAssetCard, POD_CFG } from '../pod.mjs';

configurePodRpc({
  endpoints: ['https://tapeout.net/rpc', 'https://rpc-bsc.48.club', 'https://bsc-rpc.publicnode.com'],
  logEndpoint: 'https://tapeout.net/rpc',
  logRpcFallback: 'https://bsc-rpc.publicnode.com',
  timeoutMs: 30_000,
  loadTimeoutMs: 120_000,
  ownershipTimeoutMs: 120_000,
});

const address = POD_CFG.exampleWallet;
const receipt = { startedAt: new Date().toISOString(), address, chain: 'bsc-tapeout-pod' };

async function measure(fn) {
  const start = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - start), value };
  } catch (error) {
    return { ms: Math.round(performance.now() - start), error: error.message };
  }
}

const snap = await measure(() => podSnapshot({ timeoutMs: 120_000 }));
receipt.snapshot = snap;
if (snap.value) {
  const rigs = await measure(() => podRigs(address, snap.value, () => {}, { timeoutMs: 120_000 }));
  receipt.rigs = rigs;
  if (rigs.value) {
    receipt.assetCard = podAssetCard(snap.value, rigs.value);
    receipt.sampleRigs = rigs.value.rigs.slice(0, 5);
  }
}

console.log(JSON.stringify(receipt, null, 2));
