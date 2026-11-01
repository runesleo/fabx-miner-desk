import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardLines, boardUrl, compact, formatDailyBoard, loadBoard, weekSentence } from '../board.mjs';

const snap = {
  asOf: '2026-10-25T02:00:00.000Z',
  head: 80_000_000,
  blockTime: 3,
  network: { miners: 1200, weight: 12_500_000, sealed: false },
  prices: { fabUsd: 0.2, okbUsd: 100 },
};
const entry = {
  state: 'live', complete: true, cheaper: 'listing', deltaOkb: 1.25, deltaPct: 8.2,
  baseline: { okbPerFabDay: 12.5 },
};
const pod = {
  asOf: '2026-10-25T02:00:01.000Z',
  head: 40_000_000,
  blockTime: 0.5,
  network: { miners: 800, weight: 3_200_000, sealed: true, bemPerDayVerified: 7128 },
};

test('board lines price FabX build cost and leave BSC price and buy-versus-build empty', async () => {
  const view = await loadBoard({
    snapshot: async () => snap,
    networkGrowth: async () => ({ measured: true, daily: 0.01 }),
    loadEntryComparison: async () => entry,
    fetchServerMarket: async () => ({ value: { medianBem: 0.2 } }),
    podSnapshot: async () => pod,
    podNetworkGrowth: async () => ({ measured: false, daily: null }),
  });
  const lines = boardLines(view);
  const fabx = Object.fromEntries(lines.fabx);
  const bsc = Object.fromEntries(lines.bsc);
  assert.equal(fabx['在挖矿机'], '1200 台');
  assert.equal(fabx['全网权重'], '1250万');
  assert.equal(fabx['每天多挖 1 个 FAB 要花'], '12.5 OKB');
  assert.match(fabx['买现成还是自建'], /买现成更划算/);
  assert.match(fabx['买现成还是自建'], /1\.25 OKB/);
  assert.match(fabx['近 7 天'], /涨了/);
  assert.equal(fabx['FAB 近 24 小时中位价'], '0.2 BEM');
  assert.equal(bsc['在挖矿机'], '800 台');
  assert.equal(bsc['全网权重'], '320万');
  assert.equal(bsc['每天多挖 1 个 BEM 要花'], '暂无');
  assert.equal(bsc['买现成还是自建'], '暂无');
  assert.equal(bsc['近 7 天'], '近 7 天变化暂无');
  assert.equal(weekSentence({ measuredGrowth: false }), '近 7 天变化暂无');
});

test('a failed chain leaves that side empty and the other side still renders', async () => {
  const view = await loadBoard({
    snapshot: async () => { throw new Error('xlayer down'); },
    podSnapshot: async () => pod,
    podNetworkGrowth: async () => ({ measured: true, daily: -0.02 }),
    fetchServerMarket: async () => null,
  });
  const lines = boardLines(view);
  assert.equal(lines.fabx[0][1], '暂无');
  assert.match(lines.bsc[4][1], /降了/);
  assert.ok(view.errors.some(message => /xlayer down/.test(message)));
});

test('incomplete entry comparison does not invent a build price', async () => {
  const view = await loadBoard({
    snapshot: async () => snap,
    networkGrowth: async () => ({ measured: false, daily: 0 }),
    loadEntryComparison: async () => ({ state: 'unavailable', complete: false, cheaper: 'listing', deltaOkb: 1, baseline: { okbPerFabDay: 9 } }),
    fetchServerMarket: async () => null,
    podSnapshot: async () => { throw new Error('bsc down'); },
  });
  const fabx = Object.fromEntries(boardLines(view).fabx);
  assert.equal(fabx['每天多挖 1 个 FAB 要花'], '暂无');
  assert.equal(fabx['买现成还是自建'], '暂无');
  assert.equal(fabx['在挖矿机'], '1200 台');
});

test('daily board text stays within 200 characters and names the change plus the link', () => {
  const view = {
    fabx: { miners: 1200, weight: 12_500_000, okbPerDay: 12.5, cheaper: 'build', deltaOkb: 0.4, measuredGrowth: true, week: 0.032 },
    bsc: { miners: 80, weight: 10, measuredGrowth: false, week: null },
  };
  const url = boardUrl();
  const text = formatDailyBoard(view, { url });
  assert.ok([...text].length <= 200, text);
  assert.match(text, /1200/);
  assert.match(text, /近 7 天/);
  assert.match(text, /涨了/);
  assert.match(text, /自建少花/);
  assert.ok(text.endsWith(url));
  assert.equal(text.includes('getMiner') || text.includes('bestSlot'), false);
  const long = formatDailyBoard({
    fabx: { miners: 10 ** 9, weight: 10 ** 18, okbPerDay: 0.0004, cheaper: 'listing', deltaOkb: 123456.7, measuredGrowth: true, week: 12.345 },
    bsc: { miners: 10 ** 9 },
  }, { url: 'https://example.test/board/' });
  assert.ok([...long].length <= 200, long);
  assert.match(long, /https:\/\/example\.test\/board\//);
});

test('compact weight uses 万 and 亿', () => {
  assert.equal(compact(1250), '1250');
  assert.equal(compact(12_500_000), '1250万');
  assert.equal(compact(250_000_000), '2.5亿');
});

test('home and board page expose the board without sending messages', () => {
  const home = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../board/index.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../scripts/daily-board-text.mjs', import.meta.url), 'utf8');
  assert.match(home, /href="board\/"/);
  assert.match(home, /podRigs\(/);
  assert.match(page, /BSC · TapeOut/);
  assert.match(page, /暂无/);
  assert.match(page, /from '\.\.\/board\.mjs'/);
  assert.match(page, /想每天收到？在 Telegram 机器人里发 \/daily/);
  assert.match(page, /https:\/\/t\.me\/fabx_miner_desk_bot/);
  assert.match(script, /buildDailyBoardText/);
  assert.match(script, /process\.stdout\.write/);
  assert.doesNotMatch(script, /sendMessage|telegram|api\.telegram/);
});
