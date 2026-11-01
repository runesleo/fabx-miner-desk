// FabX optimal-slot readout. Leadership comes from bestSlot, not from a lower design cost.
// Kick cause stays UNKNOWN: Demoted alone does not prove kick, reclaim, or start.
import { encodeTryAggregate, decodeTryAggregate } from './multicall.mjs';
import { keccak256Hex } from './keccak.mjs';

export const SLOT_CFG = {
  mining: '0x4f6a2312d80753bdafd35ddb1bf4bb14c43f8265',
  processor: '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6',
  processorLabel: 'FAB-Genisis',
  multicall: '0xca11bde05977b3631167028862be2a173976ca11',
  leavesPerCall: 128,
  logWindow: 1000,
  maxLogWindows: 96,
};

const SEL = {
  bestSlot: '0x11d5a55c',
  minerKey: '0x10eafa00',
  getMiner: '0x0527edc2',
  costOf: '0x3a55fef3',
  nextId: '0x61b8ce8c',
};
const TOPIC = {
  demoted: '0x687eb3f2eb7f9e2f33de282fee110bc0bcadb9c0dc5ffd2f7e27d440952e1549',
  reclaimed: '0xbf1fd8b9ffbac479b8800a970decd30b1e919c3e440c9fb3a1a21a491906ffd5',
  started: '0x7c9c1f2b9aa7cd28c79cdeb371997e1c61e4aa92cf7c29b91d01287092f94937',
};
const MINER_WORDS = 23;

const pad = (value) => value.toString(16).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const quantity = (value) => {
  const n = BigInt(value);
  return n === 0n ? '0x0' : '0x' + n.toString(16);
};
const hexBytes = (hex) => {
  const s = hex.replace(/^0x/, '');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const word = (data, index) => BigInt('0x' + data.slice(2 + index * 64, 2 + (index + 1) * 64));
const addrOf = (value) => '0x' + BigInt(value).toString(16).padStart(40, '0');

export function minerKey(processor, id) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(processor || '')) throw new Error('invalid processor');
  const packed = processor.slice(2).toLowerCase() + pad(BigInt(id));
  return keccak256Hex(hexBytes(packed));
}

export function sameTaskScanCalls(recordCount, competitorCount, leavesPerCall = SLOT_CFG.leavesPerCall) {
  if (!Number.isSafeInteger(recordCount) || recordCount < 0) throw new Error('invalid record count');
  if (!Number.isSafeInteger(competitorCount) || competitorCount < 0) throw new Error('invalid competitor count');
  if (!Number.isSafeInteger(leavesPerCall) || leavesPerCall < 1) throw new Error('invalid multicall size');
  const groups = recordCount === 0 ? 0 : Math.ceil(recordCount / leavesPerCall);
  const costs = competitorCount === 0 ? 0 : Math.ceil(competitorCount / leavesPerCall);
  return 1 + groups + costs;
}

function words(data, count) {
  if (!new RegExp(`^0x[0-9a-f]{${count * 64}}$`, 'i').test(data || '')) return null;
  return Array.from({ length: count }, (_, index) => word(data, index));
}

export function decodeBestSlot(data) {
  const fields = words(data, 2);
  if (!fields) return null;
  const holderPlus1 = fields[0];
  return { holderPlus1, cost: fields[1], id: holderPlus1 === 0n ? null : holderPlus1 - 1n };
}

export function decodeMiner(data, { id, processor, words: count = MINER_WORDS } = {}) {
  const fields = words(data, count);
  if (!fields) return null;
  if (fields.every(value => value === 0n)) return { empty: true };
  const circuitId = fields[1];
  const circuits = addrOf(fields[0]);
  const area = fields[6];
  const depth = fields[5];
  const taskId = fields[2];
  const status = fields[9];
  if (processor && circuits !== processor.toLowerCase()) return { bad: true };
  if (id != null && circuitId !== BigInt(id)) return { bad: true };
  if (area >= 2n ** 64n || depth >= 2n ** 32n || taskId >= 2n ** 32n || status >= 2n ** 32n) return { bad: true };
  return {
    empty: false,
    bad: false,
    circuitId,
    circuits,
    taskId,
    status: Number(status),
    area,
    depth,
    optimal: fields[15] !== 0n,
  };
}

