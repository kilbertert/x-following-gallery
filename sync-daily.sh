#!/usr/bin/env bash
# Refresh: sync the following list, mirror any new media, commit the archive to
# git, republish.
#
# Interval is set by SYNC_HOURS (default 24 = daily):
#   17 4 * * * SYNC_HOURS=168 /path/to/sync-daily.sh >> /tmp/xfg-sync.log 2>&1
#
# Each full sync costs ~$0.001 per followed account (Owned Reads); at ~476
# accounts that is ~$0.48/run.
#
# The git commit is the actual backup: without it the archive only ever exists
# in its latest state. Playground's git guard forbids committing on the default
# branch, so this mirrors the manual flow — commit on a throwaway branch, then
# fast-forward main. Any failure unwinds the branch so the tree is never left
# half-switched.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

SYNC_HOURS=${SYNC_HOURS:-24}
STAMP_FILE=.last-sync
REPO_ROOT="$(git rev-parse --show-toplevel)"
REL_DIR="${PWD#"$REPO_ROOT"/}"
TRACKED=(site/data/archive.json site/runtime-config.json site/env-config.js)

log() { echo "$*"; }

now=$(date +%s)
if [[ -f $STAMP_FILE ]]; then
  last=$(cat "$STAMP_FILE" 2>/dev/null || echo 0)
  elapsed_h=$(( (now - last) / 3600 ))
  if (( elapsed_h < SYNC_HOURS )); then
    log "===== $(date -Is) skipped: ${elapsed_h}h since last sync < ${SYNC_HOURS}h ====="
    exit 0
  fi
fi

log "===== $(date -Is) sync start (every ${SYNC_HOURS}h) ====="
node scripts/sync.mjs
node scripts/mirror-media.mjs

# ---- commit the archive (the backup proper) ---------------------------------
branch="exp/archive-$(date +%Y%m%d-%H%M)"
cd "$REPO_ROOT"
if git diff --quiet -- "${TRACKED[@]/#/$REL_DIR/}" && git diff --cached --quiet -- "${TRACKED[@]/#/$REL_DIR/}"; then
  log "  归档无变化，跳过提交"
else
  base_branch=$(git symbolic-ref --short HEAD)
  if [[ $base_branch != main ]]; then
    log "  ! 当前分支是 $base_branch 而非 main，跳过自动提交（避免误提交到别处）"
  else
    cleanup() { git checkout main -q 2>/dev/null || true; git branch -D "$branch" -q 2>/dev/null || true; }
    trap cleanup ERR
    git checkout -q -b "$branch"
    git add "${TRACKED[@]/#/$REL_DIR/}"
    git commit -q -m "chore(archive): 定时同步 $(date +%F) · $(node -e "
      const r=require('$REPO_ROOT/$REL_DIR/site/data/archive.json');
      const live=r.filter(x=>!x.archived_at).length, dead=r.length-live;
      process.stdout.write(live+' 存活 / '+dead+' 坟场');
    " 2>/dev/null || echo '见 archive.json')"
    git checkout -q main
    if git merge --ff-only "$branch" -q; then
      log "  ✔ 归档已提交并快进 main：$branch"
    else
      log "  ! main 已前进，无法快进——改为 rebase 后重试"
      git checkout -q "$branch"
      git rebase -q main
      git checkout -q main
      git merge --ff-only "$branch" -q && log "  ✔ rebase 后快进成功"
    fi
    git branch -d "$branch" -q
    trap - ERR
  fi
fi
cd "$PWD"

# ---- publish ----------------------------------------------------------------
npx --yes wrangler pages deploy site \
  --project-name "${CF_PAGES_PROJECT:-x-following-gallery}" \
  --branch main --commit-dirty=true

date +%s > "$STAMP_FILE"
log "===== $(date -Is) sync done ====="
