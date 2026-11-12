#!/usr/bin/env bash
# Server setup on the Hostinger VPS for https://seminar.starkpeople.in
#
# Normally run for you by the "Set up server" GitHub Actions workflow. It can
# also be run by hand as root (hPanel → VPS → Browser terminal):  bash setup-server.sh
#
# What it does — and only this; other nginx sites on the server are not touched:
#   1. Installs nginx, git, rsync, certbot and Node.js if they are missing.
#   2. Adds ONE nginx site file for seminar.starkpeople.in (plus a snippet that
#      routes /api/ to the poll server), checks the whole nginx config with
#      `nginx -t`, and reloads only if that passes — otherwise it puts its own
#      files back the way they were.
#   3. Gets an HTTPS certificate for the subdomain with certbot.
#   4. Installs a sync job (systemd timer, every minute) that fetches the latest
#      build from the public `deploy-build` branch on GitHub: the site goes to the
#      web root, the poll server code to /opt/seminar.starkpeople.in/server.
#   5. Runs the poll + workspace server (systemd service, localhost only, unprivileged user):
#      live polls, and saved presentations/uploaded files so they open on any computer.
# No credentials are stored on the server. Safe to run again.
set -euo pipefail

DOMAIN="seminar.starkpeople.in"
REPO_URL="https://github.com/starktvm-hrms/tabswitcher.git"
BRANCH="deploy-build"
WEB_ROOT="/var/www/${DOMAIN}"
SRC="/opt/${DOMAIN}"
SYNC_USER="seminar-sync"
SNIPPET="/etc/nginx/snippets/${DOMAIN}-api.conf"

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo bash $0)"; exit 1; }
say() { printf '\n==> %s\n' "$*"; }
as_sync() { runuser -u "$SYNC_USER" -- "$@"; }

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
install -d -m 755 -o "$SYNC_USER" -g "$SYNC_USER" "$WEB_ROOT" "$SRC" "$SRC/server"
install -d -m 750 -o "$SYNC_USER" -g "$SYNC_USER" "$SRC/data"
if [ ! -e "$WEB_ROOT/index.html" ]; then
  echo "<!doctype html><title>Seminar Presenter</title><p>Waiting for the first build from GitHub…</p>" > "$WEB_ROOT/index.html"
  chown "$SYNC_USER:$SYNC_USER" "$WEB_ROOT/index.html"
fi

say "Node.js for the poll server"
# Use an existing node only if the unprivileged service user can run it and it's v18+.
NODE_BIN=""
for cand in "$(command -v node || true)" /usr/bin/node /usr/local/bin/node; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  v=$(as_sync "$cand" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "${v:-0}" -ge 18 ] 2>/dev/null; then NODE_BIN="$cand"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  echo "installing nodejs from apt"
  DEBIAN_FRONTEND=noninteractive apt-get update -y -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  NODE_BIN=/usr/bin/node
fi
echo "using $NODE_BIN ($(as_sync "$NODE_BIN" -v))"

say "Poll server port"
PORT_FILE="$SRC/poll-port"
port_busy() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }
if [ -s "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE")
else
  PORT=8791
  while port_busy "$PORT"; do PORT=$((PORT + 1)); done
  echo "$PORT" > "$PORT_FILE"
fi
echo "127.0.0.1:$PORT"

say "nginx site for ${DOMAIN}"
if [ -d /etc/nginx/sites-available ]; then
  SITE="/etc/nginx/sites-available/${DOMAIN}"; LINK="/etc/nginx/sites-enabled/${DOMAIN}"
else
  SITE="/etc/nginx/conf.d/${DOMAIN}.conf"; LINK=""
fi
install -d /etc/nginx/snippets
BACKUP_DIR=$(mktemp -d)
[ -e "$SITE" ] && cp -a "$SITE" "$BACKUP_DIR/site"
[ -e "$SNIPPET" ] && cp -a "$SNIPPET" "$BACKUP_DIR/snippet"
SITE_EXISTED=$([ -e "$SITE" ] && echo 1 || echo 0)

cat > "$SNIPPET" <<NGINX
# Poll + workspace server for ${DOMAIN} (managed by setup-server.sh)
location /api/ {
    proxy_pass http://127.0.0.1:${PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Connection "";
    # Live results are a long-lived Server-Sent Events stream: no buffering, long timeout.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    # Uploaded PDFs/videos stream straight to the server (it enforces the real limits).
    client_max_body_size 520m;
    proxy_request_buffering off;
    proxy_send_timeout 1h;
}
# Uploaded presentation files (unguessable URLs; Range requests for video seeking).
location /files/ {
    proxy_pass http://127.0.0.1:${PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header Connection "";
    proxy_read_timeout 1h;
}
NGINX