function asBig(value) {
  if (value == null || value === '') return null;
  try {
    const n = BigInt(value);
    return n >= 0n ? n : null;
  } catch { return null; }
}

export function nextCheaperDesign(leaderCost, designs) {
  const leader = asBig(leaderCost);
  if (leader == null) return { ok: false };
  const cheaper = [];
  for (const design of designs) {
    const cost = asBig(design?.cost);
    if (cost == null || design?.id == null) return { ok: false };
    if (cost < leader) cheaper.push({ id: BigInt(design.id).toString(), cost });
  }
  if (!cheaper.length) return { ok: true, designs: [], count: 0, cost: null, gap: null };
  const cost = cheaper.reduce((best, design) => design.cost > best ? design.cost : best, -1n);
  return {
    ok: true,
    cost,
    gap: leader - cost,
    count: cheaper.length,
    designs: cheaper.filter(design => design.cost === cost).map(design => design.id).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
  };
}

function logIndex(log) {
  try {
    return [BigInt(log.blockNumber), BigInt(log.transactionIndex), BigInt(log.logIndex)];
  } catch { return null; }
}

function later(a, b) {
  if (!a) return true;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

function topicAddr(topic) {
  return /^0x[0-9a-f]{64}$/i.test(topic || '') ? '0x' + topic.slice(-40).toLowerCase() : null;
}

export function latestTakeover(logs, { taskId, processor }) {
  const task = asBig(taskId);
  const cpu = processor?.toLowerCase();
  if (task == null || !cpu) return { kind: 'unread', kick: 'UNKNOWN' };
  const parsed = [];
  for (const log of logs || []) {
    if (!log || log.removed) continue;
    const order = logIndex(log);
    const topic0 = log.topics?.[0]?.toLowerCase();
    const data = words(log.data, (log.data?.length - 2) / 64);
    if (!order || !topic0 || !data || !log.transactionHash) continue;
    const base = { order, tx: log.transactionHash.toLowerCase(), block: order[0] };
    if (topic0 === TOPIC.demoted && data.length >= 2 && topicAddr(log.topics[2]) === cpu && data[1] === task) {
      parsed.push({ ...base, type: 'demoted', id: data[0] });
    } else if (topic0 === TOPIC.reclaimed && topicAddr(log.topics[2]) != null && asBig(log.topics[2]) === task) {
      parsed.push({ ...base, type: 'reclaimed' });
    } else if (topic0 === TOPIC.started && data.length >= 5 && topicAddr(log.topics[2]) === cpu && data[0] === task) {
      parsed.push({ ...base, type: 'started', optimal: data[4] !== 0n });
    }
  }
  const demoted = parsed.filter(event => event.type === 'demoted');
  if (!demoted.length) return { kind: 'none', kick: 'UNKNOWN' };
  let best = null;
  for (const event of demoted) if (later(best?.order, event.order)) best = event;
  const same = parsed.filter(event => event.tx === best.tx);
  const reclaim = same.some(event => event.type === 'reclaimed');
  const start = same.some(event => event.type === 'started' && event.optimal);
  const kind = reclaim && start ? 'ambiguous' : reclaim ? 'reclaim' : start ? 'start' : 'demoted-only';
  return { kind, kick: 'UNKNOWN', block: best.block.toString(), tx: best.tx, id: best.id.toString() };
}

function text(zh, lang) {
  return lang === 'en' ? zh.en : zh.zh;
}

function eventLines(event, lang) {
  const unknown = text({
    zh: 'kick 原因：UNKNOWN。没有读取交易 input，不能把 Demoted 写成 kick，也不能把没读到写成没有发生过 kick。',
    en: 'Kick cause: UNKNOWN. Transaction input was not read, so Demoted is not labeled as kick, and a missing log is not evidence that a kick did not happen.',
  }, lang);
  if (!event || event.kind === 'unread') {
    return [text({
      zh: '最近一次夺榜或 kick 的日志读不到，显示 —。',
      en: 'The latest takeover or kick log could not be read; showing —.',
    }, lang), unknown];
  }
  if (event.kind === 'none') {
    return [text({
      zh: `从区块 ${event.to} 向早连续读到区块 ${event.from}（Demoted、Reclaimed、Started）。这段里没有该题该处理器的 Demoted。更早的区块没有读。`,
      en: `Logs were read backward from block ${event.to} through block ${event.from} (Demoted, Reclaimed, Started). That span has no Demoted for this task and processor. Earlier blocks were not read.`,
    }, lang), unknown];
  }
  const label = {
    reclaim: text({ zh: '同一笔交易里有 Reclaimed，记为 reclaim 关联夺榜', en: 'The same transaction contains Reclaimed, so this is a reclaim-linked takeover' }, lang),
    start: text({ zh: '同一笔交易里有 optimal 为真的 Started，记为 start 关联夺榜', en: 'The same transaction contains Started with optimal true, so this is a start-linked takeover' }, lang),
    'demoted-only': text({ zh: '只有 Demoted，没有同交易的 Reclaimed 或 optimal Started，不能证明是 kick、reclaim 还是 start', en: 'Only Demoted is present, without Reclaimed or optimal Started in that transaction, so this does not prove kick, reclaim, or start' }, lang),
    ambiguous: text({ zh: '同一笔交易里同时有 Reclaimed 和 optimal Started，不能收成单一原因', en: 'That transaction contains both Reclaimed and optimal Started, so it is not reduced to one cause' }, lang),
  }[event.kind];
  return [text({
    zh: `从当前区块向早连续读到的最近一次匹配事件：区块 ${event.block}，交易 ${event.tx}。${label}。`,
    en: `Latest matching event in the contiguous backward read: block ${event.block}, transaction ${event.tx}. ${label}.`,
  }, lang), unknown];
}

const boundary = {
  zh: '设计成本更低不等于能夺榜。当前反例资格、承诺和流片顺序，以及有没有人执行 reclaim，都可能影响榜位。不能只按 C 预测结果。这个成本差不是安全距离。',
  en: 'A lower design cost does not mean the slot can be taken. Current counterexamples, commit and tape-out order, and whether anyone calls reclaim can all change the slot. Cost order alone does not predict the result. This cost gap is not a safety margin.',
};

export function slotSummary(row, lang) {
  const label = {
    leader: ['最优位 · 现任榜主', 'Optimal slot · current leader'],
    other: ['最优位 · 不是榜主', 'Optimal slot · not the leader'],
    unclaimed: ['最优位 · 未认领题目', 'Optimal slot · no task claimed'],
    empty: ['最优位 · 空位', 'Optimal slot · empty'],
    unread: ['最优位 · —', 'Optimal slot · —'],
  }[row?.role] || ['最优位 · —', 'Optimal slot · —'];
  return lang === 'en' ? label[1] : label[0];
}

export function slotLoadingSummary(lang) {
  return lang === 'en' ? 'Optimal slot' : '最优位';
}

export function slotLoadingLine(lang) {
  return lang === 'en' ? 'Reading the slot.' : '正在读取榜位。';
}

export function slotBscSummary(lang) {
  return lang === 'en' ? 'Optimal slot · BSC not open' : '最优位 · BSC 尚未开放';
}

export function slotBscSentences(lang) {
  return [text({
    zh: 'BSC 榜位查询尚未开放，这里不读 bestSlot。',
    en: 'BSC slot lookup is not open, so bestSlot is not read here.',
  }, lang)];
}

export function slotSentences(row, lang) {
  if (!row || row.role === 'unread') {
    return [text({ zh: '榜位读不到，显示 —。读失败不是 0。', en: 'Slot data is unavailable; showing —. A failed read is not zero.' }, lang)];
  }
  if (row.role === 'unclaimed') {
    return [text({ zh: 'taskId=0 是未认领题目的池，不显示成题目榜主。', en: 'taskId 0 is the unclaimed pool and is not shown as a task leader.' }, lang)];
  }
  const cpu = SLOT_CFG.processorLabel;
  const lines = [];
  if (row.status != null && row.status !== 1) {
    lines.push(text({
      zh: `这台链上 status=${row.status}，不是在挖（1）。下面只对照设计成本，不表示它正在出块。`,
      en: `On-chain status is ${row.status}, not mining (1). The lines below compare design cost only and do not mean it is producing.`,
    }, lang));
  }
  if (row.role === 'empty') {
    lines.push(text({
      zh: `题 ${row.taskId}、处理器 ${cpu} 的 bestSlot 为空，没有现任榜主。空位不写成 C=0。`,
      en: `bestSlot for task ${row.taskId} on ${cpu} is empty, so there is no current leader. An empty slot is not written as C=0.`,
    }, lang));
    return lines;
  }
  if (row.role === 'leader') {
    lines.push(text({
      zh: `这台是题 ${row.taskId}、处理器 ${cpu} 的现任榜主（以 bestSlot 为准）。设计成本 C=${row.leaderC}。C 是电路面积和深度指标，不是 OKB 或 BNB 买价。`,
      en: `This rig is the current leader for task ${row.taskId} on ${cpu} (bestSlot decides). Design cost C=${row.leaderC}. C is an area and depth measure, not an OKB or BNB price.`,
    }, lang));
    if (row.costMismatch) {
      lines.push(text({
        zh: 'bestSlot 返回的 C 与这台 costOf 不一致，成本差显示 —。',
        en: 'bestSlot cost and this rig’s costOf disagree, so the cost gap is —.',
      }, lang));
    } else if (!row.scanComplete) {
      lines.push(text({
        zh: '同题在挖设计没有完整读到，下一台更便宜设计的成本差显示 —。',
        en: 'The same-task mining set was not fully read, so the gap to the next cheaper design is —.',
      }, lang));
    } else if (row.nextC == null) {
      lines.push(text({
        zh: '这次完整读到的同题在挖设计里，没有 C 低于榜主的一台。这不是安全距离，也不表示以后不会被更低成本的设计换掉。',
        en: 'Among the same-task mining designs fully read this time, none has a lower C than the leader. That is not a safety margin, and it does not mean a cheaper design cannot replace it later.',
      }, lang));
    } else {
      lines.push(text({
        zh: `同题下一台更便宜的在挖设计：#${row.nextIds.join('、')}，C=${row.nextC}，成本差 ${row.gap}（榜主 C 减该设计 C）。同题 C 低于榜主的在挖设计有 ${row.cheaperCount} 台。`,
        en: `Next cheaper mining design on this task: #${row.nextIds.join(', ')}, C=${row.nextC}, gap ${row.gap} (leader C minus that C). ${row.cheaperCount} mining design(s) on this task have a lower C than the leader.`,
      }, lang));
      lines.push(text(boundary, lang));
    }
    if (row.keyOk === false) {
      lines.push(text({
        zh: '本地 minerKey 与链上不一致，没有用本地键枚举同题设计。',
        en: 'The local minerKey did not match the chain, so same-task designs were not enumerated with local keys.',
      }, lang));
    }
    lines.push(...eventLines(row.event, lang));
    return lines;
  }
  lines.push(text({
    zh: `这台不是题 ${row.taskId}、处理器 ${cpu} 的现任榜主。榜主是 #${row.leaderId}，榜主 C=${row.leaderC}。这台 C=${row.ownC ?? '—'}，相差 ${row.gap ?? '—'}（本机 C 减榜主 C）。`,
    en: `This rig is not the current leader for task ${row.taskId} on ${cpu}. The leader is #${row.leaderId}, leader C=${row.leaderC}. This rig’s C=${row.ownC ?? '—'}, difference ${row.gap ?? '—'} (this C minus leader C).`,
  }, lang));
  if (row.ownC == null || row.leaderC == null) {
    lines.push(text({ zh: '设计成本读不到，相差显示 —。', en: 'Design cost is unavailable, so the difference is —.' }, lang));
  } else {
    lines.push(text(boundary, lang));
    if (BigInt(row.ownC) === BigInt(row.leaderC)) {
      lines.push(text({
        zh: '设计成本与榜主相同。成本相同不能只靠 C 决定榜主，还要看承诺和流片顺序。',
        en: 'Design cost equals the leader. Equal C does not decide the leader by itself; commit and tape-out order still apply.',
      }, lang));
    }
  }
  return lines;
}

function abortIf(signal) {
  if (signal?.aborted) {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }
}

async function ethCall(rpc, counts, to, data, block, signal) {
  abortIf(signal);
  counts.ethCall += 1;
  const active = counts;
  active.inFlight = (active.inFlight || 0) + 1;
  active.maxInFlight = Math.max(active.maxInFlight || 0, active.inFlight);
  try {
    return await rpc('eth_call', [{ to, data }, block], { signal });
  } finally {
    active.inFlight -= 1;
  }
}

async function aggregate(rpc, counts, calls, block, signal, leaves) {
  const values = [];
  let ok = true;
  for (let i = 0; i < calls.length; i += leaves) {
    const group = calls.slice(i, i + leaves);
    let decoded = group.map(() => null);
    try {
      const raw = await ethCall(rpc, counts, SLOT_CFG.multicall, encodeTryAggregate(group), block, signal);
      decoded = decodeTryAggregate(raw, group.length);
    } catch {
      ok = false;
    }
    if (decoded.some(value => value == null)) ok = false;
    values.push(...decoded);
  }
  return { values, ok };
}

function normalizedId(id) {
  try {
    const n = BigInt(id);
    if (n < 0n || n >= 2n ** 256n) return null;
    return n;
  } catch { return null; }
}

export async function loadSlotDefense(ids, head, { rpc, signal, cfg = SLOT_CFG } = {}) {
  const counts = { ethCall: 0, ethGetLogs: 0, maxInFlight: 0, inFlight: 0 };
  const unavailable = () => ({ state: 'unavailable', head: head ?? null, rows: [], rpc: { ethCall: counts.ethCall, ethGetLogs: counts.ethGetLogs, maxInFlight: counts.maxInFlight } });
  if (typeof rpc !== 'function' || !Number.isSafeInteger(head) || head < 0) return unavailable();
  const unique = [];
  const seen = new Set();
  for (const id of ids || []) {
    const n = normalizedId(id);
    if (n == null) continue;
    const key = n.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(n);
  }
  if (!unique.length) return { state: 'ready', head, rows: [], rpc: { ethCall: 0, ethGetLogs: 0, maxInFlight: 0 } };
  const block = quantity(head);
  const processor = cfg.processor;
  const leaves = cfg.leavesPerCall;
  let keyOk = false;
  try {
    const local = minerKey(processor, unique[0]);
    const onchain = await ethCall(rpc, counts, cfg.mining, SEL.minerKey + pad(processor) + pad(unique[0]), block, signal);
    keyOk = typeof onchain === 'string' && onchain.toLowerCase() === local;
  } catch {
    keyOk = false;
  }

  const keys = new Map();
  if (keyOk) {
    for (const id of unique) keys.set(id.toString(), minerKey(processor, id));
  } else {
    const reads = await aggregate(rpc, counts, unique.map(id => ({
      to: cfg.mining, data: SEL.minerKey + pad(processor) + pad(id),
    })), block, signal, leaves);
    unique.forEach((id, index) => {
      const value = reads.values[index];
      if (words(value, 1)) keys.set(id.toString(), value.toLowerCase());
    });
  }

  const readable = unique.filter(id => keys.has(id.toString()));
  const minerRead = readable.length
    ? await aggregate(rpc, counts, readable.map(id => ({ to: cfg.mining, data: SEL.getMiner + pad(keys.get(id.toString())) })), block, signal, leaves)
    : { values: [], ok: true };
  const miners = new Map();
  readable.forEach((id, index) => {
    miners.set(id.toString(), decodeMiner(minerRead.values[index], { id, processor }));
  });

  const tasks = [...new Set(unique.map(id => miners.get(id.toString())).filter(miner => miner && !miner.empty && !miner.bad && miner.taskId > 0n).map(miner => miner.taskId.toString()))];
  const slots = new Map();
  if (tasks.length) {
    const slotRead = await aggregate(rpc, counts, tasks.map(task => ({
      to: cfg.mining, data: SEL.bestSlot + pad(task) + pad(processor),
    })), block, signal, leaves);
    tasks.forEach((task, index) => slots.set(task, decodeBestSlot(slotRead.values[index])));
  }

  const costInputs = [];
  for (const id of unique) {
    const miner = miners.get(id.toString());
    if (!miner || miner.empty || miner.bad) continue;
    costInputs.push({ id: id.toString(), area: miner.area, depth: miner.depth });
  }
  const ownCosts = new Map();
  if (costInputs.length) {
    const costRead = await aggregate(rpc, counts, costInputs.map(row => ({
      to: cfg.mining, data: SEL.costOf + pad(row.area) + pad(row.depth),
    })), block, signal, leaves);
    costInputs.forEach((row, index) => {
      const fields = words(costRead.values[index], 1);
      if (fields) ownCosts.set(row.id, fields[0]);
    });
  }

  const leaderTasks = [];
  for (const id of unique) {
    const miner = miners.get(id.toString());
    const slot = miner && miner.taskId > 0n ? slots.get(miner.taskId.toString()) : null;
    if (slot?.id != null && slot.id === id) leaderTasks.push(miner.taskId.toString());
  }
  const leaderTaskSet = new Set(leaderTasks);

  let scanComplete = false;
  let competitors = [];
  if (leaderTaskSet.size && keyOk) {
    try {
      const nextRaw = await ethCall(rpc, counts, cfg.processor, SEL.nextId, block, signal);
      const nextFields = words(nextRaw, 1);
      const nextId = nextFields?.[0];
      if (nextId == null || nextId >= BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('nextId unavailable');
      const last = Number(nextId);
      const recordIds = Array.from({ length: last + 1 }, (_, index) => BigInt(index));
      const scan = await aggregate(rpc, counts, recordIds.map(id => ({
        to: cfg.mining, data: SEL.getMiner + pad(minerKey(processor, id)),
      })), block, signal, leaves);
      const found = [];
      let bad = false;
      recordIds.forEach((id, index) => {
        const miner = decodeMiner(scan.values[index], { id, processor });
        if (!miner || miner.bad) { bad = true; return; }
        if (miner.empty || miner.status !== 1 || !leaderTaskSet.has(miner.taskId.toString())) return;
        found.push({ id, taskId: miner.taskId.toString(), area: miner.area, depth: miner.depth });
      });
      if (!bad && scan.ok) {
        const costs = found.length
          ? await aggregate(rpc, counts, found.map(row => ({ to: cfg.mining, data: SEL.costOf + pad(row.area) + pad(row.depth) })), block, signal, leaves)
          : { values: [], ok: true };
        if (costs.ok) {
          competitors = found.map((row, index) => ({ ...row, id: row.id.toString(), cost: words(costs.values[index], 1)?.[0] ?? null }));
          scanComplete = competitors.every(row => row.cost != null);
        }
      }
    } catch {
      scanComplete = false;
    }
  }

  const events = new Map();
  if (leaderTaskSet.size) {
    const wanted = new Set(leaderTaskSet);
    let cursor = head;
    let windows = 0;
    let from = head;
    let failed = false;
    const seenLogs = [];
    while (wanted.size && cursor >= 0 && windows < cfg.maxLogWindows) {
      const lo = Math.max(0, cursor - cfg.logWindow + 1);
      from = lo;
      windows += 1;
      counts.ethGetLogs += 1;
      abortIf(signal);
      counts.inFlight += 1;
      counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight);
      let logs = null;
      try {
        logs = await rpc('eth_getLogs', [{
          address: cfg.mining,
          fromBlock: quantity(lo),
          toBlock: quantity(cursor),
          topics: [[TOPIC.demoted, TOPIC.reclaimed, TOPIC.started]],
        }], { signal });
      } catch {
        failed = true;
      } finally {
        counts.inFlight -= 1;
      }
      if (!Array.isArray(logs)) { failed = true; break; }
      seenLogs.push(...logs);
      for (const task of [...wanted]) {
        const event = latestTakeover(seenLogs, { taskId: task, processor });
        if (event.kind !== 'none') {
          events.set(task, { ...event, from: from.toString(), to: String(head) });
          wanted.delete(task);
        }
      }
      if (lo === 0) break;
      cursor = lo - 1;
    }
    for (const task of leaderTaskSet) {
      if (events.has(task)) continue;
      events.set(task, failed
        ? { kind: 'unread', kick: 'UNKNOWN' }
        : { kind: 'none', kick: 'UNKNOWN', from: from.toString(), to: String(head) });
    }
  }

  const rows = unique.map(id => {
    const key = id.toString();
    const miner = miners.get(key);
    if (!miner || miner.empty || miner.bad) return { id: key, role: 'unread' };
    if (miner.taskId === 0n) return { id: key, role: 'unclaimed', taskId: '0', status: miner.status };
    const slot = slots.get(miner.taskId.toString());
    if (!slot) return { id: key, role: 'unread', taskId: miner.taskId.toString(), status: miner.status };
    if (slot.id == null) return { id: key, role: 'empty', taskId: miner.taskId.toString(), status: miner.status };
    const ownC = ownCosts.get(key) ?? null;
    const leader = slot.id === id;
    const base = {
      id: key,
      taskId: miner.taskId.toString(),
      status: miner.status,
      leaderId: slot.id.toString(),
      leaderC: slot.cost.toString(),
      ownC: ownC?.toString() ?? null,
      keyOk,
    };
    if (leader) {
      const mismatch = ownC != null && ownC !== slot.cost;
      const pool = competitors.filter(row => row.taskId === miner.taskId.toString() && row.id !== key);
      const next = scanComplete && !mismatch ? nextCheaperDesign(slot.cost, pool) : { ok: false };
      return {
        ...base,
        role: 'leader',
        costMismatch: mismatch,
        scanComplete: scanComplete && !mismatch && next.ok,
        nextC: next.ok ? next.cost?.toString() ?? null : null,
        nextIds: next.ok ? next.designs : [],
        gap: next.ok && next.gap != null ? next.gap.toString() : null,
        cheaperCount: next.ok ? next.count : null,
        event: events.get(miner.taskId.toString()) || { kind: 'unread', kick: 'UNKNOWN' },
      };
    }
    return {
      ...base,
      role: 'other',
      gap: ownC == null ? null : (ownC - slot.cost).toString(),
    };
  });
  return {
    state: 'ready',
    head,
    rows,
    rpc: { ethCall: counts.ethCall, ethGetLogs: counts.ethGetLogs, maxInFlight: counts.maxInFlight },
  };
}
