#!/usr/bin/env node
/**
 * Publish site/ to Cloudflare Pages. Thin wrapper over wrangler so the deploy
 * command, project name and token check live in one place.
 *
 *   node scripts/publish.mjs                       # deploy to the default project
 *   node scripts/publish.mjs --project my-gallery
 *   node scripts/publish.mjs --branch main
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env (or the real env).
 * Token scopes: "Cloudflare Pages:Edit" and "Account Settings:Read".
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SITE, loadEnv, saveEnvVars, parseArgs, log, warn, ROOT } from './lib/config.mjs';

const args = parseArgs();
if (args.help) { log('用法见 scripts/publish.mjs 顶部注释'); process.exit(0); }

const env = loadEnv();
const project = args.project || env.CF_PAGES_PROJECT || 'x-following-gallery';
const branch = args.branch || 'main';

if (args.project && args.project !== env.CF_PAGES_PROJECT) {
  saveEnvVars({ CF_PAGES_PROJECT: String(args.project) });      // remember it
}

if (!existsSync(join(SITE, 'data/archive.json'))) {
  warn('⚠ site/data/archive.json 不存在——先跑 node scripts/sync.mjs，否则线上是空画廊。');
}
if (!env.CLOUDFLARE_API_TOKEN) {
  console.error('✘ 缺少 CLOUDFLARE_API_TOKEN。请在 Cloudflare 控制台创建 API Token');
  console.error('  （权限：Cloudflare Pages:Edit + Account Settings:Read），写进 .env。');
  process.exit(1);
}

const cmd = ['wrangler', 'pages', 'deploy', 'site',
  '--project-name', project, '--branch', branch, '--commit-dirty=true'];

log(`\n  项目    ${project}`);
log(`  分支    ${branch}`);
log(`  目录    ${SITE.replace(ROOT + '/', '')}`);
log(`  命令    npx ${cmd.join(' ')}\n`);

const res = spawnSync('npx', ['--yes', ...cmd], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID || '',
  },
});

if (res.status !== 0) {
  console.error(`\n✘ 发布失败（退出码 ${res.status}）`);
  console.error('  常见原因：token 权限不足、项目名不存在（先在 Pages 里建同名项目）、或未登录。');
  process.exit(res.status ?? 1);
}
log(`\n✔ 已发布。线上地址形如 https://${project}.pages.dev`);
log('  首次发布后请到 Pages 设置里绑定自定义域名——图片走 R2 自定义域，页面走这个域。\n');
