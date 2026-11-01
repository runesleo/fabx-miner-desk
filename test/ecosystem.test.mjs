import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROJECTS, ecosystemCards, radarCounts } from '../ecosystem.mjs';

test('ecosystem entries carry only https links and unique ids, with copy in both languages', () => {
  const ids = new Set();
  for (const p of PROJECTS) {
    assert.ok(!ids.has(p.id), p.id); ids.add(p.id);
    assert.match(p.x, /^[A-Za-z0-9_]{1,15}$/);
    for (const url of [p.site, p.tg].filter(Boolean)) assert.match(url, /^https:\/\//);
    assert.ok(p.zh && p.en, p.id);
    assert.ok(!/0x[0-9a-f]{40}/i.test(p.zh + p.en), 'contract addresses stay on the official sites');
  }
});

test('ecosystem cards escape text, link X profiles and show radar counts by posting account', () => {
  const counts = radarCounts([
    { official_url: 'https://x.com/Fabx_global/status/1' },
    { official_url: 'https://x.com/fabx_global/status/2' },
    { official_url: 'https://x.com/someone/status/3' },
    { official_url: 'javascript:1' },
  ]);
  assert.deepEqual(counts, { fabx: 2 });
  const html = ecosystemCards('zh', counts, [{ id: 'x', name: '<i>X</i>', chain: 'BSC', role: 'app', x: 'abc', zh: '说明', en: 'about' }]);
  assert.ok(html.includes('&lt;i&gt;X&lt;/i&gt;'));
  assert.ok(html.includes('href="https://x.com/abc"'));
  assert.ok(!html.includes('官网'), 'no site link when none is known');
  const fab = ecosystemCards('en', counts);
  assert.match(fab, /data-project="fabx"[\s\S]*?2 recent on the radar/);
});

test('the homepage labels the hub as unofficial', () => {
  const view = readFileSync(new URL('../radar-view.mjs', import.meta.url), 'utf8');
  assert.match(view, /unofficial: '非官方'/);
  assert.match(view, /docTitle: 'TapeOut 生态站（非官方）/);
});
