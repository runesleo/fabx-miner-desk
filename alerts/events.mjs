// FabX PodMining log topics and helpers (verified event names from official ABI).
import { CFG, logsChunked } from '../desk.mjs';

export const TOPIC = {
  Revoked: '0x3810979f2e0c5c2cb9eedf8c226f7c3074a2c90c65fb121fea68e62da48c63f0',
  Stopped: '0xa7347469fa4653a2b0ef8c0175367e28e0d8bffff7e15b2176b11c5c1f305d18',
  Demoted: '0xa7a95aac636e1599e0e0b7359cacbddefbc71df27038dc1b747c96e472b138a5',
  Paused: '0xd9d5ac1a8abcab35a66640a2b1c23ee9ddc62bf820e299402501f9adaae0e9ec',
  ProcessorSet: '0x4537e7af190f05e323cc18b88f23e4f7c9227c8b506c7f1f66efd7fed4b99990',
  Upgraded: '0x0e51260f13833a8d9a8525608fc2964752eadd8e5f67b9300585ebd9a52f733d',
  BoostSet: '0x1bd81975d9c5100c6eee37157c468ffa3679ccba36fccb9b9464b91bdd1cec14',
};

export const GOVERNANCE_TOPICS = [TOPIC.Paused, TOPIC.ProcessorSet, TOPIC.Upgraded, TOPIC.BoostSet];

export const TX_SEL = {
  kick: '0x919c1ada',
  reclaim: '0x96afb365',
  start: '0xa3494614',
};

export function demotedKindFromSelector(selector) {
  if (selector === TX_SEL.kick) return 'demoted_kick';
  if (selector === TX_SEL.reclaim) return 'demoted_reclaim';
  if (selector === TX_SEL.start) return 'demoted_start';
  return 'demoted';
}

export function governanceKind(topic) {
  if (topic === TOPIC.Paused) return 'governance_paused';
  if (topic === TOPIC.ProcessorSet) return 'governance_processor';
  if (topic === TOPIC.Upgraded) return 'governance_upgraded';
  if (topic === TOPIC.BoostSet) return 'governance_boost';
  return null;
}

export async function txSelector(txHash, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(CFG.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [txHash] }),
  });
  const body = await res.json();
  const input = body?.result?.input;
  if (typeof input !== 'string' || input.length < 10) return null;
  return input.slice(0, 10).toLowerCase();
}

export async function demotedKindsInRange(fromBlock, toBlock, keys, { fetchImpl, getLogs } = {}) {
  const wanted = new Set(keys.map(k => k.toLowerCase()));
  const out = new Map();
  if (!wanted.size || toBlock < fromBlock) return out;
  const logs = await getLogs(fromBlock, toBlock);
  for (const log of logs) {
    if (log.topics?.[0] !== TOPIC.Demoted) continue;
    const key = log.topics[1]?.toLowerCase();
    if (!key || !wanted.has(key)) continue;
    const selector = await txSelector(log.transactionHash, fetchImpl);
    out.set(key, demotedKindFromSelector(selector));
  }
  return out;
}

export async function defaultGetLogs(fromBlock, toBlock, signal) {
  return logsChunked({ address: CFG.mining, topics: [[TOPIC.Demoted]] }, fromBlock, toBlock, signal);
}

export async function governanceLogsInRange(fromBlock, toBlock, getLogs) {
  if (toBlock < fromBlock) return [];
  const logs = await getLogs(fromBlock, toBlock);
  return logs.filter(log => GOVERNANCE_TOPICS.includes(log.topics?.[0])).map(log => ({
    kind: governanceKind(log.topics[0]),
    txHash: log.transactionHash,
    logIndex: Number(log.logIndex),
    blockNumber: Number(log.blockNumber),
    topic: log.topics[0],
  })).filter(row => row.kind);
}
