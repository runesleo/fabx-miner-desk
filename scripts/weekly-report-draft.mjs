#!/usr/bin/env node
// FabX 矿机周报草稿：只读链上 + desk.mjs 引擎。机制说明仅引用 mechanism-ssot.md【已核实】条目。
// Usage: node scripts/weekly-report-draft.mjs [--out <file>]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CFG, snapshot, refreshOptional, networkGrowth, loadEntryComparison,
} from '../desk.mjs';

export function parseArgs(argv) {
  const out = { out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

const fmt = (n, digits = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: digits }));

function cite(block, asOf) {
  return `（区块 \`${block}\`${asOf ? `，${asOf}` : ''}）`;
}

export function buildReportMarkdown({ snap, growth, entry, generatedAt }) {
  const head = snap.head;
  const asOf = snap.asOf;
  const w = snap.network.weight;
  const miners = snap.network.miners;
  const growthPct = growth.measured ? (Math.pow(1 + growth.daily, 7) - 1) * 100 : null;
  const growthLine = growth.measured
    ? `7 日复合增速约 **${fmt(growth.daily * 100, 3)}%/日**，折合总权重约 **${fmt(growthPct, 1)}%**（自区块 \`${head}\` 向前约 7 天读 \`totalVerifWeight\`）${cite(head, asOf)}`
    : `7 日权重变化 **未能从 RPC 读出历史状态**${cite(head, asOf)}`;

  const buildOkb = entry.baseline?.okbPerFabDay ?? snap.decision.okbPerFabDay;
  const buyOkb = entry.ranked?.[0]?.okbPerFabDay ?? null;
  const listing = entry.ranked?.[0] ?? null;
  const payback = snap.decision.paybackDays;

  const lines = [
    '# FabX 矿机周报（草稿）',
    '',
    `> 生成时间：${generatedAt}。数据为链上快照，会随区块变化；出处见各指标后的区块号与时间。`,
    '',
    '## 全网概览',
    '',
    `- 在挖矿机数：**${fmt(miners, 0)}** 台${cite(head, asOf)}`,
    `- 已验证池总权重：**${fmt(w, 0)}**${cite(head, asOf)}`,
    `- ${growthLine}`,
    '',
    '## 入场成本（每 1 FAB/日，OKB）',
    '',
    `- **自建（按当前 NAND 市价与稀释模型）**：${buildOkb != null ? `**${fmt(buildOkb, 4)} OKB**` : '—（缺 NAND 报价）'}${cite(head, entry.baseline?.nandAsOf || snap.availability?.nand?.asOf || asOf)}`,
    `- **二级市场最低有效挂单**：${buyOkb != null ? `**${fmt(buyOkb, 4)} OKB**` : '—（未扫到可比对挂单）'}${listing ? cite(entry.head ?? head, entry.asOf ?? asOf) : cite(head, asOf)}`,
    listing ? `  - 挂单 #${listing.listingId}，电路 #${listing.id}，测得产出约 ${fmt(listing.fabPerDay, 2)} FAB/日` : '',
    `- 对比：${entry.cheaper === 'listing' ? '当前买机更便宜' : entry.cheaper === 'build' ? '当前建机更便宜' : entry.cheaper === 'equal' ? '两者接近' : '数据不足'}${entry.deltaPct != null ? `（价差约 ${fmt(entry.deltaPct, 1)}%）` : ''}`,
    '',
    '## 回本（静态，含稀释假设）',
    '',
    `- 按当前 NAND 价与全网权重，烧 **1 NAND 等效** 的静态回本约：**${payback != null ? `${fmt(payback, 1)} 天` : '—'}**${cite(head, asOf)}`,
    `- FAB/USD（池 slot0 × BEM/USD）：**$${fmt(snap.prices.fabUsd, 4)}**；OKB/USD：**$${fmt(snap.prices.okbUsd, 2)}**${cite(head, asOf)}`,
    '',
    '## 机制要点（仅【已核实】）',
    '',
    '- 算力：**H = (b*×F + K_task·q) × P**；F 只乘工本 b*；仅最优首创拿设计溢价 K_task·q（FabX 官方公式，见 mechanism-ssot §2.1 F 条目）。',
    '- 产出分配：已验证池 **99%**、未验证池 **1%**；`UNVERIFIED_BPS`=100（1%）（§2.3，链上与官方前端一致）。',
    '- 全网初始 `currentRate`=8,333,333/秒（约 7,200 FAB/日），当前读数仍为 8,333,333（§1.2 常量表）。',
    '- FabX 权重记账：**weight = (bstar × boostBps / 10000 + bonus) × mult × 100**（§2.2）。',
    '- 领取不中断挖矿；`pendingWithDeweb` / lens `pendingLive` 用于实时未领（§3 C6；desk 使用 `pendingWithDeweb`）。',
    '',
    '## 数据说明',
    '',
    `- 链：X Layer（chainId 196），挖矿合约 \`${CFG.mining}\`。`,
    `- 挂单扫描：${entry.complete ? `完整枚举 ${entry.totalScanned ?? '?'} 条 listing` : '未完成枚举'}，状态 \`${entry.state ?? 'unknown'}\`${entry.error ? `，错误：${entry.error}` : ''}.`,
    `- NAND 来源：${snap.decision.nandSource || snap.availability?.nand?.state || '未知'}。`,
    '',
    '---',
    '',
    '*本稿由 `scripts/weekly-report-draft.mjs` 自动生成，发布前请人工核对数字与表述。*',
  ];
  return lines.filter((line, i, arr) => line !== '' || arr[i - 1] !== '').join('\n');
}

export async function loadReportInputs(opts = {}) {
  const snap0 = await (opts.snapshot || snapshot)({ skipNand: false, storage: null, ...opts.snapshotOpts });
  const snap = await (opts.refreshOptional || refreshOptional)(snap0, { skipNand: false, storage: null, ...opts.refreshOpts });
  const growth = await (opts.networkGrowth || networkGrowth)(snap, opts);
  const entry = await (opts.loadEntryComparison || loadEntryComparison)(snap, { storage: null, ...opts.entryOpts });
  return { snap, growth, entry, generatedAt: new Date().toISOString() };
}

export async function buildWeeklyReportDraft(opts = {}) {
  const inputs = await loadReportInputs(opts);
  return buildReportMarkdown(inputs);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  (async () => {
    try {
      const args = parseArgs(process.argv.slice(2));
      const md = await buildWeeklyReportDraft();
      if (args.out) writeFileSync(args.out, `${md}\n`, 'utf8');
      else console.log(md);
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
  })();
}
