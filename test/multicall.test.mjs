import test from 'node:test';
import assert from 'node:assert/strict';

const uint = value => BigInt(value).toString(16).padStart(64, '0');

test('tryAggregate calldata encodes distinct target/data lengths and relative tuple offsets', async () => {
  const { encodeTryAggregate } = await import('../multicall.mjs');
  const actual = encodeTryAggregate([
    { to: '0x1111111111111111111111111111111111111111', data: '0x12345678' },
    { to: '0x2222222222222222222222222222222222222222', data: '0xabcdef01' + uint(7) },
  ]);
  assert.equal(actual, '0xbce38bd7' + uint(0) + uint(64) + uint(2) + uint(64) + uint(192)
    + uint(BigInt('0x1111111111111111111111111111111111111111')) + uint(64) + uint(4) + '12345678'.padEnd(64, '0')
    + uint(BigInt('0x2222222222222222222222222222222222222222')) + uint(64) + uint(36) + ('abcdef01' + uint(7)).padEnd(128, '0'));
});

test('tryAggregate decoder preserves a failed leaf and arbitrary successful return bytes', async () => {
  const { decodeTryAggregate } = await import('../multicall.mjs');
  const data = '0x' + uint(32) + uint(2) + uint(64) + uint(192)
    + uint(1) + uint(64) + uint(4) + 'deadbeef'.padEnd(64, '0')
    + uint(0) + uint(64) + uint(0);
  assert.deepEqual(decodeTryAggregate(data, 2), ['0xdeadbeef', null]);
  assert.throws(() => decodeTryAggregate(data, 3), /count/);
  assert.throws(() => decodeTryAggregate(data.slice(0, -64), 2), /offset|truncated/);
});

test('tryAggregate decoder rejects impossible offsets, bool flags and truncated padding', async () => {
  const { decodeTryAggregate, encodeTryAggregate } = await import('../multicall.mjs');
  const prefix = '0x' + uint(32) + uint(1) + uint(32);
  assert.throws(() => decodeTryAggregate(prefix + uint(2) + uint(64) + uint(0), 1), /result/);
  assert.throws(() => decodeTryAggregate(prefix + uint(1) + uint(65) + uint(0), 1), /offset/);
  assert.throws(() => decodeTryAggregate(prefix + uint(1) + uint(64) + uint(1), 1), /truncated/);
  assert.throws(() => encodeTryAggregate([{ to: '0x1', data: '0x12345678' }]), /target/);
  assert.throws(() => encodeTryAggregate([{ to: '0x1111111111111111111111111111111111111111', data: '0x1' }]), /data/);
});
