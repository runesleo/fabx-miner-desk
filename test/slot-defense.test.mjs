import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTryAggregate, encodeTryAggregate } from '../multicall.mjs';
import {
  SLOT_CFG, decodeBestSlot, decodeMiner, latestTakeover, loadSlotDefense, minerKey,
  nextCheaperDesign, sameTaskScanCalls, slotSentences,
} from '../slot-defense.mjs';

const GENESIS = SLOT_CFG.processor;
const TOPIC = {
  demoted: '0x687eb3f2eb7f9e2f33de282fee110bc0bcadb9c0dc5ffd2f7e27d440952e1549',
  reclaimed: '0xbf1fd8b9ffbac479b8800a970decd30b1e919c3e440c9fb3a1a21a491906ffd5',
  started: '0x7c9c1f2b9aa7cd28c79cdeb371997e1c61e4aa92cf7c29b91d01287092f94937',
};
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const words = (...values) => '0x' + values.map(word).join('');

function encodeResults(results) {
  const tuples = results.map((value) => {
    if (value == null) return word(0) + word(64) + word(0);
    const body = value.replace(/^0x/, '').toLowerCase();
    const padded = body.padEnd(Math.ceil(body.length / 64) * 64, '0');
    return word(1) + word(64) + word(body.length / 2) + padded;
  });
  let offset = results.length * 32;
  const offsets = tuples.map((tuple) => {
    const encoded = word(offset);
    offset += tuple.length / 2;
    return encoded;
  });
  return '0x' + word(32) + word(results.length) + offsets.join('') + tuples.join('');
}

function parseAggregate(data) {
  assert.equal(data.slice(0, 10), '0xbce38bd7');
  const body = data.slice(10);
  const at = (index) => BigInt('0x' + body.slice(index * 64, (index + 1) * 64));
  const count = Number(at(2));
  const calls = [];
  for (let i = 0; i < count; i++) {
    const start = 3 + Number(at(3 + i)) / 32;
    const to = '0x' + at(start).toString(16).padStart(40, '0');
    const byteLen = Number(at(start + 2));
    let hex = '';
    for (let w = 0; w < Math.ceil(byteLen / 32); w++) hex += at(start + 3 + w).toString(16).padStart(64, '0');
    calls.push({ to, data: '0x' + hex.slice(0, byteLen * 2) });
  }
  return calls;
}

test('multicall fixtures round-trip and minerKey matches the published FabX samples', () => {
  const encoded = encodeTryAggregate([
    { to: SLOT_CFG.mining, data: '0x11d5a55c' + word(99) + word(GENESIS) },
    { to: SLOT_CFG.mining, data: '0x0527edc2' + word(1) },
  ]);
  const calls = parseAggregate(encoded);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].data.slice(0, 10), '0x11d5a55c');
  assert.deepEqual(decodeTryAggregate(encodeResults(['0x' + word(7), null]), 2), ['0x' + word(7), null]);
  assert.equal(minerKey(GENESIS, 6108), '0x010bb6934aa07aee76b24ec00bd904bd0b5098b8d7c35badec09a34510c4b6e8');
  assert.equal(minerKey(GENESIS, 5920), '0x8238931fe340e681a6fc1b5c1849439f07d00ee6ad69845e361efd0c785ef89b');
});

