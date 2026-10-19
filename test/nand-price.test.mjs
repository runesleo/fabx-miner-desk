import test from 'node:test';
import assert from 'node:assert/strict';
import { NAND_TRANSISTORS, decodeMarketAsk, bestNandAsk, readNandPrice, validNandPrice } from '../nand-price.mjs';

const pad = n => BigInt(n).toString(16).padStart(64, '0');
const addr = a => a.slice(2).padStart(64, '0');
const owner = '0x' + '1'.repeat(40);
const order = (price = 20_000_000_000_000_000n, qty = 20n, token = 0n, collection = NAND_TRANSISTORS) => '0x' + addr(owner) + addr(collection) + pad(price) + pad(token) + pad(100) + pad(qty);
const aggregate = rows => {
  const tuples = rows.map(row => pad(row ? 1 : 0) + pad(64) + pad(row ? (row.length - 2) / 2 : 0) + (row || '0x').slice(2));
  let offset = rows.length * 32;
  return '0x' + pad(32) + pad(rows.length) + tuples.map(tuple => { const at = offset; offset += tuple.length / 2; return pad(at); }).join('') + tuples.join('');
};

test('market asks decode the exact six ABI fields and reject malformed widths', () => {
  const a = decodeMarketAsk(order(), 3);
  assert.equal(a.id, 3); assert.equal(a.transistors, NAND_TRANSISTORS); assert.equal(a.priceWei, 20_000_000_000_000_000n); assert.equal(a.remaining, 20n);
  assert.throws(() => decodeMarketAsk('0x1234', 3), /invalid/);
  assert.throws(() => decodeMarketAsk(order(2n ** 96n), 3), /invalid/);
  assert.throws(() => decodeMarketAsk(order(1n, 1n, 256n), 3), /invalid/);
});

test('best ask filters exact NAND collection/token and excludes closed orders; sums depth only at best price', () => {
  const rows = [order(20n, 8n), order(10n, 5n), order(1n, 0n), order(1n, 90n, 1n), order(1n, 90n, 0n, '0x' + '2'.repeat(40)), order(10n, 7n)];
  const best = bestNandAsk(rows.map((row, i) => decodeMarketAsk(row, i + 1)));
  assert.equal(best.priceWei, 10n); assert.equal(best.remaining, 12n); assert.equal(best.id, 2);
  assert.equal(bestNandAsk([decodeMarketAsk(order(1n, 0n), 1)]), null);
});

test('readNandPrice reads the complete inclusive ask domain at one block and reports observed state age', async () => {
  const calls = [];
  const rpc = async (method, params) => { calls.push([method, params]); assert.equal(method, 'eth_call'); return '0x' + pad(3); };
  const batch = async (requests, size) => {
    assert.equal(size, 5); requests.forEach(r => calls.push(r));
    assert.equal(requests[0][0], 'eth_getBlockByNumber');
    assert.equal(requests[1][1][0].data.slice(0, 10), '0xbce38bd7');
    assert.equal(requests[1][1][0].data.includes('0b0c1493' + pad(3)), true);
    return [{ timestamp: '0x' + (1_792_337_228).toString(16) }, aggregate([order(30n, 10n), order(20n, 5n), order(20n, 8n)])];
  };
  const value = await readNandPrice({ rpc, batch, head: 100 });
  assert.equal(value.okb, 20 / 1e18); assert.equal(value.qty, 13); assert.equal(value.ordersScanned, 3); assert.equal(value.head, 100);
  assert.equal(value.source, 'On-chain best ask'); assert.equal(value.asOf, '2026-10-18T15:27:08.000Z');
  assert.equal(calls.every(([method, p]) => method === 'eth_call' ? p[1] === '0x64' : p[0] === '0x64'), true);
  assert.equal(validNandPrice(value), true);
});

test('a failed or malformed ask makes best price unknown rather than presenting an incomplete best ask', async () => {
  const opts = { head: 100, asOf: '2026-10-18T15:27:08.000Z', rpc: async () => '0x' + pad(2) };
  await assert.rejects(readNandPrice({ ...opts, batch: async () => [aggregate([order(), null])] }), /incomplete/);
  await assert.rejects(readNandPrice({ ...opts, batch: async () => ['0x00'] }), /invalid/);
});

test('ask cap and no live NAND asks fail closed without a long scan', async () => {
  let batches = 0;
  const opts = { head: 100, asOf: '2026-10-18T15:27:08.000Z', batch: async () => { batches++; return [aggregate([order(1n, 0n)])]; } };
  await assert.rejects(readNandPrice({ ...opts, rpc: async () => '0x' + pad(4_097) }), /limit/);
  assert.equal(batches, 0);
  await assert.rejects(readNandPrice({ ...opts, rpc: async () => '0x' + pad(1) }), /no open/);
});

test('price cache validator rejects missing provenance, invalid age and numeric garbage', () => {
  const v = { okb: 0.01879, qty: 100, source: 'On-chain best ask', kind: 'onchain-ask', asOf: '2026-10-18T15:27:08.000Z', head: 100 };
  assert.equal(validNandPrice(v), true);
  for (const delta of [{ okb: NaN }, { qty: 0 }, { source: '' }, { asOf: 'bad' }, { head: -1 }, { kind: 'invented' }]) assert.equal(validNandPrice({ ...v, ...delta }), false);
});

test('a supplied timestamp promise reuses its header and a larger book is grouped into <=256 calls', async () => {
  let requestsSeen;
  const value = await readNandPrice({ head: 100, asOf: Promise.resolve('2026-10-18T15:27:08.000Z'),
    rpc: async () => '0x' + pad(257), batch: async requests => {
      requestsSeen = requests;
      return [aggregate(Array.from({length: 256}, () => order(1n, 0n))), aggregate([order()])];
    } });
  assert.equal(requestsSeen.length, 2);
  assert.equal(requestsSeen.every(r => r[0] === 'eth_call'), true);
  assert.equal(value.ordersScanned, 257); assert.equal(value.orderId, 257);
});
