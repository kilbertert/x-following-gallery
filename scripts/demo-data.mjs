#!/usr/bin/env node
/**
 * Generate synthetic demo records into site/data/archive.json so the UI can be
 * previewed and tested before X API / R2 credentials exist.
 *
 *   node scripts/demo-data.mjs          # 48 records
 *   node scripts/demo-data.mjs --n 200
 *
 * Real data replaces this on the first `node scripts/sync.mjs`. Avatars are
 * inline SVG data URIs, so the preview needs no network at all.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DATA_FILE, SITE, parseArgs, loadEnv, log } from './lib/config.mjs';

const args = parseArgs();
const N = Number(args.n || 48);
const env = loadEnv();

const LATIN = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Linus T.', 'Margaret H.', 'Barbara Liskov', 'Ken Thompson', 'Radia Perlman'];
const CJK = ['林深见鹿', '山月不知心底事', '一只柴犬', '橘子汽水', '半亩方塘', '云舒', '长安故里', '拾光者'];
const BIOS = [
  'Building small tools and writing about them. https://example.dev/blog',
  '前端 / 设计 / 摄影。作品集 → https://linktr.ee/demo',
  '独立开发者，正在做一款记笔记的小软件。https://t.co/DEMO1',
  'Researching distributed systems. Opinions are my own.',
  '每天更新一张胶片。约拍见简介链接 https://lit.link/shoot',
  '做动画的，偶尔写点教程。',
];
const avatar = (seed, hue) => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 80% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 75% 48%)"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/><circle cx="100" cy="78" r="34" fill="rgba(255,255,255,.85)"/><path d="M32 200c6-42 34-62 68-62s62 20 68 62z" fill="rgba(255,255,255,.85)"/><text x="100" y="150" font-family="monospace" font-size="34" font-weight="700" fill="rgba(0,0,0,.35)" text-anchor="middle">${seed}</text></svg>`);

const now = new Date();
const records = Array.from({ length: N }, (_, i) => {
  const id = String(1_000_000_000 + i * 7919);
  const useCJK = i % 3 === 0;
  const name = useCJK ? CJK[i % CJK.length] + (i > 7 ? String(i) : '') : LATIN[i % LATIN.length];
  const handle = (useCJK ? 'user_' : 'demo_') + id.slice(-6);
  // spread followers across all tiers so every filter/tab has members
  const followers = [120, 3_400, 45_000, 128_000, 260_000, 640_000, 1_400_000, 4_300_000][i % 8] + i * 37;
  const verified = i % 4 !== 3;
  const dead = i % 11 === 5;
  const bio = BIOS[i % BIOS.length];
  const links = ['https://example.dev/blog', 'https://linktr.ee/demo', 'https://t.co/DEMO1', 'https://lit.link/shoot']
    .filter((u) => bio.includes(u.split('://')[1].split('/')[0]));
  // Timestamps must be internally consistent — an account cannot be archived
  // before it was first seen, or its timeline renders "进入坟场" above "首次归档".
  const backedUpMs = now.getTime() - (i % 20) * 864e5;
  const archivedMs = dead ? Math.max(backedUpMs + 864e5, now.getTime() - 3 * 864e5) : null;
  return {
    id, screen_name: handle, name,
    avatar_url: avatar(i + 1, (i * 37) % 360),
    cover_url: i % 5 === 0 ? '' : 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="hsl(${(i * 53) % 360} 70% 40%)"/><stop offset="1" stop-color="hsl(${(i * 53 + 90) % 360} 70% 25%)"/></linearGradient></defs><rect width="600" height="200" fill="url(#b)"/></svg>`),
    followers_count: followers,
    following_count: 100 + i,
    tweets_count: 500 + i * 13,
    description: bio,
    location: i % 4 === 0 ? 'Shanghai' : '',
    profile_url: `https://x.com/${handle}`,
    // deliberately a THIRD-PARTY site, mirroring real data (most creators put
    // an onlyfans/linktree link here) — so the demo exercises the distinction
    // between "profile page" and "profile website".
    website_url: links[0] || '',
    verified: verified ? 1 : 0,
    verified_type: verified ? 'blue' : null,
    links, tags: links.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(Boolean),
    backed_up_at: new Date(backedUpMs).toISOString(),
    last_synced_at: now.toISOString(),
    archived_at: archivedMs ? new Date(archivedMs).toISOString() : null,
    removal_reason: dead ? (i % 2 ? 'suspended' : 'unfollowed') : null,
    is_suspended: dead && i % 2 ? 1 : 0,
    is_blocked: 0,   // cause is unknowable without --classify; archived_at drives the graveyard
    sync_count: 1 + (i % 6),
    schema_version: 1,
  };
});

mkdirSync(dirname(DATA_FILE), { recursive: true });
// Distinguishing real data from demo data is a judgement call — demo avatars are
// inline SVG, real ones point at /media or twimg. Getting that heuristic wrong
// once is cheap; getting it wrong in the destructive direction loses a backup.
// So overwriting REAL data needs a separate, unmistakable flag: `--force`
// (which is routine for regenerating demo data) is deliberately not enough.
const looksReal = (arr) => Array.isArray(arr) && arr.some(
  (r) => r && typeof r.avatar_url === 'string' && r.avatar_url && !r.avatar_url.startsWith('data:'));
if (existsSync(DATA_FILE)) {
  let prev = null;
  try { prev = JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { /* unreadable → treat as overwritable */ }
  if (looksReal(prev) && !args['i-know-this-overwrites-real-data']) {
    log(`✘ ${DATA_FILE} 看起来是**真实同步数据**（${prev.length} 条），拒绝覆盖。`);
    log('  这是备份本体。确实要清掉它、换成演示数据，请显式加：');
    log('      --i-know-this-overwrites-real-data');
    log('  想保留真实数据的日常工作请用 npm run sync / npm run mirror-media。');
    process.exit(1);
  }
}
writeFileSync(DATA_FILE, JSON.stringify(records));

