#!/usr/bin/env node
/**
 * Publish site/ to Cloudflare Pages.
 *
 * The directory is STAGED into a temp dir outside any git repository first.
 * That matters: `wrangler pages deploy` honours `.gitignore`, and this repo
 * deliberately gitignores `site/data/` (the real archive must never be
 * committed). Deploying `site/` in place would therefore silently ship a site
 * with no data — the worst kind of failure, because the deploy succeeds.
 * Staging decouples what gets deployed from what git tracks.
 *
 *   node scripts/publish.mjs                       # deploy to the default project
 *   node scripts/publish.mjs --project my-gallery
 *   node scripts/publish.mjs --branch main
 *   node scripts/publish.mjs --check               # stage + list files, no deploy
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env (or the real env).
 * Token scopes: "Cloudflare Pages:Edit" and "Account Settings:Read".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { SITE, loadEnv, saveEnvVars, parseArgs, log, warn, ROOT } from './lib/config.mjs';

const args = parseArgs();
if (args.help) { log('用法见 scripts/publish.mjs 顶部注释'); process.exit(0); }

const env = loadEnv();
const project = args.project || env.CF_PAGES_PROJECT || 'x-following-gallery';
const branch = args.branch || 'main';
if (args.project && args.project !== env.CF_PAGES_PROJECT) saveEnvVars({ CF_PAGES_PROJECT: String(args.project) });

const dataFile = join(SITE, 'data/archive.json');
if (!existsSync(dataFile)) {
  warn('⚠ site/data/archive.json 不存在——部署出来会是空画廊。先跑 npm run sync 或 npm run mirror-media。');
}

// ---- stage site/ outside git -------------------------------------------------
const staging = mkdtempSync(join(tmpdir(), 'xfg-deploy-'));
cpSync(SITE, staging, { recursive: true });
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const files = walk(staging).map((f) => relative(staging, f)).sort();
log(`\n  暂存目录  ${staging}`);
log(`  待部署    ${files.length} 个文件`);
if (!files.some((f) => f.startsWith('data/'))) {
  warn('  ⚠ 暂存目录里没有 data/ —— 站点会是空的，请检查 site/data/archive.json');
}
if (args.check) {
  for (const f of files) log(`    ${f}  ${statSync(join(staging, f)).size}B`);
  rmSync(staging, { recursive: true, force: true });
  process.exit(0);
}

// ---- deploy ------------------------------------------------------------------
if (!env.CLOUDFLARE_API_TOKEN) {
  console.error('✘ 缺少 CLOUDFLARE_API_TOKEN。请在 Cloudflare 控制台创建 API Token');
  console.error('  （权限：Cloudflare Pages:Edit + Account Settings:Read），写进 .env。');
  rmSync(staging, { recursive: true, force: true });
  process.exit(1);
}
log(`  项目      ${project}`);
log(`  分支      ${branch}\n`);

const res = spawnSync('npx', ['--yes', 'wrangler', 'pages', 'deploy', staging,
  '--project-name', project, '--branch', branch, '--commit-dirty=true'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID || '',
  },
});
rmSync(staging, { recursive: true, force: true });

if (res.status !== 0) {
  console.error(`\n✘ 发布失败（退出码 ${res.status}）`);
  console.error('  常见原因：token 权限不足、项目名不存在、或未登录。');
  process.exit(res.status ?? 1);
}
log(`\n✔ 已发布。https://${project}.pages.dev`);
log(`  站点源目录  ${SITE.replace(ROOT + '/', '')}（已排除 git 忽略规则的影响）\n`);
