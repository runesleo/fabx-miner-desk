#!/usr/bin/env node
// Local DeWeb gateway sim: any path → 302 to /v/2/<path> (query stripped); static root = dist-deweb.
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const VERSION = process.env.DEWEB_VERSION || '2';
const PORT = Number(process.env.PORT || 8765);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist-deweb');
const PREFIX = `/v/${VERSION}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  let path = url.pathname;
  if (!path.startsWith(PREFIX)) {
    const target = path === '/' ? `${PREFIX}/` : `${PREFIX}${path}${path.endsWith('/') ? '' : ''}`;
    const loc = target.endsWith('/') ? target : (target.includes('.') ? target : `${target}/`);
    return send(res, 302, { location: loc.split('?')[0] }, '');
  }
  path = path.slice(PREFIX.length) || '/';
  if (path.endsWith('/')) path += 'index.html';
  const file = join(ROOT, path.replace(/^\//, ''));
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('not file');
    const ext = extname(file);
    send(res, 200, { 'content-type': MIME[ext] || 'application/octet-stream' }, readFileSync(file));
  } catch {
    send(res, 404, { 'content-type': 'text/plain' }, 'not found');
  }
});

server.listen(PORT, () => {
  console.log(`DeWeb sim http://127.0.0.1:${PORT}/ → ${PREFIX}/ (static: ${ROOT})`);
});
