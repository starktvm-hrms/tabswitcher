#!/usr/bin/env bash
# One-time setup on the Hostinger VPS for https://seminar.starkpeople.in
#
# Normally run for you by the "Set up server" GitHub Actions workflow. It can
# also be run by hand as root (hPanel → VPS → Browser terminal):  bash setup-server.sh
#
# What it does — and only this; other nginx sites on the server are not touched:
#   1. Installs nginx, git, rsync and certbot if they are missing.
#   2. Adds ONE nginx site file for seminar.starkpeople.in, checks the whole nginx
#      config with `nginx -t`, and reloads only if that passes (otherwise it
#      removes its own file again).
#   3. Gets an HTTPS certificate for the subdomain with certbot.
#   4. Installs a small sync job (systemd timer, every minute) that fetches the
#      latest build from the public `deploy-build` branch on GitHub and copies it
#      into the web root. No credentials are stored on the server.
# Safe to run again: every step checks what is already there.
set -euo pipefail

DOMAIN="seminar.starkpeople.in"
REPO_URL="https://github.com/starktvm-hrms/tabswitcher.git"
BRANCH="deploy-build"
WEB_ROOT="/var/www/${DOMAIN}"
SRC="/opt/${DOMAIN}"
SYNC_USER="seminar-sync"

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo bash $0)"; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

say "Packages"
need=()
command -v nginx   >/dev/null || need+=(nginx)
command -v git     >/dev/null || need+=(git)
command -v rsync   >/dev/null || need+=(rsync)
command -v certbot >/dev/null || need+=(certbot python3-certbot-nginx)
if [ ${#need[@]} -gt 0 ]; then
  echo "installing: ${need[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -y -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}"
else
  echo "all present"
fi

say "Sync user and folders"
id "$SYNC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$SRC" --shell /usr/sbin/nologin "$SYNC_USER"
install -d -m 755 -o "$SYNC_USER" -g "$SYNC_USER" "$WEB_ROOT" "$SRC"
if [ ! -e "$WEB_ROOT/index.html" ]; then
  echo "<!doctype html><title>Seminar Presenter</title><p>Waiting for the first build from GitHub…</p>" > "$WEB_ROOT/index.html"
  chown "$SYNC_USER:$SYNC_USER" "$WEB_ROOT/index.html"
fi

say "nginx site for ${DOMAIN}"
if [ -d /etc/nginx/sites-available ]; then
  SITE="/etc/nginx/sites-available/${DOMAIN}"; LINK="/etc/nginx/sites-enabled/${DOMAIN}"
else
  SITE="/etc/nginx/conf.d/${DOMAIN}.conf"; LINK=""
fi
if [ -e "$SITE" ]; then
  echo "$SITE already exists — leaving it as is (certbot may have added HTTPS to it)."
else
  cat > "$SITE" <<NGINX
# Seminar Presenter (static Vite build) — synced from github.com/starktvm-hrms/tabswitcher (deploy-build branch)
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    root ${WEB_ROOT};
    index index.html;

    # Hashed build assets never change: cache them for a year.
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    # The app shell and version stamp must always be fresh so new builds show up immediately.
    location / {
        add_header Cache-Control "no-cache";
        try_files \$uri \$uri/ /index.html;
    }

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    gzip on;
    gzip_types text/css application/javascript image/svg+xml application/json;
}
NGINX
  if [ -n "$LINK" ]; then ln -sf "$SITE" "$LINK"; fi
fi

if nginx -t; then
  systemctl reload nginx 2>/dev/null || nginx -s reload
else
  echo "nginx config test FAILED — removing the new site file so nothing else is affected."
  rm -f "$SITE" ${LINK:+"$LINK"}
  exit 1
fi

say "HTTPS certificate"
if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  echo "certificate already exists"
elif getent hosts "$DOMAIN" >/dev/null; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
    || echo "certbot failed — the site still works on http://${DOMAIN}. Re-run this script later to retry."
else
  echo "DNS for ${DOMAIN} doesn't resolve yet — re-run this script in a few minutes to get HTTPS."
fi

say "Sync job (GitHub deploy-build branch → ${WEB_ROOT})"
cat > /usr/local/bin/seminar-sync <<SYNC
#!/usr/bin/env bash
# Fetches the latest build of the Seminar Presenter and publishes it if it changed.
set -euo pipefail
exec 9>"${SRC}/.lock"; flock -n 9 || exit 0
if [ ! -d "${SRC}/repo/.git" ]; then
  git clone -q --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${SRC}/repo"
else
  git -C "${SRC}/repo" fetch -q --depth 1 origin "${BRANCH}"
  git -C "${SRC}/repo" reset -q --hard FETCH_HEAD
fi
new=\$(git -C "${SRC}/repo" rev-parse HEAD)
[ "\$new" = "\$(cat "${SRC}/published" 2>/dev/null)" ] && exit 0
# --checksum: builds can produce same-size files with near-identical mtimes; compare content instead.
rsync -a --checksum --delete --delay-updates --exclude .git "${SRC}/repo/" "${WEB_ROOT}/"
echo "\$new" > "${SRC}/published"
echo "published \$new"
SYNC
chmod 755 /usr/local/bin/seminar-sync

cat > /etc/systemd/system/seminar-sync.service <<UNIT
[Unit]
Description=Publish the latest Seminar Presenter build from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${SYNC_USER}
Group=${SYNC_USER}
Environment=HOME=${SRC}
ExecStart=/usr/local/bin/seminar-sync
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${SRC} ${WEB_ROOT}
PrivateTmp=true
UNIT

cat > /etc/systemd/system/seminar-sync.timer <<UNIT
[Unit]
Description=Check GitHub for a new Seminar Presenter build every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now seminar-sync.timer
if systemctl start seminar-sync.service; then
  journalctl -u seminar-sync.service -n 5 --no-pager || true
else
  echo "First sync failed (the deploy-build branch may not exist yet). The timer retries every minute."
  journalctl -u seminar-sync.service -n 20 --no-pager || true
fi

say "Done"
echo "Site:      http://${DOMAIN}  (https once the certificate is issued)"
echo "Published: $(cat "${SRC}/published" 2>/dev/null || echo 'nothing yet')"
echo "Status:    systemctl status seminar-sync.timer   ·   journalctl -u seminar-sync"
