#!/usr/bin/env node
// Pack static assets for FabX DeWeb (no Pages functions).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-deweb');
const ZIP = join(ROOT, 'dist-deweb.zip');

const HTML_ENTRIES = [
  'index.html',
  'rigs/index.html',
  'check/index.html',
  'faq/index.html',
  'start/index.html',
  'links/index.html',
  'board/index.html',
];

const IMPORT_RE = /from\s+['"](\.\.?\/[^'"]+\.mjs)['"]/g;
const SRC_RE = /src=["']([^"']+\.mjs)["']/g;
const PRELOAD_RE = /href=["']([^"']+\.mjs)["']/g;

function refsInText(text, baseDir) {
  const paths = [];
  for (const re of [IMPORT_RE, SRC_RE, PRELOAD_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const rel = m[1];
      paths.push(rel.startsWith('/') ? null : resolve(baseDir, rel));
    }
  }
  return paths.filter(Boolean);
}

function addMjs(absPath, seen) {
  if (!absPath.endsWith('.mjs') || !absPath.startsWith(ROOT) || seen.has(absPath)) return;
  seen.add(absPath);
  const text = readFileSync(absPath, 'utf8');
  for (const child of refsInText(text, dirname(absPath))) addMjs(child, seen);
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split('\\').join('/'));
  }
  return out.sort();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const mjs = new Set();
for (const entry of HTML_ENTRIES) {
  const from = join(ROOT, entry);
  const to = join(OUT, entry);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  for (const ref of refsInText(readFileSync(from, 'utf8'), dirname(from))) addMjs(ref, mjs);
}

for (const abs of mjs) {
  const rel = relative(ROOT, abs);
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(abs, dest);
}

rmSync(ZIP, { force: true });
execFileSync('zip', ['-rq', ZIP, '.'], { cwd: OUT, stdio: 'pipe' });

const files = listFiles(OUT);
const sha = createHash('sha256').update(readFileSync(ZIP)).digest('hex');

console.log('dist-deweb files:');
for (const f of files) console.log(`  ${f}`);
console.log(`dist-deweb.zip SHA-256: ${sha}`);
