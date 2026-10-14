/**
 * Archive record building, reconciliation and media planning.
 *
 * The archive is "append-only": an account that leaves the following list is
 * never dropped from the archive — it is marked so it can be shown in the
 * 赛博坟场 (graveyard) tab. That is the whole point of a backup.
 */
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- text helpers
/** Detect CJK so one card width can serve both languages. */
export const hasCJK = (s) => /[㐀-䶿一-鿿぀-ヿ가-힯]/.test(s || '');

export function extractLinks(text, limit = 6) {
  const out = [];
  const re = /(https?:\/\/[^\s<>"）)】\]]+|(?:t\.co|linktr\.ee|lit\.link|beacons\.ai)\/[^\s<>"）)】\]]+)/g;
  let m;
  while ((m = re.exec(text || '')) && out.length < limit) {
    let u = m[1].replace(/[.,;:]+$/, '');
    if (!/^https?:/.test(u)) u = 'https://' + u;
    try { out.push(new URL(u).href); } catch { /* skip malformed */ }
  }
  return [...new Set(out)];
}

/** Derive searchable tags: links' hostnames plus a few latin words from the bio. */
export function deriveTags(description, links) {
  const tags = new Set();
  for (const u of links || []) {
    try {
      const host = new URL(u).hostname.replace(/^www\./, '');
      if (!/^(t\.co|x\.com|twitter\.com)$/.test(host)) tags.add(host);
    } catch { /* ignore */ }
  }
  const words = String(description || '').match(/[A-Za-z][A-Za-z0-9_.-]{3,}/g) || [];
  for (const w of words.slice(0, 4)) tags.add(w.toLowerCase());
  return [...tags].slice(0, 6);
}

// ---------------------------------------------------------------- passwords?? no
/** Stable fingerprint of the fields we care about — used to detect drift. */
export function fingerprint(user) {
  const bits = [
    user.name, user.description, user.profile_image_url, user.profile_banner_url,
    user.public_metrics?.followers_count, user.verified ? 1 : 0,
  ].join('\u0001');
  return createHash('sha256').update(bits).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- r2 planning
/** Content type from the URL's file extension — note the extension is at the end
 *  of the *path* (`/…/hash.jpg`), never the last `/`-segment (which is the
 *  filename and may carry no dot at all). Getting this wrong serves every image
 *  as application/octet-stream. */
const IMAGE_CT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
};
const extOf = (url) => {
  const m = String(url).split('?')[0].match(/\.([a-z0-9]{3,4})$/i);
  return m ? m[1].toLowerCase() : 'jpg';           // twimg banners carry no extension → jpeg
};
/** Query strings change on every sync; the bare path is the stable identity. */
const barePath = (url) => {
  try { const u = new URL(url); u.search = ''; return u.toString(); } catch { return url; }
};
const isTwimg = (url) => /^https?:\/\/(pbs|abs)\.twimg\.com\//.test(url || '');
/** twimg banners already end in a size segment (`/600x200`); appending another
 *  yields a 404, so only add one when it is absent. */
const hasSizeSuffix = (url) => /\/\d+x\d+$/.test(barePath(url));

/**
 * Decide the R2 object keys for a user's avatar/cover.
 * twimg URLs are re-hosted (they carry session-ish tokens and rotate); anything
 * else is hotlinked as-is. Returns `{src, key, contentType, rehost}` per kind.
 */
export function mediaPlan(id, user) {
  const plan = {};
  const planFor = (kind, raw, sizeSuffix) => {
    if (!raw) return;
    if (!isTwimg(raw)) { plan[kind] = { src: raw, key: null, contentType: null, rehost: false }; return; }
    const ext = extOf(raw);
    let src = barePath(raw).replace(/_normal(\.\w+)?$/, '_400x400$1');  // avatars: _normal → _400x400
    if (sizeSuffix && !hasSizeSuffix(src)) src += sizeSuffix;            // banners: /600x200 once
    plan[kind] = {
      src,
      key: `media/${kind === 'cover' ? 'banners' : 'avatars'}/${id}.${ext}`,
      contentType: IMAGE_CT[ext] || 'image/jpeg',
      rehost: true,
    };
  };
  planFor('avatar', user.profile_image_url, '');
  planFor('cover', user.profile_banner_url, '/600x200');
  return plan;
}

