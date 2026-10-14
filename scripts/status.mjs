#!/usr/bin/env node
/**
 * Health dashboard — answers "is the pipeline healthy?" in one screen.
 *
 * Read-only and offline by default: it inspects local state and (cheaply) the
 * R2 domain, but makes no X API call unless you pass --verify. This is the piece
 * worth borrowing from the reference site's admin console (its status cards) —
 * without the parts of that console that are liabilities: no D1, no stored X
 * cookies, no Express runtime, nothing reachable from the public internet.
 *
 *   node scripts/status.mjs            # instant, free
 *   node scripts/status.mjs --verify   # also calls /users/me (≈$0.001)
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_FILE, SITE, ENV_FILE, loadEnv, parseArgs, R2_CREDS, X_CREDS } from './lib/config.mjs';

const args = parseArgs();
const env = loadEnv();
const ok = (b) => (b ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m');
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const warnMark = '\x1b[33m!\x1b[0m';
const row = (label, value, mark = '') => console.log(`  ${mark || ' '} ${label.padEnd(22)} ${value}`);
let problems = 0;
const bad = (m) => { problems++; return `\x1b[31m${m}\x1b[0m`; };

console.log('\n\x1b[1mX 关注画廊 · 状态\x1b[0m ' + dim(new Date().toISOString()));

// ── 1. credentials ────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[凭据]\x1b[0m');
row('.env 文件', existsSync(ENV_FILE) ? ENV_FILE : bad('缺失'), existsSync(ENV_FILE) ? ok(1) : '');
const x = X_CREDS(env);
const r2 = R2_CREDS(env);
const exp = Number(env.X_EXPIRES_AT || 0);
const minsLeft = exp ? Math.round((exp - Date.now()) / 60000) : null;
row('X client id', x.client_id ? x.client_id.slice(0, 6) + '…' : bad('未设置'), x.client_id ? ok(1) : '');
row('X 授权类型', x.client_secret ? '机密客户端 (Basic)' : '公共客户端 (PKCE)');
row('X access token', x.access_token ? `${String(x.access_token).slice(0, 6)}…` : bad('未授权'), x.access_token ? ok(1) : '');
if (x.access_token) {
  // The refresh token is what keeps this working unattended; without it the
  // daily cron dies the moment the access token expires.
  const canRefresh = !!x.refresh_token;
  row('X refresh token', canRefresh ? '有（可自动续期）' : bad('无——过期后需重新授权'), canRefresh ? ok(1) : warnMark);
  if (minsLeft != null) row('token 到期', minsLeft > 0 ? `${minsLeft} 分钟后` : bad('已过期（下次运行会自动刷新）'));
  row('授权 scope', env.X_SCOPE || dim('(未记录)'));
}

// ── 2. R2 / media ─────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[图片存储]\x1b[0m');
row('R2 桶', r2.bucket || bad('未配置'), r2.bucket ? ok(1) : '');
row('R2 密钥', r2.accessKeyId && r2.secretKey ? '已配置' : bad('缺 R2_ACCESS_KEY_ID / SECRET'), r2.accessKeyId ? ok(1) : '');
row('公开域名', r2.publicDomain || bad('未配置（图片会走 twimg 热链）'), r2.publicDomain ? ok(1) : warnMark);

// ── 3. archive ────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[归档]\x1b[0m');
if (!existsSync(DATA_FILE)) {
  row('archive.json', bad('不存在——先跑 npm run sync 或 npm run demo'));
} else {
  const recs = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  const dead = recs.filter((r) => r.archived_at || r.is_suspended || r.is_blocked).length;
  const live = recs.length - dead;
  const verified = recs.filter((r) => r.verified).length;
  const top = recs.filter((r) => r.followers_count >= 5e5).length;
  const known = recs.filter((r) => r.followers_count >= 1e5).length;
  const local = recs.filter((r) => String(r.avatar_url).startsWith('/media')).length;
  const hotlink = recs.filter((r) => /twimg/.test(String(r.avatar_url) || '')).length;
  const noCover = recs.filter((r) => !r.cover_url).length;
  const cfg = existsSync(resolve(SITE, 'runtime-config.json'))
    ? JSON.parse(readFileSync(resolve(SITE, 'runtime-config.json'), 'utf8')) : {};
  const mtime = statSync(DATA_FILE).mtime;

  row('总数', `${recs.length}（存活 ${live} · 坟场 ${dead}）`);
  row('蓝标 / 50万+ / 10万+', `${verified} / ${top} / ${known}`);
  row('头像本地化', local === recs.length ? `${local}/${recs.length} 全部在 R2` : `${local}/${recs.length}（${hotlink} 走热链）`,
    local === recs.length ? ok(1) : warnMark);
  row('无封面', `${noCover} 条（前端回退渐变底）`);
  row('数据生成于', cfg.generated_at ? `${cfg.generated_at.slice(0, 19)}` : dim('(未知)'));
  row('文件最后写入', dim(mtime.toISOString().slice(0, 19)));
  if (cfg.r2_public_domain && r2.publicDomain && cfg.r2_public_domain !== r2.publicDomain) {
    row('配置一致性', bad(`runtime-config 的域名(${cfg.r2_public_domain}) 与 .env(${r2.publicDomain}) 不一致`));
  } else if (cfg.r2_public_domain) {
    row('配置一致性', '运行时域名与 .env 一致', ok(1));
  }
}

// ── 4. automation ─────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[自动化]\x1b[0m');
const { execSync } = await import('node:child_process');
const sh = (c) => { try { return execSync(c, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
row('cron', sh('crontab -l').includes('sync-daily.sh') ? '已安装（每日 04:17）' : bad('未安装'), sh('crontab -l').includes('sync-daily.sh') ? ok(1) : '');
const lastSync = existsSync('.last-sync') ? Number(readFileSync('.last-sync', 'utf8')) * 1000 : 0;
row('上次定时同步', lastSync ? `${Math.round((Date.now() - lastSync) / 3600000)} 小时前` : dim('（本机尚无记录，首次 cron 后写入）'));
const tun = sh('systemctl --user is-active x-following-gallery-frp.service');
row('OAuth 回调隧道', tun === 'active' ? 'active（xauth.ranlei.work）' : bad(`${tun || '未运行'}`), tun === 'active' ? ok(1) : '');
const logTail = existsSync('/tmp/xfg-sync.log') ? readFileSync('/tmp/xfg-sync.log', 'utf8').trim().split('\n').slice(-1)[0] : '';
row('同步日志末行', logTail ? dim(logTail.slice(0, 70)) : dim('(无)'));

// ── 5. cost ───────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[费用]\x1b[0m');
if (existsSync(DATA_FILE)) {
  const n = JSON.parse(readFileSync(DATA_FILE, 'utf8')).filter((r) => !r.archived_at).length;
  row('下次全量同步', `≈ $${(n * 0.001).toFixed(2)}（${n} 关注 × $0.001）`);
  row('每日 1 次月成本', `≈ $${(n * 0.001 * 30).toFixed(2)}`);
}

// ── 6. optional live verify ───────────────────────────────────────────────────
if (args.verify && x.client_id) {
  console.log('\n\x1b[1m[在线核验]\x1b[0m');
  const { XClient } = await import('./lib/x-api.mjs');
  try {
    const c = new XClient({ secrets: x });
    const me = (await c.me()).data;
    row('X 账号', `@${me.username}`, ok(1));
  } catch (e) { row('X 账号', bad(e.message)); }
  try {
    const res = await fetch(`${r2.publicDomain}/media/avatars/1.jpg`);
    row('R2 公开读取', r2.publicDomain ? `${res.status}` : dim('(未配置域名)'));
  } catch (e) { row('R2 公开读取', bad(e.message)); }
}

console.log(`\n  ${problems ? bad(`${problems} 处待处理`) : '\x1b[32m全部就绪\x1b[0m'}\n`);
