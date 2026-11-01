#!/usr/bin/env node
// Pull new rows from the D1 `feedback` table for the maintainer (read-only; writes only its own state file).
// Usage: node scripts/feedback-pull.mjs [--dry-run] [--state <file>] [--db <name>]
// Prints JSON: { checkedAt, lastId, new: [{ id, text, lang, source, page, telegram, created_at, status }] }.
// State (last seen id) lives outside the repo, default ~/.local/state/fabx-miner-desk/feedback-seen.json,
// so a daily job only ever sees each piece of feedback once. Requires a logged-in `wrangler`.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STATE = join(homedir(), '.local/state/fabx-miner-desk/feedback-seen.json');
const DEFAULT_DB = 'fabx-miner-desk';
export const LIMIT = 50;

export function parseArgs(argv) {
  const out = { dryRun: false, state: DEFAULT_STATE, db: DEFAULT_DB };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--state') out.state = argv[++i];
    else if (argv[i] === '--db') out.db = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out.state || !out.db) throw new Error('--state and --db need a value');
  return out;
}

export const query = lastId => `SELECT id, text, lang, source, page, telegram, created_at, status FROM feedback WHERE id > ${Number(lastId) || 0} ORDER BY id LIMIT ${LIMIT}`;

export function readState(file) {
  try { const s = JSON.parse(readFileSync(file, 'utf8')); return { lastId: Number(s.lastId) || 0, pulled: Array.isArray(s.pulled) ? s.pulled : [] }; }
  catch { return { lastId: 0, pulled: [] }; }
}

export function nextState(state, rows, checkedAt) {
  if (!rows.length) return state;
  const pulled = [...state.pulled, ...rows.map(r => ({ id: r.id, at: checkedAt, source: r.source }))].slice(-500);
  return { lastId: Math.max(state.lastId, ...rows.map(r => Number(r.id))), pulled };
}

function writeState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${file}.tmp`, file);
}

function fetchRows(db, lastId) {
  const res = spawnSync('wrangler', ['d1', 'execute', db, '--remote', '--json', '--command', query(lastId)], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  if (res.status !== 0) throw new Error(`wrangler d1 execute failed: ${(res.stderr || res.stdout || '').trim().slice(-400)}`);
  const payload = JSON.parse(res.stdout);
  return payload[0]?.results || [];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const state = readState(args.state);
    const rows = fetchRows(args.db, state.lastId);
    const checkedAt = new Date().toISOString();
    const next = nextState(state, rows, checkedAt);
    if (!args.dryRun && rows.length) writeState(args.state, next);
    console.log(JSON.stringify({ checkedAt, lastId: args.dryRun ? state.lastId : next.lastId, new: rows }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exit(2);
  }
}
