#!/usr/bin/env bash
# One-time setup on the Hostinger VPS for https://seminar.starkpeople.in
#
# Run as root on the VPS (hPanel → VPS → Browser terminal, or `ssh root@76.13.241.150`):
#   bash setup-server.sh
#
# What it does — and only this; other nginx sites on the server are not touched:
#   1. Creates a locked-down `deploy` user that can only write the site folder.
#   2. Creates /var/www/seminar.starkpeople.in with a placeholder page.
#   3. Adds ONE nginx site file for seminar.starkpeople.in, checks the whole nginx
#      config with `nginx -t`, and reloads only if the check passes.
#   4. Gets an HTTPS certificate for the subdomain with certbot.
#   5. Creates an SSH key for GitHub Actions and prints the values to paste
#      into the repository's secrets.
# Safe to run again: every step checks what is already there.
set -euo pipefail

DOMAIN="seminar.starkpeople.in"
WEB_ROOT="/var/www/${DOMAIN}"
DEPLOY_USER="deploy"
KEY="/root/${DOMAIN}-github-deploy"

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo bash $0)"; exit 1; }
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

say "Installing nginx, rsync and certbot if missing"
need=()
command -v nginx   >/dev/null || need+=(nginx)
command -v rsync   >/dev/null || need+=(rsync)
command -v certbot >/dev/null || need+=(certbot python3-certbot-nginx)
if [ ${#need[@]} -gt 0 ]; then
  apt-get update -y && apt-get install -y "${need[@]}"
else
  echo "all present"
fi

say "Deploy user and web root"
id "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$WEB_ROOT"
if [ ! -e "$WEB_ROOT/index.html" ]; then
  echo "<!doctype html><title>Seminar Presenter</title><p>Waiting for the first deploy from GitHub…</p>" > "$WEB_ROOT/index.html"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$WEB_ROOT/index.html"
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
# Seminar Presenter (static Vite build) — deployed by GitHub Actions from starktvm-hrms/tabswitcher
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

    # The app shell must always be fresh so new deploys show up immediately.
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
  [ -n "$LINK" ] && ln -sf "$SITE" "$LINK"
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
else
  if getent hosts "$DOMAIN" >/dev/null; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
      || echo "certbot failed — the site still works on http://${DOMAIN}. Re-run this script later to retry."
  else
    echo "DNS for ${DOMAIN} doesn't resolve yet — re-run this script in a few minutes to get HTTPS."
  fi
fi

say "SSH key for GitHub Actions"
if [ ! -e "$KEY" ]; then
  ssh-keygen -t ed25519 -N "" -C "github-actions@${DOMAIN}" -f "$KEY" >/dev/null
fi
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh"
AUTH="/home/${DEPLOY_USER}/.ssh/authorized_keys"
touch "$AUTH"
grep -qF "$(cut -d' ' -f2 "$KEY.pub")" "$AUTH" || cat "$KEY.pub" >> "$AUTH"
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH"; chmod 600 "$AUTH"

HOST_IP="$(curl -4 -s --max-time 5 https://ifconfig.me || hostname -I | awk '{print $1}')"
cat <<EOF

────────────────────────────────────────────────────────────────────────
 Done. Add these as repository secrets in GitHub:
 github.com/starktvm-hrms/tabswitcher → Settings → Secrets and variables
 → Actions → New repository secret

   VPS_HOST         ${HOST_IP}
   VPS_USER         ${DEPLOY_USER}
   VPS_SSH_KEY      (everything between the lines below, including BEGIN/END)
   VPS_KNOWN_HOSTS  (the host-key lines further below)
────────────────────────────────────────────────────────────────────────
$(cat "$KEY")
────────────────────────────────────────────────────────────────────────
 VPS_KNOWN_HOSTS:
$(ssh-keyscan -t ed25519,ecdsa,rsa localhost 2>/dev/null | sed "s/^localhost/${HOST_IP}/")
────────────────────────────────────────────────────────────────────────
 After saving the secrets you can delete the key from the server:
   rm ${KEY} ${KEY}.pub
EOF
