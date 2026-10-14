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
    url: `https://x.com/${handle}`,
    verified: verified ? 1 : 0,
    verified_type: verified ? 'blue' : null,
    links, tags: links.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(Boolean),
    backed_up_at: new Date(now - (i % 20) * 864e5).toISOString(),
    last_synced_at: now.toISOString(),
    archived_at: dead ? new Date(now - 7 * 864e5).toISOString() : null,
    removal_reason: dead ? (i % 2 ? 'suspended' : 'unfollowed') : null,
    is_suspended: dead && i % 2 ? 1 : 0,
    is_blocked: 0,   // cause is unknowable without --classify; archived_at drives the graveyard
    sync_count: 1 + (i % 6),
    schema_version: 1,
  };
});

mkdirSync(dirname(DATA_FILE), { recursive: true });
if (existsSync(DATA_FILE) && !args.force) {
  const prev = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  if (Array.isArray(prev) && prev.length > N && prev.some((r) => r.last_synced_at && !String(r.avatar_url).startsWith('data:'))) {
    log(`⚠ ${DATA_FILE} 看起来是真实同步数据（${prev.length} 条），拒绝覆盖。加 --force 才会替换。`);
    process.exit(1);
  }
}
writeFileSync(DATA_FILE, JSON.stringify(records));
writeFileSync(resolve(SITE, 'runtime-config.json'), JSON.stringify({
  r2_public_domain: (env.R2_PUBLIC_DOMAIN || '').replace(/\/$/, ''),
  owner_handle: env.X_OWNER_HANDLE || 'demo',
  generated_at: now.toISOString(), demo: true,
}, null, 2) + '\n');
log(`✔ 已写入 ${N} 条演示数据 → site/data/archive.json`);
log('  预览：node scripts/preview.mjs');
log('  真实同步会覆盖它：node scripts/sync.mjs');
