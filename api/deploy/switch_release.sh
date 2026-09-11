#!/usr/bin/env bash
# Switch the live API to an uploaded binary, verify it, roll back on failure.
#
#   sudo /opt/kashshaf/api/switch_release.sh vX.Y.Z
#
# Expects /opt/kashshaf/api/bin/kashshaf-api-vX.Y.Z to exist (release.yml
# scp's it there). Steps:
#   1. remember the current target of bin/current (for rollback)
#   2. repoint bin/current -> bin/kashshaf-api-vX.Y.Z, systemctl restart
#   3. wait until /health reports .version == X.Y.Z and .status == ok
#   4. wait until /health.warm_cache is "complete" (or "disabled")
#   5. run smoke.sh (search, proximity, wildcard, 0.4.x-shim, rate limit)
#   6. on any failure: repoint to the previous binary, restart, exit 1
#   7. keep the last three binaries
set -euo pipefail

TAG="${1:?usage: switch_release.sh vX.Y.Z}"
VERSION="${TAG#v}"
ROOT=/opt/kashshaf/api
BIN="$ROOT/bin/kashshaf-api-$TAG"
CURRENT="$ROOT/bin/current"
LOCAL_URL="${KASHSHAF_LOCAL_URL:-http://127.0.0.1:3000}"
SERVICE=kashshaf-api
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"   # seconds for the version to appear
WARM_TIMEOUT="${WARM_TIMEOUT:-600}"       # seconds for warm_cache == complete

log() { echo "[switch_release] $*"; }

[ -x "$BIN" ] || { log "no executable at $BIN"; exit 1; }
command -v jq >/dev/null || { log "jq is required"; exit 1; }

PREVIOUS=""
if [ -L "$CURRENT" ]; then
  PREVIOUS="$(readlink -f "$CURRENT")"
  log "current: $PREVIOUS"
fi

rollback() {
  local why="$1"
  log "FAILED: $why"
  if [ -n "$PREVIOUS" ] && [ -x "$PREVIOUS" ]; then
    log "rolling back to $PREVIOUS"
    ln -sfn "$PREVIOUS" "$CURRENT"
    systemctl restart "$SERVICE" || true
    for _ in $(seq 1 60); do
      if curl -fsS -m 3 "$LOCAL_URL/health" >/dev/null 2>&1; then log "previous binary is serving again"; break; fi
      sleep 2
    done
  else
    log "no previous binary to roll back to"
  fi
  exit 1
}

log "switching $CURRENT -> $BIN"
ln -sfn "$BIN" "$CURRENT"
systemctl restart "$SERVICE"

log "waiting for /health.version == $VERSION"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
until curl -fsS -m 3 "$LOCAL_URL/health" 2>/dev/null | jq -e --arg v "$VERSION" '.status == "ok" and .version == $v' >/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    journalctl -u "$SERVICE" -n 30 --no-pager || true
    rollback "health check did not report version $VERSION within ${HEALTH_TIMEOUT}s"
  fi
  sleep 2
done
log "version $VERSION is live"

log "waiting for warm_cache == complete"
deadline=$(( $(date +%s) + WARM_TIMEOUT ))
until curl -fsS -m 3 "$LOCAL_URL/health" 2>/dev/null | jq -e '.warm_cache == "complete" or .warm_cache == "disabled"' >/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then rollback "warm-up did not complete within ${WARM_TIMEOUT}s"; fi
  sleep 5
done
log "warm-up done"

if ! bash "$ROOT/smoke.sh" "$LOCAL_URL" "$VERSION"; then
  rollback "smoke test failed"
fi

# Keep the last three binaries (by modification time), never the live one.
ls -1t "$ROOT"/bin/kashshaf-api-v* 2>/dev/null | tail -n +4 | while read -r old; do
  if [ "$(readlink -f "$old")" != "$(readlink -f "$CURRENT")" ]; then log "pruning $old"; rm -f "$old"; fi
done

log "release $TAG deployed"
