import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { d1 } from './helpers/d1.mjs';
import { POD_CFG } from '../pod.mjs';
import { BSC_ADDRESS_LOOKUP, fetchBscRigs, parseBscRigsResponse } from '../bsc-rigs-client.mjs';
import {
  BSC_INDEX_BUILDING,
  BSC_INDEX_CHUNK_BLOCKS,
  BSC_INDEX_MAX_CHUNKS,
  BSC_TRANSFER_TOPIC,
  ZERO_ADDRESS,
  bscTransferFilter,
  defaultBscGetLogs,
  runBscIndex,
  bscRigsForAddress,
} from '../alerts/bsc-index.mjs';
import { runCheck } from '../alerts/worker.mjs';
import * as api from '../functions/api/bsc-rigs.js';

const PROC_A = POD_CFG.processors[0].address;
const ALICE = '0x0587e1e53be5e897432c64c08697df9a72fe95b2';
const BOB = '0x1111111111111111111111111111111111111111';
const NOW = () => new Date('2026-10-23T02:00:00.000Z');

function transfer({ block, index = 1, processor = PROC_A, from = ZERO_ADDRESS, to, id }) {
  const topic = (addr) => `0x${addr.slice(2).toLowerCase().padStart(64, '0')}`;
  return {
    address: processor,
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${index.toString(16)}`,
    topics: [BSC_TRANSFER_TOPIC, topic(from), topic(to), `0x${BigInt(id).toString(16).padStart(64, '0')}`],
  };
}

function reader(logs, ranges) {
  return async (filter, from, to) => {
    ranges.push([from, to, filter.address.length, filter.topics[0]]);
    assert.ok(to - from + 1 <= BSC_INDEX_CHUNK_BLOCKS);
    return logs.filter((log) => {
      const block = Number(log.blockNumber);
      return block >= from && block <= to;
    });
  };
}

test('cold backfill is capped at 15 chunks and stays incomplete', async () => {
  const db = d1();
  const ranges = [];
  const head = 20_000;
  const first = await runBscIndex(db, {
    head, fromBlock: 0, now: NOW, getLogs: reader([transfer({ block: 100, to: ALICE, id: 7 })], ranges),
  });
  assert.equal(first.chunks, BSC_INDEX_MAX_CHUNKS);
  assert.equal(first.complete, false);
  assert.equal(first.backfilling, true);
  assert.equal(ranges.length, 15);
  assert.deepEqual(ranges[0], [0, 999, 2, BSC_TRANSFER_TOPIC]);
  assert.equal(ranges.at(-1)[1] - ranges[0][0] + 1, 15_000);
  const building = await bscRigsForAddress(db, ALICE);
  assert.equal(building.message, '索引建设中');
  assert.deepEqual(building.rigs, []);
  const row = await db.prepare('SELECT owner FROM bsc_nft_holders WHERE token_id = ?').bind('7').first();
  assert.equal(row.owner, ALICE);
});

test('later rounds finish the backfill and follow transfers, burns, and out-of-order logs', async () => {
  const db = d1();
  const ranges = [];
  const fromBlock = 1_000;
  const head = 1_000 + 2_500 - 1;
  const logs = [
    transfer({ block: 1_100, to: ALICE, id: 7 }),
    transfer({ block: 1_100, index: 2, to: ALICE, id: 8 }),
    transfer({ block: 2_200, from: ALICE, to: BOB, id: 7 }),
    transfer({ block: 2_100, from: ALICE, to: ZERO_ADDRESS, id: 8 }),
    transfer({ block: 2_400, index: 2, to: BOB, id: 9 }),
    transfer({ block: 2_400, index: 4, to: ALICE, id: 9 }),
  ];
  const opts = { head, fromBlock, chunkBlocks: 1_000, maxChunks: 2, now: NOW, getLogs: reader(logs, ranges) };
  const first = await runBscIndex(db, opts);
  assert.equal(first.complete, false);
  assert.equal(first.chunks, 2);
  assert.equal(ranges.at(-1)[1], fromBlock + 2_000 - 1);
  const mid = await bscRigsForAddress(db, ALICE);
  assert.equal(mid.building, true);
  assert.deepEqual(mid.rigs, []);

  ranges.length = 0;
  const second = await runBscIndex(db, opts);
  assert.equal(second.complete, true);
  assert.equal(second.backfilling, false);
  assert.equal(ranges[0][0], fromBlock + 2_000);
  assert.equal(ranges.at(-1)[1], head);

  const alice = await bscRigsForAddress(db, ALICE);
  const bob = await bscRigsForAddress(db, BOB);
  assert.equal(alice.building, false);
  assert.equal(alice.message, null);
  assert.deepEqual(alice.rigs.map((rig) => rig.id), ['9']);
  assert.equal(alice.rigs[0].label, 'TapeOut');
  assert.equal(alice.progress.complete, true);
  assert.equal(alice.progress.updatedAt, '2026-10-23T02:00:00.000Z');
  assert.deepEqual(bob.rigs.map((rig) => [rig.label, rig.id]), [['TapeOut', '7']]);
  assert.equal((await bscRigsForAddress(db, ZERO_ADDRESS)).rigs.length, 0);

  const third = await runBscIndex(db, { ...opts, head: head + 10, getLogs: async () => [] });
  assert.equal(third.complete, true);
  assert.equal((await bscRigsForAddress(db, ALICE)).rigs.map((rig) => rig.id).join(), '9');
});

test('a failed chunk does not advance the cursor and the next run retries it', async () => {
  const db = d1();
  const ranges = [];
  const getLogs = async (_filter, from, to) => {
    ranges.push([from, to]);
    if (from >= 2_000) throw new Error('rpc down');
    return [transfer({ block: from + 5, to: ALICE, id: 3 })];
  };
  const opts = { head: 5_000, fromBlock: 1_000, chunkBlocks: 1_000, maxChunks: 15, now: NOW, getLogs };
  const failed = await runBscIndex(db, opts);
  assert.match(failed.error, /rpc down/);
  assert.equal(failed.complete, false);
  assert.deepEqual(ranges, [[1_000, 1_999], [2_000, 2_999]]);
  const stored = await db.prepare('SELECT scanned_to, complete FROM bsc_index_state WHERE id = 1').first();
  assert.equal(Number(stored.scanned_to), 1_999);
  assert.equal(Number(stored.complete), 0);

  ranges.length = 0;
  const again = await runBscIndex(db, { ...opts, getLogs: async (_filter, from, to) => { ranges.push([from, to]); return []; } });
  assert.equal(again.complete, true);
  assert.equal(ranges[0][0], 2_000);
  assert.equal(ranges.at(-1)[1], 5_000);
});

test('a head behind the index origin does not publish an empty index', async () => {
  const db = d1();
  const result = await runBscIndex(db, {
    head: 10, fromBlock: 1_000, now: NOW,
    getLogs: async () => { throw new Error('must not read logs'); },
  });
  assert.equal(result.complete, false);
  assert.equal(result.chunks, 0);
  assert.match(result.error, /origin/);
  assert.equal((await bscRigsForAddress(db, ALICE)).building, true);
  assert.equal(await db.prepare('SELECT id FROM bsc_index_state').first(), null);
});

test('a finished index stays readable when a later catch-up chunk fails', async () => {
  const db = d1();
  await runBscIndex(db, {
    head: 1_999, fromBlock: 1_000, now: NOW,
    getLogs: reader([transfer({ block: 1_100, to: ALICE, id: 4 })], []),
  });
  assert.deepEqual((await bscRigsForAddress(db, ALICE)).rigs.map((rig) => rig.id), ['4']);

  const ranges = [];
  const failed = await runBscIndex(db, {
    head: 5_000, fromBlock: 1_000, now: NOW,
    getLogs: async (_filter, from, to) => {
      ranges.push([from, to]);
      if (from >= 3_000) throw new Error('rpc down');
      return [transfer({ block: from + 1, to: BOB, id: 5 })];
    },
  });
  assert.equal(failed.complete, false);
  assert.match(failed.error, /rpc down/);
  const state = await db.prepare('SELECT scanned_to, complete FROM bsc_index_state WHERE id = 1').first();
  assert.equal(Number(state.scanned_to), 2_999);
  assert.equal(Number(state.complete), 1);
  assert.equal((await bscRigsForAddress(db, ALICE)).building, false);
  assert.deepEqual((await bscRigsForAddress(db, ALICE)).rigs.map((rig) => rig.id), ['4']);
  assert.deepEqual((await bscRigsForAddress(db, BOB)).rigs.map((rig) => rig.id), ['5']);
  assert.deepEqual(ranges, [[2_000, 2_999], [3_000, 3_999]]);
});

test('the alerts cron runs the index without measuring watched addresses', async () => {
  const db = d1();
  const ranges = [];
  const summary = await runCheck({ DB: db }, {
    snap: { head: 1, headTimestamp: 1, blockTime: 1 },
    send: async () => { throw new Error('must not send'); },
    measure: async () => { throw new Error('must not measure'); },
    skipGovernance: true,
    skipWeekly: true,
    skipMarket: true,
    head: 4_000,
    fromBlock: 1_000,
    now: NOW,
    getLogs: async (_filter, from, to) => { ranges.push([from, to]); return []; },
  });
  assert.equal(summary.addresses, 0);
  assert.equal(summary.bscIndex.complete, true);
  assert.equal(summary.bscIndex.chunks, 4);
  assert.deepEqual(ranges, [[1_000, 1_999], [2_000, 2_999], [3_000, 3_999], [4_000, 4_000]]);
});

test('default log reader refuses a range over 1000 blocks before any request', async () => {
  let called = false;
  await assert.rejects(
    () => defaultBscGetLogs(bscTransferFilter(), 10, 10 + BSC_INDEX_CHUNK_BLOCKS, undefined, {
      fetchImpl: () => { called = true; throw new Error('network'); },
    }),
    /1000/,
  );
  assert.equal(called, false);
});

test('GET /api/bsc-rigs returns CORS, 索引建设中, then the holder list', async () => {
  const DB = d1();
  const origin = 'https://r1-dc945fd3aee9829a3c9065459e82aa503572da5f-deweb.fabx.tech';
  const call = (addr, method = 'GET') => api.onRequest({
    request: new Request(`https://fabx-miner-desk.pages.dev/api/bsc-rigs?addr=${addr}`, {
      method, headers: { Origin: origin },
    }),
    env: { DB },
  });
  const options = await api.onRequest({
    request: new Request('https://fabx-miner-desk.pages.dev/api/bsc-rigs', { method: 'OPTIONS', headers: { Origin: origin } }),
    env: { DB },
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), origin);
  assert.match(options.headers.get('access-control-allow-methods'), /GET/);

  const building = await call(ALICE);
  assert.equal(building.status, 200);
  assert.equal(building.headers.get('access-control-allow-origin'), origin);
  assert.equal(building.headers.get('cache-control'), 'private, no-store');
  const buildingBody = await building.json();
  assert.equal(buildingBody.ok, true);
  assert.equal(buildingBody.message, BSC_INDEX_BUILDING);
  assert.deepEqual(buildingBody.rigs, []);
  assert.equal(buildingBody.progress.complete, false);

  await runBscIndex(DB, {
    head: 1_100, fromBlock: 1_000, now: NOW,
    getLogs: async () => [transfer({ block: 1_050, to: ALICE, id: 13659 })],
  });
  const ready = await call(`0x${ALICE.slice(2).toUpperCase()}`);
  const readyBody = await ready.json();
  assert.equal(readyBody.building, false);
  assert.equal(readyBody.message, null);
  assert.equal(readyBody.address, ALICE);
  assert.deepEqual(readyBody.rigs, [{ id: '13659', processor: PROC_A.toLowerCase(), label: 'TapeOut' }]);
  assert.equal(readyBody.progress.updatedAt, '2026-10-23T02:00:00.000Z');

  const bad = await call('0x123');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_address');
  const missing = await api.onRequest({
    request: new Request('https://fabx-miner-desk.pages.dev/api/bsc-rigs', { method: 'GET' }),
    env: {},
  });
  assert.equal(missing.status, 503);
});

