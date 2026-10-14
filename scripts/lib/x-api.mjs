/**
 * Minimal X (Twitter) API v2 client — OAuth2 user-context with PKCE + refresh.
 *
 * Deliberately official-API-only: the "scrape x.com with your session cookies"
 * route is what gets accounts locked (scripted logins trip DenyLoginSubtask, and
 * datacenter IPs get flagged), so this client never touches cookies.
 *
 * Cost model: X bills "Owned Reads" — requests your app makes for the
 * authenticated user's own data — at $0.001 per resource returned. A full
 * following sync of ~3,000 accounts is therefore ~$3.
 *
 * No runtime dependencies; Node 24 built-ins only.
 */
import { createHash, randomBytes } from 'node:crypto';

export const API = 'https://api.x.com/2';
export const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const SCOPES = ['users.read', 'follows.read', 'tweet.read', 'offline.access'];

export const USER_FIELDS = [
  'description', 'profile_image_url', 'profile_banner_url', 'public_metrics',
  'verified', 'verified_type', 'url', 'entities', 'created_at', 'location',
  'protected', 'pinned_tweet_id',
];

export const COST_PER_RESOURCE_USD = 0.001;

// ------------------------------------------------------------------ PKCE / URLs
export function pkcePair() {
  const verifier = randomBytes(48).toString('base64url').slice(0, 96);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl({ clientId, redirectUri, challenge, state }) {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/** Pull `code` out of whatever the browser landed on (full URL or bare code). */
export function extractCode(pasted) {
  const s = String(pasted || '').trim();
  if (!s) throw new Error('没有收到授权回调内容');
  const m = s.match(/[?&]code=([^&\s]+)/);
  if (m) return { code: decodeURIComponent(m[1]), state: new URL(s).searchParams.get('state') };
  if (/^[A-Za-z0-9._~-]{20,}$/.test(s)) return { code: s, state: null };
  throw new Error('无法从输入中解析出 code，请粘贴浏览器地址栏的完整 URL');
}

export function tokenBody(params) {
  return new URLSearchParams({ ...params }).toString();
}

// ------------------------------------------------------------------ token store
export function isExpired(tok, skewMs = 120_000) {
  if (!tok || !tok.expires_at) return true;
  return Date.now() + skewMs >= Number(tok.expires_at);
}

/** Exchange an auth code; or use a refresh token to mint a new access token. */
export async function requestToken({ clientId, clientSecret, redirectUri, code, verifier, refreshToken }, fetchImpl = fetch) {
  // Confidential client (a client secret exists) authenticates with HTTP Basic
  // and MUST NOT repeat client_id in the body — X rejects a request carrying
  // both. A public client (PKCE only) identifies itself in the body instead.
  const params = code
    ? { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }
    : { grant_type: 'refresh_token', refresh_token: refreshToken };

  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (clientSecret) {
    headers.authorization = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  } else {
    params.client_id = clientId;
  }
  const body = tokenBody(params);

  const res = await fetchImpl(`${API}/oauth2/token`, { method: 'POST', headers, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`token endpoint returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`token request failed (HTTP ${res.status}): ${json.error || text.slice(0, 200)}`);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (Number(json.expires_in) || 7200) * 1000,
    scope: json.scope,
  };
}

// ------------------------------------------------------------------ API client
export class XClient {
  /**
   * @param {{secrets:object, onToken?:Function, fetchImpl?:Function, retries?:number}} opts
   *   `secrets` = {client_id, client_secret?, redirect_uri?, access_token?, refresh_token?, expires_at?}
   */
  constructor({ secrets, onToken, fetchImpl = fetch, retries = 3, log = () => {} }) {
    this.s = secrets; this.onToken = onToken; this.fetch = fetchImpl;
    this.retries = retries; this.log = log;
    this.resourcesSeen = 0;
  }

  get estimatedCostUsd() { return this.resourcesSeen * COST_PER_RESOURCE_USD; }

  async ensureToken() {
    if (this.s.access_token && !isExpired(this.s)) return this.s.access_token;
    if (!this.s.refresh_token) {
      if (this.s.access_token) return this.s.access_token;         // no expiry info; try it
      throw new Error('缺少 access_token / refresh_token，请先运行 scripts/x-authorize.mjs');
    }
    this.log('刷新 access token…');
    const tok = await requestToken({
      clientId: this.s.client_id, clientSecret: this.s.client_secret,
      refreshToken: this.s.refresh_token,
    }, this.fetch);
    Object.assign(this.s, tok);
    this.onToken?.(this.s);
    return this.s.access_token;
  }

  /** Authenticated GET with automatic refresh-on-401 and 429 backoff. */
  async get(path, params = {}) {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const token = await this.ensureToken();
      const u = new URL(`${API}${path}`);
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
      }
      const res = await this.fetch(u.toString(), {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (res.status === 401 && this.s.refresh_token && attempt < this.retries) {
        this.s.expires_at = 0;                                     // force refresh
        continue;
      }
      if (res.status === 429 && attempt < this.retries) {
        const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
        const wait = Math.min(Math.max(reset - Date.now(), 1000), 60_000 * 15);
        this.log(`限流，等待 ${Math.round(wait / 1000)}s 后重试…`);
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
      if (!res.ok) {
        const detail = json?.detail || json?.title || text.slice(0, 200);
        const err = new Error(`GET ${path} → HTTP ${res.status}: ${detail}`);
        err.status = res.status; err.detail = detail; err.body = json;
        throw err;
      }
      if (Array.isArray(json?.data)) this.resourcesSeen += json.data.length;
      else if (json?.data) this.resourcesSeen += 1;
      return json;
    }
    throw new Error(`GET ${path} 重试 ${this.retries} 次后仍失败`);
  }

  me() { return this.get('/users/me', { 'user.fields': 'public_metrics,description,profile_image_url' }); }

  /** One page of the authenticated user's following list. */
  async followingPage(userId, paginationToken) {
    return this.get(`/users/${userId}/following`, {
      max_results: 1000,
      'user.fields': USER_FIELDS.join(','),
      pagination_token: paginationToken,
    });
  }

  /** Look up a single user id — used to classify a vanished account. */
  async userById(id) {
    try {
      return await this.get(`/users/${id}`, { 'user.fields': 'description,public_metrics,verified' });
    } catch (err) {
      if (err.status === 403) return { __dead: 'suspended', detail: err.detail };
      if (err.status === 404) return { __dead: 'deleted', detail: err.detail };
      throw err;
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Walk the whole following list. `maxPages` caps spend for --dry-run.
 * @returns {Promise<{users:Array, pages:number, truncated:boolean}>}
 */
export async function fetchAllFollowing(client, userId, { maxPages = Infinity, log = () => {} } = {}) {
  const users = [];
  let token, pages = 0, truncated = false;
  while (pages < maxPages) {
    const page = await client.followingPage(userId, token);
    const batch = page?.data || [];
    users.push(...batch);
    pages++;
    log(`  第 ${pages} 页：+${batch.length}（累计 ${users.length}）`);
    token = page?.meta?.next_token;
    if (!token) break;
    if (pages >= maxPages) { truncated = true; break; }
    await sleep(400);                                   // stay well under 300 req/15min
  }
  return { users, pages, truncated };
}