test('published bestSlot and task 99 logs are a reclaim link, not a proven kick', () => {
  const best = decodeBestSlot('0x' + word(0x17dd) + word(0x1fe7b));
  assert.equal(best.holderPlus1, 6109n);
  assert.equal(best.id, 6108n);
  assert.equal(best.cost, 130683n);
  const tx = '0x56f0a019907a878b30618e42cda012d3ba611d91cc59bf8a0ba32fc7d0a1094d';
  const event = latestTakeover([
    {
      removed: false, blockNumber: '0x4662d9c', transactionIndex: '0x1', logIndex: '0x32', transactionHash: tx,
      topics: [TOPIC.demoted, '0xf6d85bfc1c138ddefb6336b6b9cbf44d1c405ffda09e2db85595690286c085d7', '0x' + word(GENESIS)],
      data: '0x' + word(0x1370) + word(0x63),
    },
    {
      removed: false, blockNumber: '0x4662d9c', transactionIndex: '0x1', logIndex: '0x35', transactionHash: tx,
      topics: [TOPIC.reclaimed, '0x010bb6934aa07aee76b24ec00bd904bd0b5098b8d7c35badec09a34510c4b6e8', '0x' + word(0x63)],
      data: '0x' + word(0x524),
    },
  ], { taskId: 99, processor: GENESIS });
  assert.equal(event.kind, 'reclaim');
  assert.equal(event.kick, 'UNKNOWN');
  assert.equal(event.block, '73805212');
  const lone = latestTakeover([{
    removed: false, blockNumber: '0x10', transactionIndex: '0x0', logIndex: '0x1', transactionHash: '0x' + 'ab'.repeat(32),
    topics: [TOPIC.demoted, '0x' + word(1), '0x' + word(GENESIS)],
    data: '0x' + word(1) + word(99),
  }], { taskId: 99, processor: GENESIS });
  assert.equal(lone.kind, 'demoted-only');
  assert.equal(nextCheaperDesign(130683n, [{ id: 3257, cost: 123930n }, { id: 2787, cost: 32616n }, { id: 6108, cost: 130683n }]).gap, 6753n);
});

test('leader and cheaper non-leader copy keeps the takeover boundary', () => {
  const leader = slotSentences({
    role: 'leader', taskId: '99', status: 1, leaderC: '130683', ownC: '130683', costMismatch: false,
    scanComplete: true, nextC: '123930', nextIds: ['3257'], gap: '6753', cheaperCount: 14, keyOk: true,
    event: { kind: 'reclaim', kick: 'UNKNOWN', block: '73805212', tx: '0x56f0a019907a878b30618e42cda012d3ba611d91cc59bf8a0ba32fc7d0a1094d' },
  }, 'zh').join('\n');
  assert.match(leader, /成本差 6753/);
  assert.match(leader, /14 台/);
  assert.match(leader, /不等于能夺榜/);
  assert.match(leader, /不是安全距离/);
  assert.match(leader, /reclaim 关联夺榜/);
  assert.match(leader, /kick 原因：UNKNOWN/);
  assert.doesNotMatch(leader, /从未|可以夺榜|一定能|就能夺/);
  const cheaper = slotSentences({
    role: 'other', taskId: '99', status: 1, leaderId: '6108', leaderC: '130683', ownC: '32616', gap: '-98067',
  }, 'zh').join('\n');
  assert.match(cheaper, /相差 -98067/);
  assert.match(cheaper, /不等于能夺榜/);
  assert.doesNotMatch(cheaper, /从未|可以夺榜/);
  const missed = slotSentences({
    role: 'leader', taskId: '99', status: 1, leaderC: '130683', scanComplete: true, nextC: null, nextIds: [],
    gap: null, cheaperCount: 0, keyOk: true, costMismatch: false,
    event: { kind: 'none', kick: 'UNKNOWN', from: '1', to: '100' },
  }, 'zh').join('\n');
  assert.match(missed, /没有发生过 kick/);
  assert.doesNotMatch(missed, /从未 kick/);
  assert.match(slotSentences({ role: 'unclaimed', taskId: '0' }, 'zh').join('\n'), /不显示成题目榜主/);
  assert.match(slotSentences({ role: 'empty', taskId: '4', status: 1 }, 'en').join('\n'), /not written as C=0/);
});

function minerTuple(id, fields) {
  const data = Array(23).fill(0n);
  if (!fields) return words(...data);
  data[0] = BigInt(GENESIS);
  data[1] = BigInt(id);
  data[2] = BigInt(fields.taskId);
  data[5] = BigInt(fields.depth);
  data[6] = BigInt(fields.area);
  data[9] = BigInt(fields.status);
  data[15] = fields.optimal ? 1n : 0n;
  return words(...data);
}

function rigFixture() {
  return new Map([
    [3, { taskId: 7, status: 1, area: 9, depth: 2 }],
    [10, { taskId: 7, status: 1, area: 10, depth: 2, optimal: true }],
    [11, { taskId: 7, status: 1, area: 8, depth: 2 }],
    [12, { taskId: 0, status: 1, area: 4, depth: 1 }],
  ]);
}