// ---------------------------------------------------------------- record build
const F = (n) => Number(n) || 0;

/**
 * Build/merge one archive record from an API user object.
 * @param {object} user X API v2 user
 * @param {object|null} prev previous record, for archived_at / dead flags
 * @param {string} now ISO timestamp
 */
export function buildRecord(user, prev, now) {
  const links = extractLinks(user.description);
  const rec = {
    id: String(user.id),
    screen_name: user.username,
    name: user.name || user.username,
    avatar_url: prev?.avatar_url || '',
    cover_url: prev?.cover_url || '',
    followers_count: F(user.public_metrics?.followers_count),
    following_count: F(user.public_metrics?.following_count),
    tweets_count: F(user.public_metrics?.tweet_count),
    description: user.description || '',
    location: user.location || '',
    // The account's own page is DERIVED from the username, never taken from a
    // stored field. The X API's `url` is "the website in this profile" (entities
    // .url.urls[0]), which for most accounts is an onlyfans/linktree/t.co link —
    // using it as the profile link is a category error that sends "访问 X" to a
    // third-party site. The profile URL is trivially constructible, so construct
    // it.
    profile_url: `https://x.com/${user.username}`,
    // ...and the profile's own website, kept as a *separate*, clearly-named
    // field for callers that genuinely want it.
    website_url: user.entities?.url?.urls?.[0]?.expanded_url || user.url || '',
    verified: user.verified ? 1 : 0,
    verified_type: user.verified_type || null,
    account_created_at: user.created_at || null,
    protected: user.protected ? 1 : 0,
    links,
    tags: deriveTags(user.description, links),
    backed_up_at: prev?.backed_up_at || now,          // first seen — never overwritten
    last_synced_at: now,
    archived_at: prev?.archived_at || null,          // set when removed from following
    removal_reason: null,
    is_suspended: 0,
    is_blocked: 0,
    sync_count: (prev?.sync_count || 0) + 1,
    fingerprint: fingerprint(user),
    schema_version: SCHEMA_VERSION,
  };
  return rec;
}

/**
 * Notable fields whose change deserves a timeline entry.
 *
 * `followers_count` is deliberately NOT here. It moves on almost every sync for
 * most accounts (measured: 369 of 476 records differed after a single hour), so
 * recording each wobble would bury the events that matter under hundreds of
 * "1477944 → 1477946" lines per day. The count is still stored and updated on
 * the record; what gets a timeline entry is *crossing a tier*, which changes the
 * badge the gallery shows. See TIERS below.
 */
const WATCHED = {
  name: '昵称',
  screen_name: '用户名',
  verified: '认证',
  description: '简介',
  avatar_url: '头像',
  cover_url: '封面',
};

/** Follower tiers that change a card's badge: 10万 知名创作者, 50万 Top 头部. */
const TIERS = [
  { min: 5e5, key: 'top', label: 'Top 头部 (50万+)' },
  { min: 1e5, key: 'known', label: '知名创作者 (10万+)' },
];
export const tierKey = (n) => (n >= 5e5 ? 'top' : n >= 1e5 ? 'known' : 'rest');
const tierLabel = (n) => TIERS.find((t) => tierKey(n) === t.key)?.label || '普通账号';

/**
 * Field-level diff between two archive records, limited to WATCHED fields.
 * Returns `{field: {from, to}}`; empty object means nothing worth recording.
 */
