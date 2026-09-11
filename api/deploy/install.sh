#!/usr/bin/env bash
# One-time server setup for the Kashshaf API (Ubuntu). Idempotent; review
# before running. Does NOT deploy a binary: release.yml does that on tag.
#
#   sudo bash install.sh [--with-nginx] [--with-certbot]
#
# Creates the kashshaf user, /opt/kashshaf/{api/bin,data}, installs the
# systemd unit and (optionally) the nginx site, and makes sure jq and curl
# (used by switch_release.sh / smoke.sh) are present. The corpus data must
# be placed in /opt/kashshaf/data separately (rclone from R2 or scp).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WITH_NGINX=0; WITH_CERTBOT=0
for a in "$@"; do case "$a" in --with-nginx) WITH_NGINX=1;; --with-certbot) WITH_CERTBOT=1;; *) echo "unknown flag $a"; exit 1;; esac; done
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

echo "== packages"
apt-get update -qq
apt-get install -y -qq jq curl rsync >/dev/null
[ "$WITH_NGINX" -eq 1 ] && apt-get install -y -qq nginx >/dev/null
[ "$WITH_CERTBOT" -eq 1 ] && apt-get install -y -qq certbot python3-certbot-nginx >/dev/null

echo "== user and directories"
id -u kashshaf >/dev/null 2>&1 || useradd --system --home /opt/kashshaf --shell /usr/sbin/nologin kashshaf
install -d -o kashshaf -g kashshaf -m 755 /opt/kashshaf /opt/kashshaf/api /opt/kashshaf/api/bin /opt/kashshaf/api/incoming /opt/kashshaf/data
install -o kashshaf -g kashshaf -m 755 "$HERE/switch_release.sh" /opt/kashshaf/api/switch_release.sh
install -o kashshaf -g kashshaf -m 755 "$HERE/smoke.sh" /opt/kashshaf/api/smoke.sh

echo "== sudoers: the deploy user may switch releases without a password"
cat > /etc/sudoers.d/kashshaf-deploy <<'EOF'
# release.yml runs: sudo /opt/kashshaf/api/switch_release.sh vX.Y.Z
kashshaf ALL=(root) NOPASSWD: /opt/kashshaf/api/switch_release.sh
EOF
chmod 440 /etc/sudoers.d/kashshaf-deploy
visudo -cf /etc/sudoers.d/kashshaf-deploy >/dev/null

echo "== systemd unit"
install -m 644 "$HERE/kashshaf-api.service" /etc/systemd/system/kashshaf-api.service
systemctl daemon-reload
systemctl enable kashshaf-api >/dev/null
if [ -x /opt/kashshaf/api/bin/current ]; then
  systemctl restart kashshaf-api
else
  echo "   no binary at /opt/kashshaf/api/bin/current yet; the first release.yml run installs it"
fi

if [ "$WITH_NGINX" -eq 1 ]; then
  echo "== nginx site"
  install -m 644 "$HERE/nginx-api.kashshaf.com.conf" /etc/nginx/sites-available/api.kashshaf.com
  ln -sfn /etc/nginx/sites-available/api.kashshaf.com /etc/nginx/sites-enabled/api.kashshaf.com
  nginx -t
  systemctl reload nginx
  [ "$WITH_CERTBOT" -eq 1 ] && certbot --nginx -d api.kashshaf.com --non-interactive --agree-tos --redirect -m admin@kashshaf.com || true
fi

echo "== done"
echo "   data dir: /opt/kashshaf/data  (corpus.db, metadata.db, tantivy_index/)"
echo "   unit:     systemctl status kashshaf-api"
echo "   deploy:   Actions -> Release -> run workflow (dry_run=false) or only_api=true for a redeploy"
