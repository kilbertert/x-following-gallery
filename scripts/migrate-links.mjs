#!/usr/bin/env node
/**
 * One-shot migration: give existing archive records the corrected link fields.
 *
 * Before this change `url` held the X API's `url` — the website in the profile
 * (onlyfans / linktree / t.co), not the account page. Records therefore need:
 *   profile_url = https://x.com/<screen_name>   (derived)
 *   website_url = the old `url` value          (kept, correctly named)
 * and the old `url` key removed so nothing reads it again.
 *
 * Archives synced after the fix already have these fields; this is idempotent
 * and safe to re-run. It does not touch the network.
 *
 *   node scripts/migrate-links.mjs            # patch site/data/archive.json
 *   node scripts/migrate-links.mjs --dry-run
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_FILE, parseArgs, log, warn } from './lib/config.mjs';

const args = parseArgs();
if (!existsSync(DATA_FILE)) { warn(`⚠ ${DATA_FILE} 不存在`); process.exit(1); }

const records = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
let patched = 0, alreadyOk = 0, noHandle = 0;

for (const r of records) {
  const hasNew = typeof r.profile_url === 'string' && r.profile_url;
  const oldUrl = typeof r.url === 'string' ? r.url : '';
  const derived = r.screen_name ? `https://x.com/${r.screen_name}` : '';
  if (!derived) { noHandle++; continue; }

  if (hasNew) {
    // still drop any stray legacy `url` so nothing reads it again
    if ('url' in r && oldUrl && !r.website_url) r.website_url = oldUrl;
    delete r.url;
    alreadyOk++;
    continue;
  }

  r.profile_url = derived;
  r.website_url = oldUrl && oldUrl !== derived ? oldUrl : '';
  delete r.url;
  patched++;
}

log(`  记录 ${records.length} 条：修正 ${patched} · 已是最新 ${alreadyOk} · 无 username 跳过 ${noHandle}`);
if (args['dry-run']) { log('  --dry-run：未落盘'); process.exit(0); }
writeFileSync(DATA_FILE, JSON.stringify(records));
log(`  ✔ 已写入 ${DATA_FILE.split('/').slice(-3).join('/')}`);