// ---- change timeline (site/data/history.json) -------------------------------
// Generated from the same records so a fresh clone sees the 时光档案 feature
// without needing real data. Deliberately exercises all four event types:
// added / updated / archived / restored — otherwise a demo visitor would only
// ever see "首次归档" and never learn the timeline can show more.
const day = (ms) => new Date(ms).toISOString();
const events = [];
const push = (id, r, ts, event, detail) => events.push({
  ts: day(ts), id, screen_name: r.screen_name, name: r.name, event, ...(detail ? { detail } : {}),
});
records.forEach((r, i) => {
  const base = Date.parse(r.backed_up_at);
  const archivedAt = r.archived_at ? Date.parse(r.archived_at) : null;
  push(r.id, r, base, 'added');

  if (archivedAt) {
    push(r.id, r, archivedAt, 'archived',
      { reason: r.is_suspended ? 'suspended' : r.is_blocked ? 'deleted' : 'unfollowed' });
    // every third dead account came back — otherwise 'restored' never shows
    if (i % 3 === 0) {
      const back = Math.min(now.getTime(), archivedAt + 2 * 864e5);
      push(r.id, r, back, 'restored');
      r.archived_at = null; r.removal_reason = null;   // keep record consistent with its timeline
      r.is_suspended = 0; r.is_blocked = 0;
    }
  } else if (i % 4 === 1) {
    // a tier crossing — the kind of update that is worth recording (see archive.mjs)
    const from = ['rest', 'known'][i % 2] === 'rest' ? '普通账号' : '知名创作者 (10万+)';
    const to = from === '普通账号' ? '知名创作者 (10万+)' : 'Top 头部 (50万+)';
    push(r.id, r, base + 5 * 864e5, 'updated', { tier: { from, to } });
  } else if (i % 4 === 2) {
    push(r.id, r, base + 3 * 864e5, 'updated', { verified: { from: false, to: true } });
  }
});
events.sort((a, b) => a.ts.localeCompare(b.ts));
writeFileSync(resolve(SITE, 'data/history.json'), JSON.stringify(events));
// The records were amended above (some came back from the graveyard), so rewrite
// them — the archive and its timeline must not disagree.
writeFileSync(DATA_FILE, JSON.stringify(records));

// Both generated config files are written so a fresh clone works end to end
// without any credentials: the site reads env-config.js for the media domain,
// and mirror-media.mjs keeps it in step with runtime-config.json.
const demoCfg = {
  r2_public_domain: (env.R2_PUBLIC_DOMAIN || '').replace(/\/$/, ''),
  owner_handle: env.X_OWNER_HANDLE || 'demo',
  generated_at: now.toISOString(), demo: true,
};
writeFileSync(resolve(SITE, 'runtime-config.json'), JSON.stringify(demoCfg, null, 2) + '\n');
writeFileSync(resolve(SITE, 'env-config.js'),
  `/* Auto-generated by scripts/demo-data.mjs — do not edit by hand. */\n` +
  `window.__ENV__ = Object.freeze(${JSON.stringify({
    R2_PUBLIC_DOMAIN: demoCfg.r2_public_domain, OWNER_HANDLE: demoCfg.owner_handle, GENERATED_AT: demoCfg.generated_at,
  }, null, 2)});\n`);
log(`✔ 已写入 ${N} 条演示数据 → site/data/archive.json`);
log('  预览：node scripts/preview.mjs');
log('  真实同步会覆盖它：node scripts/sync.mjs');