export function diffRecord(prev, next) {
  const out = {};
  for (const field of Object.keys(WATCHED)) {
    const a = prev[field], b = next[field];
    if (a === b) continue;
    // avatars/covers rotate their URL constantly on a re-sync; only flag a real
    // change of the *path*, not the cache-busting query.
    if (typeof a === 'string' && typeof b === 'string') {
      const strip = (s) => s.split('?')[0].replace(/\/\d+x\d+$/, '');
      if (strip(a) === strip(b)) continue;
    }
    out[field] = { from: a ?? null, to: b ?? null };
  }
  return out;
}

/**
 * Reconcile a fresh following-list snapshot against the existing archive.
 * @returns {{records:Array, added:number, removed:Array, changed:number, events:Array}}
 */
export function reconcile({ freshUsers, prevRecords, now, classify }) {
  const prevById = new Map(prevRecords.map((r) => [r.id, r]));
  const records = [];
  const removed = [];
  const events = [];
  let added = 0, changed = 0;

  const ev = (rec, event, detail) => events.push({
    ts: now, id: rec.id, screen_name: rec.screen_name, name: rec.name, event, ...(detail ? { detail } : {}),
  });

  for (const u of freshUsers) {
    const id = String(u.id);
    const prev = prevById.get(id);
    const rec = buildRecord(u, prev, now);
    const wasArchived = !!prev?.archived_at;
    if (wasArchived) { rec.archived_at = null; rec.removal_reason = null; }   // they came back

    if (!prev) { added++; ev(rec, 'added'); }
    else if (wasArchived) { ev(rec, 'restored'); }
    else if (prev.fingerprint !== rec.fingerprint) {
      changed++;
      const diff = diffRecord(prev, rec);
      // A tier change is worth recording even though the raw count is not.
      if (tierKey(prev.followers_count) !== tierKey(rec.followers_count)) {
        diff.tier = { from: tierLabel(prev.followers_count), to: tierLabel(rec.followers_count) };
      }
      if (Object.keys(diff).length) ev(rec, 'updated', diff);
    }
    records.push(rec);
    prevById.delete(id);
  }

  // Anything left in prevById is no longer followed → graveyard, never deleted.
  //
  // `archived_at` is the authoritative "no longer in the following list" signal.
  // The is_suspended / is_blocked flags are only set when a status lookup
  // actually confirmed them (`--classify`); a plain unfollow leaves both at 0,
  // so the UI must key off archived_at, not off those flags.
  for (const gone of prevById.values()) {
    const reason = classify?.(gone) || 'unfollowed';
    removed.push({ id: gone.id, screen_name: gone.screen_name, reason });
    const archived = {
      ...gone,
      archived_at: gone.archived_at || now,
      removal_reason: gone.removal_reason || reason,
      is_suspended: reason === 'suspended' ? 1 : gone.is_suspended,
    };
    if (!gone.archived_at) ev(archived, 'archived', { reason });   // first time only
    records.push(archived);
  }

  records.sort((a, b) => (b.followers_count - a.followers_count) || String(a.screen_name).localeCompare(String(b.screen_name)));
  return { records, added, removed, changed, events };
}

/** Human-readable one-liner for a timeline event. */
export function describeEvent(e) {
  const L = WATCHED;
  switch (e.event) {
    case 'added': return '首次归档';
    case 'restored': return '回到关注列表（取消归档）';
    case 'archived': return { suspended: '账号被封禁', deleted: '账号已注销', unfollowed: '已取消关注' }[e.detail?.reason] || '退出关注列表';
    case 'updated': {
      return Object.entries(e.detail || {}).map(([f, v]) => {
        if (f === 'tier') return `影响力层级：${v.from} → ${v.to}`;
        const label = L[f] || f;
        if (f === 'verified') return `认证 ${v.from ? '有' : '无'} → ${v.to ? '有' : '无'}`;
        if (f === 'description' || f === 'name' || f === 'screen_name') return `${label}已更改`;
        return `${label}已更新`;
      }).join('；');
    }
    default: return e.event;
  }
}

