import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { rigsPageFrom } from '../scripts/sync-rigs-page.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('rigs/index.html is index.html with ../ prefixes (run scripts/sync-rigs-page.mjs)', () => {
  assert.ok(read('../rigs/index.html') === rigsPageFrom(read('../index.html')),
    'rigs/index.html is out of sync: run node scripts/sync-rigs-page.mjs');
});

test('rigs page loads every module and in-site link from the parent directory', () => {
  const rigs = read('../rigs/index.html');
  assert.doesNotMatch(rigs, /from '\.\/[^']+'/);
  assert.doesNotMatch(rigs, /(href|src)="(?!https?:|\/|#|data:|mailto:|\$\{|\.\.\/)[^"]+"/);
});
