#!/usr/bin/env node
/**
 * Sync the authenticated X account's following list into site/data/archive.json,
 * mirror avatars/banners into R2, and refresh the generated config files.
 *
 *   node scripts/sync.mjs                 # full sync
 *   node scripts/sync.mjs --dry-run       # 1 page, no R2, no write
 *   node scripts/sync.mjs --no-media      # skip R2 media
 *   node scripts/sync.mjs --limit 200     # 2 pages max (costs ~$0.20)
 *   node scripts/sync.mjs --classify      # extra lookups to label the graveyard
 *
 * Cost: X bills "Owned Reads" for your own account's data at $0.001/resource,
 * so a 3,000-account following sync is ≈ $3. The estimate is printed before the
 * write happens.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { XClient, fetchAllFollowing, COST_PER_RESOURCE_USD } from './lib/x-api.mjs';
import { reconcile } from './lib/archive.mjs';
import { mediaPlan } from './lib/archive.mjs';
import { R2Bucket, mirrorMedia } from './lib/r2.mjs';
import {
  ROOT, SITE, DATA_FILE, loadEnv, saveEnvVars, parseArgs, log, warn, X_CREDS, R2_CREDS,
} from './lib/config.mjs';

const args = parseArgs();
const DRY = !!args['dry-run'];

const die = (msg) => { console.error('✘ ' + msg); process.exit(1); };

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) { die(`${path} 不是合法 JSON：${err.message}（先备份再手工修复）`); }
}

function writeIfChanged(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (prev === text) { log(`  = ${path.replace(ROOT + '/', '')} 无变化`); return false; }
  writeFileSync(path, text);
  log(`  ✔ ${path.replace(ROOT + '/', '')}`);
  return true;
}

// ---------------------------------------------------------------- 1. auth
const env = loadEnv();
const creds = X_CREDS(env);
if (!creds.client_id) die('缺少 X_CLIENT_ID，请先填写 .env（见 README.md 的「准备」一节）');

const client = new XClient({
  secrets: creds,
  log: (m) => log('  ' + m),
  onToken: (s) => saveEnvVars({
    X_ACCESS_TOKEN: s.access_token,
    X_REFRESH_TOKEN: s.refresh_token || '',
    X_EXPIRES_AT: String(s.expires_at || 0),
  }),
});

log('\n[1/5] 读取账号信息');
let me;
try { me = (await client.me()).data; }
catch (err) { die(`无法读取账号信息（${err.message}）。若提示 401，请重新运行 node scripts/x-authorize.mjs`); }
log(`  @${me.username}  ·  id=${me.id}`);

// ---------------------------------------------------------------- 2. following
log('\n[2/5] 抓取关注列表');
// --dry-run means "prove connectivity cheaply": one page, ~$0.001/account, no
// write. Without this it would still walk the whole list and spend the full
// amount for a mere connectivity check.
const maxPages = args.limit ? Math.ceil(Number(args.limit) / 1000) : (DRY ? 1 : Infinity);
if (args.limit) warn(`  --limit ${args.limit} → 最多抓 ${maxPages} 页（每页 1000）`);
else if (DRY) warn('  --dry-run → 只抓 1 页（最多 1000 个关注）用于验证连通性');

let users = [], pages = 0, truncated = false;
try {
  ({ users, pages, truncated } = await fetchAllFollowing(client, me.id, {
    maxPages, log: (m) => log(m),
  }));
} catch (err) {
  die(`抓取失败：${err.message}`);
}
log(`  共 ${users.length} 个关注（${pages} 页）${truncated ? '（已按 --limit 截断）' : ''}`);
log(`  X 「Owned Reads」计费估算：${users.length} × $${COST_PER_RESOURCE_USD} = $${(users.length * COST_PER_RESOURCE_USD).toFixed(2)}`);

// ---------------------------------------------------------------- 3. reconcile
log('\n[3/5] 与既有归档对账');
const prev = readJson(DATA_FILE, []);
const prevRecords = Array.isArray(prev) ? prev : (prev.records || []);

// Optionally classify vanished accounts (costs one read each). Off by default
// because the raw following feed gives no removal reason.
const vanished = prevRecords.filter((r) => !users.some((u) => String(u.id) === r.id));
let classify;
if (args.classify && vanished.length) {
  log(`  对 ${vanished.length} 个消失账号做状态查询（额外 ${vanished.length} 次计费）…`);
  const reasons = new Map();
  let n = 0;
  for (const r of vanished) {
    const res = await client.userById(r.id);
    const reason = res?.__dead || (res?.data ? 'unfollowed' : 'unknown');
    reasons.set(r.id, reason);
    if (++n % 25 === 0) log(`    ${n}/${vanished.length}`);
  }
  classify = (r) => reasons.get(r.id) || 'unfollowed';
}

const now = new Date().toISOString();
const { records, added, removed, changed, events } = reconcile({ freshUsers: users, prevRecords, now, classify });
log(`  新增 ${added} · 变动 ${changed} · 移入赛博坟场 ${removed.length}`);
if (events.length) log(`  时间线新增 ${events.length} 条事件`);

// ---------------------------------------------------------------- 4. media
log('\n[4/5] 头像 / 封面');
let mediaFailed = [];
const r2 = R2_CREDS(env);
const canMedia = !args['no-media'] && !DRY && r2.accountId && r2.accessKeyId && r2.secretKey && r2.bucket;

// Plan media from the raw API objects (they carry the signed twimg URLs) and
// default every record to the *hotlinked* origin URL. That default is correct on
// its own — no R2 required. Successful R2 uploads overwrite it with `/media/...`
// in the rewrite loop below, so a failed upload degrades to hotlinking instead
// of pointing at an object that was never written.
const byId = new Map(users.map((u) => [String(u.id), u]));
for (const r of records) {
  const u = byId.get(r.id);
  const plan = u ? mediaPlan(r.id, u) : {};
  r._plan_avatar = plan.avatar;
  r._plan_cover = plan.cover;
  if (plan.avatar) r.avatar_url = plan.avatar.src;
  if (plan.cover) r.cover_url = plan.cover.src;
}

if (DRY) {
  log('  --dry-run：跳过媒体上传');
} else if (!canMedia) {
  warn('  ⚠ 未配置 R2（或用了 --no-media）——媒体将保留在 R2 上，若首次运行请先配置 .env 的 R2_* 变量');
  warn('    未 re-host 的封面将回退为空，前端会显示占位图。');
} else {
  const bucket = new R2Bucket({ ...r2, log: (m) => log('  ' + m) });
  const result = await mirrorMedia({ bucket, records, log: (m) => log(m), concurrency: 6 });
  mediaFailed = result.failed;
  log(`  上传 ${result.uploaded} · 跳过 ${result.skipped} · 失败 ${result.failed.length}`);
  for (const r of records) {
    for (const kind of ['avatar', 'cover']) {
      const url = result.rewrites.get(`${r.id}:${kind}`);
      if (url) r[kind === 'avatar' ? 'avatar_url' : 'cover_url'] = url;
    }
  }
}

// ---------------------------------------------------------------- 5. write
log('\n[5/5] 写入站点数据');
for (const r of records) {
  delete r._plan_avatar;
  delete r._plan_cover;
  delete r._avatar_src;
  delete r._cover_src;
}

if (DRY) {
  log(`  --dry-run：将写入 ${records.length} 条记录（未落盘）`);
  log(`  示例：${JSON.stringify(records[0], null, 1).slice(0, 500)}`);
} else {
  writeIfChanged(DATA_FILE, JSON.stringify(records, null, 0));

  // Append this run's events to the append-only timeline. The compaction keeps
  // only the most recent HISTORY_CAP events — recent history is what a gallery
  // shows; the full record-by-record change history lives in git anyway.
  const HISTORY_CAP = 5000;
  const HISTORY_FILE = resolve(SITE, 'data/history.json');
  const prevHistory = existsSync(HISTORY_FILE)
    ? (() => { try { const h = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); return Array.isArray(h) ? h : (h.events || []); } catch { return []; } })()
    : [];
  const merged = [...prevHistory, ...events];
  const trimmed = merged.slice(-HISTORY_CAP);
  writeIfChanged(HISTORY_FILE, JSON.stringify(trimmed, null, 0));
  log(`  时间线：本次 +${events.length}，共 ${trimmed.length} 条${merged.length > HISTORY_CAP ? `（已滚动截断，丢弃最旧 ${merged.length - HISTORY_CAP} 条）` : ''}`);

  const generatedAt = now;
  writeIfChanged(resolve(SITE, 'runtime-config.json'), JSON.stringify({
    r2_public_domain: r2.publicDomain || '',
    owner_handle: me.username,
    generated_at: generatedAt,
  }, null, 2) + '\n');

  writeIfChanged(resolve(SITE, 'env-config.js'),
    `/* Auto-generated by scripts/sync.mjs — do not edit by hand. */\n` +
    `window.__ENV__ = Object.freeze(${JSON.stringify({
      R2_PUBLIC_DOMAIN: r2.publicDomain || '',
      OWNER_HANDLE: me.username,
      GENERATED_AT: generatedAt,
    }, null, 2)});\n`);
}

// ---------------------------------------------------------------- report
log('\n──── 同步完成 ────');
log(`  账号            @${me.username}`);
log(`  关注总数        ${users.length}`);
log(`  归档总数        ${records.length}`);
log(`  本次新增        ${added}`);
log(`  移入坟场        ${removed.length}${removed.length ? ' → ' + removed.slice(0, 5).map((r) => '@' + r.screen_name).join(', ') + (removed.length > 5 ? ' …' : '') : ''}`);
if (mediaFailed.length) log(`  媒体失败        ${mediaFailed.length}（前几条：${mediaFailed.slice(0, 3).map((f) => `${f.kind}:${f.id}`).join(', ')}）`);
log(`  计费估算        $${client.estimatedCostUsd.toFixed(2)}`);
if (!DRY) log(`\n  下一步：node scripts/publish.mjs            （本地预览）`);
if (!DRY) log(`          npx wrangler pages deploy site --project-name <你的项目名>   （发布）`);
log('');
