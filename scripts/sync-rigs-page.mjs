// Regenerate rigs/index.html from index.html: same page one directory down, so every
// relative module import, stylesheet/script and in-site link gets a "../" prefix.
// Run after any edit to index.html:  node scripts/sync-rigs-page.mjs
import { readFileSync, writeFileSync } from 'node:fs';

export function rigsPageFrom(html) {
  return html
    .replace(/from '\.\/([^']+)'/g, "from '../$1'")
    .replace(/import\('\.\/([^']+)'\)/g, "import('../$1')")
    .replace(/(href|src)="(?!https?:|\/|#|data:|mailto:|\$\{|\.\.\/)([^"]+)"/g, '$1="../$2"');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('../', import.meta.url);
  const html = readFileSync(new URL('index.html', root), 'utf8');
  writeFileSync(new URL('rigs/index.html', root), rigsPageFrom(html));
  console.log('rigs/index.html regenerated');
}
