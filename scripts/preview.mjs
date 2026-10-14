#!/usr/bin/env node
/**
 * Dependency-free static preview of site/ that also applies site/_headers the
 * way Cloudflare Pages will. Running the real CSP locally means a violation
 * (inline handler, un-escaped markup) shows up here instead of in production.
 *
 *   node scripts/preview.mjs            # binds 127.0.0.1 on a free port
 *   node scripts/preview.mjs --port 13001
 *
 * This is a temporary service: per the host port registry it uses automatic
 * allocation unless --port is given, and binds loopback only. If you pin a port
 * with --port, add a row to ~/Projects/DEVELOPMENT-PORT-REGISTRY.md first.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, normalize } from 'node:path';
import { SITE, parseArgs, log } from './lib/config.mjs';

const args = parseArgs();
const PORT = args.port ? Number(args.port) : 0;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

/** Parse Pages `_headers`: a path line followed by indented `Name: value` lines. */
function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/^\s/.test(raw)) {
      const m = raw.trim().match(/^([A-Za-z-]+):\s*(.*)$/);
      if (m && current) current.headers.push([m[1], m[2]]);
    } else {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
    }
  }
  return rules;
}

/** Pages glob: `*` matches any run of characters (including '/'), `:x` segments unsupported. */
const matchPattern = (pattern, path) =>
  new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(path);

const headerRules = parseHeaders(await readFile(join(SITE, '_headers'), 'utf8').catch(() => ''));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const target = resolve(join(SITE, normalize(pathname)));
  if (!target.startsWith(SITE)) { res.writeHead(403).end('forbidden'); return; }

  try {
    const info = await stat(target);
    if (info.isDirectory()) { res.writeHead(404).end('not found'); return; }
    const body = await readFile(target);
    const headers = { 'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' };
    for (const rule of headerRules) {
      if (matchPattern(rule.pattern, pathname)) for (const [k, v] of rule.headers) headers[k] = v;
    }
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + pathname);
  }
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  log(`\n  预览地址  http://${HOST}:${port}/`);
  log(`  服务目录  ${SITE}`);
  log(`  _headers 已加载 ${headerRules.length} 条规则（CSP 在本地同样生效）`);
  log('  Ctrl-C 停止\n');
});
