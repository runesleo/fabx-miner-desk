import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTryAggregate, encodeTryAggregate } from '../multicall.mjs';
import { minerKey } from '../slot-defense.mjs';
import {
  BEM_CFG, crosschainLines, crosschainView, fabLegFromEntry, formulaAtomsPerSecond, formulaPerDay,
  labelYield, listingBudget, loadBemQuote,
} from '../crosschain-yield.mjs';

const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const TAPE = BEM_CFG.processors[0];

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
  const body = data.slice(10);
  const at = (index) => BigInt('0x' + body.slice(index * 64, (index + 1) * 64));
  const count = Number(at(2));
  const calls = [];
  for (let i = 0; i < count; i++) {
    const start = 3 + Number(at(3 + i)) / 32;
    const byteLen = Number(at(start + 2));
    let hex = '';
    for (let w = 0; w < Math.ceil(byteLen / 32); w++) hex += at(start + 3 + w).toString(16).padStart(64, '0');
    calls.push('0x' + hex.slice(0, byteLen * 2));
  }
  return calls;
}

test('FabX sample converts with the published inputs and does not treat BEM formula as measured', () => {
  const view = crosschainView({
    fab: { complete: true, method: 'observed_delta', priceOkb: '1.63296', perDay: '1.08932112', windowSeconds: 600 },
    bem: { complete: true, method: 'formula_rate', priceBnb: '0.175', perDay: '0.01296' },
    prices: { okbUsdt: '113.78', bnbUsdt: '735.6', bemPerFab: '0.02234219220560771' },
  });
  assert.equal(view.fabOkb, '1.49906209475');
  assert.equal(view.fabBnb, '0.23186961');
  assert.equal(view.bemEq, '10.37810470');
  assert.equal(view.bemBnb, '13.50308642');
  assert.equal(view.fabMethod, 'observed_delta');
  assert.equal(view.bemMethod, 'formula_rate');
  const text = crosschainLines(view, 'zh').join('\n');
  assert.match(text, /1\.49906209475 OKB/);
  assert.match(text, /0\.23186961 BNB/);
  assert.match(text, /13\.50308642 BNB/);
  assert.match(text, /短窗口实测外推/);
  assert.match(text, /不是昨天实际挖到的数量/);
  assert.match(text, /公式估算/);
  assert.match(text, /不把公式标成实测/);
  assert.match(text, /不是买入建议/);
  assert.match(text, /两枚币不等值/);
  assert.doesNotMatch(text, /BEM 实测|昨天实际挖了/);
  const missing = crosschainView({ fab: { complete: false, reason: 'fab-scan-incomplete' }, bem: { complete: false, reason: 'over-budget' }, prices: {} });
  assert.equal(missing.fabOkb, null);
  assert.equal(missing.bemBnb, null);
  const missingText = crosschainLines(missing, 'zh').join('\n');
  assert.match(missingText, /显示 —/);
  assert.match(missingText, /不用未读完的挂牌凑一个最低价/);
  assert.equal(labelYield({ formulaFallback: true, pendingEqual: true }).method, 'formula_rate');
  assert.equal(labelYield({ formulaFallback: true }).measured, false);
  assert.equal(labelYield({ settledSeconds: 585, windowSeconds: 600 }).method, 'settled_interval');
  assert.equal(labelYield({}).method, 'observed_delta');
  const atoms = formulaAtomsPerSecond({
    rate: 8333333n, unverifiedBps: 100n, verifWeight: 3n, unverWeight: 0n, totalVerif: 1583514n, totalUnver: 40668n,
  });
  assert.equal(atoms, 15n);
  assert.equal(formulaPerDay(atoms), '0.01296');
  assert.equal(formulaAtomsPerSecond({
    rate: 1n, unverifiedBps: 0n, verifWeight: 1n, unverWeight: 0n, totalVerif: 0n, totalUnver: 0n,
  }), null);
});

test('entry comparison supplies only a complete measured FabX listing', () => {
  const leg = fabLegFromEntry({
    state: 'live', complete: true, windowSeconds: 600,
    ranked: [{ id: '5920', listingId: '1522', status: 'measured', priceOkb: 1.63296, fabPerDay: 1.08932112 }],
  });
  assert.equal(leg.method, 'observed_delta');
  assert.equal(fabLegFromEntry({ state: 'live', complete: false, ranked: [] }).reason, 'fab-scan-incomplete');
  assert.equal(fabLegFromEntry({ state: 'unavailable', complete: true, ranked: [] }).complete, false);
});

test('BEM quote stops when the listing book exceeds the page budget', async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const rpc = async (method, params) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(params[0].data.slice(0, 10));
    active -= 1;
    if (params[0].data === '0x42cbb15c') return '0x' + word(100);
    if (params[0].data.startsWith('0xaaccf1ec')) return '0x' + word(20_000);
    throw new Error('listing reads are outside the budget');
  };
  const quote = await loadBemQuote({ rpc, maxListingCalls: 8, cfg: { ...BEM_CFG, leavesPerCall: 128 } });
  assert.equal(quote.complete, false);
  assert.equal(quote.reason, 'over-budget');
  assert.equal(quote.perDay, null);
  assert.equal(quote.method, null);
  assert.equal(calls.length, 2);
  assert.equal(quote.requiredCalls, listingBudget(20_000, 128));
  assert.ok(quote.requiredCalls > 8);
  assert.ok(maxActive <= 3);
});

test('a small complete BEM book is labeled formula_rate and stays within the listing budget', async () => {
  const token = 5n;
  const price = 175000000000000000n;
  const fields = Array(22).fill(0n);
  fields[0] = BigInt(TAPE);
  fields[1] = token;
  fields[2] = 4n;
  fields[9] = 1n;
  fields[19] = 3n;
  fields[20] = 0n;
  let active = 0;
  let maxActive = 0;
  let listingGroups = 0;
  const rpc = async (method, params) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      assert.equal(method, 'eth_call');
      const data = params[0].data;
      if (data === '0x42cbb15c') return '0x' + word(129095481);
      if (data.startsWith('0xaaccf1ec')) return '0x' + word(1);
      if (data.startsWith('0x10eafa00')) return minerKey(TAPE, token);
      if (!data.startsWith('0xbce38bd7')) throw new Error(data.slice(0, 10));
      const inner = parseAggregate(data);
      if (inner[0].startsWith('0xbeab7067')) {
        listingGroups += 1;
        const listing = '0x' + [1n, BigInt(TAPE), token, price, 100n, 1n].map(word).join('');
        return encodeResults([listing]);
      }
      if (inner.some(item => item.startsWith('0xf9f8bdb7'))) {
        return encodeResults(['0x' + word(8333333), '0x' + word(100), '0x' + word(1583514), '0x' + word(40668)]);
      }
      if (inner[0].startsWith('0x0527edc2')) return encodeResults(['0x' + fields.map(word).join('')]);
      throw new Error(inner[0].slice(0, 10));
    } finally {
      active -= 1;
    }
  };
  const quote = await loadBemQuote({ rpc, maxListingCalls: 8 });
  assert.equal(quote.complete, true);
  assert.equal(quote.method, 'formula_rate');
  assert.equal(quote.perDay, '0.01296');
  assert.equal(quote.priceBnb, '0.175');
  assert.equal(quote.tokenId, '5');
  assert.equal(listingGroups, 1);
  assert.ok(quote.ethCall <= listingBudget(1, 128) + 4);
  assert.ok(maxActive <= 3);
  assert.equal(decodeTryAggregate(encodeResults(['0x' + word(1)]), 1)[0], '0x' + word(1));
});
