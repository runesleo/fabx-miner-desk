import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function externalHrefs(html) {
  return [...html.matchAll(/href="(https:[^"]+)"/g)].map((m) => m[1]);
}

test('start page ships zh/en copy and fmd.lang toggle', () => {
  const html = read('../start/index.html');
  assert.match(html, /从零开始/);
  assert.match(html, /Start from zero/);
  assert.match(html, /fmd\.lang/);
  assert.match(html, /收益台可以查 <strong>BSC TapeOut<\/strong>/);
  assert.match(html, /Miner Desk can look up BSC TapeOut/);
  assert.doesNotMatch(html, /href="http:\/\//);
});

test('links page ships zh/en copy, https externals, and community disclaimer', () => {
  const html = read('../links/index.html');
  assert.match(html, /生态入口/);
  assert.match(html, /Ecosystem links/);
  assert.match(html, /社区工具，非官方/);
  assert.match(html, /Community tools, not official/);
  assert.match(html, /0xTisane/);
  for (const href of externalHrefs(html)) {
    assert.ok(href.startsWith('https://'), `non-https external: ${href}`);
  }
});

test('build-deweb bundles start/ and links/', () => {
  const script = read('../scripts/build-deweb.mjs');
  assert.match(script, /'start\/index\.html'/);
  assert.match(script, /'links\/index\.html'/);
  const out = execFileSync('/opt/homebrew/bin/node', ['scripts/build-deweb.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  });
  assert.match(out, /start\/index\.html/);
  assert.match(out, /links\/index\.html/);
});

test('home and FAQ nav link to start and links', () => {
  const home = read('../index.html');
  assert.match(home, /href="start\/"/);
  assert.match(home, /href="links\/"/);
  const faq = read('../faq/index.html');
  assert.match(faq, /href="\.\.\/start\/"/);
  assert.match(faq, /href="\.\.\/links\/"/);
});
