import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssetUrl, parseDeepLink, shareCardSpec, DEFAULT_SITE_URL, shortAddress } from '../share.mjs';

test('buildAssetUrl: fragment deep link with addr, chain and rig', () => {
  const url = buildAssetUrl(DEFAULT_SITE_URL, { address: '0xAbC000000000000000000000000000000000001', chain: 'fabx', rigId: '42' });
  assert.match(url, /#addr=0xabc/);
  assert.match(url, /rig=42/);
  assert.doesNotMatch(url, /\?/);
  const bsc = buildAssetUrl('https://example.test/', { address: '0xabc', chain: 'bsc' });
  assert.match(bsc, /#addr=0xabc&chain=bsc/);
});

test('parseDeepLink accepts query, hash params and legacy #rig-', () => {
  const a = parseDeepLink('https://x.test/rigs?addr=0x1234567890123456789012345678901234567890&chain=bsc#rig-9');
  assert.equal(a.chain, 'bsc');
  assert.equal(a.rigId, '9');
  assert.match(a.address, /^0x1234/);
  const h = parseDeepLink('https://x.test/#addr=0xabc&chain=fabx&rig=3');
  assert.equal(h.rigId, '3');
  assert.equal(h.address, '0xabc');
});

test('shareCardSpec omits full address', () => {
  const spec = shareCardSpec({ shortAddr: shortAddress('0x1234567890123456789012345678901234567890'), miningCount: 3, fabPerDay: '12.5', valueUsd: '1000', tokenLabel: 'FAB', lang: 'en' });
  assert.match(spec.address, /…/);
  assert.match(spec.mining, /3 rigs/);
});
