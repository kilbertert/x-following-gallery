/**
 * Content-hash the site's own asset references.
 *
 * Why: Pages serves app.js / style.css with a long edge TTL, and the edge cache
 * is not purged by a deploy. A visitor can therefore keep getting the previous
 * build's JS long after a fix ships — which is exactly how a fixed bug looks
 * unfixed (measured: `cf-cache-status: HIT, age: 3645` on a fresh deploy).
 * Naming the asset after its own content makes a new build a *new URL*, so no
 * cache anywhere can serve the old bytes. This is why the reference site ships
 * `app.js?v=3.0`.
 *
 * index.html itself is served `no-cache`, so it always re-reads and points at
 * the current hashes.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SITE } from './config.mjs';

/** Assets to fingerprint and the tags in index.html that reference them. */
const ASSETS = ['app.js', 'style.css'];

export function hashAssets({ site = SITE } = {}) {
  const indexPath = resolve(site, 'index.html');
  if (!existsSync(indexPath)) return { changed: false, reason: 'index.html missing' };

  let html = readFileSync(indexPath, 'utf8');
  const hashes = {};
  for (const name of ASSETS) {
    const file = resolve(site, name);
    if (!existsSync(file)) continue;
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);
    hashes[name] = digest;
    // Normalise any previous ?v=… before appending the new one, so repeated
    // runs do not stack query strings.
    const re = new RegExp(`(["'/])${name.replace('.', '\\.')}(\\?v=[0-9a-f]+)?(["'])`, 'g');
    html = html.replace(re, (_m, a, _old, b) => `${a}${name}?v=${digest}${b}`);
  }

  const next = html;
  if (next === readFileSync(indexPath, 'utf8')) return { changed: false, hashes };
  writeFileSync(indexPath, next);
  return { changed: true, hashes };
}