function costOf(area, depth) {
  const table = { '10:2': 100n, '9:2': 90n, '8:2': 70n, '4:1': 40n };
  return table[`${area}:${depth}`] ?? null;
}

function serve(records, { head = 2000, eventBlock = 2000, mismatch = false, logs = true } = {}) {
  const seen = [];
  let active = 0;
  let maxActive = 0;
  const tx = '0x' + 'cd'.repeat(32);
  const rpc = async (method, params) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    try {
      seen.push({ method, params });
      if (method === 'eth_getLogs') {
        const filter = params[0];
        const lo = Number(filter.fromBlock);
        const hi = Number(filter.toBlock);
        if (!logs || eventBlock < lo || eventBlock > hi) return [];
        return [
          {
            removed: false, blockNumber: '0x' + eventBlock.toString(16), transactionIndex: '0x1', logIndex: '0x4',
            transactionHash: tx, topics: [TOPIC.demoted, '0x' + word(1), '0x' + word(GENESIS)],
            data: '0x' + word(4) + word(7),
          },
          {
            removed: false, blockNumber: '0x' + eventBlock.toString(16), transactionIndex: '0x1', logIndex: '0x5',
            transactionHash: tx, topics: [TOPIC.reclaimed, '0x' + word(2), '0x' + word(7)],
            data: '0x' + word(9),
          },
        ];
      }
      if (method !== 'eth_call') throw new Error(method);
      const { to, data } = params[0];
      const selector = data.slice(0, 10);
      if (selector === '0x10eafa00' && !data.startsWith('0xbce38bd7')) {
        const id = BigInt('0x' + data.slice(10 + 64, 10 + 128));
        return mismatch ? '0x' + '11'.repeat(32) : minerKey(GENESIS, id);
      }
      if (selector === '0x61b8ce8c') return '0x' + word(12);
      if (selector !== '0xbce38bd7') throw new Error(`unexpected call ${selector}`);
      const inner = parseAggregate(data);
      const results = inner.map((call) => {
        const sig = call.data.slice(0, 10);
        if (sig === '0x10eafa00') return minerKey(GENESIS, BigInt('0x' + call.data.slice(74, 138)));
        if (sig === '0x0527edc2') {
          const key = call.data.slice(10, 74);
          for (const [id, fields] of records) if (minerKey(GENESIS, id).slice(2) === key) return minerTuple(id, fields);
          return minerTuple(0, null);
        }
        if (sig === '0x11d5a55c') {
          const task = Number(BigInt('0x' + call.data.slice(10, 74)));
          if (task !== 7) return null;
          return '0x' + word(11) + word(100);
        }
        if (sig === '0x3a55fef3') {
          const area = BigInt('0x' + call.data.slice(10, 74));
          const depth = BigInt('0x' + call.data.slice(74, 138));
          const cost = costOf(area, depth);
          return cost == null ? null : '0x' + word(cost);
        }
        return null;
      });
      assert.equal(to.toLowerCase(), SLOT_CFG.multicall);
      return encodeResults(results);
    } finally {
      active -= 1;
    }
  };
  return { rpc, seen, max: () => maxActive };
}