if [ "$SITE_EXISTED" = 1 ]; then
  echo "$SITE exists (certbot may have added HTTPS to it) — only adding the /api include."
  if ! grep -qF "include ${SNIPPET};" "$SITE"; then
    sed -i "s|^\(\s*\)server_name ${DOMAIN};.*$|&\n\1include ${SNIPPET};|" "$SITE"
  fi
else
  cat > "$SITE" <<NGINX
# Seminar Presenter (static Vite build + poll API) — synced from github.com/starktvm-hrms/tabswitcher
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    include ${SNIPPET};

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
grep -c "include ${SNIPPET};" "$SITE" | sed 's/^/api includes in site file: /'

if nginx -t; then
  systemctl reload nginx 2>/dev/null || nginx -s reload
else
  echo "nginx config test FAILED — restoring this site's files so nothing else is affected."
  if [ -e "$BACKUP_DIR/site" ]; then cp -a "$BACKUP_DIR/site" "$SITE"; else rm -f "$SITE" ${LINK:+"$LINK"}; fi
  if [ -e "$BACKUP_DIR/snippet" ]; then cp -a "$BACKUP_DIR/snippet" "$SNIPPET"; else rm -f "$SNIPPET"; fi
  nginx -t && (systemctl reload nginx 2>/dev/null || nginx -s reload) || true
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

say "Sync job (GitHub deploy-build branch → site + poll server)"
cat > /usr/local/bin/seminar-sync <<SYNC
#!/usr/bin/env bash
# Fetches the latest Seminar Presenter build and publishes it if it changed.
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
# Poll server code first, so the API is ready before the new page is.
# --checksum: builds can produce same-size files with near-identical mtimes; compare content instead.
if [ -d "${SRC}/repo/.server" ]; then
  changed=\$(rsync -a --checksum --delete --itemize-changes "${SRC}/repo/.server/" "${SRC}/server/")
  if [ -n "\$changed" ]; then
    # The service runs as this same user with Restart=always: stopping it restarts it on the new code.
    pkill -TERM -u "\$(id -u)" -f "${SRC}/server/poll-server.mjs" || true
    echo "poll server code updated"
  fi
fi
rsync -a --checksum --delete --delete-excluded --delay-updates --exclude .git --exclude .server "${SRC}/repo/" "${WEB_ROOT}/"
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

say "Poll server service"
cat > /etc/systemd/system/seminar-poll.service <<UNIT
[Unit]
Description=Seminar Presenter live poll server (127.0.0.1:${PORT})
After=network.target

[Service]
User=${SYNC_USER}
Group=${SYNC_USER}
WorkingDirectory=${SRC}/server
Environment=PORT=${PORT} HOST=127.0.0.1 DATA_DIR=${SRC}/data NODE_ENV=production
ExecStart=${NODE_BIN} ${SRC}/server/poll-server.mjs
Restart=always
RestartSec=1
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${SRC}/data
PrivateTmp=true
MemoryMax=512M

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now seminar-sync.timer
# Republish once so the poll server code is in place (forces a sync even if the build is unchanged).
rm -f "$SRC/published"
if systemctl start seminar-sync.service; then
  journalctl -u seminar-sync.service -n 5 --no-pager || true
else
  echo "Sync failed (the deploy-build branch may not exist yet). The timer retries every minute."
  journalctl -u seminar-sync.service -n 20 --no-pager || true
fi
if [ -e "$SRC/server/poll-server.mjs" ]; then
  systemctl enable seminar-poll.service
  systemctl restart seminar-poll.service
  for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
  echo "poll server (direct):  $(curl -fsS "http://127.0.0.1:${PORT}/api/health" || echo 'NOT RESPONDING')"
  echo "poll server (via nginx): $(curl -fsS --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/api/health" 2>/dev/null \
      || curl -fsS -H "Host: ${DOMAIN}" http://127.0.0.1/api/health 2>/dev/null || echo 'NOT RESPONDING')"
else
  echo "Poll server code not published yet; it starts once a build with .server/ is synced (re-run this script then)."
fi

say "Done"
echo "Site:      https://${DOMAIN}"
echo "Published: $(cat "${SRC}/published" 2>/dev/null || echo 'nothing yet')"
echo "Status:    systemctl status seminar-sync.timer seminar-poll   ·   journalctl -u seminar-sync -u seminar-poll"
