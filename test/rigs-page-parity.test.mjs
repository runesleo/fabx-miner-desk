import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// rigs/index.html is a copy of index.html one level down (DeWeb serves static files only).
// Apart from relative path prefixes the two pages must stay identical.
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const stripRelative = (html) => html.replace(/(["'(])(?:\.\.?\/)+/g, '$1');

test('rigs/index.html matches index.html except for relative path prefixes', () => {
  const root = stripRelative(read('../index.html'));
  const rigs = stripRelative(read('../rigs/index.html'));
  assert.ok(rigs === root, 'rigs/index.html drifted from index.html: apply the same change to both pages');
});

test('rigs runtime markup preserves dynamic absolute links', () => {
  const script = html => html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/from ['"]\.\.\//g, "from './");
  assert.equal(script(read('../rigs/index.html')), script(read('../index.html')));
});
