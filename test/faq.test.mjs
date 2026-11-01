import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../faq/index.html', import.meta.url), 'utf8');

const requiredAnchors = [
  'faq-claim-mining',
  'faq-fake-rig',
  'faq-output-drop',
  'faq-nft-transfer',
  'faq-buy-vs-build',
];

test('FAQ page defines required anchors and check deep links', () => {
  for (const id of requiredAnchors) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /\/check\/#rig=1&amp;chain=fabx|\/check\/#rig=1&chain=fabx|\.\.\/check\/#rig=1&chain=fabx/);
  assert.doesNotMatch(html, /空投|airdrop eligibility/i);
});
