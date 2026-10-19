// Read-only NAND replacement-cost reference. The official market API restricts CORS,
// so read the complete ask book through Multicall3 eth_call; no historical log scan.
import { encodeTryAggregate, decodeTryAggregate } from './multicall.mjs';

export const NAND_TRANSISTORS = '0xbe6f94115d32f3ac3252bc4626573e739beeb714';
const MARKET = '0x7f955c233fdb17e98fb26f330d778d3e30fe6ee6';
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const ASK_SELECTOR = '0x0b0c1493'; // asks(uint256)
const NEXT_ASK_SELECTOR = '0x2caf9cde'; // nextAskId(): highest assigned ID, inclusive
const hex = n => '0x' + BigInt(n).toString(16);
const pad = n => BigInt(n).toString(16).padStart(64, '0');
const positive = n => Number.isFinite(n) && n > 0;

// Official marketplace ABI: seller, transistors, price:uint96, tokenId:uint8,
// feeBps:uint16, remaining:uint256. Exact collection is essential: token 0 alone is not NAND.
export function decodeMarketAsk(data, id) {
  if (!/^0x[0-9a-f]{384}$/i.test(data || '')) throw new Error('invalid asks response');
  const words = Array.from({ length: 6 }, (_, i) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64)));
  if (words[0] >= 2n ** 160n || words[1] >= 2n ** 160n || words[2] >= 2n ** 96n
      || words[3] >= 256n || words[4] >= 65536n) throw new Error('invalid asks field width');
  return { id, seller: '0x' + words[0].toString(16).padStart(40, '0'),
    transistors: '0x' + words[1].toString(16).padStart(40, '0'),
    priceWei: words[2], tokenId: Number(words[3]), feeBps: Number(words[4]), remaining: words[5] };
}

// The returned quantity is available at this price only, not the depth available for a whole rig portfolio.
export function bestNandAsk(asks) {
  let best = null;
  for (const ask of asks) {
    if (ask.transistors !== NAND_TRANSISTORS || ask.tokenId !== 0 || ask.remaining <= 0n
        || ask.priceWei <= 0n || /^0x0{40}$/.test(ask.seller)) continue;
    if (!best || ask.priceWei < best.priceWei) best = { ...ask };
    else if (ask.priceWei === best.priceWei) best.remaining += ask.remaining;
  }
  return best;
}

export function validNandPrice(value) {
  return !!value && value.kind === 'onchain-ask' && value.source === 'On-chain best ask'
    && positive(value.okb) && positive(value.qty)
    && Number.isSafeInteger(value.head) && value.head >= 0
    && typeof value.asOf === 'string' && Number.isFinite(Date.parse(value.asOf));
}

// rpc/batch are injected so offline tests cannot reach a network. batch matches createRpcClient.batch.
// asOf can be the pinned header's ISO timestamp or a promise for it, allowing snapshot to reuse its read.
// The caller supplies its operation AbortSignal/deadline. Failure leaves manual/cache fallbacks to the caller.
export async function readNandPrice({ rpc, batch, head, market = MARKET, multicall = MULTICALL,
  signal, asOf, maxOrders = 4096 } = {}) {
  if (typeof rpc !== 'function' || typeof batch !== 'function') throw new Error('NAND pricing needs RPC readers');
  if (!Number.isSafeInteger(head) || head < 0) throw new Error('invalid NAND pricing block');
  if (!Number.isSafeInteger(maxOrders) || maxOrders < 1 || maxOrders > 4096) throw new Error('invalid ask scan limit');
  signal?.throwIfAborted();
  // Attach now, then await after book reads: an early header failure must not become unhandled.
  const suppliedTime = asOf === undefined ? null : Promise.resolve(asOf);
  suppliedTime?.catch(() => {});
  const block = hex(head);
  const countHex = await rpc('eth_call', [{ to: market, data: NEXT_ASK_SELECTOR }, block], { signal });
  if (!/^0x[0-9a-f]{64}$/i.test(countHex || '')) throw new Error('invalid nextAskId response');
  const count = BigInt(countHex);
  if (count > BigInt(maxOrders)) throw new Error(`ask scan limit exceeded (${count}/${maxOrders})`);
  if (count === 0n) throw new Error('no open NAND asks');
  const groups = [];
  for (let start = 1; start <= Number(count); start += 256) {
    groups.push(Array.from({ length: Math.min(256, Number(count) - start + 1) }, (_, i) => start + i));
  }
  const requests = groups.map(ids => ['eth_call', [{ to: multicall,
    data: encodeTryAggregate(ids.map(id => ({ to: market, data: ASK_SELECTOR + pad(id) }))) }, block]]);
  // Include the header in the first five-request batch when snapshot did not already load it.
  const needHeader = asOf === undefined;
  if (needHeader) requests.unshift(['eth_getBlockByNumber', [block, false]]);
  const values = await batch(requests, 5, { signal });
  signal?.throwIfAborted();
  if (values.length !== requests.length) throw new Error('incomplete ask scan response');
  if (needHeader) {
    const timestamp = Number(values.shift()?.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('invalid ask observation timestamp');
    asOf = new Date(timestamp * 1000).toISOString();
  }
  const asks = values.flatMap((data, i) => decodeTryAggregate(data, groups[i].length).map((raw, j) => {
    if (raw === null) throw new Error('incomplete ask scan: reverted asks read');
    return decodeMarketAsk(raw, groups[i][j]);
  }));
  const best = bestNandAsk(asks);
  if (!best) throw new Error('no open NAND asks');
  const value = { okb: Number(best.priceWei) / 1e18, kind: 'onchain-ask', source: 'On-chain best ask',
    asOf: suppliedTime ? await suppliedTime : asOf, head, qty: Number(best.remaining), orderId: best.id, ordersScanned: asks.length };
  if (!validNandPrice(value)) throw new Error('invalid NAND ask reference');
  return value;
}
