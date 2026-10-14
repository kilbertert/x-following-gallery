#!/usr/bin/env bash
# wire-tunnel.sh — publish the OAuth2 callback receiver through this host's frp.
#
# Idempotent: re-running regenerates the frpc config with the SAME credentials,
# so you never have to re-enter them. Reuses the host's existing frp edge
# (frps + nginx + Cloudflare wildcard) rather than inventing a second one.
#
#   ./ops/wire-tunnel.sh            # create/refresh config + unit, (re)start
#   ./ops/wire-tunnel.sh --status   # show state, URL and how to read credentials
#   ./ops/wire-tunnel.sh --rotate   # rotate the tunnel Basic Auth password
#
# Requires the port 12110 allocation in ~/Projects/DEVELOPMENT-PORT-REGISTRY.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRP_DIR="$HOME/.config/frp"
CRED_FILE="$FRP_DIR/credentials"
TOML="$FRP_DIR/x-following-gallery.toml"
UNIT="$HOME/.config/systemd/user/x-following-gallery-frp.service"
SUB="xauth"
LOCAL_PORT=12110
URL="https://${SUB}.ranlei.work"

die() { printf 'x %s\n' "$*" >&2; exit 1; }

[[ -r $CRED_FILE ]] || die "missing $CRED_FILE (frp server credentials)"
# shellcheck disable=SC1090
source "$CRED_FILE"
: "${FRP_SERVER:?FRP_SERVER missing}"; : "${FRP_PORT:?FRP_PORT missing}"; : "${FRP_TOKEN:?FRP_TOKEN missing}"

if [[ "${1:-}" == "--status" ]]; then
  printf 'service : '; systemctl --user is-active x-following-gallery-frp.service || true
  printf 'url     : %s/callback\n' "$URL"
  printf 'local   : 127.0.0.1:%s\n' "$LOCAL_PORT"
  printf 'auth    : user=%s  (password: grep httpPassword %s)\n' \
    "$(sed -n 's/^httpUser *= *"\(.*\)"/\1/p' "$TOML" 2>/dev/null || echo '?')" "$TOML"
  exit 0
fi

ROTATE=0; [[ "${1:-}" == "--rotate" ]] && ROTATE=1

# Preserve existing credentials across re-runs.
USER_NAME="xauth"
PASS=""
if [[ $ROTATE -eq 0 && -r $TOML ]]; then
  USER_NAME="$(sed -n 's/^httpUser *= *"\(.*\)"/\1/p' "$TOML" || true)"
  PASS="$(sed -n 's/^httpPassword *= *"\(.*\)"/\1/p' "$TOML" || true)"
fi
[[ -n $USER_NAME ]] || USER_NAME="xauth"
if [[ -z $PASS ]]; then
  PASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
fi

umask 077
sed -e "s|__FRP_SERVER__|$FRP_SERVER|" \
    -e "s|__FRP_PORT__|$FRP_PORT|" \
    -e "s|__FRP_TOKEN__|$FRP_TOKEN|" \
    -e "s|__CALLBACK_USER__|$USER_NAME|" \
    -e "s|__CALLBACK_PASSWORD__|$PASS|" \
    "$ROOT/ops/frpc.toml.template" > "$TOML"
chmod 600 "$TOML"

install -m 644 "$ROOT/ops/x-following-gallery-frp.service" "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now x-following-gallery-frp.service
systemctl --user restart x-following-gallery-frp.service
sleep 2

systemctl --user is-active --quiet x-following-gallery-frp.service \
  || die "unit did not come up — journalctl --user -u x-following-gallery-frp"

printf '\n  tunnel  : active\n'
printf '  callback: %s/callback\n' "$URL"
printf '  local   : 127.0.0.1:%s\n' "$LOCAL_PORT"
printf '  auth    : %s / %s\n\n' "$USER_NAME" "$PASS"
printf '  填进 X 开发者门户的 Callback URI：\n    %s/callback\n\n' "$URL"
printf '  填进 .env：\n    X_REDIRECT_URI=%s/callback\n    X_CALLBACK_LOCAL_PORT=%s\n\n' "$URL" "$LOCAL_PORT"
printf '  验证闸门（应为 401）：curl -s -o /dev/null -w "%%{http_code}\\n" %s/callback\n\n' "$URL"
