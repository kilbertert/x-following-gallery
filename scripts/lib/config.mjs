/**
 * Config + tiny .env reader. Zero dependencies on purpose — the whole pipeline
 * runs from a checkout with nothing but Node 24.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ENV_FILE = resolve(ROOT, '.env');
export const SITE = resolve(ROOT, 'site');
export const DATA_FILE = resolve(SITE, 'data/archive.json');

/** Parse a .env file into a flat object. Quotes are stripped; `#` starts a comment. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function serializeEnv(obj, previous = '') {
  const keys = new Set(Object.keys(obj));
  const kept = [];
  for (const raw of String(previous).split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && keys.has(m[1])) continue;      // replaced below
    kept.push(raw);
  }
  const body = Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');
  const head = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return (head ? head + '\n\n' : '') + body + '\n';
}

export function loadEnv() {
  const fileVars = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {};
  return { ...fileVars, ...process.env };      // real env overrides the file
}

export function saveEnvVars(patch) {
  const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const merged = { ...parseEnv(text), ...patch };
  const dir = dirname(ENV_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(ENV_FILE, serializeEnv(merged, text), { mode: 0o600 });
  try { chmodSync(ENV_FILE, 0o600); } catch { /* best effort on odd filesystems */ }
}

/** Never print a secret, even in an error path. */
export function redact(v, keep = 4) {
  const s = String(v ?? '');
  if (!s) return '(unset)';
  if (s.length <= keep * 2) return '***';
  return `${s.slice(0, keep)}…${s.slice(-keep)} (${s.length} chars)`;
}

export const log = (...a) => console.log(...a);
export const warn = (...a) => console.warn(...a);

/** Minimal flag parser: `--key value`, `--flag`, `--key=value`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (inline !== undefined) { args[k] = inline; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[k] = next; i++; }
    else args[k] = true;
  }
  return args;
}

export const X_CREDS = (env) => ({
  client_id: env.X_CLIENT_ID,
  client_secret: env.X_CLIENT_SECRET || undefined,
  // This host has no browser, so the callback is published via the frp reverse
  // tunnel (see docs/DEPLOY.md). X requires https for a non-localhost redirect.
  redirect_uri: env.X_REDIRECT_URI || 'https://xauth.ranlei.work/callback',
  access_token: env.X_ACCESS_TOKEN,
  refresh_token: env.X_REFRESH_TOKEN,
  expires_at: env.X_EXPIRES_AT ? Number(env.X_EXPIRES_AT) : 0,
});

export const R2_CREDS = (env) => ({
  accountId: env.CLOUDFLARE_ACCOUNT_ID,
  bucket: env.R2_BUCKET,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretKey: env.R2_SECRET_ACCESS_KEY,
  publicDomain: (env.R2_PUBLIC_DOMAIN || '').replace(/\/$/, ''),
});