// ---------------------------------------------------------------- self-check
export function demo() {
  const assert = (cond, msg) => { if (!cond) throw new Error('archive self-check failed: ' + msg); };
  const now = '2026-10-14T00:00:00.000Z';
  const u = (id, name, extra = {}) => ({
    id, username: name, name: name.toUpperCase(),
    description: `${name} bio see https://t.co/abc and www.example.com/x`,
    profile_image_url: `https://pbs.twimg.com/profile_images/${id}/AAA_normal.jpg`,
    profile_banner_url: `https://pbs.twimg.com/profile_banners/${id}/123`,
    public_metrics: { followers_count: 1000, following_count: 10, tweet_count: 5 },
    verified: false, ...extra,
  });

  // links + tags
  assert(extractLinks(u('1', 'a').description).includes('https://t.co/abc'), 'link extraction');
  assert(deriveTags('hello world', ['https://linktr.ee/x']).includes('linktr.ee'), 'tag hostname');

  // media plan: _normal is upscaled, key carries a real extension, contentType set
  const plan = mediaPlan('1', u('1', 'a'));
  assert(plan.avatar.src.endsWith('_400x400.jpg'), 'avatar upscale');
  assert(plan.avatar.key === 'media/avatars/1.jpg', 'avatar key has a dotted extension');
  assert(plan.avatar.contentType === 'image/jpeg', 'avatar content type is an image, not octet-stream');
  assert(plan.cover.src.endsWith('/600x200'), 'banner size');
  assert(plan.cover.key === 'media/banners/1.jpg', 'cover key has a dotted extension');

  // Regression: a banner URL that is already sized must NOT get a second `/600x200`
  // (that 404s — it is what silently dropped all 447 banners on the first mirror).
  const sized = mediaPlan('1', { profile_banner_url: 'https://pbs.twimg.com/profile_banners/1/123/600x200' });
  assert(sized.cover.src === 'https://pbs.twimg.com/profile_banners/1/123/600x200', 'no double size suffix');
  // Regression: a query string must not hide the extension (twimg avatars carry one).
  const q = mediaPlan('1', { profile_image_url: 'https://pbs.twimg.com/profile_images/1/hash_normal.jpg?x=1' });
  assert(q.avatar.key === 'media/avatars/1.jpg', 'extension found despite query string');

  // Regression: the profile link must be DERIVED from the username, never taken
  // from the API's `url` (which is the website in the profile — here an
  // onlyfans link). Mixing them sent "访问 X" to a third-party site.
  const pf = buildRecord({ ...u('1', 'ada'), url: 'https://onlyfans.com/ada',
    entities: { url: { urls: [{ expanded_url: 'https://onlyfans.com/ada' }] } } }, null, now);
  assert(pf.profile_url === 'https://x.com/ada', 'profile_url derived from username');
  assert(pf.website_url === 'https://onlyfans.com/ada', 'profile website kept separately');
  assert(!pf.profile_url.includes('onlyfans'), 'profile_url never a third-party site');

  // first sync → all added
  const first = reconcile({ freshUsers: [u('1', 'a'), u('2', 'b')], prevRecords: [], now });
  assert(first.added === 2 && first.removed.length === 0, 'first sync adds all');
  assert(first.records[0].backed_up_at === now, 'backed_up_at stamped');

  // second sync: 2 gone, 3 new → graveyard keeps the departed, nothing deleted
  const second = reconcile({
    freshUsers: [u('1', 'a'), u('3', 'c')],
    prevRecords: first.records, now: '2026-10-15T00:00:00.000Z',
    classify: (r) => (r.id === '2' ? 'suspended' : 'unfollowed'),
  });
  assert(second.added === 1, 'one new account');
  assert(second.records.length === 3, 'nothing deleted from archive');
  const gone = second.records.find((r) => r.id === '2');
  assert(gone.archived_at === '2026-10-15T00:00:00.000Z', 'archived_at set');
  assert(gone.is_suspended === 1, 'removal reason mapped to suspended');
  assert(second.records.find((r) => r.id === '1').backed_up_at === now, 'backed_up_at preserved across syncs');

  // follow-list-only invariant: departed accounts stay flagged, not removed
  assert(second.removed.length === 1 && second.removed[0].id === '2', 'removed list correct');

  // A plain unfollow (no --classify) must still be graveyard-visible: archived_at
  // is the signal, and neither is_suspended nor is_blocked should be fabricated.
  const third = reconcile({
    freshUsers: [u('1', 'a')], prevRecords: second.records,
    now: '2026-10-16T00:00:00.000Z',
  });
  const plainGone = third.records.find((r) => r.id === '3');
  assert(plainGone.archived_at === '2026-10-16T00:00:00.000Z', 'plain unfollow gets archived_at');
  assert(plainGone.removal_reason === 'unfollowed', 'plain unfollow reason');
  assert(plainGone.is_suspended === 0 && plainGone.is_blocked === 0, 'no fabricated status flags');

  // ---- timeline events ------------------------------------------------------
  const e1 = reconcile({ freshUsers: [u('1', 'a')], prevRecords: [], now }).events;
  assert(e1.length === 1 && e1[0].event === 'added', 'new account → added event');

  const before = reconcile({ freshUsers: [u('1', 'a')], prevRecords: [], now }).records;
  const bumped = u('1', 'a');
  bumped.public_metrics.followers_count = 5000;         // was 1000
  bumped.name = 'RENAMED';
  const e2 = reconcile({ freshUsers: [bumped], prevRecords: before, now: '2026-10-15T00:00:00.000Z' }).events;
  assert(e2.length === 1 && e2[0].event === 'updated', 'field change → updated event');
  assert(e2[0].detail.name.to === 'RENAMED', 'name change captured');
  assert(!e2[0].detail.followers_count, 'an in-tier follower bump is NOT recorded');
  assert(describeEvent(e2[0]).includes('昵称已更改'), 'describeEvent describes a rename');

  // a departure is recorded once, not on every subsequent sync
  const dep = reconcile({ freshUsers: [], prevRecords: before, now: '2026-10-16T00:00:00.000Z' });
  assert(dep.events.length === 1 && dep.events[0].event === 'archived', 'departure → archived event');
  const again = reconcile({ freshUsers: [], prevRecords: dep.records, now: '2026-10-17T00:00:00.000Z' });
  assert(again.events.length === 0, 'no duplicate archived event on a later sync');
  // ...but a return is recorded
  const back = reconcile({ freshUsers: [u('1', 'a')], prevRecords: dep.records, now: '2026-10-18T00:00:00.000Z' });
  assert(back.events.some((e) => e.event === 'restored'), 'return → restored event');

  // avatar URL churn (same path, new query/size) must NOT be an event
  const churn = reconcile({
    freshUsers: [{ ...u('1', 'a'), profile_image_url: 'https://pbs.twimg.com/profile_images/1/AAA_400x400.jpg?abc=9' }],
    prevRecords: reconcile({ freshUsers: [u('1', 'a')], prevRecords: [], now }).records,
    now,
  });
  assert(!churn.events.some((e) => e.event === 'updated' && e.detail.avatar_url), 'avatar URL churn is not an event');

  // A follower wobble (real: 369/476 records differ each sync) must NOT produce
  // an event, but crossing a tier must — the badge changes.
  const base = reconcile({ freshUsers: [u('1', 'a')], prevRecords: [], now }).records;   // 1000 followers
  const wobble = u('1', 'a'); wobble.public_metrics.followers_count = 1042;
  assert(reconcile({ freshUsers: [wobble], prevRecords: base, now }).events.length === 0, 'follower wobble is not an event');
  const crossed = u('1', 'a'); crossed.public_metrics.followers_count = 120000;
  const tierEv = reconcile({ freshUsers: [crossed], prevRecords: base, now }).events;
  assert(tierEv.length === 1 && tierEv[0].detail.tier, 'tier crossing IS an event');
  assert(describeEvent(tierEv[0]).includes('10万'), 'tier event names the tier');
  return 'archive.mjs self-check OK';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(demo());
}