test('the page client accepts a ready index and rejects a partial one', async () => {
  assert.equal(BSC_ADDRESS_LOOKUP, false);
  assert.equal(parseBscRigsResponse({ ok: true, building: true, message: '索引建设中', rigs: [{ id: '1' }], progress: { complete: false } }).rigs.length, 0);
  assert.equal(parseBscRigsResponse({ ok: true, building: false, message: null, rigs: [{ id: 'x', processor: PROC_A }], progress: { complete: true } }), null);
  const seen = [];
  const ready = await fetchBscRigs(ALICE, {
    location: { hostname: 'localhost' },
    fetchImpl: async (url) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ ok: true, building: false, message: null, address: ALICE, rigs: [{ id: '9', processor: PROC_A, label: 'TapeOut' }], progress: { complete: true, scannedTo: 5, head: 5, updatedAt: '2026-10-23T02:00:00.000Z' } }) };
    },
  });
  assert.equal(seen[0], `/api/bsc-rigs?addr=${ALICE}`);
  assert.equal(ready.building, false);
  assert.equal(ready.rigs[0].id, '9');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /BSC_ADDRESS_LOOKUP/);
  assert.match(html, /fetchBscRigs/);
  assert.match(html, /podRigsForIds/);
  assert.match(html, /索引建设中/);
});
