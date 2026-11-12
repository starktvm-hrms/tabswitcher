# Deploying to seminar.starkpeople.in

The app is a static build (`npm run build` → `dist/`). It is served by nginx on the Hostinger VPS (KVM 2, `76.13.241.150`), next to the other starkpeople.in sites. GitHub Actions builds it and copies it to the server on every push to `main`.

```
GitHub push ──► Actions: npm ci → test → build ──rsync over SSH──► VPS /var/www/seminar.starkpeople.in ──► nginx ──► https://seminar.starkpeople.in
```

DNS: an `A` record `seminar` → `76.13.241.150` already exists in the starkpeople.in zone (Hostinger DNS).

## One-time setup

1. **Prepare the server.** In hPanel, go to **VPS → Browser terminal** (or `ssh root@76.13.241.150`), then fetch and run the script. Paste the contents of `deploy/setup-server.sh` into a file on the VPS:
   ```bash
   nano setup-server.sh      # paste the script, save
   bash setup-server.sh
   ```
   It adds only its own nginx site file, checks the full nginx config before reloading, gets an HTTPS certificate, and creates a `deploy` user that can only write the site folder. It is safe to run again.

2. **Add the secrets it prints** in GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

   | Secret | Value |
   | --- | --- |
   | `VPS_HOST` | `76.13.241.150` |
   | `VPS_USER` | `deploy` |
   | `VPS_SSH_KEY` | the private key the script prints, including the BEGIN/END lines |
   | `VPS_KNOWN_HOSTS` | the host-key lines the script prints (pins the server's identity) |

3. **Deploy.** Push to `main`, or open **Actions → Deploy to seminar.starkpeople.in → Run workflow**.

## Troubleshooting

- **"NOT deployed — missing repository secrets"** warning: step 2 isn't done yet. The build and tests still run.
- **SSH `Permission denied`**: re-run the setup script. It re-adds the key to `/home/deploy/.ssh/authorized_keys`.
- **No HTTPS**: re-run the setup script after DNS has propagated. It retries certbot.
- **Wrong site shows up**: on the VPS, `nginx -T | grep -n seminar` should list the server block from `/etc/nginx/sites-available/seminar.starkpeople.in`.