test('a leader scan stays inside the same-task call budget and does not prove a kick', async () => {
  const records = rigFixture();
  const chain = serve(records);
  const cfg = { ...SLOT_CFG, leavesPerCall: 4 };
  const result = await loadSlotDefense([10, 11, 12], 2000, { rpc: chain.rpc, cfg });
  assert.equal(result.state, 'ready');
  assert.ok(result.rpc.maxInFlight <= 3);
  const leader = result.rows.find(row => row.id === '10');
  const other = result.rows.find(row => row.id === '11');
  const pool = result.rows.find(row => row.id === '12');
  assert.equal(leader.role, 'leader');
  assert.equal(leader.gap, '10');
  assert.equal(leader.nextC, '90');
  assert.deepEqual(leader.nextIds, ['3']);
  assert.equal(leader.cheaperCount, 2);
  assert.equal(leader.event.kind, 'reclaim');
  assert.equal(leader.event.kick, 'UNKNOWN');
  assert.equal(other.gap, '-30');
  assert.equal(pool.role, 'unclaimed');
  const text = slotSentences(leader, 'zh').join('\n') + slotSentences(other, 'zh').join('\n');
  assert.match(text, /不等于能夺榜/);
  assert.doesNotMatch(text, /从未|可以夺榜/);
  const logs = chain.seen.filter(call => call.method === 'eth_getLogs');
  assert.equal(logs.length, 1);
  assert.equal(result.rpc.ethGetLogs, 1);
  const expanded = chain.seen.filter(call => call.method === 'eth_call').flatMap((call) => {
    const data = call.params[0].data;
    return data.startsWith('0xbce38bd7') ? parseAggregate(data) : [{ to: call.params[0].to, data }];
  });
  assert.equal(expanded.filter(call => call.data.startsWith('0x61b8ce8c')).length, 1);
  assert.equal(expanded.filter(call => call.data.startsWith('0x0527edc2')).length, 16);
  assert.equal(expanded.filter(call => call.data.startsWith('0x3a55fef3')).length, 6);
  assert.equal(sameTaskScanCalls(13, 3, 4), 6);
  assert.equal(result.rpc.ethCall, 10);
  assert.equal(expanded.some(call => call.data.startsWith('0xb0d60279') || call.data.startsWith('0x919c1ada')), false);
  assert.equal(chain.seen.some(call => call.method === 'eth_getBlockByNumber' || call.method === 'eth_getTransactionByHash'), false);
  const miner = decodeMiner(minerTuple(10, records.get(10)), { id: 10, processor: GENESIS });
  assert.equal(miner.taskId, 7n);
  assert.equal(miner.area, 10n);
});

test('a non-leader does not scan listings or logs', async () => {
  const chain = serve(rigFixture());
  const result = await loadSlotDefense([11], 2000, { rpc: chain.rpc, cfg: { ...SLOT_CFG, leavesPerCall: 4 } });
  assert.equal(result.rows[0].role, 'other');
  assert.equal(result.rpc.ethGetLogs, 0);
  const datas = chain.seen.filter(call => call.method === 'eth_call').map(call => call.params[0].data);
  assert.equal(datas.some(data => data.startsWith('0x61b8ce8c')), false);
  assert.equal(result.rpc.ethCall, 4);
});

test('a key mismatch does not enumerate with local keys', async () => {
  const chain = serve(rigFixture(), { mismatch: true });
  const result = await loadSlotDefense([10], 2000, { rpc: chain.rpc, cfg: { ...SLOT_CFG, leavesPerCall: 4 } });
  assert.equal(result.rows[0].role, 'leader');
  assert.equal(result.rows[0].scanComplete, false);
  assert.match(slotSentences(result.rows[0], 'zh').join('\n'), /没有用本地键枚举/);
  const expanded = chain.seen.filter(call => call.method === 'eth_call').flatMap((call) => {
    const data = call.params[0].data;
    return data.startsWith('0xbce38bd7') ? parseAggregate(data) : [{ to: call.params[0].to, data }];
  });
  assert.equal(expanded.filter(call => call.data.startsWith('0x61b8ce8c')).length, 0);
  assert.equal(expanded.filter(call => call.data.startsWith('0x0527edc2')).length, 1);
});

test('an empty backward window is not reported as never kicked', async () => {
  const chain = serve(rigFixture(), { eventBlock: 10, logs: true });
  const result = await loadSlotDefense([10], 5000, { rpc: chain.rpc, cfg: { ...SLOT_CFG, leavesPerCall: 128, logWindow: 1000, maxLogWindows: 2 } });
  assert.equal(result.rows[0].event.kind, 'none');
  assert.equal(result.rpc.ethGetLogs, 2);
  const text = slotSentences(result.rows[0], 'zh').join('\n');
  assert.match(text, /更早的区块没有读/);
  assert.match(text, /不能把没读到写成没有发生过 kick/);
  assert.doesNotMatch(text, /从未 kick/);
});
